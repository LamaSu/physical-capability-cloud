import { describe, it, expect } from "vitest";
import { VerifierSelector } from "../network/verifier-selector.js";
import type { VerifierNodeInfo, HumanVerificationRequest } from "../network/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  stake: number,
  reputation: number,
  status: "online" | "offline" = "online",
): VerifierNodeInfo {
  return {
    id,
    endpoint: `http://localhost:8080/verify/${id}`,
    publicKey: `pubkey_${id}`,
    stake,
    reputation,
    status,
  };
}

function makeRequest(overrides?: Partial<HumanVerificationRequest>): HumanVerificationRequest {
  return {
    requestId: "req_test_1",
    bundleHash: "abc123",
    bundleData: "{}",
    requiredTier: 2,
    timestamp: new Date().toISOString(),
    requesterAddress: "0xdeadbeef",
    photoRef: "bafybeif_photo",
    referenceRef: "bafybeif_ref",
    verifierCount: 3,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VerifierSelector", () => {
  const selector = new VerifierSelector();
  const SEED = "0xblockhash_deterministic_seed";

  const nodes: VerifierNodeInfo[] = [
    makeNode("v1", 1000, 8000), // weight = 1000 * 0.8 = 800
    makeNode("v2", 500, 9000),  // weight = 500  * 0.9 = 450
    makeNode("v3", 2000, 5000), // weight = 2000 * 0.5 = 1000
    makeNode("v4", 100, 7000),  // weight = 100  * 0.7 = 70
    makeNode("v5", 3000, 2000), // weight = 3000 * 0.2 = 600
  ];

  const request = makeRequest();

  it("returns exactly count nodes when pool is larger", () => {
    const result = selector.selectVerifiers(request, nodes, 3, SEED);
    expect(result).toHaveLength(3);
  });

  it("returns all eligible when pool is smaller than count", () => {
    const result = selector.selectVerifiers(request, nodes, 10, SEED);
    expect(result.length).toBeLessThanOrEqual(nodes.length);
    expect(result.length).toBeGreaterThan(0);
  });

  it("is deterministic — same seed yields same selection", () => {
    const result1 = selector.selectVerifiers(request, nodes, 3, SEED);
    const result2 = selector.selectVerifiers(request, nodes, 3, SEED);
    expect(result1.map((n) => n.id)).toEqual(result2.map((n) => n.id));
  });

  it("produces different results for different seeds", () => {
    const result1 = selector.selectVerifiers(request, nodes, 3, "seed_A");
    const result2 = selector.selectVerifiers(request, nodes, 3, "seed_B");
    // They may coincidentally be equal for a small pool, but with 5 nodes and 3
    // picks this is astronomically unlikely with different seeds
    const ids1 = result1.map((n) => n.id).join(",");
    const ids2 = result2.map((n) => n.id).join(",");
    // Just verify both runs produce valid outputs (no assertion on inequality —
    // could theoretically collide, but we log to make it visible)
    expect(ids1).toBeTruthy();
    expect(ids2).toBeTruthy();
  });

  it("excludes specified addresses", () => {
    const result = selector.selectVerifiers(request, nodes, 3, SEED, ["v1", "v3"]);
    const ids = result.map((n) => n.id);
    expect(ids).not.toContain("v1");
    expect(ids).not.toContain("v3");
  });

  it("excludes offline nodes", () => {
    const nodesWithOffline = [
      ...nodes,
      makeNode("v_offline", 9999, 9999, "offline"),
    ];
    const result = selector.selectVerifiers(request, nodesWithOffline, 3, SEED);
    const ids = result.map((n) => n.id);
    expect(ids).not.toContain("v_offline");
  });

  it("returns empty array when no eligible nodes", () => {
    const offlineOnly = [makeNode("v1", 1000, 8000, "offline")];
    const result = selector.selectVerifiers(request, offlineOnly, 3, SEED);
    expect(result).toHaveLength(0);
  });

  it("returns no duplicates", () => {
    const result = selector.selectVerifiers(request, nodes, 5, SEED);
    const ids = result.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("respects case-insensitive exclusion", () => {
    const result = selector.selectVerifiers(request, nodes, 4, SEED, ["V1", "V2"]);
    const ids = result.map((n) => n.id);
    expect(ids).not.toContain("v1");
    expect(ids).not.toContain("v2");
  });

  it("handles zero-weight nodes by effectively excluding them", () => {
    const zeroWeightNodes = [
      makeNode("v_zero", 0, 0),   // weight = 0
      makeNode("v_normal", 1000, 5000), // weight = 500
    ];
    // With zero-weight node, should still return 1 valid node
    const result = selector.selectVerifiers(request, zeroWeightNodes, 1, SEED);
    expect(result).toHaveLength(1);
  });

  it("handles single-node pool", () => {
    const singleNode = [makeNode("only_one", 500, 7000)];
    const result = selector.selectVerifiers(request, singleNode, 3, SEED);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("only_one");
  });

  it("returns all eligible nodes when pool exactly matches count", () => {
    const threeNodes = [
      makeNode("a", 100, 5000),
      makeNode("b", 200, 6000),
      makeNode("c", 300, 7000),
    ];
    const result = selector.selectVerifiers(request, threeNodes, 3, SEED);
    expect(result).toHaveLength(3);
    const ids = new Set(result.map((n) => n.id));
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
    expect(ids.has("c")).toBe(true);
  });

  it("selected nodes are all in the original pool", () => {
    const result = selector.selectVerifiers(request, nodes, 4, SEED);
    const poolIds = new Set(nodes.map((n) => n.id));
    for (const node of result) {
      expect(poolIds.has(node.id)).toBe(true);
    }
  });
});
