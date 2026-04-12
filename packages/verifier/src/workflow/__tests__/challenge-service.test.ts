import { describe, it, expect } from "vitest";
import { ChallengeService } from "../challenge-service.js";
import type { WorkflowChallenge, ExecutionProof } from "@pcc/spec";
import { createHash } from "node:crypto";

describe("ChallengeService", () => {
  const service = new ChallengeService();

  // Shared test fixtures
  const BLOCK_HASH =
    "0xabc123def456789012345678901234567890123456789012345678901234abcd";
  const BLOCK_NUMBER = 100n;
  const BLOCK_TIMESTAMP = 1700000000n;
  const CHAIN_ID = 84532;
  const ISSUER = "kernel-test-001";
  const SCOPE = "job-abc-123";
  const WORK_OUTPUT_ROOT = "sha256:deadbeef01234567deadbeef01234567deadbeef01234567deadbeef01234567";

  /** Helper: create a standard challenge for testing */
  async function makeChallenge(
    overrides: Partial<Parameters<typeof service.issueChallenge>[0]> = {},
  ): Promise<WorkflowChallenge> {
    return service.issueChallenge({
      issuedBy: ISSUER,
      scope: SCOPE,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
      blockTimestamp: BLOCK_TIMESTAMP,
      chainId: CHAIN_ID,
      ...overrides,
    });
  }

  /** Helper: compute the expected SHA256 hash */
  function expectedHash(
    challengeId: string,
    blockHash: string,
    workOutputRoot: string,
  ): string {
    const h = createHash("sha256");
    h.update(challengeId);
    h.update(blockHash);
    h.update(workOutputRoot);
    return h.digest("hex");
  }

  describe("issueChallenge", () => {
    it("creates a challenge with correct structure", async () => {
      const challenge = await makeChallenge();
      expect(challenge.challengeId).toBeTruthy();
      expect(challenge.issuedBy).toBe(ISSUER);
      expect(challenge.scope).toBe(SCOPE);
      expect(challenge.anchor.chainId).toBe(CHAIN_ID);
      expect(challenge.anchor.blockNumber).toBe(BLOCK_NUMBER);
      expect(challenge.anchor.blockHash).toBe(BLOCK_HASH);
      expect(challenge.anchor.timestamp).toBe(BLOCK_TIMESTAMP);
      expect(challenge.maxAgeSeconds).toBe(600); // default
    });

    it("uses default chainId (Base Sepolia 84532) when not provided", async () => {
      const challenge = await service.issueChallenge({
        issuedBy: ISSUER,
        scope: SCOPE,
        blockNumber: BLOCK_NUMBER,
        blockHash: BLOCK_HASH,
        blockTimestamp: BLOCK_TIMESTAMP,
      });
      expect(challenge.anchor.chainId).toBe(84532);
    });

    it("respects custom maxAgeSeconds", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 120 });
      expect(challenge.maxAgeSeconds).toBe(120);
    });

    it("generates unique challengeIds", async () => {
      const c1 = await makeChallenge();
      const c2 = await makeChallenge();
      expect(c1.challengeId).not.toBe(c2.challengeId);
    });
  });

  describe("computeProof", () => {
    it("produces a proof with correct fields", async () => {
      const challenge = await makeChallenge();
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      expect(proof.challengeId).toBe(challenge.challengeId);
      expect(proof.workOutputRoot).toBe(WORK_OUTPUT_ROOT);
      expect(proof.computedAtBlock).toBe(105n);
      expect(proof.proofHash).toBe(
        expectedHash(challenge.challengeId, BLOCK_HASH, WORK_OUTPUT_ROOT),
      );
    });

    it("produces deterministic proofHash for the same inputs", async () => {
      const challenge = await makeChallenge();
      const p1 = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });
      const p2 = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 110n,
      });
      // proofHash depends on challengeId + blockHash + workOutputRoot -- NOT on currentBlockNumber
      expect(p1.proofHash).toBe(p2.proofHash);
    });

    it("produces different proofHash for different workOutputRoot", async () => {
      const challenge = await makeChallenge();
      const p1 = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });
      const p2 = service.computeProof({
        challenge,
        workOutputRoot: "sha256:aaaa",
        currentBlockNumber: 105n,
      });
      expect(p1.proofHash).not.toBe(p2.proofHash);
    });
  });

  describe("verifyExecutionProof", () => {
    it("accepts a valid proof (round-trip: issue -> compute -> verify)", async () => {
      const challenge = await makeChallenge();
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 60n, // 60s later, well within 600s window
      });

      expect(result.valid).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it("rejects proof with wrong challengeId", async () => {
      const challenge = await makeChallenge();
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      // Tamper with challengeId
      const tamperedProof: ExecutionProof = {
        ...proof,
        challengeId: "wrong-challenge-id",
      };

      const result = service.verifyExecutionProof({
        challenge,
        proof: tamperedProof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 60n,
      });

      expect(result.valid).toBe(false);
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
      expect(result.failures.some((f) => f.includes("challengeId mismatch"))).toBe(true);
    });

    it("rejects proof with tampered proofHash", async () => {
      const challenge = await makeChallenge();
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      const tamperedProof: ExecutionProof = {
        ...proof,
        proofHash: "0000000000000000000000000000000000000000000000000000000000000000",
      };

      const result = service.verifyExecutionProof({
        challenge,
        proof: tamperedProof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 60n,
      });

      expect(result.valid).toBe(false);
      expect(result.failures.some((f) => f.includes("proofHash mismatch"))).toBe(true);
    });

    it("rejects proof where computedAtBlock <= challenge anchor block (not fresh)", async () => {
      const challenge = await makeChallenge();
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 100n, // same as anchor block
      });

      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 60n,
      });

      expect(result.valid).toBe(false);
      expect(result.failures.some((f) => f.includes("strictly greater"))).toBe(true);
    });

    it("rejects proof after maxAgeSeconds expires", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 300 });
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 301n, // 301s > 300s limit
      });

      expect(result.valid).toBe(false);
      expect(result.failures.some((f) => f.includes("expired"))).toBe(true);
    });

    it("accepts proof at exact maxAgeSeconds boundary", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 300 });
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 300n, // exactly at the boundary
      });

      expect(result.valid).toBe(true);
      expect(result.failures).toEqual([]);
    });

    it("enforces custom maxAgeSeconds correctly", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 30 });
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      // Within window: valid
      const withinResult = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 25n,
      });
      expect(withinResult.valid).toBe(true);

      // Outside window: invalid
      const outsideResult = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 31n,
      });
      expect(outsideResult.valid).toBe(false);
      expect(outsideResult.failures.some((f) => f.includes("expired"))).toBe(true);
    });

    it("scope is metadata only -- different scope does not affect verification", async () => {
      const challenge = await makeChallenge({ scope: "job-A" });
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      // Verify against the same challenge (scope is just metadata, not in proof hash)
      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 60n,
      });

      expect(result.valid).toBe(true);
    });

    it("edge case: maxAgeSeconds = 0 -> everything expires immediately", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 0 });
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      // Even 1 second later should expire
      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 1n,
      });

      expect(result.valid).toBe(false);
      expect(result.failures.some((f) => f.includes("expired"))).toBe(true);
    });

    it("edge case: maxAgeSeconds = 0, currentBlockTimestamp equals anchor -> valid (0 elapsed)", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 0 });
      const proof = service.computeProof({
        challenge,
        workOutputRoot: WORK_OUTPUT_ROOT,
        currentBlockNumber: 105n,
      });

      // At exactly the same timestamp, 0 elapsed <= 0 max, so it passes the time check
      // (But computedAtBlock 105 > anchor 100, so that's fine)
      const result = service.verifyExecutionProof({
        challenge,
        proof,
        currentBlockTimestamp: BLOCK_TIMESTAMP, // 0 elapsed
      });

      expect(result.valid).toBe(true);
    });

    it("edge case: same block as challenge -> fails freshness check", async () => {
      const challenge = await makeChallenge();
      // Manually construct a proof at the anchor block
      const proofHash = expectedHash(
        challenge.challengeId,
        BLOCK_HASH,
        WORK_OUTPUT_ROOT,
      );
      const sameBlockProof: ExecutionProof = {
        challengeId: challenge.challengeId,
        proofHash,
        workOutputRoot: WORK_OUTPUT_ROOT,
        computedAtBlock: BLOCK_NUMBER, // exactly the anchor block
      };

      const result = service.verifyExecutionProof({
        challenge,
        proof: sameBlockProof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 10n,
      });

      expect(result.valid).toBe(false);
      expect(result.failures.some((f) => f.includes("strictly greater"))).toBe(true);
    });

    it("edge case: block before challenge anchor -> fails freshness check", async () => {
      const challenge = await makeChallenge();
      const proofHash = expectedHash(
        challenge.challengeId,
        BLOCK_HASH,
        WORK_OUTPUT_ROOT,
      );
      const earlyProof: ExecutionProof = {
        challengeId: challenge.challengeId,
        proofHash,
        workOutputRoot: WORK_OUTPUT_ROOT,
        computedAtBlock: 50n, // well before anchor block 100
      };

      const result = service.verifyExecutionProof({
        challenge,
        proof: earlyProof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 10n,
      });

      expect(result.valid).toBe(false);
      expect(result.failures.some((f) => f.includes("strictly greater"))).toBe(true);
    });

    it("collects multiple failures when proof is completely invalid", async () => {
      const challenge = await makeChallenge({ maxAgeSeconds: 10 });
      const badProof: ExecutionProof = {
        challengeId: "wrong-id",
        proofHash: "wrong-hash",
        workOutputRoot: WORK_OUTPUT_ROOT,
        computedAtBlock: 50n, // before anchor
      };

      const result = service.verifyExecutionProof({
        challenge,
        proof: badProof,
        currentBlockTimestamp: BLOCK_TIMESTAMP + 999n, // way past expiry
      });

      expect(result.valid).toBe(false);
      // Should have at least 3 failures: challengeId, proofHash, block freshness, expiry
      expect(result.failures.length).toBeGreaterThanOrEqual(3);
    });
  });
});
