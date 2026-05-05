import type { evidenceBundles, evidenceEvents, captureVerdicts } from "../schema/index.js";

export type EvidenceRow = typeof evidenceBundles.$inferSelect;
export type EvidenceInsert = typeof evidenceBundles.$inferInsert;
export type EvidenceEventRow = typeof evidenceEvents.$inferSelect;
export type EvidenceEventInsert = typeof evidenceEvents.$inferInsert;
export type CaptureVerdictRow = typeof captureVerdicts.$inferSelect;

/** Wave 4.1.x — additive tenant scope opts. Omitted = today's behavior. */
export interface EvidenceTenantOpts {
  tenantId?: string;
}

export interface IEvidenceBundleRepository {
  findAll(opts?: EvidenceTenantOpts): EvidenceRow[];
  findById(id: string): EvidenceRow | undefined;
  findByJob(jobId: string, opts?: EvidenceTenantOpts): EvidenceRow[];
  findByKernel(kernelId: string, opts?: EvidenceTenantOpts): EvidenceRow[];
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
