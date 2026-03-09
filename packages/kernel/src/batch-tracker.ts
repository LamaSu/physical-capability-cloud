/**
 * BatchTracker — manages batch manifests for shared instruments.
 *
 * Handles the lifecycle of batch runs: creating manifests, adding sample slots,
 * sealing, executing, and tracking per-slot results. Supports demultiplexing
 * results back to individual jobs.
 */

import type {
  BatchManifest,
  SampleSlot,
  BatchEvent,
  Id,
  SHA256,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

export class BatchTracker {
  private manifests = new Map<string, BatchManifest>();
  private events = new Map<string, BatchEvent[]>();
  private eventListeners = new Set<(event: BatchEvent) => void>();

  /** Create a new batch manifest */
  createBatch(
    kernelId: Id,
    deviceId: Id,
    capabilityId: Id,
    config: Record<string, unknown>,
  ): BatchManifest {
    const manifest: BatchManifest = {
      id: ids.batch(),
      kernelId,
      deviceId,
      capabilityId,
      status: "assembling",
      slots: [],
      runConfig: config,
    };
    this.manifests.set(manifest.id, manifest);
    this.events.set(manifest.id, []);
    this.emit(manifest.id, "batch_created", {});
    return manifest;
  }

  /** Add a sample slot to an assembling batch */
  addSample(
    batchId: Id,
    slot: Omit<SampleSlot, "id" | "status">,
  ): SampleSlot {
    const manifest = this.getManifest(batchId);
    if (manifest.status !== "assembling") {
      throw new Error(`Cannot add samples to batch in ${manifest.status} state`);
    }

    const full: SampleSlot = {
      ...slot,
      id: ids.sample(),
      status: "pending",
    };

    manifest.slots.push(full);
    this.emit(batchId, "sample_added", { slotId: full.id, position: full.position }, full.id);
    return full;
  }

  /** Seal batch — no more samples can be added */
  seal(batchId: Id): void {
    const manifest = this.getManifest(batchId);
    if (manifest.status !== "assembling") {
      throw new Error(`Cannot seal batch in ${manifest.status} state`);
    }
    if (manifest.slots.length === 0) {
      throw new Error("Cannot seal empty batch");
    }
    manifest.status = "sealed";
    manifest.sealedAt = new Date().toISOString();
    this.emit(batchId, "batch_sealed", { slotCount: manifest.slots.length });
  }

  /** Start batch execution */
  start(batchId: Id): void {
    const manifest = this.getManifest(batchId);
    if (manifest.status !== "sealed") {
      throw new Error(`Cannot start batch in ${manifest.status} state`);
    }
    manifest.status = "running";
    manifest.startedAt = new Date().toISOString();
    for (const slot of manifest.slots) {
      slot.status = "queued";
    }
    this.emit(batchId, "batch_started", {});
  }

  /** Update slot status */
  updateSlotStatus(batchId: Id, slotId: Id, status: SampleSlot["status"]): void {
    const manifest = this.getManifest(batchId);
    const slot = manifest.slots.find((s) => s.id === slotId);
    if (!slot) throw new Error(`Slot ${slotId} not found in batch ${batchId}`);

    slot.status = status;

    const eventMap: Partial<Record<SampleSlot["status"], BatchEvent["type"]>> = {
      injecting: "sample_injection_start",
      acquiring: "sample_acquisition_start",
      processing: "sample_result_available",
    };
    const eventType = eventMap[status];
    if (eventType) {
      this.emit(batchId, eventType, { position: slot.position }, slotId);
    }

    if (status === "acquiring") {
      slot.acquisitionStart = new Date().toISOString();
    }
  }

  /** Complete a slot with result hash */
  completeSlot(batchId: Id, slotId: Id, resultHash: SHA256, resultRef: string): void {
    const manifest = this.getManifest(batchId);
    const slot = manifest.slots.find((s) => s.id === slotId);
    if (!slot) throw new Error(`Slot ${slotId} not found`);

    slot.status = "completed";
    slot.acquisitionEnd = new Date().toISOString();
    slot.resultHash = resultHash;
    slot.resultRef = resultRef;
    this.emit(batchId, "sample_completed", { resultHash, resultRef }, slotId);
  }

  /** Complete entire batch */
  completeBatch(batchId: Id): void {
    const manifest = this.getManifest(batchId);
    const allDone = manifest.slots.every((s) => s.status === "completed" || s.status === "failed");
    const anyFailed = manifest.slots.some((s) => s.status === "failed");

    manifest.status = anyFailed ? (allDone ? "partial" : "running") : "completed";
    manifest.completedAt = new Date().toISOString();
    this.emit(batchId, "batch_completed", {
      completed: manifest.slots.filter((s) => s.status === "completed").length,
      failed: manifest.slots.filter((s) => s.status === "failed").length,
    });
  }

  /** Get a manifest by ID */
  getBatch(batchId: Id): BatchManifest | undefined {
    return this.manifests.get(batchId);
  }

  /** Get all manifests, optionally filtered */
  getAllBatches(filter?: { kernelId?: string; status?: BatchManifest["status"] }): BatchManifest[] {
    let result = [...this.manifests.values()];
    if (filter?.kernelId) result = result.filter((m) => m.kernelId === filter.kernelId);
    if (filter?.status) result = result.filter((m) => m.status === filter.status);
    return result;
  }

  /** Get all slots for a specific job (demultiplexing) */
  getSlotsForJob(batchId: Id, jobId: Id): SampleSlot[] {
    const manifest = this.manifests.get(batchId);
    if (!manifest) return [];
    return manifest.slots.filter((s) => s.jobId === jobId);
  }

  /** Get all batches containing a specific job */
  getBatchesForJob(jobId: Id): BatchManifest[] {
    return [...this.manifests.values()].filter(
      (m) => m.slots.some((s) => s.jobId === jobId)
    );
  }

  /** Get events for a batch */
  getEvents(batchId: Id): BatchEvent[] {
    return this.events.get(batchId) ?? [];
  }

  /** Subscribe to batch lifecycle events */
  onBatchEvent(cb: (event: BatchEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => { this.eventListeners.delete(cb); };
  }

  private getManifest(batchId: Id): BatchManifest {
    const m = this.manifests.get(batchId);
    if (!m) throw new Error(`Batch ${batchId} not found`);
    return m;
  }

  private emit(batchId: Id, type: BatchEvent["type"], payload: Record<string, unknown>, slotId?: Id): void {
    const event: BatchEvent = {
      id: ids.evidence(),
      batchId,
      timestamp: new Date().toISOString(),
      type,
      slotId,
      payload,
    };
    const list = this.events.get(batchId);
    if (list) list.push(event);
    for (const cb of this.eventListeners) {
      try { cb(event); } catch { /* ignore */ }
    }
  }
}
