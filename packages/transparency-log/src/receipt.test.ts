import { describe, it, expect } from "vitest";
import {
  signReceipt,
  verifyReceipt,
  canonicalize,
  generateEd25519Keypair,
  ReceiptPayloadSchema,
} from "./receipt.js";
import type { ReceiptPayload } from "./receipt.js";

const sampleHash = "1".repeat(64);
const samplePayload: ReceiptPayload = {
  milestoneId: "ms-001",
  capability: "fdm-3d-printing",
  actorsHashed: { user: "a".repeat(64), operator: "b".repeat(64) },
  amountCents: 12500,
  evidenceHash: sampleHash,
  timestamp: "2026-04-27T00:00:00Z",
  settlementMode: "centralized",
};

describe("Receipt sign/verify", () => {
  it("sign+verify roundtrip succeeds with the matching key", () => {
    const { privateKey, publicKey } = generateEd25519Keypair();
    const signed = signReceipt(samplePayload, privateKey);
    expect(signed.signature.length).toBe(128);
    expect(signed.signerPublicKey.length).toBe(64);
    expect(verifyReceipt(signed, publicKey)).toBe(true);
    expect(verifyReceipt(signed)).toBe(true); // self-attesting check is valid
  });

  it("tampered payload fails verification (signature was bound to original bytes)", () => {
    const { privateKey } = generateEd25519Keypair();
    const signed = signReceipt(samplePayload, privateKey);

    // Mutate the payload but keep the signature unchanged.
    const tampered = {
      ...signed,
      payload: { ...signed.payload, amountCents: 999_999 },
    };
    expect(verifyReceipt(tampered)).toBe(false);
  });

  it("canonicalize is deterministic regardless of object key insertion order", () => {
    const a: ReceiptPayload = { ...samplePayload };
    // Same fields, but key order varies by construction.
    const b: ReceiptPayload = {
      timestamp: samplePayload.timestamp,
      settlementMode: samplePayload.settlementMode,
      milestoneId: samplePayload.milestoneId,
      amountCents: samplePayload.amountCents,
      evidenceHash: samplePayload.evidenceHash,
      capability: samplePayload.capability,
      actorsHashed: {
        operator: samplePayload.actorsHashed.operator,
        user: samplePayload.actorsHashed.user,
      },
    };
    const aBytes = canonicalize(a);
    const bBytes = canonicalize(b);
    expect(Buffer.from(aBytes).toString("hex")).toBe(Buffer.from(bBytes).toString("hex"));
  });

  it("schema rejects malformed payloads (non-hex evidenceHash, raw email leak, negative amount)", () => {
    expect(() =>
      ReceiptPayloadSchema.parse({
        ...samplePayload,
        evidenceHash: "not-hex!",
      }),
    ).toThrow();

    expect(() =>
      ReceiptPayloadSchema.parse({
        ...samplePayload,
        actorsHashed: { user: "alice@example.com", operator: samplePayload.actorsHashed.operator },
      }),
    ).toThrow(); // "@" / "." not in hex charset

    expect(() =>
      ReceiptPayloadSchema.parse({
        ...samplePayload,
        amountCents: -1,
      }),
    ).toThrow();

    expect(() =>
      ReceiptPayloadSchema.parse({
        ...samplePayload,
        settlementMode: "magic-mode" as unknown as "centralized",
      }),
    ).toThrow();
  });
});
