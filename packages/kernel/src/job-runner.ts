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
import * as Sentry from "@sentry/node";

export interface JobConfig {
  jobId: string;
  stepId: string;
  gcodeHash: SHA256;
  assuranceTier: AssuranceTier;
  /** Input file data (in production: fetch from storage) */
  gcodeData?: string;
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

  constructor(
    machine: MachineAdapter,
    sensors: SensorAdapter[],
    camera: CameraAdapter | null,
    evidenceEmitter: EvidenceEmitter,
  ) {
    this.machine = machine;
    this.sensors = sensors;
    this.camera = camera;
    this.evidenceEmitter = evidenceEmitter;
  }

  async run(config: JobConfig): Promise<JobResult> {
    const startTime = Date.now();
    const { jobId, stepId, gcodeHash, assuranceTier } = config;

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

          // 8. Check tier requirements are met
          const events = this.evidenceEmitter.getEvents(jobId, stepId);
          const check = this.evidenceEmitter.checkTierRequirements(events, assuranceTier);
          if (!check.met) {
            console.warn(`Tier ${assuranceTier} requirements not fully met: ${check.missing.join(", ")}`);
          }

          // 9. Finalize evidence bundle
          const bundle = await Sentry.startSpan(
            { name: "job.finalize_bundle", op: "job.phase", attributes: { "job.id": jobId } },
            async () => this.evidenceEmitter.finalizeBundle(jobId, stepId),
          );

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
