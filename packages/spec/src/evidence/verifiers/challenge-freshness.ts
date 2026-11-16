/**
 * `fresh.challenge_bound` (#48): the evidence was produced after a
 * chain-anchored challenge, so it cannot have been prefabricated.
 *
 * This file is the EXTRACTED, behavior-identical home of the two freshness
 * checks in the verifier package's ChallengeService
 * (packages/verifier/src/workflow/challenge-service.ts), which now delegates
 * here. The verifier package and the oracle therefore run the same code:
 *   - execution form: `verifyExecutionFreshness` (was verifyExecutionProof).
 *     The proof names the challenge, its proofHash is
 *     sha256(challengeId + blockHash + workOutputRoot), it was computed
 *     strictly after the anchor block, and the challenge has not expired.
 *   - capture form: `verifyCaptureFreshness` (was verifyCaptureNonce). The
 *     capture names the challenge, was submitted inside
 *     [blockTimestamp, blockTimestamp + maxAgeSeconds], and echoes the visual
 *     nonce the detector read from the frame.
 *
 * `makeFreshChallengeBoundVerifier` wraps both as the PrimitiveVerifier the
 * oracle registers. It fails closed, and adds one binding the raw checks do not
 * make: the challenge's `scope` must be the job being settled (`ctx.jobId`).
 * Otherwise a fresh response to another job's challenge would pass. The
 * challenge itself must come from the issuer's record, never from the
 * evidence. `verifierStatus` stays "stub" in primitives.ts until the oracle
 * runs this at /settle.
 */

import { createHash } from "node:crypto";

import type { CaptureNonceChallengePayload } from "../../types/capture.js";
import type { ExecutionProof, WorkflowChallenge } from "../../types/evidence.js";
import type { PrimitiveVerifier, PrimitiveVerifyContext, PrimitiveVerifyResult } from "../verifier-interface.js";

export const FRESH_CHALLENGE_BOUND_ID = "fresh.challenge_bound";

/** SHA256(challengeId + blockHash + workOutputRoot), hex without a prefix. */
export function computeExecutionProofHash(challengeId: string, blockHash: string, workOutputRoot: string): string {
  const hash = createHash("sha256");
  hash.update(challengeId);
  hash.update(blockHash);
  hash.update(workOutputRoot);
  return hash.digest("hex");
}

/**
 * Verify an execution proof against its challenge:
 *   1. challengeId matches;
 *   2. proofHash = SHA256(challengeId + blockHash + workOutputRoot);
 *   3. computedAtBlock > challenge.anchor.blockNumber (strictly after);
 *   4. currentBlockTimestamp - anchor.timestamp <= maxAgeSeconds.
 */
export function verifyExecutionFreshness(params: {
  challenge: WorkflowChallenge;
  proof: ExecutionProof;
  currentBlockTimestamp: bigint;
}): { valid: boolean; failures: string[] } {
  const { challenge, proof, currentBlockTimestamp } = params;
  const failures: string[] = [];

  if (proof.challengeId !== challenge.challengeId) {
    failures.push(`challengeId mismatch: expected ${challenge.challengeId}, got ${proof.challengeId}`);
  }

  const expectedHash = computeExecutionProofHash(
    challenge.challengeId,
    challenge.anchor.blockHash,
    proof.workOutputRoot,
  );
  if (proof.proofHash !== expectedHash) {
    failures.push(`proofHash mismatch: expected ${expectedHash}, got ${proof.proofHash}`);
  }

  if (proof.computedAtBlock <= challenge.anchor.blockNumber) {
    failures.push(
      `computedAtBlock ${proof.computedAtBlock} must be strictly greater than anchor block ${challenge.anchor.blockNumber}`,
    );
  }

  const elapsed = currentBlockTimestamp - challenge.anchor.timestamp;
  if (elapsed > BigInt(challenge.maxAgeSeconds)) {
    failures.push(`challenge expired: ${elapsed}s elapsed, max is ${challenge.maxAgeSeconds}s`);
  }

  return { valid: failures.length === 0, failures };
}

/** What a capture submits against its nonce challenge. */
export interface CaptureChallengeResponse {
  challengeId: string;
  /** Unix seconds. */
  submittedAt: number;
  /** The visual nonce the detector extracted from the captured frame. */
  visualNonceEcho: string;
}

/**
 * Verify a capture-nonce response against the challenge that was issued:
 *   1. challengeId matches;
 *   2. submittedAt falls within [blockTimestamp, blockTimestamp + maxAgeSeconds];
 *   3. visualNonceEcho equals the challenge's visualNonce.payload.
 */
export function verifyCaptureFreshness(
  challenge: CaptureNonceChallengePayload,
  response: CaptureChallengeResponse,
): { valid: boolean; reason?: string } {
  if (response.challengeId !== challenge.challengeId) {
    return {
      valid: false,
      reason: `challengeId mismatch: expected ${challenge.challengeId}, got ${response.challengeId}`,
    };
  }

  if (response.submittedAt < challenge.blockTimestamp) {
    return {
      valid: false,
      reason: `submittedAt ${response.submittedAt} is earlier than anchor blockTimestamp ${challenge.blockTimestamp}`,
    };
  }

  const elapsed = response.submittedAt - challenge.blockTimestamp;
  if (elapsed > challenge.maxAgeSeconds) {
    return {
      valid: false,
      reason: `challenge expired: ${elapsed}s elapsed, max is ${challenge.maxAgeSeconds}s`,
    };
  }

  if (response.visualNonceEcho !== challenge.visualNonce.payload) {
    return {
      valid: false,
      reason: "visualNonce mismatch: echo does not match issued payload",
    };
  }

  return { valid: true };
}

/** The instance `fresh.challenge_bound` verifies, by form. */
export type FreshChallengeInstance =
  | { form: "execution"; challenge: WorkflowChallenge; proof: ExecutionProof; currentBlockTimestamp: bigint }
  | { form: "capture"; challenge: CaptureNonceChallengePayload; response: CaptureChallengeResponse };

const fail = (...detail: string[]): PrimitiveVerifyResult => ({ met: false, detail });

/**
 * The `fresh.challenge_bound` PrimitiveVerifier. `params` is the primitive's
 * {form: "execution" | "capture", maxAgeSeconds?}. The oracle supplies
 * `ctx.jobId`: the challenge's scope must be that job. A CSD's maxAgeSeconds
 * caps the challenge's own window. No instance yet means pending, and anything
 * malformed fails closed. It never throws.
 */
export function makeFreshChallengeBoundVerifier(): PrimitiveVerifier {
  return {
    id: FRESH_CHALLENGE_BOUND_ID,
    async verify(instance: unknown, params: unknown, ctx: PrimitiveVerifyContext): Promise<PrimitiveVerifyResult> {
      if (instance === null || instance === undefined) {
        return { met: "pending", detail: ["no challenge response yet"] };
      }
      try {
        const p = (params ?? {}) as { form?: unknown; maxAgeSeconds?: unknown };
        if (p.form !== "execution" && p.form !== "capture") {
          return fail('params.form must be "execution" or "capture"');
        }
        const inst = instance as FreshChallengeInstance;
        if (inst.form !== p.form) return fail(`instance form ${String(inst.form)} is not params.form ${p.form}`);

        const jobId = ctx.jobId;
        if (typeof jobId !== "string" || jobId.length === 0) {
          return fail("ctx.jobId is required: a challenge is bound to the job it was issued for");
        }
        if (inst.challenge.scope !== jobId) {
          return fail(`challenge scope ${JSON.stringify(inst.challenge.scope)} is not job ${JSON.stringify(jobId)}`);
        }
        if (p.maxAgeSeconds !== undefined) {
          if (typeof p.maxAgeSeconds !== "number" || !(p.maxAgeSeconds > 0)) {
            return fail("params.maxAgeSeconds must be a positive number");
          }
          if (!(inst.challenge.maxAgeSeconds <= p.maxAgeSeconds)) {
            return fail(
              `challenge window ${inst.challenge.maxAgeSeconds}s exceeds the committed maximum ${p.maxAgeSeconds}s`,
            );
          }
        }

        if (inst.form === "execution") {
          const r = verifyExecutionFreshness({
            challenge: inst.challenge,
            proof: inst.proof,
            currentBlockTimestamp: inst.currentBlockTimestamp,
          });
          return r.valid ? { met: true, detail: ["execution proof is fresh and bound"] } : fail(...r.failures);
        }
        const r = verifyCaptureFreshness(inst.challenge, inst.response);
        return r.valid ? { met: true, detail: ["capture is fresh and echoes the nonce"] } : fail(r.reason ?? "stale");
      } catch (err) {
        return fail(`malformed instance: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
