import { describe, it, expect, beforeEach } from "vitest";
import { VerifierNode } from "../verifier-node.js";
import { ConsensusEngine } from "../consensus-engine.js";
import { VerificationNetwork } from "../verification-network.js";
import type {
  VerificationRequest,
  VerificationResponse,
  NetworkConfig,
} from "../types.js";
import type { EvidenceBundle, SHA256, Address, Signature } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────────

function makeMockBundle(overrides?: Partial<EvidenceBundle>): EvidenceBundle {
  const now = new Date();
  return {
    id: "bun_net_test",
    jobId: "job_net_test",
    stepId: "step_net_test",
    kernelId: "kernel_net_test",
    assuranceTier: 2,
    events: [
      {
        id: "ev_1",
        type: "gcode_hash_verified",
        timestamp: new Date(now.getTime()).toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_net_test" },
        payload: { hash: "abc123" },
        hash: "sha256:aaaa" as SHA256,
      },
      {
        id: "ev_2",
        type: "execution_completed",
        timestamp: new Date(now.getTime() + 1000).toISOString(),
        source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_net_test" },
        payload: { success: true },
        hash: "sha256:bbbb" as SHA256,
      },
      {
        id: "ev_3",
        type: "power_profile_summary",
        timestamp: new Date(now.getTime() + 2000).toISOString(),
        source: { deviceId: "dev_002", deviceType: "power_monitor", kernelId: "kernel_net_test" },
        payload: { avgWatts: 120, durationSeconds: 60 },
        hash: "sha256:cccc" as SHA256,
      },
      {
        id: "ev_4",
        type: "cv_inspection_result",
        timestamp: new Date(now.getTime() + 3000).toISOString(),
        source: { deviceId: "dev_003", deviceType: "camera", kernelId: "kernel_net_test" },
        payload: { passed: true, confidence: 0.95 },
        hash: "sha256:dddd" as SHA256,
      },
    ],
    bundleHash: "sha256:deadbeef1234" as SHA256,
    kernelSignature: {
      signer: "0x0000000000000000000000000000000000000000" as Address,
      algorithm: "secp256k1",
      value: "mock_sig",
    } as Signature,
    createdAt: now.toISOString(),
    ...overrides,
  };
}

function makeRequest(bundle: EvidenceBundle, tier?: number): VerificationRequest {
  return {
    requestId: `vreq_test_${Date.now()}`,
    bundleHash: bundle.bundleHash,
    bundleData: JSON.stringify(bundle),
    requiredTier: tier ?? bundle.assuranceTier,
    timestamp: new Date().toISOString(),
    requesterAddress: "0x1234567890abcdef1234567890abcdef12345678",
  };
}

function createNetwork(nodeCount: number, config?: Partial<NetworkConfig>): VerificationNetwork {
  const network = new VerificationNetwork({ minNodes: 1, ...config });
  for (let i = 0; i < nodeCount; i++) {
    const qualities = ["excellent", "good", "acceptable"] as const;
    network.addNode(
      new VerifierNode({
        id: `node_${i}`,
        quality: qualities[i % qualities.length],
        stake: 1000 + i * 200,
      }),
    );
  }
  return network;
}

// ── VerifierNode Tests ──────────────────────────────────────────────

describe("VerifierNode", () => {
  it("verifies valid evidence with a high score", async () => {
    const node = new VerifierNode({ id: "node_1", quality: "excellent" });
    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    const response = await node.verify(request);

    expect(response.requestId).toBe(request.requestId);
    expect(response.nodeId).toBe("node_1");
    expect(response.score).toBeGreaterThan(0.9);
    expect(response.tierCompliant).toBe(true);
    expect(response.defectsFound).toEqual([]);
    expect(response.processingTimeMs).toBeGreaterThanOrEqual(0);
    expect(response.signature).toBeTruthy();
  });

  it("detects bundle hash mismatch", async () => {
    const node = new VerifierNode({ id: "node_2", quality: "excellent" });
    const bundle = makeMockBundle();
    const request = makeRequest(bundle);
    request.bundleHash = "sha256:wrong_hash";

    const response = await node.verify(request);

    expect(response.score).toBeLessThan(0.3);
    expect(response.tierCompliant).toBe(false);
    expect(response.defectsFound).toContain("bundle_hash_mismatch");
  });

  it("detects tier non-compliance", async () => {
    const node = new VerifierNode({ id: "node_3", quality: "good" });
    const bundle = makeMockBundle({
      events: [
        {
          id: "ev_only",
          type: "gcode_hash_verified",
          timestamp: new Date().toISOString(),
          source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_net_test" },
          payload: { hash: "abc" },
          hash: "sha256:aaaa" as SHA256,
        },
      ],
    });
    const request = makeRequest(bundle, 2);

    const response = await node.verify(request);

    expect(response.tierCompliant).toBe(false);
    expect(response.defectsFound).toContain("tier_2_requirements_not_met");
  });

  it("detects empty evidence bundle", async () => {
    const node = new VerifierNode({ id: "node_4", quality: "excellent" });
    const bundle = makeMockBundle({ events: [] });
    const request = makeRequest(bundle);

    const response = await node.verify(request);

    expect(response.defectsFound).toContain("empty_evidence_bundle");
    expect(response.score).toBeLessThan(0.3);
  });

  it("handles invalid JSON evidence data", async () => {
    const node = new VerifierNode({ id: "node_5", quality: "good" });
    const request: VerificationRequest = {
      requestId: "vreq_invalid",
      bundleHash: "sha256:test",
      bundleData: "not valid json{{{",
      requiredTier: 1,
      timestamp: new Date().toISOString(),
      requesterAddress: "0x0000",
    };

    const response = await node.verify(request);

    expect(response.score).toBe(0);
    expect(response.tierCompliant).toBe(false);
    expect(response.defectsFound).toContain("invalid_evidence_data");
  });

  it("detects negative power readings", async () => {
    const node = new VerifierNode({ id: "node_6", quality: "excellent" });
    const now = new Date();
    const bundle = makeMockBundle();
    bundle.events.push({
      id: "ev_bad_power",
      type: "power_profile_summary",
      timestamp: new Date(now.getTime() + 4000).toISOString(),
      source: { deviceId: "dev_002", deviceType: "power_monitor", kernelId: "kernel_net_test" },
      payload: { avgWatts: -50, durationSeconds: 10 },
      hash: "sha256:bad_power" as SHA256,
    });
    const request = makeRequest(bundle);

    const response = await node.verify(request);

    expect(response.defectsFound).toContain("negative_power_reading");
  });

  it("detects timestamp ordering violations", async () => {
    const node = new VerifierNode({ id: "node_7", quality: "excellent" });
    const now = new Date();
    const bundle = makeMockBundle({
      events: [
        {
          id: "ev_late",
          type: "gcode_hash_verified",
          timestamp: new Date(now.getTime() + 5000).toISOString(),
          source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_net_test" },
          payload: { hash: "abc" },
          hash: "sha256:aaaa" as SHA256,
        },
        {
          id: "ev_early",
          type: "execution_completed",
          timestamp: new Date(now.getTime()).toISOString(),
          source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_net_test" },
          payload: { success: true },
          hash: "sha256:bbbb" as SHA256,
        },
        {
          id: "ev_power",
          type: "power_profile_summary",
          timestamp: new Date(now.getTime() + 6000).toISOString(),
          source: { deviceId: "dev_002", deviceType: "power_monitor", kernelId: "kernel_net_test" },
          payload: { avgWatts: 100, durationSeconds: 60 },
          hash: "sha256:cccc" as SHA256,
        },
        {
          id: "ev_cv",
          type: "cv_inspection_result",
          timestamp: new Date(now.getTime() + 7000).toISOString(),
          source: { deviceId: "dev_003", deviceType: "camera", kernelId: "kernel_net_test" },
          payload: { passed: true },
          hash: "sha256:dddd" as SHA256,
        },
      ],
    });
    const request = makeRequest(bundle);

    const response = await node.verify(request);

    expect(response.defectsFound).toContain("timestamp_ordering_violation");
  });

  it("produces unique signatures for different data", async () => {
    const node = new VerifierNode({ id: "node_8", quality: "good" });

    const sig1 = node.sign("data_one");
    const sig2 = node.sign("data_two");

    expect(sig1).not.toBe(sig2);
    expect(sig1.length).toBe(64); // HMAC-SHA256 hex
  });

  it("produces consistent signatures for the same data", () => {
    const node = new VerifierNode({ id: "node_9", privateKey: "deadbeef".repeat(8) });

    const sig1 = node.sign("same_data");
    const sig2 = node.sign("same_data");

    expect(sig1).toBe(sig2);
  });

  it("reports correct node info", () => {
    const node = new VerifierNode({ id: "node_10", quality: "excellent", stake: 5000 });
    const info = node.getInfo();

    expect(info.id).toBe("node_10");
    expect(info.publicKey).toBeTruthy();
    expect(info.stake).toBe(5000);
    expect(info.reputation).toBe(100);
    expect(info.status).toBe("online");
  });

  it("tracks total verifications", async () => {
    const node = new VerifierNode({ id: "node_11", quality: "good" });
    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    expect(node.getTotalVerifications()).toBe(0);
    await node.verify(request);
    expect(node.getTotalVerifications()).toBe(1);
    await node.verify(request);
    expect(node.getTotalVerifications()).toBe(2);
  });

  it("quality tiers produce different score ranges for clean evidence", async () => {
    const excellentNode = new VerifierNode({ id: "n_ex", quality: "excellent" });
    const goodNode = new VerifierNode({ id: "n_good", quality: "good" });
    const acceptableNode = new VerifierNode({ id: "n_acc", quality: "acceptable" });

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    const exResponse = await excellentNode.verify(request);
    const goodResponse = await goodNode.verify(request);
    const accResponse = await acceptableNode.verify(request);

    expect(exResponse.score).toBeGreaterThanOrEqual(0.95);
    expect(goodResponse.score).toBeGreaterThanOrEqual(0.80);
    expect(goodResponse.score).toBeLessThanOrEqual(0.94);
    expect(accResponse.score).toBeGreaterThanOrEqual(0.65);
    expect(accResponse.score).toBeLessThanOrEqual(0.79);
  });
});

// ── ConsensusEngine Tests ───────────────────────────────────────────

describe("ConsensusEngine", () => {
  let engine: ConsensusEngine;

  beforeEach(() => {
    engine = new ConsensusEngine();
  });

  it("produces consensus from unanimous responses", async () => {
    const responses: VerificationResponse[] = [
      { requestId: "r1", nodeId: "n1", score: 0.95, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "sig1" },
      { requestId: "r1", nodeId: "n2", score: 0.93, tierCompliant: true, defectsFound: [], processingTimeMs: 12, signature: "sig2" },
      { requestId: "r1", nodeId: "n3", score: 0.96, tierCompliant: true, defectsFound: [], processingTimeMs: 8, signature: "sig3" },
    ];
    const stakes = new Map([["n1", 1000], ["n2", 1000], ["n3", 1000]]);

    const result = await engine.runConsensus(responses, stakes);

    expect(result.consensusScore).toBeGreaterThan(0.9);
    expect(result.tierCompliant).toBe(true);
    expect(result.participatingNodes).toHaveLength(3);
    expect(result.consensusDefects).toHaveLength(0);
  });

  it("consensus score is stake-weighted", async () => {
    // High-stake node scores 0.9, low-stake node scores 0.5
    const responses: VerificationResponse[] = [
      { requestId: "r2", nodeId: "n1", score: 0.9, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s1" },
      { requestId: "r2", nodeId: "n2", score: 0.5, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s2" },
    ];
    const highStakeFirst = new Map([["n1", 10000], ["n2", 100]]);
    const lowStakeFirst = new Map([["n1", 100], ["n2", 10000]]);

    const resultHigh = await engine.runConsensus(responses, highStakeFirst);

    // Create fresh engine for independent test
    const engine2 = new ConsensusEngine();
    const resultLow = await engine2.runConsensus(responses, lowStakeFirst);

    // When the high-scoring node has more stake, consensus should be higher
    expect(resultHigh.consensusScore).toBeGreaterThan(resultLow.consensusScore);
  });

  it("outlier nodes get penalized (reputation drops)", async () => {
    const responses: VerificationResponse[] = [
      { requestId: "r3", nodeId: "n1", score: 0.95, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s1" },
      { requestId: "r3", nodeId: "n2", score: 0.93, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s2" },
      { requestId: "r3", nodeId: "n3", score: 0.94, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s3" },
      { requestId: "r3", nodeId: "outlier", score: 0.1, tierCompliant: false, defectsFound: ["fake_defect"], processingTimeMs: 10, signature: "s4" },
    ];
    const stakes = new Map([["n1", 1000], ["n2", 1000], ["n3", 1000], ["outlier", 1000]]);

    await engine.runConsensus(responses, stakes);

    const reps = engine.getNodeReputations();
    const outlierRep = reps.get("outlier")!;
    const alignedRep = reps.get("n1")!;

    // Outlier should have lower reputation than aligned nodes
    expect(outlierRep).toBeLessThan(alignedRep);
  });

  it("non-responding nodes get penalized", () => {
    engine.penalizeNonResponders(["missing_node"]);

    const rep = engine.getNodeReputation("missing_node");
    expect(rep).toBe(80); // 100 - 20
  });

  it("throws error for empty responses", async () => {
    await expect(
      engine.runConsensus([], new Map()),
    ).rejects.toThrow("Cannot run consensus with zero responses");
  });

  it("handles single response (degenerate case)", async () => {
    const responses: VerificationResponse[] = [
      { requestId: "r4", nodeId: "solo", score: 0.85, tierCompliant: true, defectsFound: [], processingTimeMs: 5, signature: "s1" },
    ];
    const stakes = new Map([["solo", 1000]]);

    const result = await engine.runConsensus(responses, stakes);

    expect(result.consensusScore).toBe(0.85);
    expect(result.tierCompliant).toBe(true);
    expect(result.participatingNodes).toEqual(["solo"]);
  });

  it("aggregates defects by weighted vote", async () => {
    const responses: VerificationResponse[] = [
      { requestId: "r5", nodeId: "n1", score: 0.5, tierCompliant: true, defectsFound: ["hash_mismatch"], processingTimeMs: 10, signature: "s1" },
      { requestId: "r5", nodeId: "n2", score: 0.5, tierCompliant: true, defectsFound: ["hash_mismatch"], processingTimeMs: 10, signature: "s2" },
      { requestId: "r5", nodeId: "n3", score: 0.5, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s3" },
    ];
    const stakes = new Map([["n1", 1000], ["n2", 1000], ["n3", 1000]]);

    const result = await engine.runConsensus(responses, stakes);

    // hash_mismatch reported by 2/3 nodes (weight 2000/3000 = 67% > 30%)
    expect(result.consensusDefects).toContain("hash_mismatch");
  });

  it("reputation persists across multiple consensus rounds", async () => {
    const responses: VerificationResponse[] = [
      { requestId: "r6a", nodeId: "stable", score: 0.95, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s1" },
      { requestId: "r6a", nodeId: "unreliable", score: 0.95, tierCompliant: true, defectsFound: [], processingTimeMs: 10, signature: "s2" },
    ];
    const stakes = new Map([["stable", 1000], ["unreliable", 1000]]);

    // Round 1: both aligned
    await engine.runConsensus(responses, stakes);
    const repAfter1 = engine.getNodeReputation("stable");

    // Round 2: both aligned again
    const responses2 = responses.map((r) => ({ ...r, requestId: "r6b" }));
    await engine.runConsensus(responses2, stakes);
    const repAfter2 = engine.getNodeReputation("stable");

    // Reputation should increase across rounds for aligned node
    expect(repAfter2).toBeGreaterThanOrEqual(repAfter1);
  });
});

// ── VerificationNetwork Tests ───────────────────────────────────────

describe("VerificationNetwork", () => {
  it("network with 5 nodes produces valid consensus", async () => {
    const network = createNetwork(5);
    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    const result = await network.submitForVerification(request);

    expect(result.requestId).toBe(request.requestId);
    expect(result.consensusScore).toBeGreaterThan(0);
    expect(result.consensusScore).toBeLessThanOrEqual(1);
    expect(result.participatingNodes.length).toBe(5);
    expect(result.timestamp).toBeTruthy();
  });

  it("minimum quorum enforcement", async () => {
    const network = new VerificationNetwork({ minNodes: 3 });
    // Only add 2 nodes
    network.addNode(new VerifierNode({ id: "n1" }));
    network.addNode(new VerifierNode({ id: "n2" }));

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    await expect(network.submitForVerification(request)).rejects.toThrow(
      /Insufficient nodes for quorum/,
    );
  });

  it("offline nodes are excluded from verification", async () => {
    const network = new VerificationNetwork({ minNodes: 2 });
    const node1 = new VerifierNode({ id: "n1" });
    const node2 = new VerifierNode({ id: "n2" });
    const node3 = new VerifierNode({ id: "n3" });
    node3.setStatus("offline");

    network.addNode(node1);
    network.addNode(node2);
    network.addNode(node3);

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    const result = await network.submitForVerification(request);

    expect(result.participatingNodes).toHaveLength(2);
    expect(result.participatingNodes).not.toContain("n3");
  });

  it("network status reports correct counts", async () => {
    const network = createNetwork(5);

    const status1 = network.getNetworkStatus();
    expect(status1.nodes).toBe(5);
    expect(status1.activeNodes).toBe(5);
    expect(status1.totalVerifications).toBe(0);
    expect(status1.averageConsensusScore).toBe(0);

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);
    await network.submitForVerification(request);

    const status2 = network.getNetworkStatus();
    expect(status2.totalVerifications).toBe(1);
    expect(status2.averageConsensusScore).toBeGreaterThan(0);
  });

  it("different evidence quality produces different scores", async () => {
    const network = createNetwork(5);

    // Good evidence
    const goodBundle = makeMockBundle();
    const goodRequest = makeRequest(goodBundle);
    const goodResult = await network.submitForVerification(goodRequest);

    // Bad evidence (hash mismatch)
    const badBundle = makeMockBundle();
    const badRequest = makeRequest(badBundle);
    badRequest.bundleHash = "sha256:totally_wrong_hash";
    const badResult = await network.submitForVerification(badRequest);

    expect(goodResult.consensusScore).toBeGreaterThan(badResult.consensusScore);
  });

  it("hash mismatch detected by all honest nodes", async () => {
    const network = createNetwork(3);
    const bundle = makeMockBundle();
    const request = makeRequest(bundle);
    request.bundleHash = "sha256:wrong";

    const result = await network.submitForVerification(request);

    expect(result.consensusDefects).toContain("bundle_hash_mismatch");
    expect(result.tierCompliant).toBe(false);
  });

  it("tier non-compliance detected", async () => {
    const network = createNetwork(3);
    const bundle = makeMockBundle({
      events: [
        {
          id: "ev_only",
          type: "gcode_hash_verified",
          timestamp: new Date().toISOString(),
          source: { deviceId: "dev_001", deviceType: "controller", kernelId: "kernel_net_test" },
          payload: { hash: "abc" },
          hash: "sha256:aaaa" as SHA256,
        },
      ],
    });
    const request = makeRequest(bundle, 2);

    const result = await network.submitForVerification(request);

    expect(result.consensusDefects).toContain("tier_2_requirements_not_met");
  });

  it("single node network works (degenerate case)", async () => {
    const network = new VerificationNetwork({ minNodes: 1 });
    network.addNode(new VerifierNode({ id: "solo", quality: "excellent" }));

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);

    const result = await network.submitForVerification(request);

    expect(result.participatingNodes).toEqual(["solo"]);
    expect(result.consensusScore).toBeGreaterThan(0.9);
  });

  it("reputation persists across multiple verifications", async () => {
    const network = createNetwork(3);
    const bundle = makeMockBundle();

    // Run multiple verifications
    for (let i = 0; i < 3; i++) {
      const request = makeRequest(bundle);
      await network.submitForVerification(request);
    }

    const engine = network.getConsensusEngine();
    const reps = engine.getNodeReputations();

    // All nodes should have reputation > 100 (aligned consensus adds +1)
    for (const [, rep] of reps) {
      expect(rep).toBeGreaterThanOrEqual(100);
    }
  });

  it("addNode and removeNode work correctly", () => {
    const network = new VerificationNetwork({ minNodes: 1 });
    const node = new VerifierNode({ id: "temp_node" });

    network.addNode(node);
    expect(network.getNodeCount()).toBe(1);
    expect(network.getNodeIds()).toContain("temp_node");

    const removed = network.removeNode("temp_node");
    expect(removed).toBe(true);
    expect(network.getNodeCount()).toBe(0);

    const removedAgain = network.removeNode("nonexistent");
    expect(removedAgain).toBe(false);
  });

  it("static createRequest generates valid request", () => {
    const request = VerificationNetwork.createRequest(
      "sha256:test_hash",
      '{"test": true}',
      2,
      "0xabc",
    );

    expect(request.requestId).toMatch(/^vreq_/);
    expect(request.bundleHash).toBe("sha256:test_hash");
    expect(request.bundleData).toBe('{"test": true}');
    expect(request.requiredTier).toBe(2);
    expect(request.requesterAddress).toBe("0xabc");
    expect(request.timestamp).toBeTruthy();
  });

  it("consensus with all nodes agreeing produces high score", async () => {
    // All excellent nodes — should strongly agree
    const network = new VerificationNetwork({ minNodes: 1 });
    for (let i = 0; i < 5; i++) {
      network.addNode(new VerifierNode({ id: `ex_${i}`, quality: "excellent", stake: 1000 }));
    }

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);
    const result = await network.submitForVerification(request);

    expect(result.consensusScore).toBeGreaterThanOrEqual(0.95);
    expect(result.tierCompliant).toBe(true);
    expect(result.consensusDefects).toHaveLength(0);
  });

  it("mixed quality nodes still reach consensus on valid evidence", async () => {
    const network = new VerificationNetwork({ minNodes: 1 });
    network.addNode(new VerifierNode({ id: "ex", quality: "excellent", stake: 2000 }));
    network.addNode(new VerifierNode({ id: "good", quality: "good", stake: 1000 }));
    network.addNode(new VerifierNode({ id: "acc", quality: "acceptable", stake: 500 }));

    const bundle = makeMockBundle();
    const request = makeRequest(bundle);
    const result = await network.submitForVerification(request);

    // All nodes should agree the evidence is valid (just different confidence levels)
    expect(result.consensusScore).toBeGreaterThan(0.6);
    expect(result.tierCompliant).toBe(true);
  });

  it("average consensus score tracks correctly across verifications", async () => {
    const network = createNetwork(3);
    const bundle = makeMockBundle();

    const request1 = makeRequest(bundle);
    await network.submitForVerification(request1);

    const request2 = makeRequest(bundle);
    await network.submitForVerification(request2);

    const status = network.getNetworkStatus();
    expect(status.totalVerifications).toBe(2);
    expect(status.averageConsensusScore).toBeGreaterThan(0);
    expect(status.averageConsensusScore).toBeLessThanOrEqual(1);
  });

  it("getNode returns registered node or undefined", () => {
    const network = new VerificationNetwork({ minNodes: 1 });
    const node = new VerifierNode({ id: "findable" });
    network.addNode(node);

    expect(network.getNode("findable")).toBe(node);
    expect(network.getNode("nonexistent")).toBeUndefined();
  });
});
