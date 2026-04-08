import type { evidenceBundles, evidenceEvents } from "../schema/index.js";

export type EvidenceRow = typeof evidenceBundles.$inferSelect;
export type EvidenceInsert = typeof evidenceBundles.$inferInsert;
export type EvidenceEventRow = typeof evidenceEvents.$inferSelect;
export type EvidenceEventInsert = typeof evidenceEvents.$inferInsert;

export interface IEvidenceBundleRepository {
  findAll(): EvidenceRow[];
  findById(id: string): EvidenceRow | undefined;
  findByJob(jobId: string): EvidenceRow[];
  findByKernel(kernelId: string): EvidenceRow[];
  insert(bundle: EvidenceInsert): EvidenceRow | undefined;
  // Events sub-domain
  findEventsByBundle(bundleId: string): EvidenceEventRow[];
  insertEvent(event: EvidenceEventInsert): EvidenceEventRow | undefined;
  insertEvents(events: EvidenceEventInsert[]): EvidenceEventRow[];
}
