/**
 * PyLabRobotAdapter — PCC MachineAdapter that bridges to any PyLabRobot
 * backend via a long-running Python sidecar.
 *
 * Design parity with `HamiltonAdapter` (packages/kernel/src/adapters/
 * hamilton-adapter.ts):
 *   - Async run model: `execute({type: "start", ...})` kicks the run; final
 *     completion + atomic-op events arrive on the evidence channel.
 *   - Mock mode = ChatterboxBackend in the sidecar (or fully synthetic
 *     replies if `mockMode: true` is set — the sidecar never spawns).
 *   - Honest failure modes: pause/resume reflect the sidecar's per-backend
 *     support; `stop` rejects on backends that don't expose abort cleanly.
 *
 * RPC contract: see `./protocol.ts`. The sidecar must implement at minimum
 *   backend.init / backend.run / backend.status / backend.shutdown
 * and push evidence notifications during a `backend.run`.
 */

import { EventEmitter } from "node:events";

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

import { EvidenceCollector, type CameraHook, type SensorHook } from "./evidence.js";
import {
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_NOTIFICATIONS,
  type BackendInitParams,
  type BackendInitResult,
  type BackendRunParams,
  type BackendRunResult,
  type BackendStatusResult,
  type EvidenceNotificationParams,
} from "./protocol.js";
import {
  SidecarClient,
  SidecarError,
  type SidecarClientConfig,
} from "./sidecar-client.js";
import type {
  EvidenceCallback,
  MachineAdapter,
  MachineCommand,
  MachineCommandResult,
  MachineStatus,
} from "./types.js";

/** Supported PLR backends in Phase 1 (extended in Phases 2-4) */
export type PlrBackend =
  | "ot2"
  | "chatterbox"
  | "flex"
  | "star"
  | "vantage"
  | "evo"
  | "clariostar"
  | "cytation5"
  | "vspin"
  | "hamilton-hhs"
  | "inheco-thermoshake"
  | "cytomat-2"
  | "cytomat-6"
  | "inheco-odtc"
  | "liconic-stx"
  | (string & {});

export interface PyLabRobotConfig {
  /** Unique device id on this kernel */
  deviceId: string;
  /** Kernel id this device belongs to */
  kernelId: string;
  /** Which PLR backend to use */
  plrBackend: PlrBackend;
  /** Per-backend adapter config (URL, credentials, deck file path, …) */
  backendConfig: Record<string, unknown>;
  /**
   * Override the PCC MachineAdapter `type` (default "liquid-handler" —
   * fine for OT-2/Flex/STAR/Vantage/EVO. Use "plate-reader", "centrifuge",
   * etc. for Phase 3+ profiles).
   */
  machineType?: string;
  /** Skip subprocess + use synthetic responses (CI / development mode) */
  mockMode?: boolean;
  /** How long per-RPC calls may take (ms). Defaults are method-specific. */
  rpcTimeoutMs?: number;
  /** How long a full protocol run may take (ms). Default 1 hour. */
  runTimeoutMs?: number;
  /** Recycle the sidecar after this many completed jobs (default 100). */
  restartAfterJobs?: number;
  /** Inject a pre-built sidecar (tests + DI). */
  sidecar?: SidecarClient;
  /** Sidecar client config — env, cwd, python path. Ignored if `sidecar` provided. */
  sidecarConfig?: SidecarClientConfig;
  /** Optional camera hook for Tier-2+ photographic evidence */
  camera?: CameraHook;
  /** Optional sensor hooks for Tier-2+ gravimetric / pressure / temperature */
  sensors?: SensorHook[];
}

/**
 * `PyLabRobotAdapter` — implements PCC's `MachineAdapter` shape and
 * delegates execution to a Python sidecar over JSON-RPC 2.0 stdio.
 */
export class PyLabRobotAdapter extends EventEmitter implements MachineAdapter {
  readonly id: string;
  readonly type: string;
  readonly source: EvidenceSource;

  private readonly config: PyLabRobotConfig;
  private sidecar: SidecarClient | null;
  private evidenceListeners: EvidenceCallback[] = [];
  private currentCollector: EvidenceCollector | null = null;
  private currentJobId: string | null = null;
  private mockStatus: MachineStatus = "idle";
  private completedJobs = 0;
  /** Lazy-init guard so we only initialise the sidecar+backend once */
  private initialized = false;
  private disposed = false;
  /** Have we wired crash/notification/stderr handlers to the current sidecar? */
  private sidecarHandlersWired = false;

  constructor(config: PyLabRobotConfig) {
    super();
    this.id = config.deviceId;
    this.type = config.machineType ?? "liquid-handler";
    this.config = config;
    this.source = {
      deviceId: config.deviceId,
      deviceType: "instrument",
      kernelId: config.kernelId,
      firmwareVersion: `PyLabRobotAdapter-0.1.0/${config.plrBackend}`,
    };
    this.sidecar = config.sidecar ?? null;
  }

  // ── MachineAdapter ─────────────────────────────────────────────────────

  async getStatus(): Promise<MachineStatus> {
    if (this.disposed) return "offline";
    if (this.config.mockMode) return this.mockStatus;
    try {
      await this.ensureInitialized();
      const res = await this.sidecar!.call<BackendStatusResult>(
        RPC_METHODS.BACKEND_STATUS,
        { deviceId: this.id },
        this.config.rpcTimeoutMs ?? 5_000,
      );
      return this.mapPlrStatus(res.status);
    } catch {
      return "offline";
    }
  }

  async getProgress(): Promise<number> {
    if (this.config.mockMode) return this.mockStatus === "busy" ? 50 : 0;
    if (this.disposed || !this.sidecar) return 0;
    try {
      const res = await this.sidecar.call<BackendStatusResult>(
        RPC_METHODS.BACKEND_STATUS,
        { deviceId: this.id },
        this.config.rpcTimeoutMs ?? 5_000,
      );
      const progress = res.progress ?? 0;
      return Math.max(0, Math.min(100, Math.floor(progress * 100)));
    } catch {
      return 0;
    }
  }

  async execute(command: MachineCommand): Promise<MachineCommandResult> {
    if (this.disposed) {
      return { success: false, message: "adapter disposed" };
    }
    if (this.config.mockMode) {
      return this.executeMock(command);
    }
    // load_gcode is metadata-only — we stash protocol metadata on the
    // adapter without contacting the sidecar. The subsequent start()
    // triggers `ensureInitialized()` + `backend.init` + the actual run.
    if (command.type === "load_gcode") {
      return this.handleLoadGcode(command.payload);
    }
    try {
      await this.ensureInitialized();
      switch (command.type) {
        case "start":
          return await this.handleStart(command.payload);
        case "stop":
          return await this.handleStop();
        case "pause":
          return { success: false, message: "pause not implemented in Phase 1" };
        case "resume":
          return { success: false, message: "resume not implemented in Phase 1" };
        case "status": {
          const res = await this.sidecar!.call<BackendStatusResult>(
            RPC_METHODS.BACKEND_STATUS,
            { deviceId: this.id },
          );
          return { success: true, data: res as unknown as Record<string, unknown> };
        }
        default:
          return { success: false, message: `unknown command: ${(command as MachineCommand).type}` };
      }
    } catch (err) {
      if (err instanceof SidecarError) {
        return { success: false, message: `${err.code}: ${err.message}` };
      }
      return {
        success: false,
        message: err instanceof Error ? err.message : "PyLabRobot adapter error",
      };
    }
  }

  onEvidence(callback: EvidenceCallback): void {
    this.evidenceListeners.push(callback);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sidecar) {
      try {
        await this.sidecar.call(
          RPC_METHODS.BACKEND_SHUTDOWN,
          { deviceId: this.id },
          5_000,
        );
      } catch {
        // best-effort
      }
      try {
        await this.sidecar.stop();
      } catch {
        // ignore
      }
    }
    this.evidenceListeners = [];
    this.currentCollector = null;
    this.sidecar = null;
  }

  // ── execute handlers ───────────────────────────────────────────────────

  private handleLoadGcode(payload: Record<string, unknown> | undefined): MachineCommandResult {
    // `load_gcode` is the kernel's "prepare an upcoming job" hook. For PLR
    // this is metadata-only: we stash the upcoming protocol payload + deck
    // layout on the adapter so the subsequent `start` knows what to send.
    this.pendingProtocol = (payload ?? {}) as Record<string, unknown>;
    this.emit("gcode_received", payload);
    this.forwardEvent({
      type: "method_loaded",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: { ...(payload ?? {}) },
    });
    return { success: true, message: "load_gcode buffered for next start" };
  }

  private pendingProtocol: Record<string, unknown> = {};

  private async handleStart(
    payload: Record<string, unknown> | undefined,
  ): Promise<MachineCommandResult> {
    const merged = { ...this.pendingProtocol, ...(payload ?? {}) };
    const jobId = String(merged.jobId ?? `job-${Date.now()}`);
    const collector = this.makeCollector();
    this.currentCollector = collector;
    this.currentJobId = jobId;
    collector.startRecording(jobId);
    try {
      await this.sidecar!.call(
        RPC_METHODS.EVIDENCE_START_RECORDING,
        { deviceId: this.id, jobId },
        5_000,
      );
    } catch {
      // tolerate — sidecar might not have a separate recording-channel
      // implementation in early versions
    }
    const runParams: BackendRunParams = {
      deviceId: this.id,
      jobId,
      protocolSource: (merged.protocolSource as BackendRunParams["protocolSource"]) ?? "inline-ops",
      protocolPayload: typeof merged.protocolPayload === "string" ? merged.protocolPayload : undefined,
      protocolInline: (merged.protocolInline as Record<string, unknown> | unknown[]) ?? undefined,
      params: (merged.params as Record<string, unknown>) ?? merged as Record<string, unknown>,
    };
    try {
      const result = await this.sidecar!.call<BackendRunResult>(
        RPC_METHODS.BACKEND_RUN,
        runParams as unknown as Record<string, unknown>,
        this.config.runTimeoutMs ?? 3_600_000,
      );
      const bufferedEvents = collector.stopRecording(jobId, {
        opCount: result.opCount,
        durationMs: result.durationMs,
        summary: result.summary,
      });
      this.completedJobs += 1;
      if (this.completedJobs >= (this.config.restartAfterJobs ?? 100)) {
        await this.recycleSidecar();
      }
      try {
        await this.sidecar?.call(
          RPC_METHODS.EVIDENCE_STOP_RECORDING,
          { deviceId: this.id, jobId },
          5_000,
        );
      } catch {
        // tolerate
      }
      this.currentCollector = null;
      this.currentJobId = null;
      this.pendingProtocol = {};
      return {
        success: true,
        message: `run complete — ${result.opCount} ops in ${result.durationMs}ms`,
        data: {
          jobId,
          opCount: result.opCount,
          durationMs: result.durationMs,
          bufferedEvents: bufferedEvents.length,
        },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      collector.failRecording(jobId, reason, {
        rpcCode: err instanceof SidecarError ? err.code : undefined,
        rpcData: err instanceof SidecarError ? err.data : undefined,
      });
      this.currentCollector = null;
      this.currentJobId = null;
      this.pendingProtocol = {};
      try {
        await this.sidecar?.call(
          RPC_METHODS.EVIDENCE_STOP_RECORDING,
          { deviceId: this.id, jobId },
          5_000,
        );
      } catch {
        // tolerate
      }
      return {
        success: false,
        message: reason,
        data: err instanceof SidecarError ? { code: err.code, data: err.data ?? null } : undefined,
      };
    }
  }

  private async handleStop(): Promise<MachineCommandResult> {
    // PLR's per-backend abort is not uniform. OT-2 + Flex expose
    // LiquidHandler.stop(). Hamilton STAR/Vantage do not (touchscreen
    // only — same posture HamiltonAdapter takes). The sidecar surfaces
    // -32004 NOT_SUPPORTED for those backends.
    try {
      await this.sidecar!.call(
        "backend.abort",
        { deviceId: this.id },
        10_000,
      );
      return { success: true, message: "aborted" };
    } catch (err) {
      if (err instanceof SidecarError && err.code === RPC_ERROR_CODES.NOT_SUPPORTED) {
        return {
          success: false,
          message: `abort not supported on ${this.config.plrBackend}; cancel at instrument UI`,
        };
      }
      return {
        success: false,
        message: err instanceof Error ? err.message : "abort failed",
      };
    }
  }

  // ── Mock mode ──────────────────────────────────────────────────────────

  private executeMock(command: MachineCommand): MachineCommandResult {
    switch (command.type) {
      case "load_gcode":
        this.pendingProtocol = (command.payload ?? {}) as Record<string, unknown>;
        this.forwardEvent({
          type: "method_loaded",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { mock: true, ...(command.payload ?? {}) },
        });
        return { success: true, message: "load_gcode (mock)" };
      case "start": {
        const jobId = String(((command.payload ?? {}) as Record<string, unknown>).jobId ?? `mock-job-${Date.now()}`);
        this.mockStatus = "busy";
        this.forwardEvent({
          type: "execution_started",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { mock: true, jobId },
        });
        // Emit 5 simulated atomic-op events
        for (let i = 0; i < 5; i++) {
          this.forwardEvent({
            type: "instrument_result",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: {
              mock: true,
              step: i,
              action: i % 2 === 0 ? "aspirate" : "dispense",
              volume_uL: 100,
            },
          });
        }
        setTimeout(() => {
          this.mockStatus = "idle";
          this.forwardEvent({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { mock: true, jobId, opCount: 5, durationMs: 1 },
          });
          this.emit("mock_run_complete", { jobId });
        }, 0);
        return { success: true, message: `mock run ${jobId} started` };
      }
      case "stop":
        this.mockStatus = "idle";
        return { success: true, message: "mock stop" };
      case "status":
        return {
          success: true,
          data: { mock: true, status: this.mockStatus, plrBackend: this.config.plrBackend },
        };
      case "pause":
      case "resume":
      default:
        return { success: true, message: `${command.type} (mock)` };
    }
  }

  // ── sidecar plumbing ───────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.disposed) {
      throw new SidecarError(RPC_ERROR_CODES.HARDWARE_UNREACHABLE, "adapter disposed");
    }
    if (this.initialized && this.sidecar?.isAlive()) return;
    if (!this.sidecar) {
      this.sidecar = new SidecarClient(this.config.sidecarConfig);
    }
    // Wire handlers exactly once per sidecar instance — covers both
    // "we constructed it" and "test injected an already-started one".
    if (!this.sidecarHandlersWired) {
      this.sidecar.on("crash", () => {
        this.initialized = false;
        this.forwardEvent({
          type: "execution_failed",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {
            reason: "sidecar crash; pending RPC invalidated",
            jobId: this.currentJobId ?? undefined,
          },
        });
      });
      this.sidecar.onNotification(RPC_NOTIFICATIONS.EVIDENCE, (params) => {
        this.handleEvidenceNotification(params as unknown as EvidenceNotificationParams);
      });
      this.sidecar.on("stderr", (msg: string) => {
        if (!this.currentCollector || !msg.trim()) return;
        this.currentCollector.emit({
          type: "process_log_summary",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: { stderr: msg.trim() },
        });
      });
      this.sidecarHandlersWired = true;
    }
    if (!this.sidecar.isAlive()) {
      await this.sidecar.start();
    }
    if (!this.initialized) {
      const initParams: BackendInitParams = {
        deviceId: this.id,
        plrBackend: this.config.plrBackend,
        backendConfig: this.config.backendConfig,
      };
      const result = await this.sidecar.call<BackendInitResult>(
        RPC_METHODS.BACKEND_INIT,
        initParams as unknown as Record<string, unknown>,
        this.config.rpcTimeoutMs ?? 30_000,
      );
      this.forwardEvent({
        type: "device_birth",
        timestamp: new Date().toISOString(),
        source: this.source,
        payload: {
          plrBackend: result.plrBackend,
          deckSnapshot: result.deckSnapshot ?? null,
        },
      });
      this.initialized = true;
      this.completedJobs = 0;
    }
  }

  private async recycleSidecar(): Promise<void> {
    if (!this.sidecar) return;
    try {
      await this.sidecar.call(RPC_METHODS.BACKEND_SHUTDOWN, { deviceId: this.id }, 5_000);
    } catch {
      // tolerate
    }
    try {
      await this.sidecar.stop();
    } catch {
      // tolerate
    }
    this.sidecar = null;
    this.initialized = false;
    this.sidecarHandlersWired = false;
  }

  private makeCollector(): EvidenceCollector {
    const collector = new EvidenceCollector({
      source: this.source,
      camera: this.config.camera,
      sensors: this.config.sensors,
    });
    collector.onEvidence((event) => {
      this.forwardEvent(event);
    });
    return collector;
  }

  private handleEvidenceNotification(params: EvidenceNotificationParams): void {
    if (this.currentCollector) {
      this.currentCollector.ingestSidecarNotification(params);
      return;
    }
    // Outside a recording window — still forward the event but with a flag
    this.forwardEvent({
      type: "instrument_result",
      timestamp: params.timestamp ?? new Date().toISOString(),
      source: this.source,
      payload: {
        ...params.payload,
        sidecarType: params.type,
        outsideRecordingWindow: true,
      },
    });
  }

  private forwardEvent(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const cb of this.evidenceListeners) {
      try {
        cb(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  private mapPlrStatus(plrStatus: string): MachineStatus {
    switch (plrStatus.toLowerCase()) {
      case "idle":
      case "ready":
      case "setup":
        return "idle";
      case "busy":
      case "running":
        return "busy";
      case "error":
      case "failed":
        return "error";
      case "offline":
      case "disconnected":
      case "shutdown":
        return "offline";
      case "maintenance":
      case "calibrating":
        return "maintenance";
      default:
        return "idle";
    }
  }
}
