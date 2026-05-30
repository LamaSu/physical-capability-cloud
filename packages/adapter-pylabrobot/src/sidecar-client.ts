/**
 * Long-running Python sidecar manager + JSON-RPC 2.0 client.
 *
 * Responsibilities:
 *   1. Spawn the `pcc_plr_sidecar` Python module via the configured python
 *      interpreter, holding stdio pipes for newline-delimited JSON exchange.
 *   2. Frame outgoing JSON-RPC requests, correlate by id with pending
 *      responses, and time them out.
 *   3. Dispatch server-initiated notifications (no id) to subscribers.
 *   4. Auto-restart on crash with exponential backoff (1s, 2s, 4s, max 30s).
 *      In-flight requests reject with code -32099 (SIDECAR_RESTART) so the
 *      adapter can decide to retry once.
 *
 * Why a single long-running process per adapter instance (vs subprocess-
 * per-job): PLR holds expensive deck-calibration state and exclusive
 * hardware locks; reacquiring them every job costs 3-8s of cold start and
 * races against other locks. The sidecar wins for any operator with >2
 * jobs/hour (the design center). See PLR research §3.2.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  RPC_ERROR_CODES,
  type JsonRpcError,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from "./protocol.js";

export interface SidecarClientConfig {
  /** Python interpreter path (default: "python") */
  pythonPath?: string;
  /** Working directory for the child process */
  cwd?: string;
  /** Environment variables for the child process */
  env?: NodeJS.ProcessEnv;
  /** Default per-request timeout (ms). Default 60_000. Long PLR runs override per-call. */
  defaultTimeoutMs?: number;
  /** Max number of crash-restart attempts before giving up. Default 5. */
  maxRestarts?: number;
  /** Initial restart backoff (ms). Doubles each crash. Default 1000. */
  initialBackoffMs?: number;
  /** Cap on restart backoff (ms). Default 30_000. */
  maxBackoffMs?: number;
  /** Skip subprocess spawn entirely (test mode — caller injects messages). */
  inMemoryTransport?: SidecarTransport;
}

/** Pluggable transport — lets tests inject a fake message bus */
export interface SidecarTransport {
  /** Send a JSON-RPC message string (already serialized + newline-suffixed) */
  send(line: string): void;
  /** Register a handler for inbound message lines */
  onLine(handler: (line: string) => void): void;
  /** Register a handler for the transport being closed (process exit / stream end) */
  onClose(handler: () => void): void;
  /** Tear down the transport */
  close(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error & { code?: number; data?: unknown }) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (params: Record<string, unknown>) => void;

/**
 * Error thrown when the sidecar returns a JSON-RPC error (or the call times
 * out / the sidecar restarts mid-call).
 */
export class SidecarError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.data = data;
  }
}

export class SidecarClient extends EventEmitter {
  private readonly config: Required<Omit<SidecarClientConfig, "env" | "inMemoryTransport">> & {
    env?: NodeJS.ProcessEnv;
    inMemoryTransport?: SidecarTransport;
  };
  private proc: ChildProcess | null = null;
  private transport: SidecarTransport | null = null;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private partialLine = "";
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private currentBackoffMs: number;

  constructor(config: SidecarClientConfig = {}) {
    super();
    this.config = {
      pythonPath: config.pythonPath ?? "python",
      cwd: config.cwd ?? process.cwd(),
      env: config.env,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60_000,
      maxRestarts: config.maxRestarts ?? 5,
      initialBackoffMs: config.initialBackoffMs ?? 1000,
      maxBackoffMs: config.maxBackoffMs ?? 30_000,
      inMemoryTransport: config.inMemoryTransport,
    };
    this.currentBackoffMs = this.config.initialBackoffMs;
  }

  /** Start the sidecar (idempotent — no-op if already alive). */
  async start(): Promise<void> {
    if (this.transport) return;
    this.intentionallyClosed = false;
    if (this.config.inMemoryTransport) {
      this.transport = this.config.inMemoryTransport;
      this.wireTransport(this.transport);
      this.emit("ready");
      return;
    }
    await this.spawnProcess();
  }

  /** Returns true if a sidecar is currently spawned + responsive */
  isAlive(): boolean {
    return this.transport !== null;
  }

  /** Subscribe to a server-initiated notification by method name */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /**
   * Call a JSON-RPC method. Resolves with the `result` field; rejects with
   * `SidecarError` on RPC error, timeout, or sidecar crash.
   */
  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.transport) {
      throw new SidecarError(
        RPC_ERROR_CODES.HARDWARE_UNREACHABLE,
        `sidecar not started — call start() first`,
      );
    }
    const id = String(this.nextId++);
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const line = JSON.stringify(req) + "\n";

    const effectiveTimeout = timeoutMs ?? this.config.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SidecarError(
            RPC_ERROR_CODES.INTERNAL_ERROR,
            `sidecar call timed out after ${effectiveTimeout}ms: ${method}`,
          ),
        );
      }, effectiveTimeout);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutHandle,
      });
      try {
        this.transport!.send(line);
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pending.delete(id);
        reject(
          new SidecarError(
            RPC_ERROR_CODES.HARDWARE_UNREACHABLE,
            `sidecar send failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  /** Send a fire-and-forget notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.transport) return;
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    try {
      this.transport.send(JSON.stringify(msg) + "\n");
    } catch {
      // notifications are best-effort
    }
  }

  /** Stop the sidecar gracefully. Rejects any in-flight calls. */
  async stop(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.failAllPending(
      new SidecarError(RPC_ERROR_CODES.INTERNAL_ERROR, "sidecar shutdown"),
    );
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // ignore
      }
      this.transport = null;
    }
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }

  // ── private ────────────────────────────────────────────────────────────

  private async spawnProcess(): Promise<void> {
    const proc = spawn(this.config.pythonPath, ["-m", "pcc_plr_sidecar"], {
      cwd: this.config.cwd,
      env: this.config.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    // Pipe child stderr to our own (helps debugging without polluting stdout)
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    proc.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
      this.handleTransportClosed();
    });
    proc.on("error", (err) => {
      this.emit("error", err);
    });

    const transport: SidecarTransport = {
      send: (line) => {
        if (!proc.stdin || proc.stdin.destroyed) {
          throw new Error("sidecar stdin is closed");
        }
        proc.stdin.write(line);
      },
      onLine: (handler) => {
        proc.stdout?.on("data", (chunk: Buffer) => {
          this.partialLine += chunk.toString("utf8");
          let idx: number;
          while ((idx = this.partialLine.indexOf("\n")) !== -1) {
            const line = this.partialLine.slice(0, idx).trim();
            this.partialLine = this.partialLine.slice(idx + 1);
            if (line) handler(line);
          }
        });
      },
      onClose: (handler) => {
        proc.on("exit", () => handler());
      },
      close: async () => {
        proc.stdin?.end();
      },
    };
    this.transport = transport;
    this.wireTransport(transport);
    this.emit("ready");
  }

  private wireTransport(transport: SidecarTransport): void {
    transport.onLine((line) => this.handleLine(line));
    transport.onClose(() => this.handleTransportClosed());
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.emit("parse_error", { line, error: err });
      return;
    }
    if ((msg as JsonRpcNotification).method && !("id" in msg)) {
      const note = msg as JsonRpcNotification;
      const handlers = this.notificationHandlers.get(note.method);
      if (handlers) {
        for (const h of handlers) {
          try {
            h(note.params ?? {});
          } catch (err) {
            this.emit("handler_error", { method: note.method, error: err });
          }
        }
      }
      return;
    }
    const response = msg as JsonRpcResponse;
    const id = String(response.id);
    const pending = this.pending.get(id);
    if (!pending) {
      this.emit("orphan_response", response);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timeoutHandle);
    if ("error" in response) {
      const err = response.error;
      pending.reject(new SidecarError(err.code, err.message, err.data));
    } else {
      pending.resolve((response as JsonRpcSuccess).result);
    }
  }

  private handleTransportClosed(): void {
    if (this.transport === null && this.proc === null) return;
    this.transport = null;
    this.proc = null;
    this.failAllPending(
      new SidecarError(
        RPC_ERROR_CODES.SIDECAR_RESTART,
        "sidecar exited (in-flight call invalidated)",
      ),
    );
    this.emit("crash");
    if (this.intentionallyClosed) return;
    if (this.restartCount >= this.config.maxRestarts) {
      this.emit("gave_up", { attempts: this.restartCount });
      return;
    }
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const delay = Math.min(this.currentBackoffMs, this.config.maxBackoffMs);
    this.emit("restart_scheduled", { attempt: this.restartCount + 1, delayMs: delay });
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      this.restartCount += 1;
      this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.config.maxBackoffMs);
      try {
        await this.start();
        // success — reset backoff for next failure cycle
        this.currentBackoffMs = this.config.initialBackoffMs;
        this.restartCount = 0;
        this.emit("restarted");
      } catch (err) {
        this.emit("restart_failed", { attempt: this.restartCount, error: err });
        this.handleTransportClosed();
      }
    }, delay);
  }

  private failAllPending(error: SidecarError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timeoutHandle);
      p.reject(error);
      this.pending.delete(id);
    }
  }
}

// ── In-memory transport for tests ──────────────────────────────────────────

/**
 * In-memory transport for tests. Lets a test inject canned responses to
 * outbound JSON-RPC calls and emit notifications without spawning Python.
 */
export class InMemoryTransport implements SidecarTransport {
  private lineHandlers: Array<(line: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  /** Lines sent by the client (TS → sidecar direction) */
  public sent: string[] = [];

  send(line: string): void {
    this.sent.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  /** Test helper: push a line as if the sidecar sent it */
  receive(line: string): void {
    for (const h of this.lineHandlers) h(line);
  }

  /** Test helper: emit a success response for a known request id */
  respondSuccess(id: string | number, result: unknown): void {
    this.receive(
      JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
    );
  }

  /** Test helper: emit an error response for a known request id */
  respondError(
    id: string | number,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.receive(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } }) + "\n",
    );
  }

  /** Test helper: emit a notification (no id) */
  notify(method: string, params?: Record<string, unknown>): void {
    this.receive(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Test helper: parse the most-recently-sent request as JSON */
  lastSent(): JsonRpcRequest | JsonRpcNotification | null {
    if (this.sent.length === 0) return null;
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }

  async close(): Promise<void> {
    for (const h of this.closeHandlers) h();
  }
}
