/**
 * Tests for ConsensusEngine.runHumanConsensus() and
 * VerificationNetwork.processVerificationResult().
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConsensusEngine } from "../consensus-engine.js";
import { VerificationNetwork } from "../verification-network.js";
import type { HumanVerificationResponse } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHumanResponse(
  requestId: string,
  nodeId: string,
  verdict: "match" | "no_match" | "inconclusive",
  overrides?: Partial<HumanVerificationResponse>,
): HumanVerificationResponse {
  return {
    requestId,
    nodeId,
    score: verdict === "match" ? 0.9 : 0.1,
    tierCompliant: verdict === "match",
    defectsFound: [],
    processingTimeMs: 100,
    signature: `sig_${nodeId}_${verdict}`,
    humanVerdict: verdict,
    humanNotes: undefined,
    responseTimeMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ConsensusEngine.runHumanConsensus() tests
// ---------------------------------------------------------------------------

describe("ConsensusEngine.runHumanConsensus", () => {
  let engine: ConsensusEngine;

  beforeEach(() => {
    engine = new ConsensusEngine();
  });

  it("returns not-reached with empty responses", async () => {
    const result = await engine.runHumanConsensus([]);
    expect(result.reached).toBe(false);
    expect(result.verdict).toBe("inconclusive");
    expect(result.agreementRatio).toBe(0);
    expect(result.dissenters).toHaveLength(0);
    expect(result.attestationHash).toBeUndefined();
  });

  it("reaches consensus when 3 of 5 agree (60% threshold met)", async () => {
    const responses = [
      makeHumanResponse("req1", "v1", "match"),
      makeHumanResponse("req1", "v2", "match"),
      makeHumanResponse("req1", "v3", "match"),
      makeHumanResponse("req1", "v4", "no_match"),
      makeHumanResponse("req1", "v5", "no_match"),
    ];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.reached).toBe(true);
    expect(result.verdict).toBe("match");
    expect(result.agreementRatio).toBeCloseTo(0.6, 5);
    expect(result.dissenters).toHaveLength(2);
    expect(result.dissenters).toContain("v4");
    expect(result.dissenters).toContain("v5");
    expect(result.attestationHash).toBeDefined();
    expect(typeof result.attestationHash).toBe("string");
    expect(result.attestationHash!.length).toBe(64); // sha256 hex
  });

  it("does not reach consensus when below threshold (2 of 5 = 40%)", async () => {
    const responses = [
      makeHumanResponse("req2", "v1", "match"),
      makeHumanResponse("req2", "v2", "match"),
      makeHumanResponse("req2", "v3", "no_match"),
      makeHumanResponse("req2", "v4", "no_match"),
      makeHumanResponse("req2", "v5", "inconclusive"),
    ];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.reached).toBe(false);
    // Winning verdict is whichever has the most votes (match or no_match — both 2)
    // The engine picks the one that appears first in the map iteration (match or no_match)
    expect(["match", "no_match"]).toContain(result.verdict);
    expect(result.agreementRatio).toBeCloseTo(0.4, 5);
    expect(result.attestationHash).toBeUndefined();
  });

  it("reaches consensus with unanimous agreement (5/5)", async () => {
    const responses = [
      makeHumanResponse("req3", "v1", "match"),
      makeHumanResponse("req3", "v2", "match"),
      makeHumanResponse("req3", "v3", "match"),
      makeHumanResponse("req3", "v4", "match"),
      makeHumanResponse("req3", "v5", "match"),
    ];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.reached).toBe(true);
    expect(result.verdict).toBe("match");
    expect(result.agreementRatio).toBe(1.0);
    expect(result.dissenters).toHaveLength(0);
    expect(result.attestationHash).toBeDefined();
  });

  it("consensus on no_match verdict", async () => {
    const responses = [
      makeHumanResponse("req4", "v1", "no_match"),
      makeHumanResponse("req4", "v2", "no_match"),
      makeHumanResponse("req4", "v3", "no_match"),
      makeHumanResponse("req4", "v4", "match"),
      makeHumanResponse("req4", "v5", "match"),
    ];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.reached).toBe(true);
    expect(result.verdict).toBe("no_match");
    expect(result.agreementRatio).toBeCloseTo(0.6, 5);
    expect(result.dissenters).toContain("v4");
    expect(result.dissenters).toContain("v5");
  });

  it("consensus on inconclusive when all are inconclusive", async () => {
    const responses = [
      makeHumanResponse("req5", "v1", "inconclusive"),
      makeHumanResponse("req5", "v2", "inconclusive"),
      makeHumanResponse("req5", "v3", "inconclusive"),
    ];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.reached).toBe(true);
    expect(result.verdict).toBe("inconclusive");
    expect(result.agreementRatio).toBeCloseTo(1.0, 5);
    expect(result.dissenters).toHaveLength(0);
  });

  it("attestation hash is deterministic regardless of response order", async () => {
    const responses = [
      makeHumanResponse("req6", "v1", "match"),
      makeHumanResponse("req6", "v2", "match"),
      makeHumanResponse("req6", "v3", "match"),
      makeHumanResponse("req6", "v4", "no_match"),
      makeHumanResponse("req6", "v5", "no_match"),
    ];

    const shuffled = [responses[4], responses[2], responses[0], responses[3], responses[1]];

    const result1 = await engine.runHumanConsensus(responses, 0.6);
    const result2 = await engine.runHumanConsensus(shuffled, 0.6);

    expect(result1.attestationHash).toBe(result2.attestationHash);
  });

  it("single response reaches consensus at default threshold", async () => {
    const responses = [makeHumanResponse("req7", "solo", "match")];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.reached).toBe(true);
    expect(result.verdict).toBe("match");
    expect(result.agreementRatio).toBe(1.0);
    expect(result.dissenters).toHaveLength(0);
    expect(result.attestationHash).toBeDefined();
  });

  it("correctly identifies all dissenters", async () => {
    const responses = [
      makeHumanResponse("req8", "v1", "match"),
      makeHumanResponse("req8", "v2", "match"),
      makeHumanResponse("req8", "v3", "match"),
      makeHumanResponse("req8", "v4", "no_match"),
      makeHumanResponse("req8", "v5", "inconclusive"),
    ];

    const result = await engine.runHumanConsensus(responses, 0.6);

    expect(result.dissenters).toHaveLength(2);
    expect(result.dissenters).toContain("v4");
    expect(result.dissenters).toContain("v5");
    expect(result.dissenters).not.toContain("v1");
    expect(result.dissenters).not.toContain("v2");
    expect(result.dissenters).not.toContain("v3");
  });

  it("custom threshold of 0.8 requires 4 of 5 to agree", async () => {
    // Only 3/5 agree on "match" — should NOT reach consensus at 0.8
    const responses3of5 = [
      makeHumanResponse("req9a", "v1", "match"),
      makeHumanResponse("req9a", "v2", "match"),
      makeHumanResponse("req9a", "v3", "match"),
      makeHumanResponse("req9a", "v4", "no_match"),
      makeHumanResponse("req9a", "v5", "no_match"),
    ];

    const result3 = await engine.runHumanConsensus(responses3of5, 0.8);
    expect(result3.reached).toBe(false);

    // 4/5 agree on "match" — SHOULD reach consensus at 0.8
    const responses4of5 = [
      makeHumanResponse("req9b", "v1", "match"),
      makeHumanResponse("req9b", "v2", "match"),
      makeHumanResponse("req9b", "v3", "match"),
      makeHumanResponse("req9b", "v4", "match"),
      makeHumanResponse("req9b", "v5", "no_match"),
    ];

    const result4 = await engine.runHumanConsensus(responses4of5, 0.8);
    expect(result4.reached).toBe(true);
    expect(result4.verdict).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// VerificationNetwork.processVerificationResult() tests
// ---------------------------------------------------------------------------

describe("VerificationNetwork.processVerificationResult", () => {
  let network: VerificationNetwork;

  beforeEach(() => {
    network = new VerificationNetwork({ minNodes: 1 });
  });

  it("rewards aligned verifiers and returns empty slashes", async () => {
    const responses = [
      makeHumanResponse("req10", "v1", "match"),
      makeHumanResponse("req10", "v2", "match"),
      makeHumanResponse("req10", "v3", "match"),
      makeHumanResponse("req10", "v4", "no_match"),
      makeHumanResponse("req10", "v5", "no_match"),
    ];

    const consensusResult = {
      verdict: "match",
      agreementRatio: 0.6,
      dissenters: ["v4", "v5"],
    };

    const { rewards, slashes } = await network.processVerificationResult(
      "req10",
      consensusResult,
      responses,
    );

    // 3 aligned verifiers should each get a reward
    expect(rewards).toHaveLength(3);
    expect(rewards.map((r) => r.verifierId)).toContain("v1");
    expect(rewards.map((r) => r.verifierId)).toContain("v2");
    expect(rewards.map((r) => r.verifierId)).toContain("v3");
    expect(rewards.map((r) => r.verifierId)).not.toContain("v4");
    expect(rewards.map((r) => r.verifierId)).not.toContain("v5");

    // No immediate slashes
    expect(slashes).toHaveLength(0);
  });

  it("all verifiers rewarded on unanimous consensus", async () => {
    const responses = [
      makeHumanResponse("req11", "v1", "match"),
      makeHumanResponse("req11", "v2", "match"),
      makeHumanResponse("req11", "v3", "match"),
    ];

    const consensusResult = {
      verdict: "match",
      agreementRatio: 1.0,
      dissenters: [],
    };

    const { rewards, slashes } = await network.processVerificationResult(
      "req11",
      consensusResult,
      responses,
    );

    expect(rewards).toHaveLength(3);
    expect(slashes).toHaveLength(0);
  });

  it("reward amount scales with agreement ratio", async () => {
    const responses60 = [
      makeHumanResponse("req12a", "v1", "match"),
      makeHumanResponse("req12a", "v2", "match"),
      makeHumanResponse("req12a", "v3", "match"),
    ];
    const result60 = await network.processVerificationResult(
      "req12a",
      { verdict: "match", agreementRatio: 0.6, dissenters: [] },
      responses60,
    );

    const responses100 = [
      makeHumanResponse("req12b", "v1", "match"),
      makeHumanResponse("req12b", "v2", "match"),
      makeHumanResponse("req12b", "v3", "match"),
    ];
    const result100 = await network.processVerificationResult(
      "req12b",
      { verdict: "match", agreementRatio: 1.0, dissenters: [] },
      responses100,
    );

    const amount60 = parseInt(result60.rewards[0].amount, 10);
    const amount100 = parseInt(result100.rewards[0].amount, 10);

    expect(amount100).toBeGreaterThan(amount60);
  });

  it("reward records include correct metadata", async () => {
    const responses = [makeHumanResponse("req13", "verifier_abc", "no_match")];

    const { rewards } = await network.processVerificationResult(
      "req13",
      { verdict: "no_match", agreementRatio: 1.0, dissenters: [] },
      responses,
    );

    expect(rewards).toHaveLength(1);
    expect(rewards[0].verifierId).toBe("verifier_abc");
    expect(rewards[0].requestId).toBe("req13");
    expect(rewards[0].reason).toBe("correct_verification");
    expect(rewards[0].timestamp).toBeTruthy();
    expect(typeof rewards[0].amount).toBe("string");
    expect(parseInt(rewards[0].amount, 10)).toBeGreaterThan(0);
  });

  it("no rewards when all are dissenters (edge case)", async () => {
    // Edge case: consensusResult says everyone is a dissenter
    const responses = [
      makeHumanResponse("req14", "v1", "no_match"),
      makeHumanResponse("req14", "v2", "no_match"),
    ];

    const { rewards, slashes } = await network.processVerificationResult(
      "req14",
      { verdict: "match", agreementRatio: 0.0, dissenters: ["v1", "v2"] },
      responses,
    );

    expect(rewards).toHaveLength(0);
    expect(slashes).toHaveLength(0);
  });

  it("empty responses returns empty rewards and slashes", async () => {
    const { rewards, slashes } = await network.processVerificationResult(
      "req15",
      { verdict: "match", agreementRatio: 1.0, dissenters: [] },
      [],
    );

    expect(rewards).toHaveLength(0);
    expect(slashes).toHaveLength(0);
  });
});
