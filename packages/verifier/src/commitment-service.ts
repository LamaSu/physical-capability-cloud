/**
 * CommitmentService — Merkle tree construction and on-chain commitment hashing.
 *
 * Uses Barretenberg Pedersen hash (BN254) for all tree-internal operations,
 * matching Noir's `std::hash::pedersen_hash` in the circuits.
 *
 * bundleHash fields remain SHA-256 (content addressing).
 * commitmentHash, merkleRoot, and tree leaves use Pedersen.
 */

import type { EvidenceCommitment, CommitmentTree, SHA256, HashDigest } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { pedersenHash, pedersenHashPair, pedersenZeroHash, sha256ToField } from "./pedersen.js";

export class CommitmentService {
  /** Create a commitment hash for an evidence bundle */
  async createCommitment(bundleHash: SHA256): Promise<EvidenceCommitment> {
    // Pedersen hash of the bundle hash (as a BN254 field element)
    const field = sha256ToField(bundleHash);
    const commitmentHash = await pedersenHash([field]);

    return {
      id: ids.commitment(),
      bundleHash,
      commitmentHash,
      commitmentTimestamp: new Date().toISOString(),
    };
  }

  /** Build a Merkle tree from multiple commitments */
  async buildTree(commitments: EvidenceCommitment[]): Promise<CommitmentTree> {
    if (commitments.length === 0) {
      throw new Error("Cannot build tree from empty commitments");
    }

    const leaves: HashDigest[] = commitments.map((c) => c.commitmentHash);

    // Pad to next power of 2
    const nextPow2 = Math.pow(2, Math.ceil(Math.log2(leaves.length)));
    const paddedLeaves: HashDigest[] = [...leaves];
    const zeroHash = await pedersenZeroHash();
    while (paddedLeaves.length < nextPow2) {
      paddedLeaves.push(zeroHash);
    }

    // Build tree bottom-up using Pedersen pair hashing
    let currentLevel = paddedLeaves;
    let depth = 0;

    while (currentLevel.length > 1) {
      const nextLevel: HashDigest[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const hash = await pedersenHashPair(currentLevel[i], currentLevel[i + 1]);
        nextLevel.push(hash);
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
  ): Promise<{ path: HashDigest[]; indices: number[] }> {
    if (leafIndex < 0 || leafIndex >= tree.leaves.length) {
      throw new Error(`Leaf index ${leafIndex} out of range`);
    }

    const path: HashDigest[] = [];
    const indices: number[] = [];

    let currentLevel = [...tree.leaves];
    let idx = leafIndex;

    while (currentLevel.length > 1) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      path.push(currentLevel[siblingIdx]);
      indices.push(idx % 2); // 0 = left, 1 = right

      // Compute next level
      const nextLevel: HashDigest[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const hash = await pedersenHashPair(currentLevel[i], currentLevel[i + 1]);
        nextLevel.push(hash);
      }
      currentLevel = nextLevel;
      idx = Math.floor(idx / 2);
    }

    return { path, indices };
  }

  /** Verify a Merkle proof */
  async verifyMerkleProof(
    root: HashDigest,
    leaf: HashDigest,
    proof: { path: HashDigest[]; indices: number[] },
  ): Promise<boolean> {
    let current = leaf;

    for (let i = 0; i < proof.path.length; i++) {
      const sibling = proof.path[i];
      if (proof.indices[i] === 0) {
        // current is left child
        current = await pedersenHashPair(current, sibling);
      } else {
        // current is right child
        current = await pedersenHashPair(sibling, current);
      }
    }

    return current === root;
  }
}
