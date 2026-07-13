import type { evidenceSessions } from "../schema/index.js";

export type EvidenceSessionRow = typeof evidenceSessions.$inferSelect;
export type EvidenceSessionInsert = typeof evidenceSessions.$inferInsert;

export interface IEvidenceSessionRepository {
  insert(record: EvidenceSessionInsert): EvidenceSessionRow | undefined;
  findById(sessionId: string): EvidenceSessionRow | undefined;
  /**
   * The single session for a (job, milestone), ANY status — the finalize
   * idempotency lookup (step 6 has one session per (job, milestone)).
   */
  findByJobMilestone(jobId: string, milestoneIndex: number): EvidenceSessionRow | undefined;
  /** The OPEN session for a (job, milestone), if any (status='open'). */
  findOpenByJobMilestone(jobId: string, milestoneIndex: number): EvidenceSessionRow | undefined;
  /** Set the lifecycle status (`open` → `finalized`); returns the updated row. */
  setStatus(sessionId: string, status: string): EvidenceSessionRow | undefined;
}
