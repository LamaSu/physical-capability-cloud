import { describe, it, expect } from "vitest";
import { ZKProofService } from "../zk-proof-service.js";
import { CommitmentService } from "../commitment-service.js";
import type { EvidenceBundle, SHA256, Address, Signature } from "@pcc/spec";

function makeMockBundle(): EvidenceBundle {
  return {
    id: "bun_zk_test",
    jobId: "job_zk_test",
    stepId: "step_zk_test",
    kernelId: "kernel_zk_test",
    assuranceTier: 2,
    events: [
      {
        id: "ev_zk_1",
        type: "gcode_hash_verified",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_zk_test" },
        payload: { hash: "abc123" },
        hash: "sha256:aaaa" as SHA256,
      },
      {
        id: "ev_zk_2",
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_zk_test" },
        payload: { success: true },
        hash: "sha256:bbbb" as SHA256,
      },
      {
        id: "ev_zk_3",
        type: "power_profile_summary",
        timestamp: new Date().toISOString(),
        source: { deviceId: "dev_002", deviceType: "power_monitor", kernelId: "kernel_zk_test" },
        payload: { avgWatts: 100 },
        hash: "sha256:cccc" as SHA256,
      },
    ],
    bundleHash: "sha256:deadbeef" as SHA256,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "mock",
    } as Signature,
    createdAt: new Date().toISOString(),
  };
}

describe("ZKProofService", () => {
  const zkService = new ZKProofService();
  const commitService = new CommitmentService();

  describe("generateProof", () => {
    it("generates a proof with valid structure", async () => {
      const commitment = await commitService.createCommitment(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256,
      );
      const proof = await zkService.generateProof("data_integrity", commitment, { data: "test" });

      expect(proof.id).toMatch(/^proof_/);
      expect(proof.proofType).toBe("data_integrity");
      expect(proof.commitmentId).toBe(commitment.id);
      expect(proof.publicInputs).toHaveLength(2);
      expect(proof.proof).toMatch(/^sha256:/);
      expect(proof.verificationKey).toMatch(/^sha256:/);
      expect(proof.verified).toBe(false);
      expect(proof.generatedAt).toBeTruthy();
    });
  });

  describe("verifyProof", () => {
    it("verifies a valid proof", async () => {
      const commitment = await commitService.createCommitment(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256,
      );
      const proof = await zkService.generateProof("data_integrity", commitment, { data: "test" });

      const result = await zkService.verifyProof(proof);
      expect(result).toBe(true);
      expect(proof.verified).toBe(true);
    });

    it("rejects malformed proof", async () => {
      const badProof = {
        id: "proof_bad",
        proofType: "data_integrity" as const,
        commitmentId: "cmt_bad",
        publicInputs: [], // Empty — should fail
        proof: "not_a_hash",
        verificationKey: "not_a_hash",
        verified: false,
        generatedAt: new Date().toISOString(),
      };
      const result = await zkService.verifyProof(badProof);
      expect(result).toBe(false);
    });
  });

  describe("proveEvidenceInclusion", () => {
    it("generates an inclusion proof for a leaf in a tree", async () => {
      const h1 = "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256;
      const h2 = "sha256:2222222222222222222222222222222222222222222222222222222222222222" as SHA256;

      const commitments = await Promise.all([
        commitService.createCommitment(h1),
        commitService.createCommitment(h2),
      ]);
      const tree = await commitService.buildTree(commitments);

      const proof = await zkService.proveEvidenceInclusion(tree, 0, h1);
      expect(proof.proofType).toBe("evidence_inclusion");
      expect(proof.publicInputs).toContain(h1);

      const valid = await zkService.verifyProof(proof);
      expect(valid).toBe(true);
    });
  });

  describe("proveTierCompliance", () => {
    it("generates a tier compliance proof", async () => {
      const bundle = makeMockBundle();
      const proof = await zkService.proveTierCompliance(bundle, 2);

      expect(proof.proofType).toBe("tier_compliance");
      expect(proof.publicInputs).toContain(bundle.bundleHash);

      const valid = await zkService.verifyProof(proof);
      expect(valid).toBe(true);
    });
  });
});
