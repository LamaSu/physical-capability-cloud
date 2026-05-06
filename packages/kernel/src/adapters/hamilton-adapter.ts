/**
 * Hamilton ML Prep adapter.
 *
 * Talks to a Hamilton Microlab Prep (or compatible Hamilton instrument) via
 * its LAN-resident REST API at `http://{prep_ip}/api/v1/...`. JWT bearer
 * auth with a renew-token refresh path.
 *
 * Hamilton API docs: https://developer.hamiltoncompany.com/products/prep/api/openapi
 *
 * Design parity with `octoprint-adapter.ts`:
 *   - LAN endpoint + credentials
 *   - Async run model (POST /protocol-run/create, then poll /protocol-run)
 *   - Mock mode for CI / dev / demos with no real device
 *
 * Hamilton specifics:
 *   - Two-step submit: select protocol via `load_gcode` → start via `start`.
 *     The MachineCommand union is gcode-centric; we re-use `load_gcode` to
 *     mean "select the protocol identified in payload.protocolId".
 *   - The `stop` command is intentionally not API-driven. Hamilton runs are
 *     cancelled at the touchscreen UI on the instrument; the public REST
 *     surface does not expose a clean abort. We surface this honestly via a
 *     failed `MachineCommandResult`.
 *   - Run completion exposes a `runDataId`; PDF + pipetting CSV artifacts
 *     are downloaded via dedicated helpers (`getRunDataPdf`,
 *     `getRunDataCsv`) so the kernel's evidence emitter can fold them into
 *     the bundle.
 *
 * Auth lifecycle:
 *   1. First call: POST /api/v1/authenticate with {username, password}
 *   2. Token stored with absolute expiry
 *   3. Subsequent calls auto-refresh via POST /authenticate/renew-token
 *      when within `refreshLeadSeconds` of expiry
 *   4. dispose() best-effort DELETE /api/v1/authenticate to log out
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { MachineAdapter, MachineCommand, MachineCommandResult, MachineStatus } from "./types.js";

export interface HamiltonConfig {
  /** Instrument URL, e.g. "http://192.168.1.50" (no trailing slash) */
  url: string;
  /** Hamilton account username */
  username: string;
  /** Hamilton account password */
  password: string;
  /** Kernel ID this instrument belongs to */
  kernelId: string;
  /** Poll interval (ms) for run status — default 3000 */
  pollIntervalMs?: number;
  /** Skip all real HTTP — use scripted mock state for tests/demos */
  mockMode?: boolean;
  /** Refresh JWT this many seconds before expiry — default 60 */
  refreshLeadSeconds?: number;
  /** Mock-mode simulated run duration (ms) — default 2000 */
  mockRunDurationMs?: number;
}

interface HamiltonAuth {
  token: string;
  expiresAt: number;
  userId: string;
  userName: string;
}

interface RunState {
  runId: string | null;
  status: "idle" | "running" | "completed" | "error" | "unknown";
  protocolId?: string;
  startedAt?: string;
  runDataId?: string;
}

export class HamiltonAdapter implements MachineAdapter {
  readonly id: string;
  readonly type = "liquid-handler" as const;
  readonly source: EvidenceSource;

  private config: HamiltonConfig;
  private auth: HamiltonAuth | null = null;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentRun: RunState = { runId: null, status: "idle" };
  private mockStatus: MachineStatus = "idle";
  private mockProgress = 0;

  constructor(id: string, config: HamiltonConfig) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "instrument",
      kernelId: config.kernelId,
      firmwareVersion: "Hamilton-MLPrep-Adapter-1.0.0",
    };
  }

  async getStatus(): Promise<MachineStatus> {
    if (this.config.mockMode) return this.mockStatus;

    try {
      await this.ensureAuth();
      const ready = await this.apiGet("/api/v1/system-ready");
      const runState = await this.apiGet("/api/v1/instruments/global-run-state");
      return this.mapStatus(ready, runState);
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockProgress;

    try {
      await this.ensureAuth();
      const run = await this.apiGet("/api/v1/protocol-run");
      return this.estimateProgress(run);
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.config.mockMode) return this.executeMock(command);

    try {
      await this.ensureAuth();

      switch (command.type) {
        case "load_gcode": {
          // Hamilton: "select a protocol by ID". We piggyback on load_gcode.
          const protocolId = command.payload?.protocolId as string | undefined;
          if (!protocolId) {
            return { success: false, message: "Hamilton requires payload.protocolId" };
          }
          const protocol = await this.apiGet(`/api/v1/protocols/${protocolId}`);
          this.currentRun.protocolId = protocolId;
          this.emit({
            type: "gcode_received",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              protocolId,
              protocolName: protocol?.name ?? null,
            },
          });
          return { success: true, message: `Protocol ${protocolId} selected` };
        }

        case "start": {
          const payload = (command.payload ?? {}) as Record<string, unknown>;
          const body: Record<string, unknown> = {
            protocolId: this.currentRun.protocolId ?? payload.protocolId,
          };
          if (payload.parameters) body.parameters = payload.parameters;

          const res = await this.apiPost("/api/v1/protocol-run/create", body);
          this.currentRun.runId = (res?.runId as string | undefined) ?? (res?.id as string | undefined) ?? null;
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
            },
          });
          return { success: true, message: `Run ${this.currentRun.runId ?? "(unknown id)"} started` };
        }

        case "status": {
          const ready = await this.apiGet("/api/v1/system-ready");
          const runState = await this.apiGet("/api/v1/instruments/global-run-state");
          const run = await this.apiGet("/api/v1/protocol-run");
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
          // Hamilton's documented public API does not expose a clean abort
          // (rtsa is real-time analytics, not cancel). Operators use the
          // touchscreen UI. We surface this honestly rather than pretend.
          return {
            success: false,
            message: "Hamilton stop is not API-driven. Cancel from the instrument UI.",
          };
        }

        case "pause":
        case "resume":
        default:
          return { success: false, message: `${command.type} not supported on Hamilton via API` };
      }
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : "Hamilton API error",
      };
    }
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.stopPolling();
    if (this.auth && !this.config.mockMode) {
      try {
        await fetch(`${this.config.url}/api/v1/authenticate`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.auth.token}` },
        });
      } catch {
        // best-effort logout
      }
    }
    this.auth = null;
    this.listeners = [];
  }

  // ---------------------------------------------------------------------------
  // Run-data + camera helpers (consumed by the kernel evidence pipeline)
  // ---------------------------------------------------------------------------

  /** Fetch run-data PDF artifact (base64) for tier-2 evidence bundling. */
  async getRunDataPdf(runDataId: string): Promise<string | null> {
    if (this.config.mockMode) return null;
    try {
      await this.ensureAuth();
      const res = await fetch(`${this.config.url}/api/v1/run-data/${runDataId}/pdf`, {
        headers: { Authorization: `Bearer ${this.auth!.token}` },
      });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return Buffer.from(buf).toString("base64");
    } catch {
      return null;
    }
  }

  /** Fetch the full pipetting CSV for a run as a UTF-8 string. */
  async getRunDataCsv(runDataId: string): Promise<string | null> {
    if (this.config.mockMode) return null;
    try {
      await this.ensureAuth();
      const res = await fetch(`${this.config.url}/api/v1/run-data/${runDataId}/pipetting-csv`, {
        headers: { Authorization: `Bearer ${this.auth!.token}` },
      });
      if (!res.ok) return null;
      return res.text();
    } catch {
      return null;
    }
  }

  /** Capture a snapshot from the instrument's built-in camera (base64 PNG). */
  async captureCameraSnapshot(rectify = false): Promise<string | null> {
    if (this.config.mockMode) return null;
    try {
      await this.ensureAuth();
      const res = await fetch(`${this.config.url}/api/v1/camera/${rectify}`, {
        headers: { Authorization: `Bearer ${this.auth!.token}` },
      });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return Buffer.from(buf).toString("base64");
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  private async ensureAuth(): Promise<void> {
    const refreshLeadMs = (this.config.refreshLeadSeconds ?? 60) * 1000;
    const now = Date.now();

    if (this.auth && this.auth.expiresAt - now > refreshLeadMs) {
      return; // current token still has plenty of life
    }

    // If we have a valid-but-near-expiry token, try the renew path first.
    if (this.auth && this.auth.expiresAt > now) {
      try {
        const res = await fetch(`${this.config.url}/api/v1/authenticate/renew-token`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.auth.token}` },
        });
        if (res.ok) {
          const json = (await res.json()) as Record<string, unknown>;
          this.auth = {
            token: String(json.token),
            expiresAt: Date.now() + (Number(json.expiresIn ?? 60)) * 60 * 1000,
            userId: this.auth.userId,
            userName: this.auth.userName,
          };
          return;
        }
      } catch {
        // fall through to fresh login
      }
    }

    // Fresh login
    const res = await fetch(`${this.config.url}/api/v1/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    });
    if (!res.ok) throw new Error(`Hamilton auth failed: ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    this.auth = {
      token: String(json.token),
      expiresAt: Date.now() + Number(json.expiresIn ?? 60) * 60 * 1000,
      userId: String(json.userId ?? ""),
      userName: String(json.userName ?? this.config.username),
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  private async apiGet(path: string): Promise<any> {
    if (!this.auth) throw new Error("Hamilton: not authenticated");
    const res = await fetch(`${this.config.url}${path}`, {
      headers: { Authorization: `Bearer ${this.auth.token}` },
    });
    if (!res.ok) throw new Error(`Hamilton GET ${path}: ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? res.json() : res.text();
  }

  private async apiPost(path: string, body: unknown): Promise<any> {
    if (!this.auth) throw new Error("Hamilton: not authenticated");
    const res = await fetch(`${this.config.url}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.auth.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Hamilton POST ${path}: ${res.status}`);
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
        await this.ensureAuth();
        const run = await this.apiGet("/api/v1/protocol-run");
        this.handleRunUpdate(run);
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

  private handleRunUpdate(run: any): void {
    const statusStr = String(run?.status ?? run?.state ?? "").toLowerCase();
    const isDone =
      statusStr.includes("complete") || statusStr.includes("finished") || statusStr.includes("success");
    const isError = statusStr.includes("error") || statusStr.includes("fail");

    if (isDone && this.currentRun.status === "running") {
      this.currentRun.status = "completed";
      this.currentRun.runDataId = (run?.runDataId as string | undefined) ?? (run?.id as string | undefined);
      this.emit({
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          runId: this.currentRun.runId,
          runDataId: this.currentRun.runDataId,
          protocolId: this.currentRun.protocolId,
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

  private executeMock(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "load_gcode": {
        this.currentRun.protocolId =
          (command.payload?.protocolId as string | undefined) ?? "mock-protocol";
        this.emit({
          type: "gcode_received",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { protocolId: this.currentRun.protocolId, mock: true },
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
          payload: { runId: this.currentRun.runId, mock: true },
        });

        const dur = this.config.mockRunDurationMs ?? 2000;
        setTimeout(() => {
          this.mockStatus = "idle";
          this.mockProgress = 100;
          this.currentRun.status = "completed";
          this.currentRun.runDataId = `mock-run-data-${Date.now()}`;
          this.emit({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              runId: this.currentRun.runId,
              runDataId: this.currentRun.runDataId,
              protocolId: this.currentRun.protocolId,
              mock: true,
            },
          });
        }, dur);
        return { success: true, message: `Run ${this.currentRun.runId} started (mock)` };
      }

      case "stop":
        return {
          success: false,
          message: "Hamilton stop is not API-driven (mock parity with real device)",
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
