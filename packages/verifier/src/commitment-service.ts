/**
 * CommitmentService — Merkle tree construction and on-chain commitment hashing.
 *
 * Uses SHA-256 as a stand-in for Poseidon. When Noir circuits are integrated,
 * only the hash function changes.
 */

import type { EvidenceCommitment, CommitmentTree, SHA256 } from "@pcc/spec";
import { sha256 } from "@pcc/spec";
import { ids } from "@pcc/spec";

export class CommitmentService {
  /** Create a commitment hash for an evidence bundle */
  async createCommitment(bundleHash: SHA256): Promise<EvidenceCommitment> {
    // Mock Poseidon: use SHA-256 of the bundle hash
    const commitmentHash = await sha256(bundleHash);

    return {
      id: ids.commitment(),
      bundleHash,
      commitmentHash: commitmentHash as SHA256,
      commitmentTimestamp: new Date().toISOString(),
    };
  }

  /** Build a Merkle tree from multiple commitments */
  async buildTree(commitments: EvidenceCommitment[]): Promise<CommitmentTree> {
    if (commitments.length === 0) {
      throw new Error("Cannot build tree from empty commitments");
    }

    const leaves = commitments.map((c) => c.commitmentHash);

    // Pad to next power of 2
    const nextPow2 = Math.pow(2, Math.ceil(Math.log2(leaves.length)));
    const paddedLeaves = [...leaves];
    while (paddedLeaves.length < nextPow2) {
      paddedLeaves.push(`sha256:${"0".repeat(64)}` as SHA256);
    }

    // Build tree bottom-up
    let currentLevel = paddedLeaves;
    let depth = 0;

    while (currentLevel.length > 1) {
      const nextLevel: SHA256[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const combined = currentLevel[i] + currentLevel[i + 1];
        const hash = await sha256(combined);
        nextLevel.push(hash as SHA256);
      }
      currentLevel = nextLevel;
      depth++;
    }

    const root = currentLevel[0];

    // Update commitments with tree info
    for (let i = 0; i < commitments.length; i++) {
      commitments[i].merkleRoot = root;
      commitments[i].merkleIndex = i;
    }

    return {
      id: ids.commitment(),
      root,
      depth,
      leafCount: commitments.length,
      leaves: paddedLeaves,
      createdAt: new Date().toISOString(),
    };
  }

  /** Generate Merkle proof (sibling path) for a leaf */
  async generateMerkleProof(
    tree: CommitmentTree,
    leafIndex: number,
  ): Promise<{ path: SHA256[]; indices: number[] }> {
    if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of range`);
    }

    const path: SHA256[] = [];
    const indices: number[] = [];

    let currentLevel = [...tree.leaves];
    let idx = leafIndex;

    while (currentLevel.length > 1) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      path.push(currentLevel[siblingIdx]);
      indices.push(idx % 2); // 0 = left, 1 = right

      // Compute next level
      const nextLevel: SHA256[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const combined = currentLevel[i] + currentLevel[i + 1];
        const hash = await sha256(combined);
        nextLevel.push(hash as SHA256);
      }
      currentLevel = nextLevel;
      idx = Math.floor(idx / 2);
    }

    return { path, indices };
  }

  /** Verify a Merkle proof */
  async verifyMerkleProof(
    root: SHA256,
    leaf: SHA256,
    proof: { path: SHA256[]; indices: number[] },
  ): Promise<boolean> {
    let current = leaf;

    for (let i = 0; i < proof.path.length; i++) {
      const sibling = proof.path[i];
      const combined = proof.indices[i] === 0
        ? current + sibling    // current is left
        : sibling + current;   // current is right
      current = await sha256(combined) as SHA256;
    }

    return current === root;
  }
}
