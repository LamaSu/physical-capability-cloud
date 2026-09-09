import { and, eq } from "drizzle-orm";
import { evidenceSessions } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  EvidenceSessionInsert,
  IEvidenceSessionRepository,
} from "../interfaces/IEvidenceSessionRepository.js";

/**
 * Persistence for evidence sessions (§8.5 step 6 / §2.1). Pure data access —
 * window computation from terms and the one-open-session policy live in the
 * gateway service services/evidence-session-store.ts (not yet wired; step-6
 * endpoint work). This class only reads and writes rows.
 *
 * `insert` uses `.returning().get()` so the endpoint can construct its response
 * FROM the persisted row. `findByJobMilestone` relies on the UNIQUE
 * (job_id, milestone_index) index → at most one row.
 */
export class EvidenceSessionRepository implements IEvidenceSessionRepository {
  constructor(private db: StoreDB) {}

  insert(record: EvidenceSessionInsert) {
    return this.db.insert(evidenceSessions).values(record).returning().get();
  }

  findById(sessionId: string) {
    return this.db
      .select()
      .from(evidenceSessions)
      .where(eq(evidenceSessions.sessionId, sessionId))
      .get();
  }

  findByJobMilestone(jobId: string, milestoneIndex: number) {
    return this.db
      .select()
      .from(evidenceSessions)
      .where(
        and(
          eq(evidenceSessions.jobId, jobId),
          eq(evidenceSessions.milestoneIndex, milestoneIndex),
        ),
      )
      .get();
  }

  findOpenByJobMilestone(jobId: string, milestoneIndex: number) {
    return this.db
      .select()
      .from(evidenceSessions)
      .where(
        and(
          eq(evidenceSessions.jobId, jobId),
          eq(evidenceSessions.milestoneIndex, milestoneIndex),
          eq(evidenceSessions.status, "open"),
        ),
      )
      .get();
  }

  setStatus(sessionId: string, status: string) {
    return this.db
      .update(evidenceSessions)
      .set({ status })
      .where(eq(evidenceSessions.sessionId, sessionId))
      .returning()
      .get();
  }

  // Round-7 (re-audit): compare-and-set open→toStatus. The WHERE clause makes the transition atomic and
  // conditional on `open`, so a concurrent terminal transition (or a finalize) cannot be overwritten and
  // a post-terminal acceptance cannot re-open the session. Returns the row iff it transitioned.
  transitionIfOpen(sessionId: string, toStatus: string) {
    return this.db
      .update(evidenceSessions)
      .set({ status: toStatus })
      .where(and(eq(evidenceSessions.sessionId, sessionId), eq(evidenceSessions.status, "open")))
      .returning()
      .get();
  }
}
