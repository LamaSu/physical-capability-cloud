/**
 * Approval-as-Evidence — pcc.approval.v1 / pcc.verification-policy.v1
 *
 * Human approval becomes a signed, evidence-hash-bound, oracle-authenticated
 * INPUT — one more clearing condition inside the oracle's verification
 * policy — never a release rail (D1-D3: the oracle is the sole settlement
 * gate and fee carrier). Success parameters (the policy's claims) are agreed
 * BEFORE the job runs (D8); the oracle's job is to verify those were met.
 *
 * See: C:\Users\globa\ai\research\approval-as-evidence-build-spec.md (§1)
 *      C:\Users\globa\ai\research\pcc-wiki\settlement-decisions.md (D8)
 *
 * Boundary: this file defines shapes + pure canonicalization/hashing only.
 * Signature VERIFICATION (recovering an address from a signature, checking
 * a WebAuthn assertion) is oracle-authoritative and lives in pcc-oracle
 * (mirrored by value there — pcc-oracle has no @pcc deps). Anything in the
 * gateway that uses the functions here is a non-authoritative UX pre-check
 * only — never the settlement verdict.
 */

import { canonicalize, sha256 } from "../util/canonical.js";
import type { SHA256, Id, Timestamp, AssuranceTier } from "./common.js";

// ── Schema identifiers ───────────────────────────────────────────────────

export const APPROVAL_SCHEMA_V1 = "pcc.approval.v1" as const;
export const VERIFICATION_POLICY_SCHEMA_V1 = "pcc.verification-policy.v1" as const;

// ── pcc.approval.v1 ────────────────────────────────────────────────────────

export type ApprovalVerdict = "approve" | "reject";
export type ApproverRole = "payer" | "expert";

/** eip191 personal_sign — slice increment 1 (test wallets prove the architecture first). */
export interface ApprovalSignatureEip191 {
  scheme: "eip191";
  address: `0x${string}`;
  signature: string;
}

/** WebAuthn P-256 passkey assertion — slice increment 2 (mobile). */
export interface ApprovalSignatureWebauthnP256 {
  scheme: "webauthn-p256";
  credentialId: string;
  publicKey: string;
  signature: string;
  authenticatorData: string;
  clientDataJSON: string;
}

export type ApprovalSignature = ApprovalSignatureEip191 | ApprovalSignatureWebauthnP256;

/**
 * The unit the oracle authenticates. Signed-field ordering is LOAD-BEARING
 * — see APPROVAL_V1_FIELD_ORDER / approvalSigningPayloadV1 below. Mirrors
 * the convention at pcc-oracle/src/types.ts:39-47 ("Field order is
 * LOAD-BEARING").
 */
export interface ApprovalEvidenceV1 {
  schema: typeof APPROVAL_SCHEMA_V1;
  jobId: Id;
  /** 0x… — binds to the escrow being settled. */
  escrowAddress: string;
  milestoneIndex: number;
  /**
   * "sha256:<hex>" — the WORK bundle hash this approval approves. References
   * the already-committed hash (commit-then-reveal: the bundle hash is
   * computed at /complete BEFORE the approval exists) — so no
   * evidence-shopping, no approve-then-swap.
   */
  evidenceHash: string;
  /** The pre-agreed policy this approval satisfies (D8: params set pre-job). */
  policyId: Id;
  /** Which policy claims this clears, e.g. ["payer-accepts"]. */
  claimIds: string[];
  /** Rejection is ALSO evidence (reasoned-rejection rule). */
  verdict: ApprovalVerdict;
  /** REQUIRED when verdict === "reject" — enters the dispute record. */
  reasonCode?: string;
  approverRole: ApproverRole;
  /** Operator/user id bound in the policy at job creation. */
  approverId: string;
  issuedAt: Timestamp;
  /** Freshness bound — stale approvals are not evidence. */
  expiresAt: Timestamp;
  /** Gateway-issued single-use challenge nonce (anti-replay). */
  nonce: string;
  sig: ApprovalSignature;
}

/**
 * The exact, declared order used to build the signing payload. LOAD-BEARING:
 * the gateway, the oracle (mirrored by value there), and every signer
 * (mobile, test wallets) MUST build the payload object by inserting keys in
 * this order — JS/V8 guarantees insertion order is preserved for string
 * keys in JSON.stringify, so the resulting string (and its hash) is only
 * stable across implementations if every one of them inserts in the same
 * order. Do not reorder without bumping the schema version.
 */
export const APPROVAL_V1_FIELD_ORDER: readonly (keyof Omit<ApprovalEvidenceV1, "sig">)[] = [
  "schema",
  "jobId",
  "escrowAddress",
  "milestoneIndex",
  "evidenceHash",
  "policyId",
  "claimIds",
  "verdict",
  "reasonCode",
  "approverRole",
  "approverId",
  "issuedAt",
  "expiresAt",
  "nonce",
];

/**
 * Builds the canonical signing payload for an approval — every field
 * EXCEPT `sig`, inserted in the fixed declared order above. `JSON.stringify`
 * drops the `reasonCode` key entirely when it is `undefined` (verdict ===
 * "approve"); that is intentional and must be replicated identically by
 * every implementation (including the oracle-side mirror).
 */
export function approvalSigningPayloadV1(
  a: Omit<ApprovalEvidenceV1, "sig">,
): Record<string, unknown> {
  return {
    schema: a.schema,
    jobId: a.jobId,
    escrowAddress: a.escrowAddress,
    milestoneIndex: a.milestoneIndex,
    evidenceHash: a.evidenceHash,
    policyId: a.policyId,
    claimIds: a.claimIds,
    verdict: a.verdict,
    reasonCode: a.reasonCode,
    approverRole: a.approverRole,
    approverId: a.approverId,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    nonce: a.nonce,
  };
}

/**
 * digest = sha256(canonical signing payload). For the `eip191` scheme this
 * digest's "sha256:<hex>" string form IS the personal_sign message. For
 * `webauthn-p256` this digest IS the WebAuthn challenge (the authenticator
 * signs `authenticatorData || sha256(clientDataJSON)`, and the verifier
 * checks `clientDataJSON.challenge === this digest`).
 */
export async function approvalDigestV1(
  a: Omit<ApprovalEvidenceV1, "sig">,
): Promise<SHA256> {
  return sha256(JSON.stringify(approvalSigningPayloadV1(a)));
}

// ── pcc.verification-policy.v1 ──────────────────────────────────────────────

/** Registered AT POLICY CREATION — the trust binding the oracle authenticates against. */
export interface ApproverKey {
  scheme: "eip191" | "webauthn-p256";
  /** Address (eip191) or credentialId (webauthn). */
  keyId: string;
  /** webauthn: stored P-256 public key from enrollment. */
  publicKey?: string;
}

/**
 * How a claim clears. `machine-tier` / `human-approval` / `window-lapse`
 * are built this slice. `committee` / `zk-proof` are RESERVED — designed
 * into the enum now (N-of-M / Lit-threshold-decrypt / ZK plug in as
 * additional clearing conditions later), not built yet. None of the
 * reserved kinds require re-architecting when they land — they are all new
 * clearing conditions behind the same oracle gate.
 */
export type PolicyClaimClearing =
  | { kind: "machine-tier" }
  | {
      kind: "human-approval";
      approverRole: ApproverRole;
      approverKeys: ApproverKey[];
      /** Approval window (seconds) after evidence is on file. */
      windowSecs: number;
      /**
       * "approve" = default-approve on silence (anti-extortion, philosophy
       * §5.4). "hold" = wait (conservative default for this slice).
       */
      onLapse: "approve" | "hold";
    }
  | { kind: "window-lapse"; windowSecs: number }
  | { kind: "committee" } // RESERVED — not built this slice
  | { kind: "zk-proof" }; // RESERVED — not built this slice

export interface PolicyClaim {
  claimId: string;
  /** The acceptance criterion, human-readable — agreed BEFORE work runs. */
  statement: string;
  /** Advisory objectivity band (philosophy §2.1); not enforced in this slice. */
  band?: "B1" | "B2" | "B3" | "B4" | "B5";
  clearing: PolicyClaimClearing;
}

/**
 * Pre-agreed at job creation (D8). Generalizes the static
 * TIER_REQUIREMENTS table (evidence-checker.ts) into a per-job document.
 * `createdAt` is set at negotiate commit; the row is immutable after
 * COMMITTED — same convention as the OperatorPolicy constraints snapshot
 * taken at session creation (negotiation.ts).
 */
export interface VerificationPolicyV1 {
  schema: typeof VERIFICATION_POLICY_SCHEMA_V1;
  policyId: Id;
  jobId: Id;
  /** sha256 over the canonical body (excl. this field) — the pre-agreement anchor. */
  policyHash: string;
  /** Existing tier checks REMAIN the machine floor — never lowered while adding a new one. */
  baseTier: AssuranceTier;
  claims: PolicyClaim[];
  /** Slice: required claims AND together (philosophy §5.2 step 4). */
  composition: "all";
  createdAt: Timestamp;
}

/**
 * Buyer-supplied policy proposal at negotiate time. The server stamps
 * `policyId` / `jobId` / `policyHash` / `createdAt` — none of those are
 * caller-settable (they are the pre-agreement anchor, not a claim).
 */
export interface VerificationPolicyInputV1 {
  /** Omitted -> derive from the session's already-agreed assurance tier. */
  baseTier?: AssuranceTier;
  claims: PolicyClaim[];
  composition: "all";
}

/**
 * sha256 over the canonical (sorted-key) JSON of the policy body, excluding
 * `policyHash` itself. Uses the general-purpose `canonicalize()` helper
 * (recursive key-sort) rather than a fixed field order like the approval
 * digest, because the policy body nests arrays of claims/approverKeys and
 * no external wallet hand-signs this hash the way it signs the approval
 * digest — only the gateway and the oracle need to agree on it.
 */
export async function policyHashV1(
  policy: Omit<VerificationPolicyV1, "policyHash">,
): Promise<SHA256> {
  return sha256(canonicalize(policy));
}

/**
 * The "no policy supplied" default — a single machine-tier claim at the
 * session's agreed baseTier. Exists so exactly ONE code path exists
 * downstream (the oracle lane never has to special-case "no policy"; a
 * job either satisfies a real policy or this trivial one).
 */
export function defaultTrivialPolicy(
  jobId: Id,
  baseTier: AssuranceTier,
): Omit<VerificationPolicyV1, "policyHash"> {
  return {
    schema: VERIFICATION_POLICY_SCHEMA_V1,
    policyId: `policy-${jobId}-trivial`,
    jobId,
    baseTier,
    claims: [
      {
        claimId: "machine-tier",
        statement: `Evidence meets the machine-checked baseline for assurance tier ${baseTier}.`,
        clearing: { kind: "machine-tier" },
      },
    ],
    composition: "all",
    createdAt: new Date().toISOString(),
  };
}
