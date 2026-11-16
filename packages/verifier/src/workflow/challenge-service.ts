/**
 * ChallengeService -- Block-anchor + challenge hybrid for anti-replay freshness.
 *
 * Issues challenges anchored to a specific block on Base Sepolia (or any EVM chain).
 * Executors must compute an ExecutionProof that includes the challenge's block hash,
 * proving their work was produced *after* the challenge was issued and not replayed
 * from a cache.
 *
 * Also issues capture-nonce challenges for the Capture Verification Protocol
 * (CVP). Capture nonces reuse the block-anchor machinery with a tighter
 * default `maxAgeSeconds` of 120s (capped to 120s regardless of caller
 * input) and carry a `VisualNonce` the operator must embed in-scene.
 *
 * See:
 *   ai/research/digital-verifier/05-workflow-challenge.md
 *   ai/research/capture-verification-protocol.md §3
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  computeExecutionProofHash,
  verifyCaptureFreshness,
  verifyExecutionFreshness,
  type WorkflowChallenge,
  type ExecutionProof,
  type BlockAnchor,
  type CaptureNonceChallengePayload,
  type VisualNonce,
} from "@pcc/spec";

/** Default challenge validity window: 10 minutes */
const DEFAULT_MAX_AGE_SECONDS = 600;

/**
 * Hard cap on capture-nonce validity. Tighter than the default workflow
 * window because capture flows are interactive (operator is on-device, not
 * a long-running kernel job).
 */
const CAPTURE_NONCE_MAX_AGE_SECONDS = 120;

/** Default chain ID for Base Sepolia */
const DEFAULT_CHAIN_ID = 84532;

/**
 * Runtime shape of a capture-nonce challenge kept server-side.
 *
 * Extends the on-wire `CaptureNonceChallengePayload` with a convenience
 * `issuedBy` field used by the verifier to track which principalKey / agent
 * the nonce was minted for.
 */
export interface CaptureNonceChallenge extends CaptureNonceChallengePayload {
  /** ERC-8004 AgentRegistryId or kernel id that requested the nonce */
  issuedBy: string;
}

/**
 * Wordlist used to construct `gesture` visual nonces. Short, common,
 * unambiguous — intentionally easy for operators to perform + remember.
 */
const GESTURE_WORDS: readonly string[] = [
  "tilt",
  "pan",
  "rotate",
  "lift",
  "lower",
  "zoom",
  "steady",
  "hold",
  "wave",
  "tap",
  "point",
  "press",
];

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
    // The checks live in @pcc/spec (fresh.challenge_bound), so this service
    // and the oracle run the same code.
    return verifyExecutionFreshness(params);
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
   * Issue a capture-nonce challenge for the Capture Verification Protocol.
   *
   * Reuses block-anchor machinery from `issueChallenge`, and adds a visual
   * nonce (QR / color sequence / gesture prompt) the operator must embed
   * in-scene. `maxAgeSeconds` is clamped to `CAPTURE_NONCE_MAX_AGE_SECONDS`
   * (120s) — tighter than the default workflow window — because capture
   * flows are interactive and the operator is online.
   */
  issueCaptureNonce(params: {
    issuedBy: string;
    scope: string;
    visualNonceType: "qr" | "color" | "gesture";
    blockNumber: number;
    blockHash: string;
    blockTimestamp: number;
    chainId: number;
    maxAgeSeconds?: number;
  }): CaptureNonceChallenge {
    const requestedAge =
      params.maxAgeSeconds !== undefined
        ? params.maxAgeSeconds
        : CAPTURE_NONCE_MAX_AGE_SECONDS;

    // Hard cap regardless of caller request.
    const maxAgeSeconds = Math.min(requestedAge, CAPTURE_NONCE_MAX_AGE_SECONDS);

    const issuedAt = new Date().toISOString();
    const visualNonce: VisualNonce = this.generateVisualNonce(
      params.visualNonceType,
      issuedAt,
    );

    return {
      challengeId: randomUUID(),
      issuedBy: params.issuedBy,
      scope: params.scope,
      visualNonce,
      blockNumber: params.blockNumber,
      blockHash: params.blockHash,
      blockTimestamp: params.blockTimestamp,
      chainId: params.chainId,
      issuedAt,
      maxAgeSeconds,
    };
  }

  /**
   * Verify a capture-nonce response against the challenge that was issued.
   *
   * Checks:
   *   1. `challengeId` matches the issued challenge.
   *   2. `submittedAt` (unix seconds) falls within `[blockTimestamp,
   *      blockTimestamp + maxAgeSeconds]`.
   *   3. `visualNonceEcho` equals the challenge's `visualNonce.payload`
   *      (the detector's CV pass extracts this from the captured frame).
   *
   * Returns a descriptive `reason` on failure so callers can log a specific
   * `capture_liveness_result` / `capture_nonce_issued` failure event.
   */
  verifyCaptureNonce(
    challenge: CaptureNonceChallenge,
    response: {
      challengeId: string;
      submittedAt: number;
      visualNonceEcho: string;
    },
  ): { valid: boolean; reason?: string } {
    return verifyCaptureFreshness(challenge, response);
  }

  /**
   * Compute the deterministic proof hash: SHA256(challengeId + blockHash + workOutputRoot)
   */
  private computeProofHash(
    challengeId: string,
    blockHash: string,
    workOutputRoot: string,
  ): string {
    return computeExecutionProofHash(challengeId, blockHash, workOutputRoot);
  }

  /**
   * Generate a visual nonce of the requested kind.
   *
   * - `qr`      — 16-byte hex string (32 chars, QR-paintable at ~4cm@300dpi)
   * - `color`   — 6-tuple of HSL strings (hue-only varies; sat/light fixed
   *                for contrast). Serialized as comma-separated HSL().
   * - `gesture` — 3-word prompt drawn from `GESTURE_WORDS` (e.g.
   *                "tilt-pan-hold").
   */
  private generateVisualNonce(
    type: "qr" | "color" | "gesture",
    renderedAt: string,
  ): VisualNonce {
    let payload: string;
    switch (type) {
      case "qr":
        payload = randomBytes(16).toString("hex");
        break;
      case "color": {
        // 6 hues, 60deg apart by random offset so pattern is unpredictable
        // but visually distinguishable. Saturation 90%, lightness 50% for
        // screen-rendered contrast.
        const offset = randomBytes(1)[0] ?? 0; // 0..255 maps to 0..360 deg
        const baseHue = Math.floor((offset / 255) * 360);
        const hues = Array.from(
          { length: 6 },
          (_, i) => (baseHue + i * 60) % 360,
        );
        payload = hues
          .map((h) => `hsl(${h},90%,50%)`)
          .join(",");
        break;
      }
      case "gesture": {
        const bytes = randomBytes(3);
        const picked: string[] = [];
        for (let i = 0; i < 3; i++) {
          const byte = bytes[i] ?? 0;
          const word = GESTURE_WORDS[byte % GESTURE_WORDS.length] ?? "hold";
          picked.push(word);
        }
        payload = picked.join("-");
        break;
      }
    }
    return { type, payload, renderedAt };
  }
}
