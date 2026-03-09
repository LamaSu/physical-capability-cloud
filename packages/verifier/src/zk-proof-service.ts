/**
 * ZKProofService — mock ZK proof generation and verification.
 *
 * Uses HMAC-based "proofs" with the same interface as real Noir proofs.
 * Future upgrade: compile Noir circuits to WASM, call from TypeScript.
 */

import type {
  ZKProof,
  EvidenceCommitment,
  CommitmentTree,
  EvidenceBundle,
  AssuranceTier,
  SHA256,
} from "@pcc/spec";
import { sha256, canonicalize, ids } from "@pcc/spec";
import { CommitmentService } from "./commitment-service.js";

export class ZKProofService {
  private commitmentService = new CommitmentService();

  /** Generate a mock ZK proof */
  async generateProof(
    proofType: ZKProof["proofType"],
    commitment: EvidenceCommitment,
    privateWitness: Record<string, unknown>,
  ): Promise<ZKProof> {
    // Mock proof: HMAC-like signature over public inputs + witness
    const publicInputs = [
      commitment.bundleHash,
      commitment.commitmentHash,
    ];

    const proofData = canonicalize({
      type: proofType,
      publicInputs,
      witness: privateWitness,
      nonce: Date.now(),
    });
    const proofHash = await sha256(proofData);

    // Mock verification key
    const vkData = canonicalize({ type: proofType, version: "mock-v1" });
    const verificationKey = await sha256(vkData);

    return {
      id: ids.proof(),
      proofType,
      commitmentId: commitment.id,
      publicInputs,
      proof: proofHash,
      verificationKey,
      verified: false,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Verify a mock ZK proof */
  async verifyProof(proof: ZKProof): Promise<boolean> {
    // Mock verification: check proof format and non-empty inputs
    const valid =
      proof.proof.startsWith("sha256:") &&
      proof.verificationKey.startsWith("sha256:") &&
      proof.publicInputs.length >= 2 &&
      proof.proofType !== undefined;

    proof.verified = valid;
    return valid;
  }

  /** Generate evidence inclusion proof (bundle is in commitment tree) */
  async proveEvidenceInclusion(
    tree: CommitmentTree,
    leafIndex: number,
    bundleHash: SHA256,
  ): Promise<ZKProof> {
    const merkleProof = await this.commitmentService.generateMerkleProof(tree, leafIndex);

    const commitment: EvidenceCommitment = {
      id: ids.commitment(),
      bundleHash,
      commitmentHash: tree.leaves[leafIndex],
      merkleRoot: tree.root,
      merkleIndex: leafIndex,
      commitmentTimestamp: new Date().toISOString(),
    };

    return this.generateProof("evidence_inclusion", commitment, {
      merklePath: merkleProof.path,
      merkleIndices: merkleProof.indices,
      treeRoot: tree.root,
    });
  }

  /** Generate tier compliance proof (evidence meets tier without revealing data) */
  async proveTierCompliance(
    bundle: EvidenceBundle,
    requiredTier: AssuranceTier,
  ): Promise<ZKProof> {
    const commitmentHash = await sha256(bundle.bundleHash);

    const commitment: EvidenceCommitment = {
      id: ids.commitment(),
      bundleHash: bundle.bundleHash,
      commitmentHash: commitmentHash as SHA256,
      commitmentTimestamp: new Date().toISOString(),
    };

    return this.generateProof("tier_compliance", commitment, {
      tier: requiredTier,
      eventCount: bundle.events.length,
      eventTypes: bundle.events.map((e) => e.type),
      assuranceTier: bundle.assuranceTier,
    });
  }
}
