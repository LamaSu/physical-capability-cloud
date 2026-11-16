import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  FRESH_CHALLENGE_BOUND_ID,
  computeExecutionProofHash,
  makeFreshChallengeBoundVerifier,
  verifyCaptureFreshness,
  verifyExecutionFreshness,
} from "../evidence/verifiers/challenge-freshness.js";
import type { ExecutionProof, WorkflowChallenge } from "../types/evidence.js";
import type { CaptureNonceChallengePayload } from "../types/capture.js";

const JOB = "job-fresh-1";

const challenge = (over: Partial<WorkflowChallenge> = {}): WorkflowChallenge => ({
  challengeId: "c-1",
  issuedBy: "gateway",
  anchor: { chainId: 84532, blockNumber: 100n, blockHash: "0xabc", timestamp: 1_000n },
  maxAgeSeconds: 600,
  scope: JOB,
  ...over,
});
const proof = (c: WorkflowChallenge, over: Partial<ExecutionProof> = {}): ExecutionProof => ({
  challengeId: c.challengeId,
  proofHash: computeExecutionProofHash(c.challengeId, c.anchor.blockHash, "root-1"),
  workOutputRoot: "root-1",
  computedAtBlock: 101n,
  ...over,
});
const capture = (over: Partial<CaptureNonceChallengePayload> = {}): CaptureNonceChallengePayload => ({
  challengeId: "cap-1",
  scope: JOB,
  visualNonce: { type: "qr", payload: "nonce-xyz", renderedAt: "2026-09-24T12:00:00.000Z" },
  blockNumber: 100,
  blockHash: "0xabc",
  blockTimestamp: 1_000,
  chainId: 84532,
  issuedAt: "2026-09-24T12:00:00.000Z",
  maxAgeSeconds: 120,
  ...over,
});

describe("execution freshness (extracted from ChallengeService.verifyExecutionProof)", () => {
  it("the proof hash is sha256(challengeId + blockHash + workOutputRoot), hex without a prefix", () => {
    const expected = createHash("sha256").update("c-1").update("0xabc").update("root-1").digest("hex");
    expect(computeExecutionProofHash("c-1", "0xabc", "root-1")).toBe(expected);
  });

  it("a fresh, matching proof is valid", () => {
    const c = challenge();
    expect(verifyExecutionFreshness({ challenge: c, proof: proof(c), currentBlockTimestamp: 1_300n })).toEqual({
      valid: true,
      failures: [],
    });
  });

  it("each check fails on its own: id, hash, block order, age", () => {
    const c = challenge();
    const check = (p: ExecutionProof, now = 1_300n) => verifyExecutionFreshness({ challenge: c, proof: p, currentBlockTimestamp: now }).failures;
    expect(check(proof(c, { challengeId: "other" }))[0]).toMatch(/challengeId mismatch/);
    expect(check(proof(c, { proofHash: "00".repeat(32) }))[0]).toMatch(/proofHash mismatch/);
    expect(check(proof(c, { computedAtBlock: 100n }))[0]).toMatch(/strictly greater/);
    expect(check(proof(c), 1_601n)[0]).toMatch(/expired/);
    expect(check(proof(c), 1_600n)).toEqual([]);
  });
});

describe("capture freshness (extracted from ChallengeService.verifyCaptureNonce)", () => {
  const ok = { challengeId: "cap-1", submittedAt: 1_060, visualNonceEcho: "nonce-xyz" };
  it("a capture inside the window that echoes the nonce is valid", () => {
    expect(verifyCaptureFreshness(capture(), ok)).toEqual({ valid: true });
    expect(verifyCaptureFreshness(capture(), { ...ok, submittedAt: 1_120 })).toEqual({ valid: true });
  });
  it("wrong challenge, before the anchor, past the window and a wrong echo are each refused", () => {
    expect(verifyCaptureFreshness(capture(), { ...ok, challengeId: "x" }).reason).toMatch(/challengeId mismatch/);
    expect(verifyCaptureFreshness(capture(), { ...ok, submittedAt: 999 }).reason).toMatch(/earlier than anchor/);
    expect(verifyCaptureFreshness(capture(), { ...ok, submittedAt: 1_121 }).reason).toMatch(/expired/);
    expect(verifyCaptureFreshness(capture(), { ...ok, visualNonceEcho: "nonce-abc" }).reason).toMatch(/visualNonce mismatch/);
  });
});

describe("fresh.challenge_bound PrimitiveVerifier", () => {
  const v = makeFreshChallengeBoundVerifier();
  const ctx = { vocabVersion: 1, jobId: JOB };
  const exec = (over: Partial<WorkflowChallenge> = {}) => {
    const c = challenge(over);
    return { form: "execution" as const, challenge: c, proof: proof(c), currentBlockTimestamp: 1_300n };
  };
  const cap = (over: Partial<CaptureNonceChallengePayload> = {}) => ({
    form: "capture" as const,
    challenge: capture(over),
    response: { challengeId: "cap-1", submittedAt: 1_060, visualNonceEcho: "nonce-xyz" },
  });

  it("is registered under its vocabulary id", () => {
    expect(v.id).toBe(FRESH_CHALLENGE_BOUND_ID);
    expect(FRESH_CHALLENGE_BOUND_ID).toBe("fresh.challenge_bound");
  });

  it("no response yet is pending, never met", async () => {
    expect((await v.verify(null, { form: "execution" }, ctx)).met).toBe("pending");
  });

  it("a fresh response to this job's challenge is met, in either form", async () => {
    expect((await v.verify(exec(), { form: "execution" }, ctx)).met).toBe(true);
    expect((await v.verify(cap(), { form: "capture", maxAgeSeconds: 120 }, ctx)).met).toBe(true);
  });

  it("a fresh response to ANOTHER job's challenge is not met", async () => {
    expect((await v.verify(exec({ scope: "job-other" }), { form: "execution" }, ctx)).met).toBe(false);
    expect((await v.verify(cap({ scope: "job-other" }), { form: "capture" }, ctx)).met).toBe(false);
  });

  it("without ctx.jobId nothing is met: the scope cannot be checked", async () => {
    const r = await v.verify(exec(), { form: "execution" }, { vocabVersion: 1 });
    expect(r.met).toBe(false);
    expect(r.detail[0]).toMatch(/ctx\.jobId is required/);
    // A scopeless challenge must not "match" a missing job id (undefined === undefined).
    const scopeless = exec({ scope: undefined as unknown as string });
    expect((await v.verify(scopeless, { form: "execution" }, { vocabVersion: 1 })).met).toBe(false);
  });

  it("the committed maxAgeSeconds caps the challenge's own window", async () => {
    expect((await v.verify(cap({ maxAgeSeconds: 600 }), { form: "capture", maxAgeSeconds: 120 }, ctx)).met).toBe(false);
    expect((await v.verify(cap(), { form: "capture", maxAgeSeconds: 0 }, ctx)).met).toBe(false);
  });

  it("a wrong or unknown form, and a stale response, are not met", async () => {
    expect((await v.verify(exec(), { form: "capture" }, ctx)).met).toBe(false);
    expect((await v.verify(exec(), { form: "gesture" }, ctx)).met).toBe(false);
    expect((await v.verify(exec(), undefined, ctx)).met).toBe(false);
    const stale = { ...exec(), currentBlockTimestamp: 5_000n };
    expect((await v.verify(stale, { form: "execution" }, ctx)).met).toBe(false);
  });

  it("a malformed instance fails closed instead of throwing", async () => {
    const r = await v.verify({ form: "execution", challenge: { scope: JOB }, proof: {} }, { form: "execution" }, ctx);
    expect(r.met).toBe(false);
    expect(r.detail[0]).toMatch(/malformed instance/);
  });
});
