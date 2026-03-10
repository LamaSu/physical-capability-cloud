/**
 * SampleTracker — tracks the lifecycle and physical movement of samples
 * as they traverse instruments within a shop kernel.
 */

import type {
  Sample,
  SampleMovement,
  LabwareType,
  TransferMechanism,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

type MoveCallback = (movement: SampleMovement, sample: Sample) => void;
type SampleCallback = (sample: Sample) => void;

export class SampleTracker {
  private samples = new Map<string, Sample>();

  private moveListeners = new Set<MoveCallback>();
  private completeListeners = new Set<SampleCallback>();
  private failListeners = new Set<SampleCallback>();

  // ── Creation ────────────────────────────────────────────────────

  createSample(
    jobId: string,
    label: string,
    labwareType: LabwareType,
    startNodeId: string,
  ): Sample {
    const sample: Sample = {
      id: ids.sample(),
      jobId,
      label,
      labwareType,
      currentNodeId: startNodeId,
      status: "created",
      history: [],
      createdAt: new Date().toISOString(),
    };
    this.samples.set(sample.id, sample);
    return sample;
  }

  // ── Movement ────────────────────────────────────────────────────

  moveSample(
    sampleId: string,
    toNodeId: string,
    mechanism: TransferMechanism,
  ): SampleMovement {
    const sample = this.requireSample(sampleId);

    const movement: SampleMovement = {
      id: ids.sampleMovement(),
      sampleId,
      fromNodeId: sample.currentNodeId,
      toNodeId,
      mechanism,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    sample.currentNodeId = toNodeId;
    sample.status = "in_transit";
    sample.history.push(movement);

    // After movement completes, mark idle
    sample.status = "idle";

    for (const cb of this.moveListeners) {
      cb(movement, sample);
    }

    return movement;
  }

  // ── Status transitions ──────────────────────────────────────────

  startProcessing(sampleId: string): void {
    const sample = this.requireSample(sampleId);
    sample.status = "processing";
  }

  completeProcessing(sampleId: string): void {
    const sample = this.requireSample(sampleId);
    sample.status = "idle";
  }

  completeSample(sampleId: string): void {
    const sample = this.requireSample(sampleId);
    sample.status = "completed";
    for (const cb of this.completeListeners) {
      cb(sample);
    }
  }

  failSample(sampleId: string, reason?: string): void {
    const sample = this.requireSample(sampleId);
    sample.status = "failed";
    if (reason) {
      sample.metadata = { ...sample.metadata, failureReason: reason };
    }
    for (const cb of this.failListeners) {
      cb(sample);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────

  getSample(id: string): Sample | undefined {
    return this.samples.get(id);
  }

  getSamplesAtNode(nodeId: string): Sample[] {
    return [...this.samples.values()].filter((s) => s.currentNodeId === nodeId);
  }

  getSamplesForJob(jobId: string): Sample[] {
    return [...this.samples.values()].filter((s) => s.jobId === jobId);
  }

  getAllSamples(): Sample[] {
    return [...this.samples.values()];
  }

  // ── Event listeners ─────────────────────────────────────────────

  onMove(cb: MoveCallback): () => void {
    this.moveListeners.add(cb);
    return () => {
      this.moveListeners.delete(cb);
    };
  }

  onComplete(cb: SampleCallback): () => void {
    this.completeListeners.add(cb);
    return () => {
      this.completeListeners.delete(cb);
    };
  }

  onFail(cb: SampleCallback): () => void {
    this.failListeners.add(cb);
    return () => {
      this.failListeners.delete(cb);
    };
  }

  // ── Internals ───────────────────────────────────────────────────

  private requireSample(id: string): Sample {
    const sample = this.samples.get(id);
    if (!sample) {
      throw new Error(`Sample ${id} not found`);
    }
    return sample;
  }
}
