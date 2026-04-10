import type { batchManifests, sampleSlots, batchEvents } from "../schema/index.js";

export type BatchManifestRow = typeof batchManifests.$inferSelect;
export type BatchManifestInsert = typeof batchManifests.$inferInsert;
export type SampleSlotRow = typeof sampleSlots.$inferSelect;
export type SampleSlotInsert = typeof sampleSlots.$inferInsert;
export type BatchEventRow = typeof batchEvents.$inferSelect;
export type BatchEventInsert = typeof batchEvents.$inferInsert;

export interface IBatchRepository {
  // Manifests
  findAll(opts?: { kernelId?: string; status?: string }): BatchManifestRow[];
  findById(id: string): BatchManifestRow | undefined;
  insert(manifest: BatchManifestInsert): BatchManifestRow | undefined;
  updateStatus(
    id: string,
    status: string,
    timestamps?: { sealedAt?: string; startedAt?: string; completedAt?: string },
  ): BatchManifestRow | undefined;
  // Slots
  findSlotsByBatch(batchId: string): SampleSlotRow[];
  findSlotsByJob(batchId: string, jobId: string): SampleSlotRow[];
  insertSlot(slot: SampleSlotInsert): SampleSlotRow | undefined;
  updateSlotStatus(
    id: string,
    status: string,
    timestamps?: { acquisitionStart?: string; acquisitionEnd?: string },
  ): SampleSlotRow | undefined;
  // Events
  findEventsByBatch(batchId: string): BatchEventRow[];
  insertEvent(event: BatchEventInsert): BatchEventRow | undefined;
}
