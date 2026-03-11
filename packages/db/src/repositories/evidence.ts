import { eq } from "drizzle-orm";
import { evidenceBundles, evidenceEvents } from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class EvidenceBundleRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(evidenceBundles).all();
  }

  findById(id: string) {
    return this.db.select().from(evidenceBundles).where(eq(evidenceBundles.id, id)).get();
  }

  findByJob(jobId: string) {
    return this.db.select().from(evidenceBundles).where(eq(evidenceBundles.jobId, jobId)).all();
  }

  findByKernel(kernelId: string) {
    return this.db.select().from(evidenceBundles).where(eq(evidenceBundles.kernelId, kernelId)).all();
  }

  insert(bundle: typeof evidenceBundles.$inferInsert) {
    return this.db.insert(evidenceBundles).values(bundle).returning().get();
  }

  // ── Events ──────────────────────────────────────────────────────

  findEventsByBundle(bundleId: string) {
    return this.db.select().from(evidenceEvents).where(eq(evidenceEvents.bundleId, bundleId)).all();
  }

  insertEvent(event: typeof evidenceEvents.$inferInsert) {
    return this.db.insert(evidenceEvents).values(event).returning().get();
  }

  insertEvents(events: (typeof evidenceEvents.$inferInsert)[]) {
    if (events.length === 0) return [];
    return this.db.insert(evidenceEvents).values(events).returning().all();
  }
}
