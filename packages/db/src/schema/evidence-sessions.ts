import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Evidence sessions — the open execution-authority window for one
 * (job, milestone) under the §8.5 step-6 async evidence split.
 *
 * One row is created by `POST /api/jobs/:jobId/evidence/begin` (spec §2.1) when
 * the gateway opens window 1 (§8.4 window 1): it records the verified
 * PhaseDelegation (`sessionKeyAuthorization`), the terms-derived authority
 * window `[notBefore, expiresAt, evidenceSubmissionDeadline]` (the 3600-clamp
 * replacement, §2.1-3), and the session lifecycle `status` (`open` →
 * `finalized`). Checkpoints (`checkpoint_bodies`) and the final package
 * (`milestone_packages`) reference this session.
 *
 * ONE session per (job, milestone) in step 6 (renewal/chaining is step 9), so
 * (job_id, milestone_index) is a UNIQUE index — the DB fail-closes the
 * "one active session" rule of §2.1-4 (a second begin with a different sessionId
 * → the endpoint maps the unique violation to 409 session_already_open).
 *
 * All domain times are Unix SECONDS (matches acceptedAt/effectiveEvidenceTime,
 * gateway-receipt-store.ts L73). `openedAt` is the ISO 8601 row-creation metadata
 * (mirrors gateway_receipts.createdAt) — distinct from the domain window times.
 *
 * ADDITIVE + NON-BREAKING: backs the step-6 async endpoints only; no existing
 * route reads or writes this table.
 */
export const evidenceSessions = sqliteTable(
  "evidence_sessions",
  {
    /**
     * The EVIDENCE session id — derived deterministically as `evs-<jobId>-<milestoneIndex>`
     * (§2.1-4); PK. This is NOT the delegation's cryptographic session-key id — that is
     * `delegationSessionId` below (S6-8: the two are distinct and both recorded, so the
     * step-10 oracle's session-key / revocation / chain-continuity checks are unambiguous).
     */
    sessionId: text("session_id").primaryKey(),
    jobId: text("job_id").notNull(),
    /** Milestone within the job; default 0 in the single-milestone step-6 flow. */
    milestoneIndex: integer("milestone_index").notNull(),
    /** The verified §8.3 PhaseDelegation / SessionKeyAuthorization, JSON. */
    sessionKeyAuthorization: text("session_key_authorization", { mode: "json" }).notNull(),
    /**
     * The DELEGATION's cryptographic session-key id (`sessionKeyAuthorization.sessionId`),
     * recorded DISTINCTLY from the evidence `sessionId` above (S6-8). This is the id the
     * session signature, expiry, and REVOCATION key off — binding it here makes the
     * evidence-chain ↔ authorization link explicit + queryable (never inferred from the
     * JSON). Nullable/additive; populated at `begin` for every step-6 session.
     */
    delegationSessionId: text("delegation_session_id"),
    /** Window 1 open bound (Unix seconds); authority is invalid before this. */
    notBefore: integer("not_before").notNull(),
    /** Window 2 close bound (Unix seconds); checkpoints accepted only at/before. */
    expiresAt: integer("expires_at").notNull(),
    /** Window 3 close bound (Unix seconds); finalize allowed only at/before. */
    evidenceSubmissionDeadline: integer("evidence_submission_deadline").notNull(),
    /** Lifecycle: `open` | `finalized`. */
    status: text("status").notNull(),
    /** ISO 8601 row-creation timestamp (DB metadata; distinct from the window times). */
    openedAt: text("opened_at").notNull(),
  },
  (t) => ({
    // All sessions for a job (there is one per milestone in step 6).
    byJob: index("evidence_sessions_job_idx").on(t.jobId),
    // UNIQUE(job_id, milestone_index): the DB enforces the one-session-per
    // (job, milestone) rule (§2.1-4) — the endpoint maps a violation to 409.
    // Also serves findByJobMilestone / findOpenByJobMilestone lookups.
    byJobMilestone: uniqueIndex("evidence_sessions_job_milestone_unique").on(
      t.jobId,
      t.milestoneIndex,
    ),
  }),
);
