/**
 * Trilobio adapter.
 *
 * Talks to a Trilobio fleet controller via its LAN-resident `tcode-api` HTTP
 * surface. The fleet controller orchestrates trilobot pipettes, robots, and
 * labware; jobs are either curated protocol IDs (safer, the default) or
 * arbitrary tcode-api Python scripts (gated by `allowArbitraryScripts`).
 *
 * Trilobio reference:
 *   Source     https://github.com/trilobio/tcode-api
 *   API docs   https://tcode.trilo.bio/
 *   Install    uv add git+https://github.com/trilobio/tcode-api.git
 *
 * Design parity with `hamilton-adapter.ts`:
 *   - LAN endpoint + credentials
 *   - Async run model (POST /protocol-run/create, then poll /protocol-run)
 *   - Mock mode for CI / dev / demos with no real device
 *
 * Trilobio specifics:
 *   - apiKey-first auth (header `X-Api-Key: <key>`); basic-auth fallback
 *     when no apiKey is supplied (Authorization: Basic <base64>).
 *   - Two execution modes:
 *       1. Curated protocol IDs (default) — `payload.protocolId` selects a
 *          server-side protocol; safer for shared / multi-tenant fleets.
 *       2. Arbitrary scripts — `payload.script` ships a tcode-api Python
 *          source body. Only honored when `config.allowArbitraryScripts=true`.
 *   - We piggyback `load_gcode` semantically on "select a protocol" / "stage
 *     a script", matching the Hamilton precedent. The MachineCommand union
 *     is gcode-centric; the adapter normalizes the payload.
 *   - The `stop` command POSTs a cancel endpoint when present; we surface
 *     non-2xx as a failed `MachineCommandResult` rather than swallow.
 *   - Run completion exposes evidence: event log, run timing, calibration
 *     deltas, and sensor data — folded into `execution_completed.payload`.
 *
 * HTTP-surface assumptions (DOCUMENTED, not authoritative):
 *   The Trilobio fleet-controller HTTP API is not fully publicly documented
 *   at the level required to pin exact endpoint paths. We mirror the
 *   Hamilton path shape (POST /api/v1/protocol-run/create + GET
 *   /api/v1/protocol-run + GET /api/v1/health) and centralize them in
 *   `pathFor()` so that, when the real surface is confirmed, only one place
 *   needs to change. Path overrides may later flow through config without
 *   touching adapter logic.
 *
 * Auth lifecycle:
 *   - apiKey path: every request includes `X-Api-Key: <key>`. No refresh.
 *   - basic-auth path: every request includes `Authorization: Basic <b64>`.
 *     No refresh, no session token.
 *   - dispose() is a no-op for HTTP cleanup (no session to tear down).
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "./types.js";

export interface TrilobioConfig {
  /** Fleet controller URL, e.g. "http://192.168.1.50" (no trailing slash) */
  url: string;
  /** Trilobio fleet-controller API key (preferred) */
  apiKey?: string;
  /** Basic-auth fallback username */
  username?: string;
  /** Basic-auth fallback password */
  password?: string;
  /** Kernel ID this device belongs to */
  kernelId: string;
  /** Pinned tcode-api version (informational; surfaces in evidence) */
  tcodeApiVersion?: string;
  /** Poll interval (ms) for run status — default 3000 */
  pollIntervalMs?: number;
  /** Maximum allowed wall-clock seconds for a single tcode script — default 3600 */
  maxScriptTimeoutSec?: number;
  /** Skip all real HTTP — use scripted mock state for tests/demos */
  mockMode?: boolean;
  /** Mock-mode simulated run duration (ms) — default 2000 */
  mockRunDurationMs?: number;
  /**
   * Whether arbitrary operator-supplied tcode scripts are accepted.
   * Default false — only `payload.protocolId` (curated server-side protocol)
   * is honored. When true, `payload.script` may carry raw Python source.
   */
  allowArbitraryScripts?: boolean;
}

interface RunState {
  runId: string | null;
  status: "idle" | "running" | "completed" | "error" | "unknown";
  protocolId?: string;
  scriptHash?: string;
  startedAt?: string;
}

/**
 * Centralized HTTP path table. If the Trilobio surface diverges from these
 * Hamilton-mirrored paths, edit here only.
 */
const PATHS = {
  health: "/api/v1/health",
  systemReady: "/api/v1/system-ready",
  globalRunState: "/api/v1/instruments/global-run-state",
  protocolGet: (id: string) => `/api/v1/protocols/${encodeURIComponent(id)}`,
  protocolRunCreate: "/api/v1/protocol-run/create",
  protocolRunStatus: "/api/v1/protocol-run",
  protocolRunCancel: "/api/v1/protocol-run/cancel",
  scriptRun: "/api/v1/scripts/run",
  runEvents: (runId: string) => `/api/v1/protocol-run/${encodeURIComponent(runId)}/events`,
} as const;

export class TrilobioAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "liquid-handler" as const;
  readonly source: EvidenceSource;

  private config: TrilobioConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentRun: RunState = { runId: null, status: "idle" };
  private mockStatus: MachineStatus = "idle";
  private mockProgress = 0;

  constructor(id: string, config: TrilobioConfig) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "instrument",
      kernelId: config.kernelId,
      firmwareVersion: `Trilobio-Adapter-1.0.0/tcode-api@${config.tcodeApiVersion ?? "latest"}`,
    };
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return this.mockStatus;

    try {
      const ready = await this.apiGet(PATHS.systemReady);
      const runState = await this.apiGet(PATHS.globalRunState);
      return this.mapStatus(ready, runState);
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockProgress;

    try {
      const run = await this.apiGet(PATHS.protocolRunStatus);
      return this.estimateProgress(run);
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode) return this.executeMock(command);

    try {
      switch (command.type) {
        case "load_gcode": {
          // Trilobio: "select a protocol by ID" or "stage a script body".
          const payload = (command.payload ?? {}) as Record<string, unknown>;
          const protocolId = payload.protocolId as string | undefined;
          const script = payload.script as string | undefined;

          if (script !== undefined) {
            if (!this.config.allowArbitraryScripts) {
              return {
                success: false,
                message:
                  "Arbitrary tcode scripts are disabled on this device (allowArbitraryScripts=false). Pass payload.protocolId instead.",
              };
            }
            this.currentRun.scriptHash = await sha256Hex(script);
            this.currentRun.protocolId = undefined;
            this.emit({
              type: "gcode_received",
              timestamp: new Date().toISOString(),
              source: this.source,
              payload: {
                scriptHash: this.currentRun.scriptHash,
                scriptBytes: script.length,
                tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
              },
            });
            return { success: true, message: `Tcode script staged (sha256:${this.currentRun.scriptHash?.slice(0, 12)}…)` };
          }

          if (!protocolId) {
            return {
              success: false,
              message: "Trilobio requires payload.protocolId (or payload.script if allowArbitraryScripts=true)",
            };
          }

          // Best-effort fetch of protocol metadata for evidence enrichment.
          // Tolerate failures — the controller may not expose this endpoint.
          let protocolMeta: any = null;
          try {
            protocolMeta = await this.apiGet(PATHS.protocolGet(protocolId));
          } catch {
            // protocol metadata is optional context; not a failure
          }

          this.currentRun.protocolId = protocolId;
          this.currentRun.scriptHash = undefined;
          this.emit({
            type: "gcode_received",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              protocolId,
              protocolName: protocolMeta?.name ?? null,
              tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
            },
          });
          return { success: true, message: `Protocol ${protocolId} selected` };
        }

        case "start": {
          const payload = (command.payload ?? {}) as Record<string, unknown>;

          // Two start paths: scriptRun for arbitrary scripts, protocolRunCreate
          // for curated protocols. Hash routes selection.
          const useScriptPath =
            this.currentRun.scriptHash !== undefined ||
            (this.config.allowArbitraryScripts && typeof payload.script === "string");

          let res: any;
          if (useScriptPath) {
            const script = (payload.script as string | undefined) ?? null;
            const body: Record<string, unknown> = {
              tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
              maxTimeoutSec: this.config.maxScriptTimeoutSec ?? 3600,
            };
            if (script !== null) body.script = script;
            if (this.currentRun.scriptHash) body.scriptHash = this.currentRun.scriptHash;
            if (payload.parameters) body.parameters = payload.parameters;

            res = await this.apiPost(PATHS.scriptRun, body);
          } else {
            const body: Record<string, unknown> = {
              protocolId: this.currentRun.protocolId ?? payload.protocolId,
              maxTimeoutSec: this.config.maxScriptTimeoutSec ?? 3600,
            };
            if (payload.parameters) body.parameters = payload.parameters;

            res = await this.apiPost(PATHS.protocolRunCreate, body);
          }

          this.currentRun.runId =
            (res?.runId as string | undefined) ?? (res?.id as string | undefined) ?? null;
          this.currentRun.status = "running";
          this.currentRun.startedAt = new Date().toISOString();
          this.startPolling();
          this.emit({
            type: "execution_started",
            timestamp: this.currentRun.startedAt,
            source: this.source,
            payload: {
              runId: this.currentRun.runId,
              protocolId: this.currentRun.protocolId,
              scriptHash: this.currentRun.scriptHash,
              tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
            },
          });
          return {
            success: true,
            message: `Run ${this.currentRun.runId ?? "(unknown id)"} started`,
          };
        }

        case "status": {
          const ready = await this.apiGet(PATHS.systemReady);
          const runState = await this.apiGet(PATHS.globalRunState);
          const run = await this.apiGet(PATHS.protocolRunStatus);
          return {
            success: true,
            data: {
              ready,
              globalRunState: runState,
              currentRun: run,
              tracked: { ...this.currentRun },
            },
          };
        }

        case "stop": {
          // Best-effort cancel; surface non-2xx honestly.
          try {
            await this.apiPost(PATHS.protocolRunCancel, { runId: this.currentRun.runId });
            this.stopPolling();
            this.currentRun.status = "idle";
            return { success: true, message: `Run ${this.currentRun.runId ?? "(unknown id)"} cancelled` };
          } catch (err) {
            return {
              success: false,
              message:
                err instanceof Error
                  ? `Trilobio cancel failed: ${err.message}`
                  : "Trilobio cancel failed",
            };
          }
        }

        case "pause":
        case "resume":
        default:
          return {
            success: false,
            message: `${command.type} not supported on Trilobio via tcode-api`,
          };
      }
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Trilobio API error",
      };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopPolling();
    // No HTTP session to clean up (apiKey/basic-auth are stateless).
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // Run-data helpers (consumed by the kernel evidence pipeline)
  // ---------------------------------------------------------------------------

  /**
   * Fetch the full event log for a run as structured JSON. Tolerates
   * non-JSON responses by returning null (some controller versions emit
   * NDJSON or plain-text logs which the caller can request separately).
   */
  async getRunEvents(runId: string): Promise<unknown[] | null> {
    if (this.config.mockMode) return null;
    try {
      const res = await this.apiGet(PATHS.runEvents(runId));
      if (Array.isArray(res)) return res;
      if (Array.isArray(res?.events)) return res.events;
      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /** Build the auth headers for the configured auth mode. */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers["X-Api-Key"] = this.config.apiKey;
    } else if (this.config.username && this.config.password) {
      const b64 = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
      headers["Authorization"] = `Basic ${b64}`;
    }
    return headers;
  }

  private async apiGet(path: string): Promise<any> {
    const res = await fetch(`${this.config.url}${path}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`Trilobio GET ${path}: ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? res.json() : res.text();
  }

  private async apiPost(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.config.url}${path}`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Trilobio POST ${path}: ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? res.json() : res.text();
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private startPolling(): void {
    this.stopPolling();
    const interval = this.config.pollIntervalMs ?? 3000;

    this.pollTimer = setInterval(async () => {
      try {
        const run = await this.apiGet(PATHS.protocolRunStatus);
        await this.handleRunUpdate(run);
      } catch {
        // tolerate transient failures; next tick will retry
      }
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async handleRunUpdate(run: any): Promise<void> {
    const statusStr = String(run?.status ?? run?.state ?? "").toLowerCase();
    const isDone =
      statusStr.includes("complete") || statusStr.includes("finished") || statusStr.includes("success");
    const isError = statusStr.includes("error") || statusStr.includes("fail");

    if (isDone && this.currentRun.status === "running") {
      this.currentRun.status = "completed";

      // Best-effort evidence enrichment: pull the event log and any
      // calibration deltas the controller surfaces alongside the run record.
      let eventLog: unknown[] | null = null;
      if (this.currentRun.runId) {
        eventLog = await this.getRunEvents(this.currentRun.runId);
      }

      this.emit({
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          runId: this.currentRun.runId,
          protocolId: this.currentRun.protocolId,
          scriptHash: this.currentRun.scriptHash,
          startedAt: this.currentRun.startedAt,
          finishedAt: run?.finishedAt ?? run?.endedAt ?? null,
          eventCount: eventLog?.length ?? null,
          calibrationDeltas: run?.calibrationDeltas ?? null,
          sensorSummary: run?.sensorSummary ?? null,
          tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
        },
      });
      this.stopPolling();
    } else if (isError && this.currentRun.status === "running") {
      this.currentRun.status = "error";
      this.emit({
        type: "execution_failed",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          runId: this.currentRun.runId,
          error: run?.error ?? run?.message ?? statusStr,
        },
      });
      this.stopPolling();
    }
  }

  private mapStatus(ready: any, runState: any): MachineStatus {
    const readyVal = ready?.systemReady ?? ready?.ready ?? ready;
    if (readyVal === false || readyVal === "false") return "offline";

    const stateStr = String(runState?.state ?? runState?.value ?? "").toLowerCase();
    if (stateStr.includes("run") || stateStr.includes("busy")) return "busy";
    if (stateStr.includes("error")) return "error";
    if (stateStr.includes("maintenance")) return "maintenance";
    return "idle";
  }

  private estimateProgress(run: any): number {
    const startedAt = run?.startedAt ?? this.currentRun.startedAt;
    const expectedDurationMs = run?.expectedDurationMs ?? null;
    if (!startedAt || !expectedDurationMs) return 0;
    const elapsedMs = Date.now() - new Date(startedAt).getTime();
    return Math.max(0, Math.min(99, Math.floor((elapsedMs / Number(expectedDurationMs)) * 100)));
  }

  // ---------------------------------------------------------------------------
  // Mock mode
  // ---------------------------------------------------------------------------

  private async executeMock(command: MachineCommand): Promise<MachineCommandResult> {
    switch (command.type) {
      case "load_gcode": {
        const payload = (command.payload ?? {}) as Record<string, unknown>;
        const protocolId = payload.protocolId as string | undefined;
        const script = payload.script as string | undefined;

        if (script !== undefined) {
          if (!this.config.allowArbitraryScripts) {
            return {
              success: false,
              message:
                "Arbitrary tcode scripts are disabled on this device (allowArbitraryScripts=false).",
            };
          }
          this.currentRun.scriptHash = await sha256Hex(script);
          this.currentRun.protocolId = undefined;
          this.emit({
            type: "gcode_received",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              scriptHash: this.currentRun.scriptHash,
              scriptBytes: script.length,
              mock: true,
              tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
            },
          });
          return { success: true, message: "Tcode script staged (mock)" };
        }

        this.currentRun.protocolId = protocolId ?? "mock-protocol";
        this.currentRun.scriptHash = undefined;
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {
            protocolId: this.currentRun.protocolId,
            mock: true,
            tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
          },
        });
        return { success: true, message: "Protocol selected (mock)" };
      }

      case "start": {
        this.mockStatus = "busy";
        this.mockProgress = 0;
        this.currentRun.runId = `mock-run-${Date.now()}`;
        this.currentRun.status = "running";
        this.currentRun.startedAt = new Date().toISOString();
        this.emit({
          type: "execution_started",
          timestamp: this.currentRun.startedAt,
          source: this.source,
          payload: {
            runId: this.currentRun.runId,
            protocolId: this.currentRun.protocolId,
            scriptHash: this.currentRun.scriptHash,
            mock: true,
            tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
          },
        });

        const dur = this.config.mockRunDurationMs ?? 2000;
        setTimeout(() => {
          this.mockStatus = "idle";
          this.mockProgress = 100;
          this.currentRun.status = "completed";
          this.emit({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              runId: this.currentRun.runId,
              protocolId: this.currentRun.protocolId,
              scriptHash: this.currentRun.scriptHash,
              startedAt: this.currentRun.startedAt,
              finishedAt: new Date().toISOString(),
              eventCount: 0,
              calibrationDeltas: null,
              sensorSummary: { mock: true },
              mock: true,
              tcodeApiVersion: this.config.tcodeApiVersion ?? "latest",
            },
          });
        }, dur);
        return { success: true, message: `Run ${this.currentRun.runId} started (mock)` };
      }

      case "stop":
        this.mockStatus = "idle";
        this.currentRun.status = "idle";
        return {
          success: true,
          message: `Run ${this.currentRun.runId ?? "(none)"} cancelled (mock)`,
        };

      case "status":
        return {
          success: true,
          data: {
            mock: true,
            status: this.mockStatus,
            progress: this.mockProgress,
            tracked: { ...this.currentRun },
          },
        };

      default:
        return { success: true, message: `${command.type} (mock)` };
    }
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Hash a tcode script body to sha256-hex for evidence enrichment.
 * Uses the Web Crypto API which is available in modern Node and the browser.
 */
async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
