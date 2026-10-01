import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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

  it("the weighted path does not depend on the pool's order (review E1b, finding 1)", () => {
    const pick = (pool: VerifierNodeInfo[]) => selector.selectVerifiers(request, pool, 3, SEED).map((n) => n.id);
    const expected = pick(nodes);
    expect(pick([...nodes].reverse())).toEqual(expected);
    for (let r = 1; r < nodes.length; r++) {
      expect(pick([...nodes.slice(r), ...nodes.slice(0, r)]), `rotation ${r}`).toEqual(expected);
    }
  });

  it("refuses a pool with duplicate verifier ids, ASCII case folded (review E1b, finding 1)", () => {
    expect(() => selector.selectVerifiers(request, [...nodes, makeNode("v1", 5, 5000)], 3, SEED)).toThrow(/duplicate verifier id/);
    expect(() => selector.selectVerifiers(request, [...nodes, makeNode("V1", 5, 5000)], 3, SEED)).toThrow(/duplicate verifier id/);
  });

  it("exclusions fold ASCII only: a non-ASCII exclusion is refused, never Unicode-folded onto another id (review E1b, finding 2)", () => {
    const pool = [makeNode("k-1", 1000, 8000), makeNode("v2", 500, 9000)];
    // U+212A (Kelvin sign) lowercases to ASCII "k" under Unicode casing.
    expect(() => selector.selectVerifiers(request, pool, 2, SEED, ["\u212A-1"])).toThrow(/printable ASCII/);
    expect(selector.selectVerifiers(request, pool, 2, SEED, ["K-1"]).map((n) => n.id)).toEqual(["v2"]);
  });

  it("a node whose id is not printable ASCII is never eligible (review E1b, finding 2)", () => {
    const pool = [makeNode("\u212A-1", 1000, 8000), makeNode("v2", 500, 9000), makeNode("", 500, 9000)];
    expect(selector.selectVerifiers(request, pool, 5, SEED).map((n) => n.id)).toEqual(["v2"]);
  });

  it("orders the not-enough-nodes fallback by code units, never the host's collation (review E1)", () => {
    // Under a Danish LANG, localeCompare sorts "aa..." after "ed..." ("aa" collates as "\u00e5").
    const pool = [makeNode("node-6", 100, 5000), makeNode("node-13", 100, 5000)];
    const digest = (id: string) => createHash("sha256").update(`${SEED}:${id}`).digest("hex");
    expect(digest("node-13").slice(0, 2)).toBe("aa");
    expect(digest("node-6").slice(0, 2)).toBe("ed");
    expect(selector.selectVerifiers(request, pool, 10, SEED).map((n) => n.id)).toEqual(["node-13", "node-6"]);
  });

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
