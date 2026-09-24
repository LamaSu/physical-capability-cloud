import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Milestone packages — the persisted claim-free FinalMilestonePackage and its
 * settlement-boundary PackageReceipt (§8.4-B, object §8.3 L317-324), produced by
 * `POST /api/jobs/:jobId/evidence/finalize` (spec §2.3).
 *
 * One row per finalized (job, milestone). The package aggregates already-accepted
 * checkpoint hashes into `evidenceRoot = merkleRoot(acceptedCheckpointHashes)`
 * and is content-addressed by `packageHash = sha256(canonical package bytes)`.
 * Both names are kept DISTINCT here (spec §2.3 naming rule): `evidenceRoot` is a
 * Merkle root over the chain; `packageHash` is what `GET /api/evidence/:hash`
 * serves and the oracle re-hashes — conflating them breaks fetch-and-verify.
 *
 * `body` is the full FinalMilestonePackage JSON; `receiptBody` the PackageReceipt
 * JSON — both stored for a lossless round-trip. The finalize trigger is
 * permissionless-in-principle (§8.1-#1), so re-finalize is idempotent: the
 * deterministic PK `fmp-<jobId>-<milestoneIndex>` + UNIQUE(job_id, milestone_index)
 * fail-close a second row.
 *
 * `acceptedAt` = the window-3 boundary time (finalize receivedAt), Unix SECONDS;
 * `createdAt` = ISO 8601 row metadata (mirrors gateway_receipts.createdAt).
 *
 * ADDITIVE + NON-BREAKING: backs the step-6 finalize path only.
 */
export const milestonePackages = sqliteTable(
  "milestone_packages",
  {
    /** Deterministic id `fmp-<jobId>-<milestoneIndex>`; PK. */
    packageId: text("package_id").primaryKey(),
    jobId: text("job_id").notNull(),
    milestoneIndex: integer("milestone_index").notNull(),
    sessionId: text("session_id").notNull(),
    /** MerkleRoot(acceptedCheckpointHashes) — verifiable against the receipt chain. */
    evidenceRoot: text("evidence_root").notNull(),
    /** sha256 of the canonical package document — the servable/anchorable unit. */
    packageHash: text("package_hash").notNull(),
    /** The PackageReceipt id `fmprcpt-<jobId>-<milestoneIndex>`. */
    receiptId: text("receipt_id").notNull(),
    /** Full FinalMilestonePackage JSON (round-trip). */
    body: text("body", { mode: "json" }).notNull(),
    /** Full PackageReceipt JSON (round-trip). */
    receiptBody: text("receipt_body", { mode: "json" }).notNull(),
    /** Window-3 boundary time = finalize receivedAt, Unix SECONDS. */
    acceptedAt: integer("accepted_at").notNull(),
    /** ISO 8601 row-creation timestamp (DB metadata; distinct from acceptedAt). */
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    byJob: index("milestone_packages_job_idx").on(t.jobId),
    // UNIQUE(job_id, milestone_index): one finalized package per (job, milestone);
    // permissionless re-finalize is idempotent (§2.3-6). Also serves
    // findByJobMilestone.
    byJobMilestone: uniqueIndex("milestone_packages_job_milestone_unique").on(
      t.jobId,
      t.milestoneIndex,
    ),
  }),
);
