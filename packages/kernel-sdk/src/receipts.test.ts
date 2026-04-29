import { describe, it, expect } from "vitest";
import { generateEd25519Keypair, signReceipt, canonicalize } from "@pcc/transparency-log";
import {
  composeMilestoneReceipt,
  verifyServerReceipt,
  aggregateSignatures,
  verifyMultiSignedReceipt,
  type MilestoneInput,
  type EvidenceInput,
  type SignersInput,
} from "./receipts.js";

const milestone: MilestoneInput = {
  milestoneId: "ms-week2-001",
  capability: "fdm-3d-printing",
  amountCents: 12500,
  // settlementMode omitted on purpose to exercise the default.
};

const evidence: EvidenceInput = {
  evidenceHash: "ab".repeat(32), // 64-char hex
  timestamp: "2026-04-27T12:00:00Z",
};

const signers: SignersInput = {
  user: "11".repeat(32),
  operator: "22".repeat(32),
};

describe("composeMilestoneReceipt + sign + verifyServerReceipt", () => {
  it("compose+sign+verify roundtrip succeeds end-to-end", () => {
    const { privateKey, publicKey } = generateEd25519Keypair();

    const payload = composeMilestoneReceipt(milestone, evidence, signers);
    expect(payload.settlementMode).toBe("centralized"); // default applied
    expect(payload.milestoneId).toBe("ms-week2-001");
    expect(payload.amountCents).toBe(12500);

    const signed = signReceipt(payload, privateKey);
    expect(signed.signature.length).toBe(128);

    const result = verifyServerReceipt(signed, publicKey);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("kernel-side compose is deterministic across object key order", () => {
    // Re-build the same logical payload but with the inputs constructed
    // in a different field order. Canonicalization must produce identical bytes.
    const a = composeMilestoneReceipt(milestone, evidence, signers);
    const b = composeMilestoneReceipt(
      {
        amountCents: milestone.amountCents,
        capability: milestone.capability,
        milestoneId: milestone.milestoneId,
        settlementMode: "centralized",
      },
      {
        timestamp: evidence.timestamp,
        evidenceHash: evidence.evidenceHash,
      },
      {
        operator: signers.operator,
        user: signers.user,
      },
    );

    const aBytes = canonicalize(a);
    const bBytes = canonicalize(b);
    expect(Buffer.from(aBytes).toString("hex")).toBe(Buffer.from(bBytes).toString("hex"));
  });

  it("verifyServerReceipt returns errors when signature is invalid (tampered payload)", () => {
    const { privateKey } = generateEd25519Keypair();
    const payload = composeMilestoneReceipt(milestone, evidence, signers);
    const signed = signReceipt(payload, privateKey);

    // Mutate the payload but keep the original signature.
    const tampered = {
      ...signed,
      payload: { ...signed.payload, amountCents: 99999 },
    };

    const result = verifyServerReceipt(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("Ed25519 signature"))).toBe(true);
  });

  it("verifyServerReceipt rejects malformed evidence (raw email leak in actorsHashed)", () => {
    expect(() =>
      composeMilestoneReceipt(milestone, evidence, {
        user: "alice@example.com", // not hex — should reject at compose
        operator: signers.operator,
      }),
    ).toThrow();
  });

  it("verifyServerReceipt also fails when expected server key does NOT match the signing key", () => {
    const real = generateEd25519Keypair();
    const other = generateEd25519Keypair();
    const payload = composeMilestoneReceipt(milestone, evidence, signers);
    const signed = signReceipt(payload, real.privateKey);

    // Pretend we expected a DIFFERENT gateway key — must fail with a
    // distinct error, not a generic signature error.
    const result = verifyServerReceipt(signed, other.publicKey);
    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.some((e) => e.includes("does not match expected server key"))).toBe(
      true,
    );
  });
});

describe("multi-signer aggregation", () => {
  it("aggregateSignatures + verifyMultiSignedReceipt round-trips with two co-attesters", () => {
    const kernelA = generateEd25519Keypair();
    const kernelB = generateEd25519Keypair();

    const payload = composeMilestoneReceipt(milestone, evidence, signers);
    const signedA = signReceipt(payload, kernelA.privateKey);
    const signedB = signReceipt(payload, kernelB.privateKey);

    const bundle = aggregateSignatures([signedA, signedB]);
    expect(bundle.signatures).toHaveLength(2);

    const result = verifyMultiSignedReceipt(bundle);
    expect(result.ok).toBe(true);

    // Required-signers gate: both keys present → ok; only kernelA required → ok.
    const result2 = verifyMultiSignedReceipt(bundle, [kernelA.publicKey]);
    expect(result2.ok).toBe(true);
  });
});
