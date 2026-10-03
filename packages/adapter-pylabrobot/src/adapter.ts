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
import { OutstandingWork } from "./outstanding-work.js";
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
  /**
   * What can still emit for work given: each command and status call in flight (a start
   * runs the whole protocol; any call may initialise the sidecar and emit device_birth),
   * and each mock completion not yet emitted.
   */
  private readonly work = new OutstandingWork();

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

  getStatus(): Promise<MachineStatus> {
    return this.work.track(this.readStatus());
  }

  private async readStatus(): Promise<MachineStatus> {
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

  execute(command: MachineCommand): Promise<MachineCommandResult> {
    return this.work.track(this.executeCommand(command));
  }

  private async executeCommand(command: MachineCommand): Promise<MachineCommandResult> {
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

  /**
   * Resolves once no command or status call is in flight and every mock completion has
   * been emitted; at once when none is. A real run is one `start` call, which returns only
   * after the sidecar has answered evidence.stopRecording. The sidecar sends that answer
   * only after writing every notification it scheduled for the job (a barrier, astra pack
   * 186), so each one has been forwarded by then. A barrier that fails (an error, the 5 s
   * timeout) proves nothing: the run fails, with no execution_completed, and the sidecar is
   * stopped before `start` returns, so nothing of the job can arrive after this resolves
   * (astra pack 191). A notification of a job that is not recording now is late, and is
   * dropped, never forwarded; so is anything a stopped sidecar still sends. What the
   * sidecar sends bound to no job (a notification outside any recording window) is not
   * work this adapter was given, and this does not wait for it.
   */
  quiesceEvidence(): Promise<void> {
    return this.work.idle();
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
      // The run's notifications can still be on their way: the barrier first, so each has
      // reached the collector before it emits execution_completed and stops.
      const barrier = await this.sidecarBarrier(jobId);
      if (barrier !== null) {
        // Nothing proves the job's evidence complete: the run fails, with no execution_completed,
        // and the sidecar is stopped before start returns (astra pack 191).
        return await this.failRun(collector, jobId, `evidence barrier failed: ${barrier}`, undefined, true);
      }
      const bufferedEvents = collector.stopRecording(jobId, {
        opCount: result.opCount,
        durationMs: result.durationMs,
        summary: result.summary,
      });
      this.currentCollector = null;
      this.currentJobId = null;
      this.pendingProtocol = {};
      // Recycled only after the barrier, which the old sidecar must answer.
      this.completedJobs += 1;
      if (this.completedJobs >= (this.config.restartAfterJobs ?? 100)) {
        await this.recycleSidecar();
      }
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
      const barrier = await this.sidecarBarrier(jobId);
      return await this.failRun(
        collector,
        jobId,
        barrier === null ? reason : `${reason}; evidence barrier failed: ${barrier}`,
        err,
        barrier !== null,
      );
    }
  }

  /**
   * Fail the job's recording (execution_failed) and end the job. When its barrier failed, the
   * sidecar is stopped too, before this returns, so it can send nothing more of the job.
   */
  private async failRun(
    collector: EvidenceCollector,
    jobId: string,
    reason: string,
    err: unknown,
    stopSidecar: boolean,
  ): Promise<MachineCommandResult> {
    collector.failRecording(jobId, reason, {
      rpcCode: err instanceof SidecarError ? err.code : undefined,
      rpcData: err instanceof SidecarError ? err.data : undefined,
    });
    this.currentCollector = null;
    this.currentJobId = null;
    this.pendingProtocol = {};
    if (stopSidecar) await this.recycleSidecar();
    return {
      success: false,
      message: reason,
      data: err instanceof SidecarError ? { code: err.code, data: err.data ?? null } : undefined,
    };
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
        const endRun = this.work.begin();
        setTimeout(() => {
          this.mockStatus = "idle";
          this.forwardEvent({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { mock: true, jobId, opCount: 5, durationMs: 1 },
          });
          this.emit("mock_run_complete", { jobId });
          // Ended only after the completion is emitted.
          endRun();
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
      // Bound to this sidecar: once it is replaced or stopped (recycleSidecar detaches it
      // first), nothing it still sends reaches the adapter.
      const client = this.sidecar;
      client.on("crash", () => {
        if (client !== this.sidecar) return;
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
      client.onNotification(RPC_NOTIFICATIONS.EVIDENCE, (params) => {
        if (client !== this.sidecar) return;
        this.handleEvidenceNotification(params as unknown as EvidenceNotificationParams);
      });
      client.on("stderr", (msg: string) => {
        if (client !== this.sidecar || !this.currentCollector || !msg.trim()) return;
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
    const old = this.sidecar;
    if (!old) return;
    // Detached first: the handlers ignore a sidecar that is no longer this.sidecar, so nothing
    // it still sends (a buffered line, the "crash" its own stop emits) reaches the adapter.
    this.sidecar = null;
    this.initialized = false;
    this.sidecarHandlersWired = false;
    try {
      await old.call(RPC_METHODS.BACKEND_SHUTDOWN, { deviceId: this.id }, 5_000);
    } catch {
      // tolerate
    }
    try {
      await old.stop();
    } catch {
      // tolerate
    }
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

  /**
   * Close the sidecar's recording window, a barrier: the sidecar answers only after writing
   * every notification it scheduled for the job. Null once it has answered; otherwise why it
   * did not (an error, the 5 s timeout, no sidecar). A barrier that fails proves nothing about
   * what is still on its way, so the caller fails the run and stops the sidecar.
   */
  private async sidecarBarrier(jobId: string): Promise<string | null> {
    if (!this.sidecar) return "no sidecar to answer evidence.stopRecording";
    try {
      await this.sidecar.call(
        RPC_METHODS.EVIDENCE_STOP_RECORDING,
        { deviceId: this.id, jobId },
        5_000,
      );
      return null;
    } catch (err) {
      return `evidence.stopRecording did not answer: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private handleEvidenceNotification(params: EvidenceNotificationParams): void {
    // A notification bound to a job other than the one recording now is late: that job's
    // window is closed, and its hook may have answered. Forwarded, it would be recorded
    // under whichever job holds the device now, so it is dropped (astra pack 186).
    if (params.jobId != null && params.jobId !== this.currentJobId) {
      console.warn(
        `[pylabrobot-adapter] ${this.id}: dropped a late ${params.type} notification of job ${String(params.jobId)}: that job is not recording`,
      );
      return;
    }
    if (this.currentCollector) {
      this.currentCollector.ingestSidecarNotification(params);
      return;
    }
    // Outside a recording window, and bound to no job — still forward the event, flagged
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
