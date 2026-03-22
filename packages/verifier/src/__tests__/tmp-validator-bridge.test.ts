import { describe, it, expect, beforeEach } from "vitest";
import { TMPValidatorBridge } from "../tmp-validator-bridge.js";
import { EvidenceVerifier } from "../evidence-verifier.js";
import { CommitmentService } from "../commitment-service.js";
import { ZKProofService } from "../zk-proof-service.js";
import { BittensorSubnetBridge } from "../bittensor/subnet-bridge.js";
import type { BenchmarkProofEnvelope } from "../tmp-validator-bridge.js";
import type { EvidenceBundle, SHA256, Address, Signature } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────────

function makeEnvelope(
  overrides?: Partial<BenchmarkProofEnvelope>,
): BenchmarkProofEnvelope {
  return {
    taskId: "task_001",
    contractAddress: "0x0000000000000000000000000000000000000001" as Address,
    chainId: 84532,
    worker: "0x0000000000000000000000000000000000000002" as Address,
    deliverable: "0xdeadbeef",
    metricTarget: "dimensional_accuracy >= 0.95",
    proofType: "sensor_evidence",
    proof: {},
    submittedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockBundle(): EvidenceBundle {
  return {
    id: "bun_test",
    jobId: "job_test",
    stepId: "step_test",
    kernelId: "kernel_test",
    assuranceTier: 1,
    events: [
      {
        id: "ev_1",
        type: "execution_started",
        timestamp: new Date(Date.now() - 60000).toISOString(),
        source: {
          deviceId: "dev_001",
          deviceType: "controller",
          kernelId: "kernel_test",
        },
        payload: {},
        hash: "sha256:aaaa" as SHA256,
      },
      {
        id: "ev_2",
        type: "execution_completed",
        timestamp: new Date().toISOString(),
        source: {
          deviceId: "dev_001",
          deviceType: "controller",
          kernelId: "kernel_test",
        },
        payload: { success: true },
        hash: "sha256:bbbb" as SHA256,
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

// ── Tests ────────────────────────────────────────────────────────────

describe("TMPValidatorBridge", () => {
  let bridge: TMPValidatorBridge;
  let evidenceVerifier: EvidenceVerifier;
  let commitmentService: CommitmentService;
  let zkProofService: ZKProofService;
  let bittensorBridge: BittensorSubnetBridge;

  beforeEach(() => {
    evidenceVerifier = new EvidenceVerifier(
      "verifier_test",
      "0x0000000000000000000000000000000000000001",
    );
    commitmentService = new CommitmentService();
    zkProofService = new ZKProofService();
    bittensorBridge = new BittensorSubnetBridge({
      numMinersToQuery: 5,
      minScoreThreshold: 0.6,
    });

    bridge = new TMPValidatorBridge(
      evidenceVerifier,
      commitmentService,
      zkProofService,
      bittensorBridge,
    );
  });

  // ── Proof Routing ────────────────────────────────────────────────

  describe("proof routing", () => {
    it("routes sensor_evidence to EvidenceVerifier", async () => {
      const bundle = makeMockBundle();
      const envelope = makeEnvelope({
        proofType: "sensor_evidence",
        proof: { evidenceBundle: bundle },
      });

      const result = await bridge.validate(envelope);

      // The mock bundle may not pass all checks (hash mismatch), but it should
      // produce a structured result with findings
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe("boolean");
      expect(typeof result.confidence).toBe("number");
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it("routes zk_proof to ZKProofService", async () => {
      // Generate a real ZK proof first
      const commitment = await commitmentService.createCommitment(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256,
      );
      const proof = await zkProofService.generateProof(
        "data_integrity",
        commitment,
        { data: "test" },
      );

      const envelope = makeEnvelope({
        proofType: "zk_proof",
        proof: { zkProof: proof },
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].check).toBe("zk_proof_verification");
      expect(result.findings[0].passed).toBe(true);
    });

    it("routes merkle_commitment to CommitmentService", async () => {
      // Build a Merkle tree with commitments
      const h1 =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256;
      const h2 =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222" as SHA256;

      const commitments = await Promise.all([
        commitmentService.createCommitment(h1),
        commitmentService.createCommitment(h2),
      ]);
      const tree = await commitmentService.buildTree(commitments);
      const merkleProof = await commitmentService.generateMerkleProof(tree, 0);

      const envelope = makeEnvelope({
        proofType: "merkle_commitment",
        proof: {
          merkleRoot: tree.root,
          leaf: tree.leaves[0],
          path: merkleProof.path,
          indices: merkleProof.indices,
        },
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
      expect(result.findings[0].check).toBe("merkle_inclusion");
      expect(result.findings[0].passed).toBe(true);
    });

    it("routes bittensor_verification to BittensorSubnetBridge", async () => {
      const bundle = makeMockBundle();
      const envelope = makeEnvelope({
        proofType: "bittensor_verification",
        proof: {
          bundleHash: bundle.bundleHash,
          bundleData: JSON.stringify(bundle),
          requiredTier: 1,
        },
      });

      const result = await bridge.validate(envelope);

      expect(result).toBeDefined();
      expect(typeof result.valid).toBe("boolean");
      expect(typeof result.confidence).toBe("number");
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].check).toBe("bittensor_consensus");
    });
  });

  // ── Error Handling ───────────────────────────────────────────────

  describe("error handling", () => {
    it("fails gracefully when sensor evidence bundle is missing", async () => {
      const envelope = makeEnvelope({
        proofType: "sensor_evidence",
        proof: {},
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.findings[0].check).toBe("evidence_bundle_present");
      expect(result.findings[0].passed).toBe(false);
    });

    it("fails gracefully when ZK proof is missing", async () => {
      const envelope = makeEnvelope({
        proofType: "zk_proof",
        proof: {},
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("zk_proof_present");
    });

    it("fails gracefully when Merkle proof is incomplete", async () => {
      const envelope = makeEnvelope({
        proofType: "merkle_commitment",
        proof: { merkleRoot: "sha256:abc" },
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("merkle_proof_complete");
    });

    it("fails gracefully when Bittensor bridge is unavailable", async () => {
      const bridgeNoBittensor = new TMPValidatorBridge(
        evidenceVerifier,
        commitmentService,
        zkProofService,
        // No bittensor bridge
      );

      const envelope = makeEnvelope({
        proofType: "bittensor_verification",
        proof: { bundleHash: "test", bundleData: "{}", requiredTier: 1 },
      });

      const result = await bridgeNoBittensor.validate(envelope);

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("bittensor_available");
    });

    it("fails gracefully when Bittensor input data is missing", async () => {
      const envelope = makeEnvelope({
        proofType: "bittensor_verification",
        proof: {},
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("bittensor_input");
    });

    it("returns invalid for unknown proof type", async () => {
      const envelope = makeEnvelope({
        proofType: "unknown_type" as any,
        proof: {},
      });

      const result = await bridge.validate(envelope);

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("proof_type");
    });
  });

  // ── Acceptance Formatting ────────────────────────────────────────

  describe("formatAcceptance", () => {
    it("formats acceptance callback for valid result", async () => {
      const commitment = await commitmentService.createCommitment(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111" as SHA256,
      );
      const proof = await zkProofService.generateProof(
        "data_integrity",
        commitment,
        { data: "test" },
      );

      const envelope = makeEnvelope({
        proofType: "zk_proof",
        proof: { zkProof: proof },
      });

      const result = await bridge.validate(envelope);
      const acceptance = bridge.formatAcceptance(envelope, result);

      expect(acceptance.taskId).toBe("task_001");
      expect(acceptance.worker).toBe(
        "0x0000000000000000000000000000000000000002",
      );
      expect(acceptance.accepted).toBe(true);
      expect(acceptance.validationResult).toBe(result);
    });

    it("rejects acceptance when confidence is too low", () => {
      const envelope = makeEnvelope();
      const result = {
        valid: true,
        confidence: 0.5, // Below 0.7 threshold
        findings: [],
      };

      const acceptance = bridge.formatAcceptance(envelope, result);
      expect(acceptance.accepted).toBe(false);
    });

    it("rejects acceptance when result is invalid", () => {
      const envelope = makeEnvelope();
      const result = {
        valid: false,
        confidence: 0.95,
        findings: [],
      };

      const acceptance = bridge.formatAcceptance(envelope, result);
      expect(acceptance.accepted).toBe(false);
    });
  });
});
