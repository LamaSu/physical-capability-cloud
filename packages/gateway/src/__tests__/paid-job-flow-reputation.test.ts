/**
 * Runtime coverage for the EXTERNAL completion path's reputation settle
 * call-sites in `PUT /api/jobs/:jobId/complete` (paid-job-flow.ts).
 *
 * The settle seam itself is unit-tested in reputation-completion.test.ts. This
 * file closes the remaining gap: the original paid-job-flow.test.ts is in the
 * vitest `exclude` list (its status/response expectations went stale in the
 * facade rewrite — e.g. it still asserts scopes are revoked on completion,
 * which the route now intentionally does NOT do), so the two settle call-sites
 * on the real route had type-checking but no runtime test. Here we drive the
 * REAL `/complete` route via `app.inject` and spy on `settleStepReputationForJob`
 * to prove the route wires both branches:
 *   (a) oracle-VERIFIED success → settleStepReputationForJob(jobId, "success", {evidenceBundleId})
 *   (b) 422 oracle_verification_failed → settleStepReputationForJob(jobId, "failed")
 *
 * Only the real-I/O boundaries are mocked: evidence storage (IPFS/local archive)
 * and the verification oracle (to force verified true/false). The reputation
 * module is spied but DELEGATES to the real implementation, so the +10/+5 credit
 * and the -15 debit are asserted end-to-end against the in-memory ledger — the
 * same math reputation-completion.test.ts locks in at the seam level.
 *
 * No escrow-client / on-chain mocks are needed: with MOCK_SETTLEMENT=true and a
 * seeded job that has no negotiation session (no real escrow), every V2/V3
 * on-chain branch is gated off, so the route settles via the mock path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// ── Mock the real-I/O boundaries BEFORE importing the route ────────────────

// Evidence storage: the route archives the bundle best-effort; mocking the
// factory keeps the test hermetic + fast (no real IPFS/local writes).
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi
      .fn()
      .mockResolvedValue({ cid: "bafytest-repext", metadataCid: "bafymeta-repext" }),
    archiveEncryptedBundle: vi
      .fn()
      .mockResolvedValue({ cid: "bafyenc-repext", metadataCid: "bafyencmeta-repext" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Oracle: force verified true/false per test. Preserve every other export
// (the route also imports buildEasAttestationMetadata from this module).
vi.mock("../services/oracle-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/oracle-client.js")>();
  return { ...actual, verifyWithOracle: vi.fn() };
});

// Reputation: spy on the settle seam but delegate to the REAL implementation so
// the ledger side-effects (credit/debit) still happen and can be asserted. The
// route's `import { settleStepReputationForJob } from "./reputation.js"` resolves
// to this same mocked module, so the spy captures the route's call.
vi.mock("../routes/reputation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/reputation.js")>();
  return {
    ...actual,
    settleStepReputationForJob: vi.fn(actual.settleStepReputationForJob),
  };
});

import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { verifyWithOracle, type OracleResponse } from "../services/oracle-client.js";
import {
  settleStepReputationForJob,
  recordStepOutcome,
  getOrInitReputation,
  _clearReputationForTests,
} from "../routes/reputation.js";
import { initStore, closeStore, getRepos } from "../db.js";

const STARTED_AT = "2026-07-06T10:00:00.000Z";

/** A deterministic OracleResponse shaped exactly like the real mock/live one. */
function buildOracleResponse(verified: boolean): OracleResponse {
  return {
    result: {
      verified,
      tier: 0,
      reason: verified ? "mock_verification" : "evidence_insufficient",
      checks: {
        evidenceExists: verified,
        hashMatches: verified,
        tierMet: verified,
        notReplay: true,
        identityValid: true,
      },
    },
    attestation: verified
      ? {
          version: 1,
          escrowAddress: "0x0000000000000000000000000000000000000000",
          jobId: "job-001",
          evidenceHash: "0x" + "00".repeat(32),
          tier: 0,
          verified: true,
          timestamp: Math.floor(Date.now() / 1000),
          nonce: "0x" + "0".repeat(64),
          extraData: "0x",
          signature: "0x" + "0".repeat(130),
        }
      : null,
    easAttestation: null,
    oracle: "0x0000000000000000000000000000000000000000",
    chainId: 84532,
  };
}

/**
 * Thread the (compositionId, stepIndex) bridge onto a seeded job AND record its
 * `pending` step outcome — the exact "credit at completion, not ack" setup the
 * real composition path produces. Without both, the settle is inert.
 */
function linkStep(
  jobId: string,
  compositionId: string,
  stepIndex: number,
  agentId: string,
): void {
  recordStepOutcome({
    compositionId,
    stepIndex,
    capabilityId: "cap-nyc-fdm",
    agentId,
    status: "pending",
    startedAt: STARTED_AT,
  });
  getRepos().jobs.update(jobId, {
    parameters: { __pccStep: { compositionId, stepIndex } },
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.ready();
  return app;
}

describe("PUT /api/jobs/:jobId/complete — external-path reputation settle", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    delete process.env.PCC_USE_EAS_V2;
    delete process.env.PCC_ORACLE_KEY;
    vi.clearAllMocks();
    initStore({ seed: true });
    _clearReputationForTests();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("oracle-verified success → settles the step as success, credits the ledger, returns 200", async () => {
    vi.mocked(verifyWithOracle).mockResolvedValue(buildOracleResponse(true));

    // job-001 is a seeded, non-terminal ("executing") job — attach a 1-step
    // composition bridge with a pending outcome so the settle has a step to credit.
    linkStep("job-001", "comp-ext-ok", 0, "op-success");
    expect(getOrInitReputation("op-success").score).toBe(500);

    const res = await app.inject({
      method: "PUT",
      url: "/api/jobs/job-001/complete",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("settled");
    expect(body.oracleVerified).toBe(true);
    expect(body.evidenceBundleId).toMatch(/^bundle-/);

    // (a) settle called on the SUCCESS branch, carrying the evidence bundle id
    // the route just minted (same value it returned to the caller).
    expect(settleStepReputationForJob).toHaveBeenCalledTimes(1);
    expect(settleStepReputationForJob).toHaveBeenCalledWith("job-001", "success", {
      evidenceBundleId: body.evidenceBundleId,
    });

    // Real ledger effect: 1-step composition success = +10 step +5 composition
    // bonus → score 515 across two positive deltas (step_completed + composition_completed).
    const rep = getOrInitReputation("op-success");
    expect(rep.score).toBe(515);
    expect(rep.positiveContributions).toBe(2);
  });

  it("422 oracle_verification_failed → settles the step as failed and debits the ledger", async () => {
    vi.mocked(verifyWithOracle).mockResolvedValue(buildOracleResponse(false));

    linkStep("job-001", "comp-ext-fail", 0, "op-fail");
    expect(getOrInitReputation("op-fail").score).toBe(500);

    const res = await app.inject({
      method: "PUT",
      url: "/api/jobs/job-001/complete",
      payload: {},
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("oracle_verification_failed");

    // (b) settle called on the FAILURE branch, before the 422, with verdict
    // "failed" and no options (the 2-arg form the route uses).
    expect(settleStepReputationForJob).toHaveBeenCalledTimes(1);
    expect(settleStepReputationForJob).toHaveBeenCalledWith("job-001", "failed");

    // Real ledger effect: step failed = -15, and (deferral) no positive credit
    // was ever applied at ack, so nothing to reverse.
    const rep = getOrInitReputation("op-fail");
    expect(rep.score).toBe(485);
    expect(rep.positiveContributions).toBe(0);
    expect(rep.negativeContributions).toBe(1);
  });

  it("is inert for a completion whose job carries no __pccStep bridge (still 200)", async () => {
    vi.mocked(verifyWithOracle).mockResolvedValue(buildOracleResponse(true));

    // job-003 (seeded, "queued") is a single non-composition job — no bridge.
    const res = await app.inject({
      method: "PUT",
      url: "/api/jobs/job-003/complete",
      payload: {},
    });

    expect(res.statusCode).toBe(200);

    // The route still invokes settle unconditionally on the success branch…
    expect(settleStepReputationForJob).toHaveBeenCalledWith(
      "job-003",
      "success",
      expect.objectContaining({ evidenceBundleId: expect.stringMatching(/^bundle-/) }),
    );
    // …but the seam is inert: no (compositionId, stepIndex) bridge → no deltas.
    expect(vi.mocked(settleStepReputationForJob).mock.results[0].value).toEqual([]);
  });
});
