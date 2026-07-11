/**
 * Money-path correctness: POST /api/negotiate/session/:id/commit must NOT return
 * a false HTTP 200 when REAL settlement wiring fails.
 *
 * The bug: after marking the session "committed", the handler called
 * createJobFromSession inside a try/catch that only console.warn'd on throw, then
 * returned 200 with escrowAddress:null. In real-settlement mode a buyer was told
 * the deal was funded when NO on-chain escrow existed.
 *
 * The fix: in real mode (MOCK_SETTLEMENT="false"), a throw OR a result without an
 * escrowAddress → HTTP 502 { error: "settlement_failed", ... }. Mock/dev mode is
 * unchanged (best-effort 200).
 *
 * Real-mode failure is exercised faithfully (not mocked): with MOCK_SETTLEMENT
 * "false" and PCC_GATEWAY_PRIVATE_KEY unset, createJobFromSession throws
 * "PCC_GATEWAY_PRIVATE_KEY required for real settlement" before any on-chain call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const { negotiationSessions } = schema;

// ---------------------------------------------------------------------------
// Mocks (mirror negotiation-settlement-correctness.test.ts so registration and
// any offline paths behave). The real-mode throw happens before these are hit.
// ---------------------------------------------------------------------------

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
  submitEvidenceV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_v2" }),
  submitAttestationV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_attest_v2" }),
  getMilestoneV2: vi.fn().mockResolvedValue({ stepId: "0xstep" }),
  resolveMockUSDCAddress: vi.fn().mockReturnValue("0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Same seeded pair the correctness test uses (passes the capability-match gate).
const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

// Preserve the settlement-mode env across tests; each test sets its own mode.
const ORIG = {
  mock: process.env.MOCK_SETTLEMENT,
  pk: process.env.PCC_GATEWAY_PRIVATE_KEY,
};

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.ready();
  return app;
}

async function createSession(app: FastifyInstance, userAgentId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/negotiate/session",
    payload: { userAgentId, kernelId: KERNEL, capabilityType: CAP },
  });
  expect(res.statusCode).toBe(200);
  return res.json().session.id;
}
function quote(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` });
}
function review(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` });
}
function commit(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit` });
}

/** Drive a fresh session up to (but not through) /commit. */
async function toReview(app: FastifyInstance, userAgentId: string): Promise<string> {
  const id = await createSession(app, userAgentId);
  expect((await quote(app, id)).statusCode).toBe(200);
  expect((await review(app, id)).statusCode).toBe(200);
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("negotiation /commit — fail loud on real-settlement failure", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    // Restore settlement-mode env so we don't leak into other tests.
    if (ORIG.mock === undefined) delete process.env.MOCK_SETTLEMENT;
    else process.env.MOCK_SETTLEMENT = ORIG.mock;
    if (ORIG.pk === undefined) delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    else process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG.pk;
  });

  it("REAL mode + createJobFromSession throws → HTTP 502, not a false 200", async () => {
    const id = await toReview(app, "real-throws");

    // Real settlement, no gateway key → createJobFromSession throws before any
    // on-chain call ("PCC_GATEWAY_PRIVATE_KEY required for real settlement").
    process.env.MOCK_SETTLEMENT = "false";
    delete process.env.PCC_GATEWAY_PRIVATE_KEY;

    const res = await commit(app, id);

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("settlement_failed");
    expect(body.message).toContain("PCC_GATEWAY_PRIVATE_KEY");
    expect(body.sessionId).toBe(id);
    // No false escrow leaked into the response.
    expect(body.escrowAddress).toBeUndefined();
  });

  it("REAL-mode failure leaves the session committed so a retry is 409-blocked (no double escrow)", async () => {
    const id = await toReview(app, "real-retry");
    process.env.MOCK_SETTLEMENT = "false";
    delete process.env.PCC_GATEWAY_PRIVATE_KEY;

    expect((await commit(app, id)).statusCode).toBe(502);

    // Rollback decision: the row stays "committed", so assertSessionLive() 409s a
    // retry of /commit. That guard is what stops a second createJobFromSession
    // from deploying a duplicate escrow if a first attempt had already created one.
    const row = getStore().db
      .select().from(negotiationSessions)
      .where(eq(negotiationSessions.id, id)).get();
    expect(row!.status).toBe("committed");

    const retry = await commit(app, id);
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error).toContain("committed");
  });

  it("MOCK mode commit is unchanged: 200 with a (synthetic) escrow", async () => {
    const id = await toReview(app, "mock-ok");

    // Mock/dev mode — the default. Best-effort behavior is preserved.
    process.env.MOCK_SETTLEMENT = "true";

    const res = await commit(app, id);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.escrowAddress).toBeTruthy();
    expect(body.escrowId).toBeTruthy();
    expect(body.jobId).toBeTruthy();
  });
});
