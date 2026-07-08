/**
 * Approval-as-evidence intake service (D8, settlement-decisions.md).
 *
 * Owns three things, all BENIGN and NON-AUTHORITATIVE:
 *   1. Issuing single-use challenge nonces + a best-effort digest preview
 *      (UX only — lets the Approve card show "you're approving digest X"
 *      before the user signs).
 *   2. Structurally pre-checking a submitted ApprovalEvidenceV1 (shape,
 *      expiry, nonce freshness, binding to a known policy) — this is a
 *      fail-fast convenience, NEVER the settlement verdict. The oracle
 *      authenticates the signature and decides whether a claim clears;
 *      nothing here does signature verification/recovery.
 *   3. Persisting intake'd approvals so the (not-yet-built) /complete
 *      wiring can read them and hand them to the oracle's /verify call.
 *
 * Boundary: this file never touches paid-job-flow.ts, oracle-client.ts, or
 * any settlement/oracle call. See approval-as-evidence-build-spec.md §2
 * Lane B and the HARD BOUNDARIES section of the task that produced this
 * file for the full rationale.
 */

import crypto from "node:crypto";
import { schema, eq, desc } from "@pcc/store";
import {
  type Result,
  ok,
  err,
  Errors,
  ApprovalEvidenceV1Schema,
  type ApprovalEvidenceV1,
  type PolicyClaim,
  approvalDigestV1,
} from "@pcc/spec";
import { getStore, getRepos } from "../db.js";

const { verificationPolicies, approvalEvidence, approvalChallenges } = schema;

/** How long an issued challenge nonce stays usable before it must be re-issued. */
export const APPROVAL_CHALLENGE_TTL_MS = 15 * 60_000;

export interface IssuedChallenge {
  nonce: string;
  /** Non-authoritative UX preview — null when no evidence is on file yet to hash. */
  digestPreview: string | null;
  policyClaims: PolicyClaim[];
  expiresAt: string;
}

/**
 * Loads the verification policy snapshot for a job (set at negotiation
 * commit — see routes/negotiation.ts). Returns undefined if the job never
 * had one committed (pre-D8 session, or the best-effort snapshot write
 * failed) — callers should treat "no policy" as "machine-tier only",
 * mirroring @pcc/spec's defaultTrivialPolicy().
 */
export function getPolicyForJob(
  jobId: string,
): typeof verificationPolicies.$inferSelect | undefined {
  const { db } = getStore();
  return db
    .select()
    .from(verificationPolicies)
    .where(eq(verificationPolicies.jobId, jobId))
    .get();
}

/**
 * Issues a single-use challenge nonce for a job, with a best-effort digest
 * preview of the approval the caller is about to build (uses the job's
 * latest evidence bundle hash if one exists yet; null otherwise — the
 * caller signs the REAL evidenceHash at submit time regardless of what
 * this preview showed).
 */
export function issueChallenge(jobId: string): Result<IssuedChallenge> {
  const { db } = getStore();
  const now = new Date();
  const nonce = `chal-${crypto.randomUUID()}`;
  const expiresAt = new Date(now.getTime() + APPROVAL_CHALLENGE_TTL_MS).toISOString();

  const policyRow = getPolicyForJob(jobId);
  const policyClaims = (policyRow?.body as { claims?: PolicyClaim[] } | undefined)?.claims ?? [];

  // Best-effort preview only — never blocks challenge issuance.
  let digestPreview: string | null = null;
  try {
    const bundles = getRepos().evidence.findByJob(jobId);
    const latest = bundles.length > 0 ? bundles[bundles.length - 1] : undefined;
    if (latest && policyRow) {
      // Synthetic preview payload — real values (escrowAddress, claimIds,
      // approverRole/Id, issuedAt/expiresAt) are only known once the caller
      // actually builds their approval. This preview exists purely so a UI
      // can render "digest of the evidence you're about to approve".
      digestPreview = latest.bundleHash ?? null;
    }
  } catch {
    // best-effort — evidence lookup failures never block challenge issuance
  }

  db.insert(approvalChallenges)
    .values({
      nonce,
      jobId,
      policyId: policyRow?.policyId ?? null,
      digestPreview,
      issuedAt: now.toISOString(),
      expiresAt,
      consumedAt: null,
    })
    .run();

  return ok({ nonce, digestPreview, policyClaims, expiresAt });
}

/**
 * Structural pre-check of a submitted approval — shape, expiry, nonce
 * freshness, binding to a known policy. NEVER authoritative: does not
 * verify `sig` in any way. A gateway PASS here is "well-formed enough to
 * carry to the oracle", not "cryptographically valid".
 */
function preCheckIntake(body: unknown): Result<ApprovalEvidenceV1> {
  const parsed = ApprovalEvidenceV1Schema.safeParse(body);
  if (!parsed.success) {
    return Errors.badRequestWithHint(
      `Malformed approval: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      "Validate the approval against pcc.approval.v1 (@pcc/spec ApprovalEvidenceV1Schema) before submitting.",
    );
  }
  const approval = parsed.data as ApprovalEvidenceV1;

  if (new Date(approval.expiresAt).getTime() < Date.now()) {
    return err("APPROVAL_EXPIRED", "Approval's expiresAt has already passed", 410, { retryable: false });
  }

  const { db } = getStore();
  const challengeRow = db
    .select()
    .from(approvalChallenges)
    .where(eq(approvalChallenges.nonce, approval.nonce))
    .get();
  if (!challengeRow) {
    return Errors.badRequestWithHint(
      "Nonce was not issued by this gateway (or has already rotated out)",
      "Call POST /api/jobs/:jobId/approval-challenge first and embed the returned nonce.",
    );
  }
  if (challengeRow.consumedAt) {
    return err("NONCE_ALREADY_USED", "This challenge nonce has already been consumed", 409, { retryable: false });
  }
  if (new Date(challengeRow.expiresAt).getTime() < Date.now()) {
    return err("CHALLENGE_EXPIRED", "The challenge nonce has expired — request a fresh one", 410, { retryable: true });
  }
  if (challengeRow.jobId !== approval.jobId) {
    return Errors.badRequest("nonce is not bound to this jobId");
  }

  const policyRow = db
    .select()
    .from(verificationPolicies)
    .where(eq(verificationPolicies.policyId, approval.policyId))
    .get();
  if (!policyRow) {
    return Errors.notFoundWithHint(
      "policy",
      approval.policyId,
      "Fetch the job's committed policy (negotiation session snapshot) before building an approval against it.",
    );
  }
  if (policyRow.jobId !== approval.jobId) {
    return Errors.badRequest("policyId is not bound to this jobId");
  }

  return ok(approval);
}

/**
 * Validates + persists a submitted approval. Marks the matching challenge
 * nonce consumed in the same call. Returns the persisted row's id.
 */
export function submitApproval(
  jobId: string,
  body: unknown,
): Result<{ id: string; status: string }> {
  const checked = preCheckIntake(body);
  if (!checked.success) return checked;
  const approval = checked.data;

  if (approval.jobId !== jobId) {
    return Errors.badRequest("Approval body jobId does not match the URL jobId");
  }

  const { db } = getStore();
  const id = `appr-${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();

  try {
    db.insert(approvalEvidence)
      .values({
        id,
        jobId: approval.jobId,
        policyId: approval.policyId,
        evidenceHash: approval.evidenceHash,
        verdict: approval.verdict,
        sigScheme: approval.sig.scheme,
        body: approval as unknown as Record<string, unknown>,
        nonce: approval.nonce,
        status: "received",
        createdAt: now,
      })
      .run();
  } catch (e) {
    // UNIQUE(nonce) violation — the pre-check above already rejects a
    // consumed nonce, but a concurrent duplicate submit can still race
    // past that read. The UNIQUE constraint is the real guard; this just
    // turns the low-level SQLite error into a clean 409.
    return err("NONCE_ALREADY_USED", "This challenge nonce has already been consumed", 409, {
      retryable: false,
      details: { cause: e instanceof Error ? e.message : String(e) },
    });
  }

  db.update(approvalChallenges)
    .set({ consumedAt: now })
    .where(eq(approvalChallenges.nonce, approval.nonce))
    .run();

  return ok({ id, status: "received" });
}

/** Lists all approvals submitted for a job, most recent first. */
export function listApprovals(jobId: string): Array<typeof approvalEvidence.$inferSelect> {
  const { db } = getStore();
  return db
    .select()
    .from(approvalEvidence)
    .where(eq(approvalEvidence.jobId, jobId))
    .orderBy(desc(approvalEvidence.createdAt))
    .all();
}

// approvalDigestV1 is re-exported for callers (e.g. tests, future mobile
// signer stubs) that want to compute the SAME digest a real signer would
// sign, without reaching into @pcc/spec directly.
export { approvalDigestV1 };
