import { describe, it, expect, beforeEach } from "vitest";
import { TIER_ENFORCING_PIPELINES, TMPValidatorBridge } from "../tmp-validator-bridge.js";
import { EvidenceVerifier } from "../evidence-verifier.js";
import { CommitmentService } from "../commitment-service.js";
import { ZKProofService } from "../zk-proof-service.js";
import { BittensorSubnetBridge } from "../bittensor/subnet-bridge.js";
import type { BenchmarkProofEnvelope } from "../tmp-validator-bridge.js";
import type { EvidenceBundle, EvidenceEvent, SHA256, Address, Signature } from "@pcc/spec";
import { canonicalize, EvidenceBundleSchema, EvidenceEventSchema, hashBundle, hashEvent } from "@pcc/spec";

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

// ── Sealed bundles and a spy network (E11f) ─────────────────────────

const T = (s: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, s)).toISOString();
const sealedSource = { deviceId: "dev_001", deviceType: "controller" as const, kernelId: "kernel_test" };
type EventSpec = [EvidenceEvent["type"], number, Record<string, unknown>];
/** Valid at tier 1: gcode, a 4 s run, a consistent power summary. */
const TIER1: EventSpec[] = [
  ["gcode_hash_verified", 0, { hash: "abc" }],
  ["execution_started", 1, {}],
  ["execution_completed", 5, { success: true }],
  ["power_profile_summary", 6, { durationSeconds: 4, avgWatts: 100 }],
];
/** Valid at tier 2: tier 1's events plus an inspection. */
const TIER2: EventSpec[] = [...TIER1, ["cv_inspection_result", 7, { passed: true, confidence: 0.95 }]];

/** A bundle sealed as a kernel seals one: each event hash and the bundle hash computed. */
async function sealedBundle(specs: EventSpec[]): Promise<EvidenceBundle> {
  const events = await Promise.all(
    specs.map(async ([type, s, payload], i) => {
      const raw = { type, timestamp: T(s), source: sealedSource, payload };
      return { ...raw, id: `ev_${i}`, hash: (await hashEvent(raw as never)) as SHA256 } as EvidenceEvent;
    }),
  );
  return {
    id: "bun_sealed",
    jobId: "job_sealed",
    stepId: "step_sealed",
    kernelId: "kernel_test",
    assuranceTier: 1,
    events,
    bundleHash: (await hashBundle(events)) as SHA256,
    kernelSignature: { signer: "0x0000000000000000000000000000000000000000" as Address, algorithm: "secp256k1", value: "mock" } as Signature,
    createdAt: T(0),
  };
}

/** A deterministic network that records exactly what it was given, and answers `passed`. */
function withSpyNetwork(passed = true) {
  const calls: Array<{ bundleHash: string; bundleData: string; tier: number }> = [];
  const network = {
    isAvailable: () => true,
    submitForVerification: async (bundleHash: string, bundleData: string, tier: number) => {
      calls.push({ bundleHash, bundleData, tier });
      return { passed, score: passed ? 0.9 : 0.1, oracle: "spy" };
    },
  };
  const spied = new TMPValidatorBridge(
    new EvidenceVerifier("verifier_spy", "0x0000000000000000000000000000000000000001"),
    new CommitmentService(),
    new ZKProofService(),
    network as never,
  );
  return { bridge: spied, calls };
}

/** What decides: validity, and every finding's check and outcome. */
const verdictOf = (r: { valid: boolean; findings: Array<{ check: string; passed: boolean }> }) => ({
  valid: r.valid,
  findings: r.findings.map((f) => `${f.check}:${f.passed}`),
});

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
      const bundle = await sealedBundle(TIER1);
      const envelope = makeEnvelope({
        proofType: "bittensor_verification",
        proof: {
          bundleHash: bundle.bundleHash,
          bundleData: JSON.stringify(bundle),
        },
      });

      // The task's pipeline and accepted tier are its own record, never the proof's (N118, E11e).
      const result = await bridge.validate(envelope, taskCtx(envelope, 1));

      expect(result).toBeDefined();
      expect(typeof result.valid).toBe("boolean");
      expect(typeof result.confidence).toBe("number");
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].check).toBe("bittensor_consensus");
      // The bundle was verified locally first, at the task's tier (E11f).
      expect(result.findings[1]).toMatchObject({ check: "bittensor_bundle", passed: true });
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

    it.each(["bittensor_verification", "oracle_verification"] as const)("%s never reads the proof's requiredTier: the verdict is the same whatever it claims (E11f)", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      const bundle = await sealedBundle(TIER2);
      const proof = { bundleHash: bundle.bundleHash, bundleData: JSON.stringify(bundle) };
      const base = verdictOf(await spied.validate(makeEnvelope({ proofType, proof }), { proofType, acceptedTier: 2 }));
      expect(base.valid).toBe(true);
      for (const requiredTier of [0, 1, 2, 3, "2", null, { tier: 2 }]) {
        const result = await spied.validate(makeEnvelope({ proofType, proof: { ...proof, requiredTier } }), { proofType, acceptedTier: 2 });
        expect(verdictOf(result), JSON.stringify(requiredTier)).toEqual(base);
      }
      // The network is always asked at the task's tier.
      expect(calls.map((c) => c.tier)).toEqual(new Array(8).fill(2));
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

  // ── E11f: oracle and Bittensor judge only the verified bundle's committed data ──

  describe("E11f: oracle and Bittensor see only a verified bundle's committed data", () => {
    const pipelines = ["oracle_verification", "bittensor_verification"] as const;
    const prefix = (p: (typeof pipelines)[number]) => (p === "oracle_verification" ? "oracle" : "bittensor");

    it.each(pipelines)("%s: the reproduction (one bundleHash, fabricated or empty bundleData) is refused before any network", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      const HASH = "sha256:" + "ab".repeat(32);
      const fake = (types: string[]) =>
        JSON.stringify({
          id: "b", jobId: "j", stepId: "s", kernelId: "k", assuranceTier: 2, bundleHash: HASH, createdAt: T(0),
          kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "secp256k1", value: "x" },
          events: types.map((type, i) => ({
            id: `e${i}`, type, timestamp: T(i), source: sealedSource,
            payload: { success: true, durationSeconds: 1, avgWatts: 100, passed: true }, hash: "sha256:" + "cd".repeat(32),
          })),
        });
      const fabricated = fake(["gcode_hash_verified", "execution_started", "execution_completed", "power_profile_summary", "cv_inspection_result"]);
      for (const bundleData of [fabricated, fake([])]) {
        const result = await spied.validate(makeEnvelope({ proofType, proof: { bundleHash: HASH, bundleData } }), { proofType, acceptedTier: 2 });
        expect(result.valid).toBe(false);
        expect(result.findings[0]!.check).toBe(`${prefix(proofType)}_bundle`);
      }
      expect(calls).toHaveLength(0);
    });

    it.each(pipelines)("%s: a sealed bundle reaches the network as canonical JSON of what its hash commits, and nothing else", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      const bundle = await sealedBundle(TIER2);
      const result = await spied.validate(
        makeEnvelope({ proofType, proof: { bundleHash: bundle.bundleHash, bundleData: JSON.stringify(bundle) } }),
        { proofType, acceptedTier: 2 },
      );
      expect(result.valid).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.bundleHash).toBe(bundle.bundleHash);
      const committed = {
        bundleHash: bundle.bundleHash,
        events: bundle.events.map(({ type, timestamp, source, payload, hash }) => ({ type, timestamp, source, payload, hash })),
      };
      expect(calls[0]!.bundleData).toBe(canonicalize(committed));
      const sent = JSON.parse(calls[0]!.bundleData) as { events: object[] };
      expect(Object.keys(sent).sort()).toEqual(["bundleHash", "events"]);
      for (const e of sent.events) expect(Object.keys(e).sort()).toEqual(["hash", "payload", "source", "timestamp", "type"]);
    });

    it.each(pipelines)("%s: no uncommitted field of the bundle or an event, no order, no payload key order and no requiredTier changes what the network receives or the verdict", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      const honest = await sealedBundle(TIER2);
      const run = (b: unknown, extra: object = {}) =>
        spied.validate(
          makeEnvelope({ proofType, proof: { bundleHash: honest.bundleHash, bundleData: JSON.stringify(b), ...extra } }),
          { proofType, acceptedTier: 2 },
        );
      const base = verdictOf(await run(honest));
      expect(base.valid).toBe(true);
      const sent = calls[0]!.bundleData;
      // Every DECLARED field (the schema's keys, optional ones included) plus an injected one.
      const COMMITTED_BUNDLE = new Set(["events", "bundleHash"]);
      const COMMITTED_EVENT = new Set(["type", "timestamp", "source", "payload", "hash"]);
      const values: unknown[] = ["mutated", "", 0, 7, null, { injected: true }, ["injected"]];
      const variants: Array<[string, unknown]> = [];
      for (const key of [...Object.keys(EvidenceBundleSchema.shape), "unsignedExtra"]) {
        if (COMMITTED_BUNDLE.has(key)) continue;
        for (const v of values) variants.push([`bundle.${key}=${JSON.stringify(v)}`, { ...honest, [key]: v }]);
      }
      honest.events.forEach((event, i) => {
        for (const key of [...Object.keys(EvidenceEventSchema.shape), "unsignedExtra"]) {
          if (COMMITTED_EVENT.has(key)) continue;
          for (const v of values) {
            variants.push([`events[${i}].${key}=${JSON.stringify(v)}`, { ...honest, events: honest.events.map((e, j) => (j === i ? { ...e, [key]: v } : e)) }]);
          }
        }
        const reversedPayload = Object.fromEntries(Object.entries(event.payload).reverse());
        variants.push([`events[${i}].payload keys reversed`, { ...honest, events: honest.events.map((e, j) => (j === i ? { ...e, payload: reversedPayload } : e)) }]);
      });
      variants.push(["events reversed", { ...honest, events: [...honest.events].reverse() }]);
      expect(variants.length).toBeGreaterThan(60);
      for (const [name, variant] of variants) expect(verdictOf(await run(variant)), name).toEqual(base);
      for (const requiredTier of [0, 3, "2", null]) expect(verdictOf(await run(honest, { requiredTier })), String(requiredTier)).toEqual(base);
      expect(new Set(calls.map((c) => c.bundleData))).toEqual(new Set([sent]));
    });

    it.each(pipelines)("%s: the bundle must meet the task's tier itself; a tier-1 bundle on a tier-2 task never reaches the network", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      const bundle = await sealedBundle(TIER1);
      const result = await spied.validate(
        makeEnvelope({ proofType, proof: { bundleHash: bundle.bundleHash, bundleData: JSON.stringify(bundle) } }),
        { proofType, acceptedTier: 2 },
      );
      expect(result.valid).toBe(false);
      expect(result.findings[0]!.check).toBe(`${prefix(proofType)}_bundle`);
      expect(result.findings.some((f) => f.check === "tier_requirement_cv_inspection_result_or_camera_snapshot" && !f.passed)).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it.each(pipelines)("%s: a bundleHash other than the verified bundle's own is refused, and no network is asked", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      const bundle = await sealedBundle(TIER2);
      const result = await spied.validate(
        makeEnvelope({ proofType, proof: { bundleHash: "sha256:" + "ef".repeat(32), bundleData: JSON.stringify(bundle) } }),
        { proofType, acceptedTier: 2 },
      );
      expect(result.valid).toBe(false);
      expect(result.findings[0]!.details).toMatch(/not the hash of the verified bundle/);
      expect(calls).toHaveLength(0);
    });

    it.each(pipelines)("%s: the network can only add a refusal", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork(false);
      const bundle = await sealedBundle(TIER2);
      const result = await spied.validate(
        makeEnvelope({ proofType, proof: { bundleHash: bundle.bundleHash, bundleData: JSON.stringify(bundle) } }),
        { proofType, acceptedTier: 2 },
      );
      expect(calls).toHaveLength(1);
      expect(result.valid).toBe(false);
      expect(result.findings[1]).toMatchObject({ check: `${prefix(proofType)}_bundle`, passed: true });
    });

    it("TIER_ENFORCING_PIPELINES is exactly the pipelines validation doesn't refuse as tier_unenforceable (task creation uses it)", async () => {
      const { bridge: spied } = withSpyNetwork();
      const all = ["sensor_evidence", "zk_proof", "merkle_commitment", "bittensor_verification", "oracle_verification"] as const;
      for (const proofType of all) {
        const result = await spied.validate(makeEnvelope({ proofType, proof: {} }), { proofType, acceptedTier: 1 });
        expect(result.findings[0]?.check === "tier_unenforceable", proofType).toBe(!TIER_ENFORCING_PIPELINES.includes(proofType));
      }
    });

    it.each(pipelines)("%s: bundleData that is not a JSON object with an events array is refused", async (proofType) => {
      const { bridge: spied, calls } = withSpyNetwork();
      for (const bundleData of ["not json{", "[]", "null", "{}", '{"events":{}}', '"text"']) {
        const result = await spied.validate(
          makeEnvelope({ proofType, proof: { bundleHash: "sha256:" + "ab".repeat(32), bundleData } }),
          { proofType, acceptedTier: 2 },
        );
        expect(result.valid, bundleData).toBe(false);
        expect(result.findings[0]!.check, bundleData).toBe(`${prefix(proofType)}_bundle`);
      }
      expect(calls).toHaveLength(0);
    });
  });
});
