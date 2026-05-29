/**
 * SP1 zk verifier tests.
 *
 * Mocks the SP1 SDK hook + (optionally) the on-chain RPC.
 */

import { describe, it, expect } from "vitest";
import { verifySp1Proof } from "../sp1-verifier.js";
import { verifyZkProof } from "../index.js";
import type { ZkProofMetadata } from "@pcc/spec";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa === "function"
    ? btoa(bin)
    : Buffer.from(bin, "binary").toString("base64");
}

const SAMPLE_PROOF = bytesToBase64(new Uint8Array(64).fill(0xaa));

const baseMetadata: ZkProofMetadata = {
  zkSystem: "sp1",
  statement: "tee-wrap",
  programCid: "ipfs://sample",
  publicInputsHash: "sha256:" + "a".repeat(64),
  publicOutputsHash: "sha256:" + "b".repeat(64),
  verificationKeyHash: "vk-sha256:" + "c".repeat(64),
};

describe("verifySp1Proof — happy path", () => {
  it("SP1 hook returns valid → valid", async () => {
    const res = await verifySp1Proof(SAMPLE_PROOF, baseMetadata, {
      sp1Verify: async () => ({ valid: true }),
    });
    expect(res.valid).toBe(true);
    expect(res.vkMatch).toBe(true);
    expect(res.system).toBe("sp1");
    expect(res.statement).toBe("tee-wrap");
  });

  it("acceptUnverifiedInTest with non-empty vk hash → valid", async () => {
    const res = await verifySp1Proof(SAMPLE_PROOF, baseMetadata, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(true);
  });

  it("on-chain double-check matches → still valid", async () => {
    const res = await verifySp1Proof(
      SAMPLE_PROOF,
      { ...baseMetadata, onchainVerifier: { chainId: 84532, address: "0x" + "1".repeat(40) } },
      {
        sp1Verify: async () => ({ valid: true }),
        onchainVerifierRpc: async () => ({ valid: true }),
      },
    );
    expect(res.valid).toBe(true);
  });
});

describe("verifySp1Proof — failures", () => {
  it("SP1 hook returns invalid → invalid", async () => {
    const res = await verifySp1Proof(SAMPLE_PROOF, baseMetadata, {
      sp1Verify: async () => ({ valid: false, reason: "Groth16 pairing failed" }),
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/Groth16 pairing failed/);
  });

  it("proof too short → invalid", async () => {
    const tiny = bytesToBase64(new Uint8Array(10));
    const res = await verifySp1Proof(tiny, baseMetadata, {
      acceptUnverifiedInTest: true,
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/proof too short/);
  });

  it("no sp1Verify wired and not test-mode → invalid", async () => {
    const res = await verifySp1Proof(SAMPLE_PROOF, baseMetadata);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/no sp1Verify backend wired/);
  });

  it("on-chain double-check disagrees → invalid", async () => {
    const res = await verifySp1Proof(
      SAMPLE_PROOF,
      { ...baseMetadata, onchainVerifier: { chainId: 84532, address: "0x" + "1".repeat(40) } },
      {
        sp1Verify: async () => ({ valid: true }),
        onchainVerifierRpc: async () => ({ valid: false, reason: "chain says no" }),
      },
    );
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/on-chain double-check failed/);
  });

  it("sp1 hook throws → caught + reported", async () => {
    const res = await verifySp1Proof(SAMPLE_PROOF, baseMetadata, {
      sp1Verify: async () => {
        throw new Error("vk file missing");
      },
    });
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/vk file missing/);
  });
});

describe("verifyZkProof dispatcher", () => {
  it("dispatches sp1 to verifySp1Proof", async () => {
    const res = await verifyZkProof(SAMPLE_PROOF, baseMetadata, {
      sp1Verify: async () => ({ valid: true }),
    });
    expect(res.system).toBe("sp1");
    expect(res.valid).toBe(true);
  });

  it("dispatches risc0 to verifyRisc0Proof", async () => {
    const r0 = { ...baseMetadata, zkSystem: "risc0" as const };
    const res = await verifyZkProof(SAMPLE_PROOF, r0, {
      risc0Verify: async () => ({ valid: true }),
    });
    expect(res.system).toBe("risc0");
    expect(res.valid).toBe(true);
  });

  it("noir returns Phase 2 stub", async () => {
    const n = { ...baseMetadata, zkSystem: "noir" as const };
    const res = await verifyZkProof(SAMPLE_PROOF, n);
    expect(res.valid).toBe(false);
    expect(res.system).toBe("noir");
    expect(res.reason).toMatch(/Phase 2/);
  });

  it("halo2 returns sp1 redirect message", async () => {
    const h = { ...baseMetadata, zkSystem: "halo2" as const };
    const res = await verifyZkProof(SAMPLE_PROOF, h);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/use sp1/);
  });

  it("plonky3 returns sp1 redirect message", async () => {
    const p = { ...baseMetadata, zkSystem: "plonky3" as const };
    const res = await verifyZkProof(SAMPLE_PROOF, p);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/use sp1/);
  });

  it("missing metadata throws", async () => {
    await expect(
      // @ts-expect-error: intentionally passing undefined
      verifyZkProof(SAMPLE_PROOF, undefined),
    ).rejects.toThrow(/zkProofMetadata missing/);
  });
});
