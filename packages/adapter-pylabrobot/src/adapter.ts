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
  type EvidenceWindowAttestation,
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
/**
 * What a held adapter waits to see proven, by the sidecar process that recorded the job (its
 * generation): that the job's window is closed (an attested close), or, when the window's
 * opening was never confirmed (requireWindow false), that process's own word that it never
 * opened one.
 */
interface HoldSpec {
  jobId: string;
  generation: string;
  requireWindow: boolean;
}

const START_NEEDS_JOB_ID = "start needs the job's id (payload.jobId), so the run's evidence is bound to its job";

/** Lifecycle events are the adapter's own; the sidecar cannot send them (astra pack 194). */
const ADAPTER_LIFECYCLE: ReadonlySet<string> = new Set(["execution_started", "execution_completed", "execution_failed"]);

/** Whether a sidecar answer attests the job's recording window in the given sidecar process. */
function attests(answer: unknown, jobId: string, generation: string): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const a = answer as Partial<EvidenceWindowAttestation>;
  return a.ok === true && a.jobId === jobId && a.generation === generation;
}

function describeAnswer(answer: unknown): string {
  try {
    return JSON.stringify(answer) ?? String(answer);
  } catch {
    return String(answer);
  }
}

export class PyLabRobotAdapter extends EventEmitter implements MachineAdapter {
  readonly id: string;
  readonly type: string;
  readonly source: EvidenceSource;

  private readonly config: PyLabRobotConfig;
  private sidecar: SidecarClient | null;
  private evidenceListeners: EvidenceCallback[] = [];
  private currentCollector: EvidenceCollector | null = null;
  private currentJobId: string | null = null;
  /**
   * The job whose start is in flight, from the moment it is accepted until it returns. The
   * adapter records one job at a time: its collector and currentJobId are single, and the
   * sidecar keeps one window per device. So a start while this is set is refused, before
   * anything reaches the sidecar (astra pack 473). It is set before the first await, so two
   * starts in the same tick cannot both pass.
   */
  private running: string | null = null;
  private mockStatus: MachineStatus = "idle";
  /**
   * The mock run in flight, from its start until it completes or is stopped. Mock mode keeps
   * one run per device too: a start while it is set is refused, and a stop ends it, with no
   * completion (astra pack 204).
   */
  private mockRun: { jobId: string; timer: ReturnType<typeof setTimeout> | null; end: () => void } | null = null;
  private completedJobs = 0;
  /** Lazy-init guard so we only initialise the sidecar+backend once */
  private initialized = false;
  private disposed = false;
  /** Have we wired crash/notification/stderr handlers to the current sidecar? */
  private sidecarHandlersWired = false;
  /**
   * Set while a job's window is not proven closed: its barrier failed, or its opening was not
   * confirmed. Nothing proves that job's notifications are all out, so the adapter holds one
   * unit of outstanding work (quiesceEvidence() waits), refuses a new start, and retries until
   * the sidecar process that recorded the job proves the window closed (astra packs 191, 194).
   * The sidecar is not recycled for it (steward #5409): stopping it could interrupt the
   * instrument. Another process's answer never releases it: only dispose() does.
   */
  private unproven: (HoldSpec & { end: () => void; timer: ReturnType<typeof setTimeout> | null }) | null = null;
  /** The sidecar process backend.init named. Its recording windows are attested with it. */
  private generation: string | null = null;
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
    if (command.type === "start" && this.unproven !== null) {
      return {
        success: false,
        message: `the evidence of job ${this.unproven.jobId} is not yet proven complete (its barrier has not answered), so no new run starts`,
      };
    }
    // A start needs its job's id before anything reaches the sidecar: not even backend.init,
    // which can run a backend's setup() on the device (astra pack 197).
    const startJob = command.type === "start" ? this.startJobId(command.payload) : null;
    if (command.type === "start" && startJob === null) {
      return { success: false, message: START_NEEDS_JOB_ID };
    }
    // One run per device (astra pack 473): a second start would take over the collector and
    // the job the sidecar's notifications are bound to, so the first job's evidence would be
    // dropped while it still completed. Reserved here, before the first await.
    if (startJob !== null) {
      if (this.running !== null) {
        return { success: false, message: `busy with job ${this.running}: a run is in flight on this device, so job ${startJob} does not start` };
      }
      this.running = startJob;
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
    } finally {
      // The start has returned: its run has ended, or never began. A held job's evidence still
      // refuses new starts on its own (unproven).
      if (startJob !== null && this.running === startJob) this.running = null;
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
   * timeout) proves nothing: the run fails, with no execution_completed, and this stays
   * pending, and a new start is refused, until a retried barrier answers (astra pack 191).
   * Only a notification bound to the job recording now is evidence: one of another job is
   * late, and one bound to no job is unattributable, so both are dropped, never forwarded
   * (steward #5413). So is anything a replaced sidecar still sends. Its stderr is a
   * diagnostic ("sidecar_stderr"), not evidence.
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
    // The sidecar is stopped, so it can send nothing more: a job held unproven is released.
    if (this.unproven !== null) {
      const held = this.unproven;
      this.unproven = null;
      if (held.timer) clearTimeout(held.timer);
      held.end();
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

  /** The job's id a start would run under (its payload over load_gcode's), or null if it names none. */
  private startJobId(payload: Record<string, unknown> | undefined): string | null {
    const jobId = { ...this.pendingProtocol, ...(payload ?? {}) }.jobId;
    return typeof jobId === "string" && jobId.length > 0 ? jobId : null;
  }

  private async handleStart(
    payload: Record<string, unknown> | undefined,
  ): Promise<MachineCommandResult> {
    const merged = { ...this.pendingProtocol, ...(payload ?? {}) };
    // The run is the caller's job, and its id binds every event of it (astra pack 194): never
    // invented here. executeCommand has already refused a start without one.
    const jobId = this.startJobId(payload);
    if (jobId === null) {
      return { success: false, message: START_NEEDS_JOB_ID };
    }
    const generation = this.generation;
    if (generation === null) {
      return { success: false, message: "the sidecar has named no generation, so it cannot attest the job's recording window" };
    }
    const collector = this.makeCollector();
    this.currentCollector = collector;
    this.currentJobId = jobId;
    collector.startRecording(jobId);
    // The job's recording window, attested by this sidecar process: nothing physical runs
    // without it (astra pack 194). A window that failed to open may be open after all, so the
    // adapter is held until that process says which (requireWindow: false).
    const opening = await this.openWindow(jobId, generation);
    if (opening !== null) {
      return await this.failRun(collector, jobId, `evidence recording could not be opened: ${opening}`, undefined, {
        jobId,
        generation,
        requireWindow: false,
      });
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
      const barrier = await this.sidecarBarrier(jobId, generation);
      if (barrier !== null) {
        // Nothing proves the job's evidence complete: the run fails, with no execution_completed,
        // and the adapter is held until the process that recorded the job proves its window
        // closed (astra packs 191 and 194).
        return await this.failRun(collector, jobId, `evidence barrier failed: ${barrier}`, undefined, {
          jobId,
          generation,
          requireWindow: true,
        });
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
      const barrier = await this.sidecarBarrier(jobId, generation);
      return await this.failRun(
        collector,
        jobId,
        barrier === null ? reason : `${reason}; evidence barrier failed: ${barrier}`,
        err,
        barrier === null ? null : { jobId, generation, requireWindow: true },
      );
    }
  }

  /**
   * Fail the job's recording (execution_failed) and end the job. When its window is not proven
   * closed, the adapter is held (holdUntilProven) until it is.
   */
  private async failRun(
    collector: EvidenceCollector,
    jobId: string,
    reason: string,
    err: unknown,
    hold: HoldSpec | null,
  ): Promise<MachineCommandResult> {
    collector.failRecording(jobId, reason, {
      rpcCode: err instanceof SidecarError ? err.code : undefined,
      rpcData: err instanceof SidecarError ? err.data : undefined,
    });
    this.currentCollector = null;
    this.currentJobId = null;
    this.pendingProtocol = {};
    if (hold !== null) this.holdUntilProven(hold);
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
        if (this.mockRun !== null) {
          return { success: false, message: `busy with job ${this.mockRun.jobId}: a run is in flight on this device, so job ${jobId} does not start` };
        }
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
        const run: { jobId: string; timer: ReturnType<typeof setTimeout> | null; end: () => void } = { jobId, timer: null, end: this.work.begin() };
        this.mockRun = run;
        run.timer = setTimeout(() => {
          if (this.mockRun !== run) return; // stopped meanwhile: no completion
          this.mockRun = null;
          this.mockStatus = "idle";
          this.forwardEvent({
            type: "execution_completed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { mock: true, jobId, opCount: 5, durationMs: 1 },
          });
          this.emit("mock_run_complete", { jobId });
          // Ended only after the completion is emitted.
          run.end();
        }, 0);
        return { success: true, message: `mock run ${jobId} started` };
      }
      case "stop": {
        // A stop ends the mock run in flight with no completion, as the real stop fails the real
        // run: execution_failed, "stopped" (astra pack 204).
        const run = this.mockRun;
        this.mockRun = null;
        this.mockStatus = "idle";
        if (run !== null) {
          if (run.timer) clearTimeout(run.timer);
          this.forwardEvent({
            type: "execution_failed",
            timestamp: new Date().toISOString(),
            source: this.source,
            payload: { mock: true, jobId: run.jobId, reason: "stopped" },
          });
          run.end();
        }
        return { success: true, message: "mock stop" };
      }
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
        this.generation = null;
        // Evidence only when a job is recording, and bound to it: with none, the failure names
        // no job, so it is not forwarded (steward #5413). The run in flight fails on its own.
        if (this.currentJobId === null) return;
        this.forwardEvent({
          type: "execution_failed",
          timestamp: new Date().toISOString(),
          source: this.source,
          payload: {
            reason: "sidecar crash; pending RPC invalidated",
            jobId: this.currentJobId,
          },
        });
      });
      client.onNotification(RPC_NOTIFICATIONS.EVIDENCE, (params) => {
        if (client !== this.sidecar) return;
        this.handleEvidenceNotification(params as unknown as EvidenceNotificationParams);
      });
      // Its stderr names no job, so it is a diagnostic, never evidence (steward #5413).
      client.on("stderr", (msg: string) => {
        if (client !== this.sidecar || !msg.trim()) return;
        this.emit("sidecar_stderr", msg.trim());
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
      if (typeof result.generation !== "string" || result.generation.length === 0) {
        throw new SidecarError(
          RPC_ERROR_CODES.NON_RETRYABLE,
          "the sidecar named no generation, so it cannot attest its recording windows",
        );
      }
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
      this.generation = result.generation;
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
    this.generation = null;
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
   * Hold the adapter until the job's window is proven closed: one unit of outstanding work, so
   * the hook waits, and a retry with backoff (1 s, doubling to 30 s). dispose() ends the hold.
   */
  private holdUntilProven(spec: HoldSpec): void {
    if (this.unproven !== null) return;
    const held = { ...spec, end: this.work.begin(), timer: null as ReturnType<typeof setTimeout> | null };
    this.unproven = held;
    const retry = (delayMs: number): void => {
      held.timer = setTimeout(() => {
        held.timer = null;
        void this.provenClosed(spec).then((proven) => {
          if (this.unproven !== held) return;
          if (proven) {
            this.unproven = null;
            held.end();
          } else {
            retry(Math.min(delayMs * 2, 30_000));
          }
        });
      }, delayMs);
    };
    retry(1_000);
  }

  /**
   * Whether the sidecar process that recorded the job (spec.generation) proves its window
   * closed: an attested close of it, or, when its opening was never confirmed, that process's
   * own word that it never opened one. Another process's answer proves nothing: a restarted
   * sidecar holds no window of the job and answers with its own generation, so the hold stays
   * until the adapter is disposed (astra pack 194).
   */
  private async provenClosed(spec: HoldSpec): Promise<boolean> {
    if (!this.sidecar) return false;
    try {
      const answer = await this.sidecar.call<EvidenceWindowAttestation>(
        RPC_METHODS.EVIDENCE_STOP_RECORDING,
        { deviceId: this.id, jobId: spec.jobId },
        5_000,
      );
      return attests(answer, spec.jobId, spec.generation);
    } catch (err) {
      return (
        !spec.requireWindow &&
        err instanceof SidecarError &&
        err.code === RPC_ERROR_CODES.NO_RECORDING_WINDOW &&
        (err.data as { generation?: unknown } | undefined)?.generation === spec.generation
      );
    }
  }

  /**
   * Close the sidecar's recording window, a barrier: the sidecar answers only after writing
   * every notification it scheduled for the job. Null once the process that recorded the job
   * attests the close (its generation, this job); otherwise why not (an error, the 5 s
   * timeout, no sidecar, or an answer that attests nothing). A barrier that fails proves
   * nothing about what is still on its way, so the caller fails the run and holds the adapter.
   */
  private async sidecarBarrier(jobId: string, generation: string): Promise<string | null> {
    if (!this.sidecar) return "no sidecar to answer evidence.stopRecording";
    try {
      const answer = await this.sidecar.call<EvidenceWindowAttestation>(
        RPC_METHODS.EVIDENCE_STOP_RECORDING,
        { deviceId: this.id, jobId },
        5_000,
      );
      if (attests(answer, jobId, generation)) return null;
      return `evidence.stopRecording did not attest job ${jobId}'s window in sidecar ${generation}: ${describeAnswer(answer)}`;
    } catch (err) {
      return `evidence.stopRecording did not answer: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Open the job's recording window: null once this sidecar process attests it; else why not. */
  private async openWindow(jobId: string, generation: string): Promise<string | null> {
    try {
      const answer = await this.sidecar!.call<EvidenceWindowAttestation>(
        RPC_METHODS.EVIDENCE_START_RECORDING,
        { deviceId: this.id, jobId },
        5_000,
      );
      if (attests(answer, jobId, generation)) return null;
      return `the sidecar did not attest it: ${describeAnswer(answer)}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private handleEvidenceNotification(params: EvidenceNotificationParams): void {
    // Only a notification bound to the job recording now is evidence of it. One bound to
    // another job is late: that job's window is closed, and its hook may have answered. One
    // bound to no job is unattributable. Forwarded, either would be recorded under whichever
    // job holds the device, so both are dropped (astra packs 186 and 191, steward #5413).
    const collector = this.currentCollector;
    if (collector === null || params.jobId == null || params.jobId !== this.currentJobId) {
      console.warn(
        `[pylabrobot-adapter] ${this.id}: dropped a ${params.type} notification ` +
          (params.jobId == null ? "bound to no job" : `of job ${String(params.jobId)}, which is not recording`),
      );
      return;
    }
    // Lifecycle is the adapter's own: a completion is published only after the barrier has
    // proven the job's evidence complete. One the sidecar sends is dropped (astra pack 194).
    if (ADAPTER_LIFECYCLE.has(params.type)) {
      console.warn(`[pylabrobot-adapter] ${this.id}: dropped a ${params.type} notification: lifecycle events are the adapter's own`);
      return;
    }
    collector.ingestSidecarNotification(params);
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
