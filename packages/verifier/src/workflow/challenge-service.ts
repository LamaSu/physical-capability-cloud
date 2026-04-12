/**
 * ChallengeService -- Block-anchor + challenge hybrid for anti-replay freshness.
 *
 * Issues challenges anchored to a specific block on Base Sepolia (or any EVM chain).
 * Executors must compute an ExecutionProof that includes the challenge's block hash,
 * proving their work was produced *after* the challenge was issued and not replayed
 * from a cache.
 *
 * See: ai/research/digital-verifier/05-workflow-challenge.md
 */

import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  WorkflowChallenge,
  ExecutionProof,
  BlockAnchor,
} from "@pcc/spec";

/** Default challenge validity window: 10 minutes */
const DEFAULT_MAX_AGE_SECONDS = 600;

/** Default chain ID for Base Sepolia */
const DEFAULT_CHAIN_ID = 84532;

export class ChallengeService {
  /**
   * Issue a fresh challenge anchored to the current block.
   * For settled jobs: use the escrow creation block.
   * For unsettled: use the latest block.
   */
  async issueChallenge(params: {
    issuedBy: string;
    scope: string;
    maxAgeSeconds?: number;
    blockNumber: bigint;
    blockHash: string;
    blockTimestamp: bigint;
    chainId?: number;
  }): Promise<WorkflowChallenge> {
    const anchor: BlockAnchor = {
      chainId: params.chainId ?? DEFAULT_CHAIN_ID,
      blockNumber: params.blockNumber,
      blockHash: params.blockHash,
      timestamp: params.blockTimestamp,
    };

    return {
      challengeId: randomUUID(),
      issuedBy: params.issuedBy,
      anchor,
      maxAgeSeconds: params.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
      scope: params.scope,
    };
  }

  /**
   * Verify an execution proof against a challenge.
   * Checks:
   * 1. challengeId matches
   * 2. proofHash = SHA256(challengeId + blockHash + workOutputRoot)
   * 3. computedAtBlock > challenge.anchor.blockNumber (strictly after)
   * 4. Time between challenge and proof < maxAgeSeconds
   */
  verifyExecutionProof(params: {
    challenge: WorkflowChallenge;
    proof: ExecutionProof;
    currentBlockTimestamp: bigint;
  }): { valid: boolean; failures: string[] } {
    const { challenge, proof, currentBlockTimestamp } = params;
    const failures: string[] = [];

    // 1. challengeId must match
    if (proof.challengeId !== challenge.challengeId) {
      failures.push(
        `challengeId mismatch: expected ${challenge.challengeId}, got ${proof.challengeId}`,
      );
    }

    // 2. proofHash must equal SHA256(challengeId + blockHash + workOutputRoot)
    const expectedHash = this.computeProofHash(
      challenge.challengeId,
      challenge.anchor.blockHash,
      proof.workOutputRoot,
    );
    if (proof.proofHash !== expectedHash) {
      failures.push(
        `proofHash mismatch: expected ${expectedHash}, got ${proof.proofHash}`,
      );
    }

    // 3. computedAtBlock must be strictly greater than anchor block
    if (proof.computedAtBlock <= challenge.anchor.blockNumber) {
      failures.push(
        `computedAtBlock ${proof.computedAtBlock} must be strictly greater than anchor block ${challenge.anchor.blockNumber}`,
      );
    }

    // 4. Time elapsed must not exceed maxAgeSeconds
    const elapsed = currentBlockTimestamp - challenge.anchor.timestamp;
    if (elapsed > BigInt(challenge.maxAgeSeconds)) {
      failures.push(
        `challenge expired: ${elapsed}s elapsed, max is ${challenge.maxAgeSeconds}s`,
      );
    }

    return {
      valid: failures.length === 0,
      failures,
    };
  }

  /**
   * Compute an execution proof for submitted work.
   * Used by kernels to prove their work is fresh.
   */
  computeProof(params: {
    challenge: WorkflowChallenge;
    workOutputRoot: string;
    currentBlockNumber: bigint;
  }): ExecutionProof {
    const { challenge, workOutputRoot, currentBlockNumber } = params;

    const proofHash = this.computeProofHash(
      challenge.challengeId,
      challenge.anchor.blockHash,
      workOutputRoot,
    );

    return {
      challengeId: challenge.challengeId,
      proofHash,
      workOutputRoot,
      computedAtBlock: currentBlockNumber,
    };
  }

  /**
   * Compute the deterministic proof hash: SHA256(challengeId + blockHash + workOutputRoot)
   */
  private computeProofHash(
    challengeId: string,
    blockHash: string,
    workOutputRoot: string,
  ): string {
    const hash = createHash("sha256");
    hash.update(challengeId);
    hash.update(blockHash);
    hash.update(workOutputRoot);
    return hash.digest("hex");
  }
}
