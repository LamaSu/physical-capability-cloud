/**
 * Job Runner — orchestrates a single job step on the kernel.
 *
 * Coordinates machine adapter, sensor adapters, camera adapter,
 * and evidence emitter to execute a capability and produce a
 * signed evidence bundle.
 *
 * SAFETY BOUNDARY (R-11: physical safety is not implied by economic
 * authorization). This class holds the only references to a MachineAdapter
 * during a job, so it is the last place a command can be stopped before it
 * reaches hardware. Every machine.execute() here is routed through
 * SafetyGateway.validateAndRelay(): the exact MachineCommand object that is
 * admitted is the same object handed to the adapter, so there is no
 * validate-then-mutate gap. Admission denial returns
 * { success: false, error: "safety: <reason>" } and the job does not proceed —
 * no sensors started, no snapshot taken, no start command issued.
 */

import type { AssuranceTier, SHA256 } from "@pcc/spec";
import type {
  MachineAdapter,
  SensorAdapter,
  CameraAdapter,
  MachineCommand,
  MachineCommandResult,
} from "./adapters/types.js";
import { EvidenceEmitter } from "./evidence-emitter.js";
import { getSafetyGateway, type SafetyGateway } from "./safety/gateway.js";
import type { CommandClass, PhysicalCommand } from "./safety/governor.js";
import * as Sentry from "@sentry/node";

/**
 * Safety classification for every MachineCommand type the kernel can issue.
 *
 * Mapping rationale (governor.ts CommandClass doc comments are the source):
 *   - "read"   — Class 1, always allowed (health, status, calibration).
 *   - "safe"   — Class 2, allowed during an active job (home, lights, identify).
 *   - "scoped" — Class 3, requires an active scope ("protocol upload, run").
 *
 * load_gcode IS protocol upload and start IS run, so both are "scoped": the
 * governor denies them unless the caller supplies the job's execution scope.
 * pause/resume/stop are in-job supervisory commands that must remain available
 * to an operator even without a scope, so they are "safe". status is a read.
 *
 * This table is fixed per command type. It deliberately does NOT vary with
 * whether a scopeId happens to be present — downgrading the class when the
 * credential is missing is what makes an admission check vacuous.
 */
const MACHINE_COMMAND_CLASS: Record<MachineCommand["type"], CommandClass> = {
  load_gcode: "scoped",
  start: "scoped",
  pause: "safe",
  resume: "safe",
  stop: "safe",
  status: "read",
};

/** Identity a dispatched command is attributed to, for audit + rate limiting. */
export interface DispatchContext {
  jobId: string;
  stepId: string;
  /** Requesting agent DID — the governor's rate-limit bucket. */
  agentDid: string;
  /** Execution scope authorizing class-"scoped" commands, if one was granted. */
  scopeId?: string;
}

/**
 * Translate a MachineCommand (what the adapter understands) into a
 * PhysicalCommand (what the SafetyGovernor validates).
 *
 * `params` is the *same object reference* as `command.payload` when present, so
 * a caller cannot validate one parameter set and dispatch another.
 */
export function toPhysicalCommand(
  command: MachineCommand,
  deviceId: string,
  ctx: DispatchContext,
): PhysicalCommand {
  return {
    commandId: `${ctx.jobId}:${ctx.stepId}:${command.type}`,
    deviceId,
    class: MACHINE_COMMAND_CLASS[command.type],
    type: command.type,
    params: command.payload ?? {},
    agentDid: ctx.agentDid,
    scopeId: ctx.scopeId,
  };
}

/** Callback fired at key pipeline phase transitions for external telemetry. */
export type OnPhaseCallback = (
  jobId: string,
  phase: "job_accepted" | "job_started" | "evidence_capture",
  status: "completed" | "failed",
  metadata?: Record<string, unknown>,
) => void;

export interface JobConfig {
  jobId: string;
  stepId: string;
  gcodeHash: SHA256;
  assuranceTier: AssuranceTier;
  /** Input file data (in production: fetch from storage) */
  gcodeData?: string;
  /**
   * Optional callback for phase telemetry events.
   * The kernel package cannot import gateway telemetry directly, so callers
   * (e.g. kernel-service.ts) inject this to bridge phase events to the
   * gateway's pipelineTelemetry service.
   */
  onPhase?: OnPhaseCallback;
  /**
   * Execution scope authorizing this job's actuation commands.
   *
   * load_gcode and start are class "scoped"; the SafetyGovernor denies them
   * when no scope is supplied. A job dispatched without a scopeId therefore
   * fails closed at the boundary and issues ZERO machine commands. Callers
   * that mint an execution scope (the gateway writes one per paid job) must
   * thread its id here.
   */
  scopeId?: string;
  /**
   * DID of the agent this job's commands are attributed to. Used for the
   * governor's audit trail and its per-agent command rate limit. Defaults to
   * a stable per-device DID (see JobRunner.run) so the rate limit buckets by
   * device rather than by job — a per-job default would never rate-limit,
   * since a job issues only two commands.
   */
  agentDid?: string;
}

export interface JobResult {
  success: boolean;
  bundleId?: string;
  bundleHash?: string;
  error?: string;
  durationMs: number;
}

export class JobRunner {
  private machine: MachineAdapter;
  private sensors: SensorAdapter[];
  private camera: CameraAdapter | null;
  private evidenceEmitter: EvidenceEmitter;
  private injectedGateway: SafetyGateway | null;

  constructor(
    machine: MachineAdapter,
    sensors: SensorAdapter[],
    camera: CameraAdapter | null,
    evidenceEmitter: EvidenceEmitter,
    /**
     * SafetyGateway to route actuation through. Defaults to the process-wide
     * singleton via getSafetyGateway(). If the singleton has not been
     * initialized, run() fails closed rather than dispatching unchecked —
     * a missing gateway is a wiring error, not permission to skip admission.
     */
    safetyGateway?: SafetyGateway,
  ) {
    this.machine = machine;
    this.sensors = sensors;
    this.camera = camera;
    this.evidenceEmitter = evidenceEmitter;
    this.injectedGateway = safetyGateway ?? null;
  }

  /**
   * Resolve the gateway. Never throws — an unresolvable gateway is reported as
   * a denial reason so the caller fails closed with no hardware contact.
   */
  private resolveGateway(): { gateway: SafetyGateway } | { reason: string } {
    if (this.injectedGateway) return { gateway: this.injectedGateway };
    try {
      return { gateway: getSafetyGateway() };
    } catch (err) {
      return {
        reason: `safety gateway unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Send one command to the machine through the SafetyGateway.
   *
   * The exact `command` object that is described to the governor is the object
   * the adapter receives — the closure captures it by reference and nothing
   * mutates it in between.
   */
  private async dispatch(
    gateway: SafetyGateway,
    command: MachineCommand,
    ctx: DispatchContext,
  ): Promise<{ admitted: true; result: MachineCommandResult } | { admitted: false; reason: string }> {
    const physical = toPhysicalCommand(command, this.machine.id, ctx);
    const outcome = await gateway.validateAndRelay(physical, () => this.machine.execute(command));

    if (!outcome.allowed) {
      return {
        admitted: false,
        reason:
          outcome.verdict?.reason ??
          outcome.reason ??
          `command ${physical.commandId} denied`,
      };
    }
    if (!outcome.executed) {
      // Admitted, but the adapter threw. The gateway already recorded the
      // failure against the device's circuit breaker.
      return {
        admitted: true,
        result: { success: false, message: outcome.error ?? "machine execution failed" },
      };
    }
    return { admitted: true, result: outcome.result as MachineCommandResult };
  }

  async run(config: JobConfig): Promise<JobResult> {
    const startTime = Date.now();
    const { jobId, stepId, gcodeHash, assuranceTier, onPhase } = config;

    // Resolve the safety boundary BEFORE touching any adapter. No gateway,
    // no job — this path fails closed.
    const resolved = this.resolveGateway();
    if ("reason" in resolved) {
      return { success: false, error: `safety: ${resolved.reason}`, durationMs: Date.now() - startTime };
    }
    const gateway = resolved.gateway;
    const dispatchCtx: DispatchContext = {
      jobId,
      stepId,
      agentDid: config.agentDid ?? `did:pcc:device:${this.machine.id}`,
      scopeId: config.scopeId,
    };

    // Register step with evidence emitter
    this.evidenceEmitter.registerStep(jobId, stepId, assuranceTier);

    // Wire up evidence listeners
    const handleEvidence = (event: Parameters<MachineAdapter["onEvidence"]>[0] extends (e: infer E) => void ? E : never) => {
      this.evidenceEmitter.addEvent(jobId, stepId, event).catch(console.error);
    };

    this.machine.onEvidence(handleEvidence);
    for (const sensor of this.sensors) {
      sensor.onEvidence(handleEvidence);
    }
    if (this.camera) {
      this.camera.onEvidence(handleEvidence);
    }

    try {
      return await Sentry.startSpan(
        {
          name: "job.run",
          op: "job.run",
          attributes: {
            "job.id": jobId,
            "job.step_id": stepId,
            "job.assurance_tier": assuranceTier,
          },
        },
        async () => {
          // 1. Load G-code (class "scoped" — denied without an execution scope)
          const loadCommand: MachineCommand = {
            type: "load_gcode",
            payload: { gcodeHash },
          };
          const loadDispatch = await Sentry.startSpan(
            { name: "job.load_gcode", op: "job.phase", attributes: { "job.id": jobId } },
            async () => this.dispatch(gateway, loadCommand, dispatchCtx),
          );
          if (!loadDispatch.admitted) {
            // Denied at the boundary: the machine was never called, so nothing
            // downstream (sensors, snapshot, start) may run.
            return { success: false, error: `safety: ${loadDispatch.reason}`, durationMs: Date.now() - startTime };
          }
          const loadResult = loadDispatch.result;
          if (!loadResult.success) {
            return { success: false, error: `Failed to load G-code: ${loadResult.message}`, durationMs: Date.now() - startTime };
          }

          // 2. Start sensors (Tier 1+)
          if (assuranceTier >= 1) {
            await Sentry.startSpan(
              { name: "job.start_sensors", op: "job.phase", attributes: { "job.id": jobId, "sensor.count": this.sensors.length } },
              async () => {
                for (const sensor of this.sensors) {
                  await sensor.startRecording(jobId);
                }
              },
            );
          }

          // 3. Take before-snapshot (Tier 2+)
          if (assuranceTier >= 2 && this.camera) {
            await Sentry.startSpan(
              { name: "job.before_snapshot", op: "job.phase", attributes: { "job.id": jobId } },
              async () => this.camera!.captureSnapshot(),
            );
          }

          // 4. Start execution (class "scoped" — denied without an execution scope)
          const startCommand: MachineCommand = { type: "start" };
          const startDispatch = await Sentry.startSpan(
            { name: "job.start_execution", op: "job.phase", attributes: { "job.id": jobId } },
            async () => this.dispatch(gateway, startCommand, dispatchCtx),
          );
          if (!startDispatch.admitted) {
            return { success: false, error: `safety: ${startDispatch.reason}`, durationMs: Date.now() - startTime };
          }
          const startResult = startDispatch.result;
          if (!startResult.success) {
            return { success: false, error: `Failed to start: ${startResult.message}`, durationMs: Date.now() - startTime };
          }

          // 5. Wait for completion
          await Sentry.startSpan(
            { name: "job.wait_for_completion", op: "job.phase", attributes: { "job.id": jobId } },
            async () => this.waitForCompletion(),
          );

          // 6. Stop sensors and collect summaries (Tier 1+)
          if (assuranceTier >= 1) {
            await Sentry.startSpan(
              { name: "job.stop_sensors", op: "job.phase", attributes: { "job.id": jobId } },
              async () => {
                for (const sensor of this.sensors) {
                  await sensor.stopRecording();
                }
              },
            );
          }

          // 7. Run CV inspection (Tier 2+)
          if (assuranceTier >= 2 && this.camera) {
            await Sentry.startSpan(
              { name: "job.cv_inspection", op: "job.phase", attributes: { "job.id": jobId } },
              async () => this.camera!.runInspection(),
            );
          }

          // 8. Check tier requirements are met
          const events = this.evidenceEmitter.getEvents(jobId, stepId);
          const check = this.evidenceEmitter.checkTierRequirements(events, assuranceTier);
          if (!check.met) {
            // For tier >= 2, unmet requirements are a hard failure
            if (assuranceTier >= 2) {
              onPhase?.(jobId, "evidence_capture", "failed", { missing: check.missing });
              return {
                success: false,
                error: `Tier ${assuranceTier} requirements not met: ${check.missing.join(", ")}`,
                durationMs: Date.now() - startTime,
              };
            }
            // For tier 0-1, warn but continue (self-attested/sensor-only)
            console.warn(`[job-runner] Tier ${assuranceTier} partially met: ${check.missing.join(", ")}`);
          }

          // 9. Finalize evidence bundle
          const bundle = await Sentry.startSpan(
            { name: "job.finalize_bundle", op: "job.phase", attributes: { "job.id": jobId } },
            async () => this.evidenceEmitter.finalizeBundle(jobId, stepId),
          );

          // Emit phase callback for evidence capture so kernel-service can relay to telemetry
          onPhase?.(jobId, "evidence_capture", "completed", {
            eventCount: bundle.events.length,
            bundleHash: bundle.bundleHash,
          });

          return {
            success: true,
            bundleId: bundle.id,
            bundleHash: bundle.bundleHash,
            durationMs: Date.now() - startTime,
          };
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message, durationMs: Date.now() - startTime };
    }
  }

  private async waitForCompletion(timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (true) {
      const progress = await this.machine.getProgress();
      if (progress >= 100) return;

      const status = await this.machine.getStatus();
      if (status === "error") throw new Error("Machine reported error");
      if (status === "idle" && progress < 100) throw new Error("Machine went idle before completion");

      if (Date.now() - start > timeoutMs) throw new Error("Job timed out");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
