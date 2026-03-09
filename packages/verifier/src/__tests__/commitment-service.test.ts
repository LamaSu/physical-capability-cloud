import { describe, it, expect } from "vitest";
import { CommitmentService } from "../commitment-service.js";
import type { SHA256 } from "@pcc/spec";

describe("CommitmentService", () => {
  const service = new CommitmentService();

  const hash1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256;
  const hash2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222" as SHA256;
  const hash3 = "sha256:3333333333333333333333333333333333333333333333333333333333333333" as SHA256;

  describe("createCommitment", () => {
    it("creates a commitment with valid structure", async () => {
      const commitment = await service.createCommitment(hash1);
      expect(commitment.id).toMatch(/^cmt_/);
      expect(commitment.bundleHash).toBe(hash1);
      expect(commitment.commitmentHash).toMatch(/^sha256:/);
      expect(commitment.commitmentTimestamp).toBeTruthy();
    });

    it("produces different commitments for different hashes", async () => {
      const c1 = await service.createCommitment(hash1);
      const c2 = await service.createCommitment(hash2);
      expect(c1.commitmentHash).not.toBe(c2.commitmentHash);
    });

    it("produces deterministic commitment for same hash", async () => {
      const c1 = await service.createCommitment(hash1);
      const c2 = await service.createCommitment(hash1);
      expect(c1.commitmentHash).toBe(c2.commitmentHash);
    });
  });

  describe("buildTree", () => {
    it("builds a Merkle tree from commitments", async () => {
      const commitments = await Promise.all([
        service.createCommitment(hash1),
        service.createCommitment(hash2),
      ]);
      const tree = await service.buildTree(commitments);

      expect(tree.id).toMatch(/^cmt_/);
      expect(tree.root).toMatch(/^sha256:/);
      expect(tree.leafCount).toBe(2);
      expect(tree.depth).toBeGreaterThan(0);
      // Padded to power of 2
      expect(tree.leaves.length).toBe(2);
    });

    it("updates commitments with tree info", async () => {
      const commitments = await Promise.all([
        service.createCommitment(hash1),
        service.createCommitment(hash2),
      ]);
      const tree = await service.buildTree(commitments);

      expect(commitments[0].merkleRoot).toBe(tree.root);
      expect(commitments[0].merkleIndex).toBe(0);
      expect(commitments[1].merkleIndex).toBe(1);
    });

    it("handles single commitment", async () => {
      const commitments = [await service.createCommitment(hash1)];
      const tree = await service.buildTree(commitments);
      expect(tree.leafCount).toBe(1);
      expect(tree.root).toMatch(/^sha256:/);
    });

    it("handles odd number of commitments (pads to power of 2)", async () => {
      const commitments = await Promise.all([
        service.createCommitment(hash1),
        service.createCommitment(hash2),
        service.createCommitment(hash3),
      ]);
      const tree = await service.buildTree(commitments);
      expect(tree.leafCount).toBe(3);
      expect(tree.leaves.length).toBe(4); // padded
    });

    it("throws on empty commitments", async () => {
      await expect(service.buildTree([])).rejects.toThrow("empty");
    });
  });

  describe("Merkle proofs", () => {
    it("generates and verifies a valid proof", async () => {
      const commitments = await Promise.all([
        service.createCommitment(hash1),
        service.createCommitment(hash2),
        service.createCommitment(hash3),
      ]);
      const tree = await service.buildTree(commitments);

      for (let i = 0; i < commitments.length; i++) {
        const proof = await service.generateMerkleProof(tree, i);
        const valid = await service.verifyMerkleProof(tree.root, tree.leaves[i], proof);
        expect(valid).toBe(true);
      }
    });

    it("rejects proof with wrong leaf", async () => {
      const commitments = await Promise.all([
        service.createCommitment(hash1),
        service.createCommitment(hash2),
      ]);
      const tree = await service.buildTree(commitments);

      const proof = await service.generateMerkleProof(tree, 0);
      // Verify with wrong leaf (leaf 1 data with leaf 0 proof)
      const valid = await service.verifyMerkleProof(tree.root, tree.leaves[1], proof);
      expect(valid).toBe(false);
    });

    it("rejects proof with wrong root", async () => {
      const commitments = await Promise.all([
        service.createCommitment(hash1),
        service.createCommitment(hash2),
      ]);
      const tree = await service.buildTree(commitments);

      const proof = await service.generateMerkleProof(tree, 0);
      const fakeRoot = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as SHA256;
      const valid = await service.verifyMerkleProof(fakeRoot, tree.leaves[0], proof);
      expect(valid).toBe(false);
    });

    it("throws on out-of-range leaf index", async () => {
      const commitments = [await service.createCommitment(hash1)];
      const tree = await service.buildTree(commitments);
      await expect(service.generateMerkleProof(tree, 5)).rejects.toThrow("out of range");
    });
  });
});
