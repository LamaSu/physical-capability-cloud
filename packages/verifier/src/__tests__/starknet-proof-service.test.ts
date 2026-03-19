import { describe, it, expect } from "vitest";
import {
  StarknetProofAnchoringService,
  type StarknetAnchor,
  type AnchorStatus,
} from "../starknet-proof-service.js";
import type { ZKProof, SHA256 } from "@pcc/spec";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeMockProof(overrides: Partial<ZKProof> = {}): ZKProof {
  return {
    id: "proof_starknet_test_001",
    proofType: "evidence_inclusion",
    commitmentId: "cmt_starknet_test_001",
    publicInputs: [
      "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256,
      "sha256:2222222222222222222222222222222222222222222222222222222222222222" as SHA256,
    ],
    proof: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verificationKey: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    verified: true,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("StarknetProofAnchoringService (mock mode)", () => {
  // All tests use mock mode — no real Starknet connection required
  const service = new StarknetProofAnchoringService({ mock: true });

  describe("constructor", () => {
    it("initialises in mock mode by default", () => {
      const s = new StarknetProofAnchoringService();
      expect(s.isMock()).toBe(true);
    });

    it("respects mock: false configuration", () => {
      // We only set mock: false, not providing real credentials — just checking the flag
      const s = new StarknetProofAnchoringService({ mock: false });
      expect(s.isMock()).toBe(false);
    });
  });

  describe("anchorProof", () => {
    it("returns a StarknetAnchor with correct shape", async () => {
      const proof = makeMockProof();
      const anchor = await service.anchorProof(proof);

      expect(anchor).toMatchObject<Partial<StarknetAnchor>>({
        chain: "starknet-sepolia",
      });
      expect(anchor.txHash).toMatch(/^0x/);
      expect(anchor.txHash.length).toBeGreaterThan(10);
      expect(anchor.blockNumber).toBeGreaterThan(0);
      expect(anchor.proofHash).toMatch(/^sha256:/);
      expect(anchor.anchoredAt).toBeTruthy();
      // ISO 8601
      expect(() => new Date(anchor.anchoredAt)).not.toThrow();
    });

    it("produces different tx hashes for different proofs", async () => {
      const proof1 = makeMockProof({ id: "proof_a" });
      const proof2 = makeMockProof({ id: "proof_b" });

      const anchor1 = await service.anchorProof(proof1);
      const anchor2 = await service.anchorProof(proof2);

      expect(anchor1.txHash).not.toBe(anchor2.txHash);
      expect(anchor1.proofHash).not.toBe(anchor2.proofHash);
    });

    it("stores the anchor internally (retrievable by txHash)", async () => {
      const proof = makeMockProof({ id: "proof_stored_test" });
      const anchor = await service.anchorProof(proof);

      const stored = service.getStoredAnchor(anchor.txHash);
      expect(stored).toBeDefined();
      expect(stored!.txHash).toBe(anchor.txHash);
      expect(stored!.proofHash).toBe(anchor.proofHash);
    });

    it("handles tier_compliance proof type", async () => {
      const proof = makeMockProof({ proofType: "tier_compliance" });
      const anchor = await service.anchorProof(proof);
      expect(anchor.chain).toBe("starknet-sepolia");
      expect(anchor.txHash).toMatch(/^0x/);
    });
  });

  describe("anchorMerkleRoot", () => {
    const merkleRoot = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    it("returns a StarknetAnchor for a Merkle root", async () => {
      const anchor = await service.anchorMerkleRoot(merkleRoot, 3);

      expect(anchor.chain).toBe("starknet-sepolia");
      expect(anchor.txHash).toMatch(/^0x/);
      expect(anchor.proofHash).toMatch(/^sha256:/);
      expect(anchor.blockNumber).toBeGreaterThan(0);
    });

    it("produces different anchors for different tree depths", async () => {
      const anchor3 = await service.anchorMerkleRoot(merkleRoot, 3);
      const anchor4 = await service.anchorMerkleRoot(merkleRoot, 4);

      // Different depth → different canonical hash → different proofHash
      expect(anchor3.proofHash).not.toBe(anchor4.proofHash);
    });

    it("produces consistent proofHash for same root + depth", async () => {
      const a1 = await service.anchorMerkleRoot(merkleRoot, 5);
      const a2 = await service.anchorMerkleRoot(merkleRoot, 5);

      // The proofHash (SHA-256 of root+depth) should be identical even if txHash differs
      expect(a1.proofHash).toBe(a2.proofHash);
    });
  });

  describe("getAnchorStatus", () => {
    it("returns 'rejected' for unknown tx hash", async () => {
      const status = await service.getAnchorStatus("0xdeadbeef");
      expect(status).toBe<AnchorStatus>("rejected");
    });

    it("returns 'pending' on first poll", async () => {
      const freshService = new StarknetProofAnchoringService({ mock: true });
      const proof = makeMockProof({ id: "proof_poll_test" });
      const anchor = await freshService.anchorProof(proof);

      // First poll → pending (check count = 1, threshold is 2)
      const status = await freshService.getAnchorStatus(anchor.txHash);
      expect(status).toBe<AnchorStatus>("pending");
    });

    it("returns 'accepted' after 2 polls", async () => {
      const freshService = new StarknetProofAnchoringService({ mock: true });
      const proof = makeMockProof({ id: "proof_accepted_test" });
      const anchor = await freshService.anchorProof(proof);

      await freshService.getAnchorStatus(anchor.txHash); // poll 1 → pending
      const status = await freshService.getAnchorStatus(anchor.txHash); // poll 2 → accepted
      expect(status).toBe<AnchorStatus>("accepted");
    });
  });

  describe("verifyAnchor — round-trip", () => {
    it("returns false on first verification (still pending)", async () => {
      const freshService = new StarknetProofAnchoringService({ mock: true });
      const proof = makeMockProof({ id: "proof_verify_pending" });
      const anchor = await freshService.anchorProof(proof);

      // First call to verifyAnchor → getAnchorStatus poll 1 → pending → false
      const result = await freshService.verifyAnchor(anchor);
      expect(result).toBe(false);
    });

    it("returns true after anchor is accepted (2 polls)", async () => {
      const freshService = new StarknetProofAnchoringService({ mock: true });
      const proof = makeMockProof({ id: "proof_verify_accepted" });
      const anchor = await freshService.anchorProof(proof);

      await freshService.getAnchorStatus(anchor.txHash); // poll 1 → pending
      const result = await freshService.verifyAnchor(anchor); // poll 2 → accepted → true
      expect(result).toBe(true);
    });

    it("completes a full anchor-then-verify round-trip", async () => {
      const freshService = new StarknetProofAnchoringService({ mock: true });
      const proof = makeMockProof({ id: "proof_roundtrip" });

      // Step 1: Anchor
      const anchor = await freshService.anchorProof(proof);
      expect(anchor.chain).toBe("starknet-sepolia");
      expect(anchor.txHash).toMatch(/^0x/);

      // Step 2: Simulate time passing — poll until accepted
      let accepted = false;
      for (let i = 0; i < 5; i++) {
        const status = await freshService.getAnchorStatus(anchor.txHash);
        if (status === "accepted") { accepted = true; break; }
      }
      expect(accepted).toBe(true);

      // Step 3: Verify
      const verified = await freshService.verifyAnchor(anchor);
      expect(verified).toBe(true);
    });

    it("round-trip with Merkle root anchor", async () => {
      const freshService = new StarknetProofAnchoringService({ mock: true });
      const root = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

      const anchor = await freshService.anchorMerkleRoot(root, 4);
      expect(anchor.proofHash).toMatch(/^sha256:/);

      // Advance past pending → accepted
      await freshService.getAnchorStatus(anchor.txHash);
      const verified = await freshService.verifyAnchor(anchor);
      expect(verified).toBe(true);
    });
  });

  describe("type structure", () => {
    it("StarknetAnchor has all required fields with correct types", async () => {
      const proof = makeMockProof({ id: "proof_type_check" });
      const anchor = await service.anchorProof(proof);

      expect(typeof anchor.txHash).toBe("string");
      expect(typeof anchor.blockNumber).toBe("number");
      expect(typeof anchor.proofHash).toBe("string");
      expect(typeof anchor.anchoredAt).toBe("string");
      expect(anchor.chain).toBe("starknet-sepolia");
    });

    it("anchoredAt is a valid ISO 8601 datetime string", async () => {
      const proof = makeMockProof({ id: "proof_datetime" });
      const anchor = await service.anchorProof(proof);

      const date = new Date(anchor.anchoredAt);
      expect(date.toISOString()).toBe(anchor.anchoredAt);
    });
  });
});
