import { eq } from "drizzle-orm";
import { evidenceBundles, evidenceEvents, captureVerdicts } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IEvidenceBundleRepository } from "../interfaces/IEvidenceBundleRepository.js";

export class EvidenceBundleRepository implements IEvidenceBundleRepository {
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

  // ── Capture verdicts (CVP cross-facade wiring) ───────────────────
  //
  // Exposes the Wave 4 `capture_verdicts` table through the evidence repo so
  // ComplianceFacade can tighten ALCOA+ flags when capture verification has
  // run for a job. See ai/research/cvp-alcoa-integration.md for the wiring
  // sketch; there is intentionally NO join between evidence_bundles and
  // capture_verdicts (a job can have verdicts without evidence bundles and
  // vice versa — the only link is jobId).

  findCaptureVerdictsByJob(jobId: string) {
    return this.db
      .select()
      .from(captureVerdicts)
      .where(eq(captureVerdicts.jobId, jobId))
      .all();
  }
}
