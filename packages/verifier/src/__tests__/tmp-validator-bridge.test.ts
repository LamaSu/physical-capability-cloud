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
  /** The task's own record, as the route passes it: its pipeline (here the envelope's) and its tier. */
  const taskCtx = (envelope: BenchmarkProofEnvelope, acceptedTier: 0 | 1 | 2 | 3 = 1) => ({ proofType: envelope.proofType, acceptedTier });
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

      const result = await bridge.validate(envelope, taskCtx(envelope));

      // The mock bundle may not pass all checks (hash mismatch), but it should
      // produce a structured result with findings
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe("boolean");
      expect(typeof result.confidence).toBe("number");
      expect(result.findings.length).toBeGreaterThan(0);
    });

    it("zk_proof refuses, even with a genuine proof: it cannot evidence an assurance tier (E11e)", async () => {
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

      const result = await bridge.validate(envelope, taskCtx(envelope));

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.findings[0].check).toBe("tier_unenforceable");
    });

    it("merkle_commitment refuses, even with a genuine inclusion proof: it cannot evidence an assurance tier (E11e)", async () => {
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

      const result = await bridge.validate(envelope, taskCtx(envelope));

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("tier_unenforceable");
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

      // The task's pipeline and accepted tier are its own record, never the proof's (N118, E11e).
      const result = await bridge.validate(envelope, taskCtx(envelope, 1));

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

      const result = await bridge.validate(envelope, taskCtx(envelope));

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

      const result = await bridge.validate(envelope, taskCtx(envelope));

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("tier_unenforceable");
    });

    it("fails gracefully when Merkle proof is incomplete", async () => {
      const envelope = makeEnvelope({
        proofType: "merkle_commitment",
        proof: { merkleRoot: "sha256:abc" },
      });

      const result = await bridge.validate(envelope, taskCtx(envelope));

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("tier_unenforceable");
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

      const result = await bridgeNoBittensor.validate(envelope, taskCtx(envelope));

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("bittensor_available");
    });

    it("fails gracefully when Bittensor input data is missing", async () => {
      const envelope = makeEnvelope({
        proofType: "bittensor_verification",
        proof: {},
      });

      const result = await bridge.validate(envelope, taskCtx(envelope, 1));

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("bittensor_input");
    });

    it("returns invalid for unknown proof type", async () => {
      const envelope = makeEnvelope({
        proofType: "unknown_type" as any,
        proof: {},
      });

      const result = await bridge.validate(envelope, taskCtx(envelope));

      expect(result.valid).toBe(false);
      expect(result.findings[0].check).toBe("proof_type");
    });
  });

  // ── Acceptance Formatting ────────────────────────────────────────

  describe("formatAcceptance", () => {
    it("formats acceptance callback for valid result", async () => {
      // formatAcceptance is pure: a valid result built directly (the ZK pipeline that used to produce one
      // refuses since E11e).
      const envelope = makeEnvelope();
      const result = { valid: true, confidence: 0.95, findings: [] };
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
  // ── N118: a worker's proof never chooses the tier ───────────────────

  describe("N118: the tier is the task's accepted one, never the worker's", () => {
    const oracleOrBittensor = (proofType: "bittensor_verification" | "oracle_verification", requiredTier?: number) =>
      makeEnvelope({
        proofType,
        proof: { bundleHash: "sha256:" + "ab".repeat(32), bundleData: "{}", ...(requiredTier === undefined ? {} : { requiredTier }) },
      });

    it.each(["bittensor_verification", "oracle_verification"] as const)("%s without an accepted tier is refused, whatever the proof claims", async (proofType) => {
      for (const claimed of [undefined, 0, 1, 3]) {
        const result = await bridge.validate(oracleOrBittensor(proofType, claimed), { proofType });
        expect(result.valid, String(claimed)).toBe(false);
        expect(result.findings[0]!.check, String(claimed)).toMatch(/_accepted_tier$/);
      }
    });

    it.each(["bittensor_verification", "oracle_verification"] as const)("%s whose proof claims another tier is refused", async (proofType) => {
      const result = await bridge.validate(oracleOrBittensor(proofType, 0), { proofType, acceptedTier: 2 });
      expect(result.valid).toBe(false);
      expect(result.findings[0]!.details).toMatch(/claims tier 0, but the task was accepted at tier 2/);
    });

    it("sensor_evidence without an accepted tier fails closed in the verifier", async () => {
      const result = await bridge.validate(makeEnvelope({ proofType: "sensor_evidence", proof: { evidenceBundle: makeMockBundle() } }), { proofType: "sensor_evidence" });
      expect(result.valid).toBe(false);
      expect(result.findings.find((f) => f.check === "assurance_tier_accepted")?.passed).toBe(false);
    });

    it("a sensor bundle's claimed tier is never read: the task's accepted tier chooses the evidence (E11e)", async () => {
      const bundle = { ...makeMockBundle(), assuranceTier: 0 as const };
      const result = await bridge.validate(makeEnvelope({ proofType: "sensor_evidence", proof: { evidenceBundle: bundle } }), { proofType: "sensor_evidence", acceptedTier: 2 });
      expect(result.findings.find((f) => f.check === "assurance_tier_accepted")?.passed).toBe(true);
      // Tier 2's camera requirement applies although the bundle claims tier 0.
      expect(result.findings.some((f) => f.check === "tier_requirement_cv_inspection_result_or_camera_snapshot")).toBe(true);
    });
  });

  // ── E11e: the pipeline is the task's, and every pipeline enforces the tier or refuses ──

  describe("E11e: a worker's proof never chooses the pipeline, and no pipeline accepts without the tier", () => {
    it("an empty-path Merkle proof (root === leaf) does not pass a tier-3 task that requires sensor evidence", async () => {
      const leaf = "sha256:" + "cd".repeat(32);
      const envelope = makeEnvelope({ proofType: "merkle_commitment", proof: { merkleRoot: leaf, leaf, path: [], indices: [] } });
      const result = await bridge.validate(envelope, { acceptedTier: 3, proofType: "sensor_evidence" });
      expect(result.valid).toBe(false);
      expect(result.findings[0]!.check).toBe("task_pipeline");
      // Even a task that itself names merkle_commitment refuses it: no tier can be enforced through it.
      const onMerkle = await bridge.validate(envelope, { acceptedTier: 3, proofType: "merkle_commitment" });
      expect(onMerkle.valid).toBe(false);
      expect(onMerkle.findings[0]!.check).toBe("tier_unenforceable");
    });

    it("a submission without the task's pipeline, or on another pipeline, is refused before anything is verified", async () => {
      const envelope = makeEnvelope({ proofType: "sensor_evidence", proof: { evidenceBundle: makeMockBundle() } });
      for (const context of [undefined, {}, { acceptedTier: 2 as const }]) {
        const result = await bridge.validate(envelope, context);
        expect(result.valid, JSON.stringify(context)).toBe(false);
        expect(result.findings[0]!.check, JSON.stringify(context)).toBe("task_pipeline");
      }
      const other = await bridge.validate(envelope, { proofType: "oracle_verification", acceptedTier: 2 });
      expect(other.findings[0]!.details).toMatch(/uses sensor_evidence, but the task requires oracle_verification/);
    });
  });
});
