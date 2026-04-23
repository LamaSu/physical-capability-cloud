import type { evidenceBundles, evidenceEvents, captureVerdicts } from "../schema/index.js";

export type EvidenceRow = typeof evidenceBundles.$inferSelect;
export type EvidenceInsert = typeof evidenceBundles.$inferInsert;
export type EvidenceEventRow = typeof evidenceEvents.$inferSelect;
export type EvidenceEventInsert = typeof evidenceEvents.$inferInsert;
export type CaptureVerdictRow = typeof captureVerdicts.$inferSelect;

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
  // Capture verdicts (CVP cross-facade wiring)
  /**
   * Return all captureVerdicts rows linked to a given jobId.
   * Used by ComplianceFacade to tighten ALCOA+ flags when capture verification
   * has been performed. Returns [] when no verdicts exist (not an error).
   */
  findCaptureVerdictsByJob(jobId: string): CaptureVerdictRow[];
}
