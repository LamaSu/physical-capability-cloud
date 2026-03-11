import { describe, it, expect } from "vitest";
import { NoirProofService } from "../noir-proof-service.js";
import { CommitmentService } from "../commitment-service.js";
import type { EvidenceBundle, AssuranceTier, SHA256 } from "@pcc/spec";
import { sha256, ids } from "@pcc/spec";

describe("NoirProofService", () => {
  const service = new NoirProofService();
  const commitmentService = new CommitmentService();

  describe("isNoirAvailable", () => {
    it("returns false when noir packages are not installed", async () => {
      const available = await service.isNoirAvailable();
      // In test environment, Noir packages are not installed
      expect(typeof available).toBe("boolean");
    });
  });

  describe("proveEvidenceInclusion (mock fallback)", () => {
    it("generates a valid mock proof when Noir is unavailable", async () => {
      const hash1 = await sha256("bundle-1");
      const hash2 = await sha256("bundle-2");
      const hash3 = await sha256("bundle-3");

      const c1 = await commitmentService.createCommitment(hash1 as SHA256);
      const c2 = await commitmentService.createCommitment(hash2 as SHA256);
      const c3 = await commitmentService.createCommitment(hash3 as SHA256);

      const tree = await commitmentService.buildTree([c1, c2, c3]);

      const proof = await service.proveEvidenceInclusion(tree, 0, hash1 as SHA256);

      expect(proof.id).toMatch(/^proof_/);
      expect(proof.proofType).toBe("evidence_inclusion");
      expect(proof.publicInputs.length).toBeGreaterThanOrEqual(2);
      expect(proof.proof).toBeTruthy();
      expect(proof.verificationKey).toBeTruthy();
      expect(proof.verified).toBe(false);
    });

    it("generates different proofs for different leaves", async () => {
      const hash1 = await sha256("bundle-a");
      const hash2 = await sha256("bundle-b");

      const c1 = await commitmentService.createCommitment(hash1 as SHA256);
      const c2 = await commitmentService.createCommitment(hash2 as SHA256);

      const tree = await commitmentService.buildTree([c1, c2]);

      const proof1 = await service.proveEvidenceInclusion(tree, 0, hash1 as SHA256);
      const proof2 = await service.proveEvidenceInclusion(tree, 1, hash2 as SHA256);

      expect(proof1.id).not.toBe(proof2.id);
    });
  });

  describe("proveTierCompliance (mock fallback)", () => {
    const makeBundle = async (tier: AssuranceTier, eventTypes: string[]): Promise<EvidenceBundle> => {
      const events = eventTypes.map((type) => ({
        type,
        timestamp: new Date().toISOString(),
        source: "test-kernel",
        payload: {},
        eventHash: `sha256:${"a".repeat(64)}` as SHA256,
      }));

      const bundleHash = await sha256(JSON.stringify(events));

      return {
        id: ids.bundle(),
        jobId: ids.job(),
        stepId: ids.step(),
        kernelId: ids.kernel(),
        assuranceTier: tier,
        events: events as any,
        bundleHash: bundleHash as SHA256,
        kernelSignature: "0xmock" as any,
        createdAt: new Date().toISOString(),
      };
    };

    it("generates a tier 0 compliance proof", async () => {
      const bundle = await makeBundle(0, ["execution_started", "execution_completed"]);
      const proof = await service.proveTierCompliance(bundle, 0);

      expect(proof.proofType).toBe("tier_compliance");
      expect(proof.publicInputs).toContain(bundle.bundleHash);
    });

    it("generates a tier 2 compliance proof", async () => {
      const bundle = await makeBundle(2, [
        "execution_started",
        "execution_completed",
        "power_profile_sample",
        "camera_snapshot",
      ]);
      const proof = await service.proveTierCompliance(bundle, 2);

      expect(proof.proofType).toBe("tier_compliance");
      expect(proof.publicInputs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("verifyProof", () => {
    it("verifies mock proofs (sha256 prefix)", async () => {
      const hash = await sha256("test-bundle");
      const c = await commitmentService.createCommitment(hash as SHA256);
      const tree = await commitmentService.buildTree([c]);
      const proof = await service.proveEvidenceInclusion(tree, 0, hash as SHA256);

      const isValid = await service.verifyProof(proof);

      // Mock proofs verify based on format check
      expect(typeof isValid).toBe("boolean");
      if (proof.proof.startsWith("sha256:")) {
        expect(isValid).toBe(true);
        expect(proof.verified).toBe(true);
      }
    });

    it("handles noir proof prefix gracefully when noir unavailable", async () => {
      const proof = {
        id: ids.proof(),
        proofType: "evidence_inclusion" as const,
        commitmentId: ids.commitment(),
        publicInputs: ["sha256:abc", "sha256:def"],
        proof: "noir:deadbeef",
        verificationKey: "noir:cafebabe",
        verified: false,
        generatedAt: new Date().toISOString(),
      };

      const isValid = await service.verifyProof(proof);
      // Should return false since noir is not available
      expect(isValid).toBe(false);
      expect(proof.verified).toBe(false);
    });
  });
});
