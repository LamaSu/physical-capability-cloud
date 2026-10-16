/**
 * Where the live batches are (cross-family review r5 of #403). services.ts registers its
 * BatchTracker here, and the read filters (recordOwnersOf, job-read-gate.ts) ask it who owns a
 * slot or a batch: a slot belongs to the job the tracker holds for it, whatever a record's payload
 * or the slot's own serialized form says. Until a source is registered, a record tied to a batch
 * cannot be placed.
 */
import type { BatchManifest } from "@pcc/spec";

export interface BatchOwnership {
  /** The live slot with this id: its batch, and its job (undefined when it names none). */
  slotOf(slotId: string): { batchId: string; jobId: string | undefined } | undefined;
  /** The job of every slot of the live batch (undefined for a slot naming none). */
  batchJobsOf(batchId: string): ReadonlyArray<string | undefined> | undefined;
}

let source: BatchOwnership | undefined;

export function registerBatchOwnership(next: BatchOwnership | undefined): void {
  source = next;
}

export function batchOwnership(): BatchOwnership | undefined {
  return source;
}

const liveJobOf = (slot: { jobId?: unknown }) =>
  typeof slot.jobId === "string" && slot.jobId.trim() !== "" ? slot.jobId : undefined;

/** The ownership a tracker's own records give (BatchTracker, @pcc/kernel). */
export function batchOwnershipOf(tracker: {
  getAllBatches(): readonly BatchManifest[];
  getBatch(batchId: string): BatchManifest | undefined;
}): BatchOwnership {
  return {
    slotOf: (slotId) => {
      for (const batch of tracker.getAllBatches()) {
        const slot = batch.slots.find((s) => s.id === slotId);
        if (slot) return { batchId: batch.id, jobId: liveJobOf(slot) };
      }
      return undefined;
    },
    batchJobsOf: (batchId) => tracker.getBatch(batchId)?.slots.map(liveJobOf),
  };
}
