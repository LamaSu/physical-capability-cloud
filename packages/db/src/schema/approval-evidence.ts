import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Approval-as-evidence (D8, settlement-decisions.md) — three tables:
 *
 *   verificationPolicies — pre-agreed acceptance criteria for a job,
 *     snapshotted immutable at negotiation commit (D8: params set
 *     pre-job). One row per policyId. `body` is the full
 *     pcc.verification-policy.v1 JSON document (including policyHash,
 *     for a self-contained row); `policyHash` is also broken out as its
 *     own column for fast lookup/comparison without a JSON parse.
 *
 *   approvalEvidence — signed, evidence-hash-bound approvals submitted
 *     against a policy's human-approval claims. The gateway only carries
 *     + structurally pre-checks these (never authoritative — D1/D8); the
 *     oracle lane (Opus, out of scope here) authenticates the signature
 *     and decides whether a claim clears. `status` starts at "received"
 *     and is stamped "consumed" by the (not-yet-built) /complete wiring
 *     once it has been handed to the oracle — that transition is NOT
 *     performed anywhere in this benign lane.
 *
 *   approvalChallenges — single-use, gateway-issued anti-replay nonces.
 *     Not named in the build spec's 2-table list explicitly, but required
 *     to implement "issue single-use challenge nonces" (approval-service
 *     responsibility) — a nonce that's never registered as issued can't
 *     be checked for freshness/single-use at intake time.
 */

/** One row per policyId — immutable once written (stamped at negotiate commit). */
export const verificationPolicies = sqliteTable("verification_policies", {
  policyId: text("policy_id").primaryKey(),
  jobId: text("job_id").notNull(),
  policyHash: text("policy_hash").notNull(),
  /** Full pcc.verification-policy.v1 JSON document, policyHash included. */
  body: text("body", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  createdAt: text("created_at").notNull(),
});

/** Signed approval-evidence intake — one row per submitted approval. */
export const approvalEvidence = sqliteTable("approval_evidence", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  policyId: text("policy_id").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  /** "approve" | "reject" */
  verdict: text("verdict").notNull(),
  /** "eip191" | "webauthn-p256" */
  sigScheme: text("sig_scheme").notNull(),
  /** Full pcc.approval.v1 JSON document (incl. sig envelope). */
  body: text("body", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  nonce: text("nonce").notNull().unique(),
  /** "received" | "consumed" — "consumed" is stamped by the oracle-lane /complete wiring (out of scope here). */
  status: text("status").notNull().default("received"),
  createdAt: text("created_at").notNull(),
});

/** Single-use challenge nonces issued by POST /api/jobs/:jobId/approval-challenge. */
export const approvalChallenges = sqliteTable("approval_challenges", {
  nonce: text("nonce").primaryKey(),
  jobId: text("job_id").notNull(),
  policyId: text("policy_id"),
  /** Non-authoritative UX preview of the digest the caller is about to sign. */
  digestPreview: text("digest_preview"),
  issuedAt: text("issued_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
});
