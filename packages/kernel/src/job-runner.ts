/**
 * Job Runner — orchestrates a single job step on the kernel.
 *
 * Coordinates machine adapter, sensor adapters, camera adapter,
 * and evidence emitter to execute a capability and produce a
 * signed evidence bundle.
 */

import type { AssuranceTier, SHA256 } from "@pcc/spec";
import type { MachineAdapter, SensorAdapter, CameraAdapter } from "./adapters/types.js";
import { EvidenceEmitter } from "./evidence-emitter.js";
import { DEFAULT_EVIDENCE_QUIET_MS, openEvidenceSession } from "./evidence-session.js";
import * as Sentry from "@sentry/node";

/**
 * The (jobId, stepId) keys running on each emitter, each mapped to the run that holds it.
 * registerStep overwrites a step under an active key, so two runs of one step on disjoint
 * adapters would read and finalize each other's events (astra pack 172). A run takes the
 * key before registerStep and releases it on every exit; a run whose key is held is refused.
 */
const activeSteps = new WeakMap<EvidenceEmitter, Map<string, string>>();
let runs = 0;

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
}

export interface JobResult {
  success: boolean;
  bundleId?: string;
  bundleHash?: string;
  error?: string;
  /**
   * Set when the run was refused before it started: nothing ran, no step was registered
   * and nothing was recorded. The device is not at fault, so a caller should queue or
   * retry the job, never count a device failure.
   *   - "adapter": the device of adapter `adapterId` is recording job `jobId`'s evidence;
   *   - "quiescing": that device has not been quiet since job `jobId` ended, so what it
   *     emits now could still be that job's evidence;
   *   - "step": this run's (jobId, stepId) is already running on this evidence emitter.
   */
  busy?: { jobId: string; adapterId?: string; stepId?: string; reason: "adapter" | "step" | "quiescing" };
  durationMs: number;
}

export interface JobRunnerOptions {
  /**
   * How long a run waits, once it stops accepting evidence, for the events it accepted
   * to be recorded. Past that it fails: an addEvent may never settle. Default 30 s.
   */
  evidenceSettleTimeoutMs?: number;
  /**
   * How long an adapter without quiesceEvidence must have been silent before the run
   * takes its evidence to be complete; also how long a device stays unavailable to the
   * next job after its last event. Default 1000 ms.
   */
  evidenceQuietMs?: number;
  /** How long a run waits for its adapters to quiesce before it fails. Default 15 s. */
  evidenceQuiesceTimeoutMs?: number;
}

export class JobRunner {
  private machine: MachineAdapter;
  private sensors: SensorAdapter[];
  private camera: CameraAdapter | null;
  private evidenceEmitter: EvidenceEmitter;
  private evidenceSettleTimeoutMs: number;
  private evidenceQuietMs: number;
  private evidenceQuiesceTimeoutMs: number;

  constructor(
    machine: MachineAdapter,
    sensors: SensorAdapter[],
    camera: CameraAdapter | null,
    evidenceEmitter: EvidenceEmitter,
    options?: JobRunnerOptions,
  ) {
    this.machine = machine;
    this.sensors = sensors;
    this.camera = camera;
    this.evidenceEmitter = evidenceEmitter;
    this.evidenceSettleTimeoutMs = options?.evidenceSettleTimeoutMs ?? 30_000;
    this.evidenceQuietMs = options?.evidenceQuietMs ?? DEFAULT_EVIDENCE_QUIET_MS;
    this.evidenceQuiesceTimeoutMs = options?.evidenceQuiesceTimeoutMs ?? 15_000;
  }

  async run(config: JobConfig): Promise<JobResult> {
    const startTime = Date.now();
    const { jobId, stepId, gcodeHash, assuranceTier, onPhase } = config;

    // addEvent hashes asynchronously before it stores an event, so each one is
    // recorded on one chain, in the order it was emitted, and the tier check and the
    // bundle wait for the chain. An unawaited addEvent could land after both: an
    // inspection emitted at step 7 was missing from the step-8 check (found in
    // LO-SE-1 round 2).
    let recorded: Promise<void> = Promise.resolve();
    // Set when the run fails, so an event still queued is never written.
    let sealed = false;

    // Every refusal below comes before any adapter command, and before registerStep,
    // which would overwrite the step of a job already running under the same ids. The
    // checks, the session's claim and the step key's lease are one synchronous block.
    const stepKey = `${jobId}:${stepId}`; // the emitter's own key for the step
    let leases = activeSteps.get(this.evidenceEmitter);
    if (leases === undefined) {
      leases = new Map();
      activeSteps.set(this.evidenceEmitter, leases);
    }
    if (leases.has(stepKey)) {
      return {
        success: false,
        error: `step ${stepId} of job ${jobId} is already running`,
        busy: { reason: "step", jobId, stepId },
        durationMs: Date.now() - startTime,
      };
    }

    // This run's evidence window: events reach the chain only while it is open.
    // A listener per run could not be removed, so it went on recording later and
    // overlapping jobs' events into this run's step (astra pack 168).
    const opened = openEvidenceSession(
      [this.machine, ...this.sensors, ...(this.camera ? [this.camera] : [])],
      { jobId, stepId },
      (event) => {
        recorded = recorded.then(async () => {
          if (sealed) return;
          try {
            await this.evidenceEmitter.addEvent(jobId, stepId, event);
          } catch (err) {
            console.error(err);
          }
        });
      },
      { quietMs: this.evidenceQuietMs },
    );
    if (!opened.ok) {
      const { reason, adapterId, jobId: holder } = opened.busy;
      return {
        success: false,
        error: reason === "adapter" ? `adapter ${adapterId} is in use by job ${holder}` : `adapter ${adapterId} is still quiescing after job ${holder}`,
        busy: { reason, adapterId, jobId: holder },
        durationMs: Date.now() - startTime,
      };
    }
    const session = opened.session;
    const lease = `${jobId}#${++runs}`;
    leases.set(stepKey, lease);
    this.evidenceEmitter.registerStep(jobId, stepId, assuranceTier);

    // Wait for the chain, but not forever: an addEvent may never settle.
    // Resolves false when the timeout comes first.
    const settle = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.evidenceSettleTimeoutMs);
      });
      try {
        return await Promise.race([recorded.then(() => true), timeout]);
      } finally {
        clearTimeout(timer);
      }
    };

    let succeeded = false;
    let settleTimedOut = false;
    try {
      const result = await Sentry.startSpan(
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
          // 1. Load G-code
          const loadResult = await Sentry.startSpan(
            { name: "job.load_gcode", op: "job.phase", attributes: { "job.id": jobId } },
            async () =>
              this.machine.execute({
                type: "load_gcode",
                payload: { gcodeHash },
              }),
          );
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

          // 4. Start execution
          const startResult = await Sentry.startSpan(
            { name: "job.start_execution", op: "job.phase", attributes: { "job.id": jobId } },
            async () => this.machine.execute({ type: "start" }),
          );
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

          // 8. Wait, still recording, until the adapters have emitted all of this job's
          // evidence: returning from step 5, 6 or 7 does not prove an adapter is done (a
          // poll loop may report the completion later). Bounded: a device that never goes
          // quiet fails the run, at every tier, and nothing is finalized.
          if (!(await session.quiesce(this.evidenceQuietMs, this.evidenceQuiesceTimeoutMs))) {
            return {
              success: false,
              error: `evidence did not quiesce within ${this.evidenceQuiesceTimeoutMs} ms`,
              durationMs: Date.now() - startTime,
            };
          }

          // Then stop accepting evidence, so the chain stops growing, and wait for it. An
          // event emitted from here on is dropped, with a warning, and keeps its device
          // from the next job until it has been quiet again.
          session.close();
          if (!(await settle())) {
            settleTimedOut = true;
            return {
              success: false,
              error: `evidence recording did not settle within ${this.evidenceSettleTimeoutMs} ms`,
              durationMs: Date.now() - startTime,
            };
          }

          // Check tier requirements are met, over every event the run accepted
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

          // 9. Finalize evidence bundle. The chain is closed and settled, so the step
          // cannot change while the bundle is hashed, signed and copied.
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
      succeeded = result.success;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message, durationMs: Date.now() - startTime };
    } finally {
      // Every exit closes the window. A failed run also seals the chain, so an event
      // still queued is never written; waits, bounded, for the addEvent in flight; and
      // then detaches its step (cleanup), so getEvents() for it is empty from then on.
      // An addEvent still running at that bound cannot be recalled: it holds the step
      // record it looked up before it awaited the hash, so it appends to that detached
      // record, which nothing reads, after run() has returned.
      session.close();
      if (!succeeded) {
        sealed = true;
        if (!settleTimedOut) await settle();
        this.evidenceEmitter.cleanup(jobId, stepId);
      }
      // Released last, so a later run of this step registers a fresh record.
      if (leases.get(stepKey) === lease) leases.delete(stepKey);
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
