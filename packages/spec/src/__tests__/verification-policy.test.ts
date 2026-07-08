/**
 * Tests for approval-as-evidence types in @pcc/spec (pcc.approval.v1 /
 * pcc.verification-policy.v1 — D8).
 *
 * The fixtures in ./fixtures/*.fixture.json are the golden vectors: the
 * oracle-lane implementer (pcc-oracle, standalone repo, no @pcc deps) will
 * copy these JSON files verbatim into their own repo and assert their
 * mirrored approvalSigningPayloadV1/policyHashV1 produce the SAME digests
 * these tests compute. This file proves our own side is deterministic and
 * schema-valid; cross-repo parity is the oracle lane's own test.
 */

import { describe, it, expect } from "vitest";
import approvalFixture from "./fixtures/approval-evidence-v1.fixture.json" with { type: "json" };
import policyFixture from "./fixtures/verification-policy-v1.fixture.json" with { type: "json" };
import {
  approvalSigningPayloadV1,
  approvalDigestV1,
  policyHashV1,
  defaultTrivialPolicy,
  APPROVAL_SCHEMA_V1,
  VERIFICATION_POLICY_SCHEMA_V1,
  APPROVAL_V1_FIELD_ORDER,
  type ApprovalEvidenceV1,
  type VerificationPolicyV1,
} from "../types/verification-policy.js";
import {
  ApprovalEvidenceV1Schema,
  VerificationPolicyV1Schema,
  VerificationPolicyInputV1Schema,
  PolicyClaimClearingSchema,
} from "../schemas/index.js";

// The fixtures are the *signing payload* / *hashable body* shapes (no sig,
// no policyHash) — exactly what approvalSigningPayloadV1/policyHashV1 take.
const approvalBody = approvalFixture as unknown as Omit<ApprovalEvidenceV1, "sig">;
const policyBody = policyFixture as unknown as Omit<VerificationPolicyV1, "policyHash">;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

describe("schema identifiers", () => {
  it("are the exact versioned strings", () => {
    expect(APPROVAL_SCHEMA_V1).toBe("pcc.approval.v1");
    expect(VERIFICATION_POLICY_SCHEMA_V1).toBe("pcc.verification-policy.v1");
  });
});

describe("approvalSigningPayloadV1", () => {
  it("excludes sig and includes every other field in the declared order", () => {
    const payload = approvalSigningPayloadV1(approvalBody);
    expect(payload).not.toHaveProperty("sig");
    // Object.keys preserves insertion order for string keys (V8 guarantee).
    // reasonCode is present in the object (undefined) since this fixture
    // approves; JSON.stringify (below) is what actually drops it.
    expect(Object.keys(payload)).toEqual([...APPROVAL_V1_FIELD_ORDER]);
  });

  it("produces the exact expected canonical JSON string for the fixture", () => {
    const json = JSON.stringify(approvalSigningPayloadV1(approvalBody));
    // reasonCode is absent (undefined, verdict="approve") — JSON.stringify
    // drops it. This locks in the "field order is LOAD-BEARING" contract:
    // any accidental reorder in the implementation breaks this assertion.
    expect(json).toBe(
      '{"schema":"pcc.approval.v1","jobId":"job-fixture-0001","escrowAddress":"0x71b9E1AbF447574F6df52B4468BC12a45692AD2a","milestoneIndex":0,"evidenceHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","policyId":"policy-fixture-0001","claimIds":["payer-accepts"],"verdict":"approve","approverRole":"payer","approverId":"payer-test-0x9f8b","issuedAt":"2026-07-08T00:00:00.000Z","expiresAt":"2026-07-11T00:00:00.000Z","nonce":"nonce-fixture-0001"}',
    );
  });

  it("drops reasonCode when absent but keeps it when present (reject verdict)", () => {
    const rejectBody: Omit<ApprovalEvidenceV1, "sig"> = {
      ...approvalBody,
      verdict: "reject",
      reasonCode: "surface-defect",
    };
    const json = JSON.stringify(approvalSigningPayloadV1(rejectBody));
    expect(json).toContain('"reasonCode":"surface-defect"');
    expect(JSON.stringify(approvalSigningPayloadV1(approvalBody))).not.toContain("reasonCode");
  });
});

describe("approvalDigestV1", () => {
  it("returns a well-formed sha256 digest", async () => {
    const digest = await approvalDigestV1(approvalBody);
    expect(digest).toMatch(SHA256_RE);
  });

  it("is deterministic across repeated calls", async () => {
    const d1 = await approvalDigestV1(approvalBody);
    const d2 = await approvalDigestV1(approvalBody);
    expect(d1).toBe(d2);
  });

  it("changes when any signed field changes", async () => {
    const base = await approvalDigestV1(approvalBody);
    const mutated = await approvalDigestV1({ ...approvalBody, milestoneIndex: 1 });
    expect(mutated).not.toBe(base);
  });

  it("is stable regardless of source object key-insertion order", async () => {
    // Build an equivalent object with a DIFFERENT insertion order to prove
    // the digest depends on approvalSigningPayloadV1's fixed order, not on
    // whatever order the caller happened to construct their object in.
    const reordered: Omit<ApprovalEvidenceV1, "sig"> = {
      nonce: approvalBody.nonce,
      expiresAt: approvalBody.expiresAt,
      issuedAt: approvalBody.issuedAt,
      approverId: approvalBody.approverId,
      approverRole: approvalBody.approverRole,
      verdict: approvalBody.verdict,
      claimIds: approvalBody.claimIds,
      policyId: approvalBody.policyId,
      evidenceHash: approvalBody.evidenceHash,
      milestoneIndex: approvalBody.milestoneIndex,
      escrowAddress: approvalBody.escrowAddress,
      jobId: approvalBody.jobId,
      schema: approvalBody.schema,
    };
    expect(await approvalDigestV1(reordered)).toBe(await approvalDigestV1(approvalBody));
  });
});

describe("policyHashV1", () => {
  it("returns a well-formed sha256 digest", async () => {
    const hash = await policyHashV1(policyBody);
    expect(hash).toMatch(SHA256_RE);
  });

  it("is deterministic across repeated calls", async () => {
    const h1 = await policyHashV1(policyBody);
    const h2 = await policyHashV1(policyBody);
    expect(h1).toBe(h2);
  });

  it("changes when a claim changes", async () => {
    const base = await policyHashV1(policyBody);
    const mutated = await policyHashV1({
      ...policyBody,
      claims: [...policyBody.claims, { claimId: "extra", statement: "extra claim", clearing: { kind: "machine-tier" } }],
    });
    expect(mutated).not.toBe(base);
  });
});

describe("defaultTrivialPolicy", () => {
  it("synthesizes a single machine-tier claim at the given baseTier", () => {
    const policy = defaultTrivialPolicy("job-abc", 2);
    expect(policy.schema).toBe(VERIFICATION_POLICY_SCHEMA_V1);
    expect(policy.jobId).toBe("job-abc");
    expect(policy.baseTier).toBe(2);
    expect(policy.composition).toBe("all");
    expect(policy.claims).toHaveLength(1);
    expect(policy.claims[0]!.clearing).toEqual({ kind: "machine-tier" });
  });

  it("hashes deterministically once policyHashV1 is applied", async () => {
    const policy = defaultTrivialPolicy("job-abc", 0);
    const h1 = await policyHashV1(policy);
    const h2 = await policyHashV1(policy);
    expect(h1).toBe(h2);
  });
});

describe("ApprovalEvidenceV1Schema", () => {
  const validEip191: ApprovalEvidenceV1 = {
    ...approvalBody,
    sig: {
      scheme: "eip191",
      address: "0x9f8bC1a2D3e4F5061728394a5b6c7d8e9f0a1b2c",
      signature: "0xdeadbeef",
    },
  };

  it("accepts a valid approve-verdict approval", () => {
    expect(ApprovalEvidenceV1Schema.safeParse(validEip191).success).toBe(true);
  });

  it("rejects a reject-verdict approval with no reasonCode", () => {
    const rejectNoReason = { ...validEip191, verdict: "reject" as const };
    const result = ApprovalEvidenceV1Schema.safeParse(rejectNoReason);
    expect(result.success).toBe(false);
  });

  it("accepts a reject-verdict approval WITH reasonCode", () => {
    const rejectWithReason = { ...validEip191, verdict: "reject" as const, reasonCode: "surface-defect" };
    expect(ApprovalEvidenceV1Schema.safeParse(rejectWithReason).success).toBe(true);
  });

  it("rejects a malformed evidenceHash", () => {
    const bad = { ...validEip191, evidenceHash: "not-a-hash" };
    expect(ApprovalEvidenceV1Schema.safeParse(bad).success).toBe(false);
  });

  it("accepts a valid webauthn-p256 signature envelope", () => {
    const webauthn: ApprovalEvidenceV1 = {
      ...approvalBody,
      sig: {
        scheme: "webauthn-p256",
        credentialId: "cred-123",
        publicKey: "pub-123",
        signature: "sig-123",
        authenticatorData: "authdata-123",
        clientDataJSON: "clientdata-123",
      },
    };
    expect(ApprovalEvidenceV1Schema.safeParse(webauthn).success).toBe(true);
  });

  it("rejects an unknown sig scheme", () => {
    const bad = { ...validEip191, sig: { scheme: "rsa", address: "0x00" } };
    expect(ApprovalEvidenceV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe("VerificationPolicyV1Schema", () => {
  it("accepts the fixture once a policyHash is attached", async () => {
    const policyHash = await policyHashV1(policyBody);
    const full = { ...policyBody, policyHash };
    expect(VerificationPolicyV1Schema.safeParse(full).success).toBe(true);
  });

  it("rejects a policy with zero claims", async () => {
    const policyHash = await policyHashV1(policyBody);
    const empty = { ...policyBody, claims: [], policyHash };
    expect(VerificationPolicyV1Schema.safeParse(empty).success).toBe(false);
  });

  it("rejects composition values other than 'all'", async () => {
    const policyHash = await policyHashV1(policyBody);
    const bad = { ...policyBody, policyHash, composition: "any" };
    expect(VerificationPolicyV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe("VerificationPolicyInputV1Schema", () => {
  it("accepts a buyer-supplied proposal with no policyId/jobId/policyHash/createdAt", () => {
    const input = {
      baseTier: 1,
      claims: policyBody.claims,
      composition: "all" as const,
    };
    expect(VerificationPolicyInputV1Schema.safeParse(input).success).toBe(true);
  });

  it("accepts a proposal with baseTier omitted (server derives it)", () => {
    const input = { claims: policyBody.claims, composition: "all" as const };
    expect(VerificationPolicyInputV1Schema.safeParse(input).success).toBe(true);
  });
});

describe("PolicyClaimClearingSchema — reserved kinds", () => {
  it("accepts the reserved committee/zk-proof kinds structurally (not yet enforced)", () => {
    expect(PolicyClaimClearingSchema.safeParse({ kind: "committee" }).success).toBe(true);
    expect(PolicyClaimClearingSchema.safeParse({ kind: "zk-proof" }).success).toBe(true);
  });

  it("rejects an unknown clearing kind", () => {
    expect(PolicyClaimClearingSchema.safeParse({ kind: "vibes" }).success).toBe(false);
  });
});
