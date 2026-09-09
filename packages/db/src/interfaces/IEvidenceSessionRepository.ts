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
  /**
   * Compare-and-set: transition to `toStatus` ONLY if the session is currently `open` (round-7 re-audit).
   * Returns the updated row on success, or `undefined` if the session was not open (already terminal /
   * finalized / missing). Atomic within the caller's transaction — SQLite serializes write txns, so this
   * closes the acceptance-time lifecycle race even across instances.
   */
  transitionIfOpen(sessionId: string, toStatus: string): EvidenceSessionRow | undefined;
}
