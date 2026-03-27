/**
 * Real Noir ZK proof generation tests.
 *
 * These tests actually run Barretenberg WASM to generate and verify proofs.
 * They require @noir-lang/noir_js and @noir-lang/backend_barretenberg to be
 * installed (not just devDependencies).
 *
 * Timeout: 120s per test (WASM proof generation takes 10-30s).
 */

import { describe, it, expect, afterAll } from "vitest";
import { NoirProofService } from "../noir-proof-service.js";
import { CommitmentService } from "../commitment-service.js";
import { sha256 } from "@pcc/spec";
import type { SHA256, EvidenceBundle, AssuranceTier } from "@pcc/spec";
import { ids } from "@pcc/spec";

describe("Real Noir Proof Generation", () => {
  const noirService = new NoirProofService();
  const commitmentService = new CommitmentService();

  afterAll(async () => {
    await noirService.destroy();
  });

  it("loads Noir WASM successfully", async () => {
    const available = await noirService.isNoirAvailable();
    expect(available).toBe(true);
  }, 30_000);

  it("generates and verifies a REAL evidence inclusion proof", async () => {
    const available = await noirService.isNoirAvailable();
    if (!available) {
      console.log("Skipping: Noir not available");
      return;
    }

    // Create Pedersen-based Merkle tree
    const h1 = (await sha256("real-proof-bundle-1")) as SHA256;
    const h2 = (await sha256("real-proof-bundle-2")) as SHA256;
    const c1 = await commitmentService.createCommitment(h1);
    const c2 = await commitmentService.createCommitment(h2);
    const tree = await commitmentService.buildTree([c1, c2]);

    // Tree should use Pedersen
    expect(tree.root).toMatch(/^pedersen:/);

    // Generate proof
    const proof = await noirService.proveEvidenceInclusion(tree, 0, h1);

    // Must be a real Noir proof, not mock
    expect(proof.proof).toMatch(/^noir:/);
    expect(proof.verificationKey).toMatch(/^noir:/);
    expect(proof.proofType).toBe("evidence_inclusion");

    // Verify the proof
    const verified = await noirService.verifyProof(proof);
    expect(verified).toBe(true);
    expect(proof.verified).toBe(true);
  }, 120_000);

  it("generates different proofs for different leaves in same tree", async () => {
    const available = await noirService.isNoirAvailable();
    if (!available) return;

    const h1 = (await sha256("diff-bundle-a")) as SHA256;
    const h2 = (await sha256("diff-bundle-b")) as SHA256;
    const c1 = await commitmentService.createCommitment(h1);
    const c2 = await commitmentService.createCommitment(h2);
    const tree = await commitmentService.buildTree([c1, c2]);

    const proof1 = await noirService.proveEvidenceInclusion(tree, 0, h1);
    const proof2 = await noirService.proveEvidenceInclusion(tree, 1, h2);

    // Both should be real proofs
    expect(proof1.proof).toMatch(/^noir:/);
    expect(proof2.proof).toMatch(/^noir:/);

    // Different proofs for different leaves
    expect(proof1.proof).not.toBe(proof2.proof);

    // Both verify
    expect(await noirService.verifyProof(proof1)).toBe(true);
    expect(await noirService.verifyProof(proof2)).toBe(true);
  }, 180_000);
});
