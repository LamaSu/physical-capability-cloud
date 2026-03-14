import { eq, and } from "drizzle-orm";
import { batchManifests, sampleSlots, batchEvents } from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class BatchRepository {
  constructor(private db: StoreDB) {}

  // ── Manifests ─────────────────────────────────────────────────

  findAll(opts?: { kernelId?: string; status?: string }) {
    if (opts?.kernelId && opts?.status) {
      return this.db
        .select()
        .from(batchManifests)
        .where(and(eq(batchManifests.kernelId, opts.kernelId), eq(batchManifests.status, opts.status)))
        .all();
    }
    if (opts?.kernelId) {
      return this.db
        .select()
        .from(batchManifests)
        .where(eq(batchManifests.kernelId, opts.kernelId))
        .all();
    }
    if (opts?.status) {
      return this.db
        .select()
        .from(batchManifests)
        .where(eq(batchManifests.status, opts.status))
        .all();
    }
    return this.db.select().from(batchManifests).all();
  }

  findById(id: string) {
    return this.db.select().from(batchManifests).where(eq(batchManifests.id, id)).get();
  }

  insert(manifest: typeof batchManifests.$inferInsert) {
    return this.db.insert(batchManifests).values(manifest).returning().get();
  }

  updateStatus(id: string, status: string, timestamps?: { sealedAt?: string; startedAt?: string; completedAt?: string }) {
    return this.db
      .update(batchManifests)
      .set({ status, ...timestamps })
      .where(eq(batchManifests.id, id))
      .returning()
      .get();
  }

  // ── Slots ─────────────────────────────────────────────────────

  findSlotsByBatch(batchId: string) {
    return this.db.select().from(sampleSlots).where(eq(sampleSlots.batchId, batchId)).all();
  }

  findSlotsByJob(batchId: string, jobId: string) {
    return this.db
      .select()
      .from(sampleSlots)
      .where(and(eq(sampleSlots.batchId, batchId), eq(sampleSlots.jobId, jobId)))
      .all();
  }

  insertSlot(slot: typeof sampleSlots.$inferInsert) {
    return this.db.insert(sampleSlots).values(slot).returning().get();
  }

  updateSlotStatus(id: string, status: string, timestamps?: { acquisitionStart?: string; acquisitionEnd?: string }) {
    return this.db
      .update(sampleSlots)
      .set({ status, ...timestamps })
      .where(eq(sampleSlots.id, id))
      .returning()
      .get();
  }

  // ── Events ────────────────────────────────────────────────────

  findEventsByBatch(batchId: string) {
    return this.db.select().from(batchEvents).where(eq(batchEvents.batchId, batchId)).all();
  }

  insertEvent(event: typeof batchEvents.$inferInsert) {
    return this.db.insert(batchEvents).values(event).returning().get();
  }
}
