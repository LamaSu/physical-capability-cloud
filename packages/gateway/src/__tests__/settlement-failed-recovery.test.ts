/**
 * Recovery for a stuck "settlement_failed" negotiation session.
 *
 * #242 made /commit fail loud (502) when REAL settlement wiring fails, but left the
 * row status="committed" — so the session was stuck: a /commit retry 409s and there
 * was no cancel/retry path. This suite covers the fix:
 *
 *   1. A real-settlement commit failure moves the session to "settlement_failed"
 *      (not silently "committed"); the 502 body is unchanged.
 *   2. A naive /commit retry is still 409-blocked (double-escrow guard preserved).
 *   3. POST /retry-settlement NEVER double-mints:
 *        - escrow already recorded → RESUME from it, no new escrow;
 *        - no escrow + provably pre-flight failure → safe to re-mint;
 *        - no escrow + ambiguous failure → FAIL CLOSED (refuse).
 *   4. DELETE cancels a settlement_failed session cleanly.
 *
 * This file is intentionally NOT in vitest.config.ts `exclude` (unlike
 * paid-job-flow.test.ts / settlement.test.ts, per #322), so it runs in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { schema, eq } from "@pcc/store";

const { negotiationSessions } = schema;

// Mirror negotiation-commit-fail-loud.test.ts so registration / offline paths behave.
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

// Seeded pair (passes the capability-match gate) — same as the fail-loud suite.
const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

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
const quote = (app: FastifyInstance, id: string) =>
  app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` });
const review = (app: FastifyInstance, id: string) =>
  app.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` });
const commit = (app: FastifyInstance, id: string) =>
  app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit` });
const retry = (app: FastifyInstance, id: string) =>
  app.inject({ method: "POST", url: `/api/negotiate/session/${id}/retry-settlement` });
const cancel = (app: FastifyInstance, id: string) =>
  app.inject({ method: "DELETE", url: `/api/negotiate/session/${id}` });

async function toReview(app: FastifyInstance, userAgentId: string): Promise<string> {
  const id = await createSession(app, userAgentId);
  expect((await quote(app, id)).statusCode).toBe(200);
  expect((await review(app, id)).statusCode).toBe(200);
  return id;
}

/** Drive a fresh session into REAL-mode settlement_failed (no gateway key → the
 *  createJobFromSession real path throws pre-flight before any on-chain call). */
async function toSettlementFailed(app: FastifyInstance, userAgentId: string): Promise<string> {
  const id = await toReview(app, userAgentId);
  process.env.MOCK_SETTLEMENT = "false";
  delete process.env.PCC_GATEWAY_PRIVATE_KEY;
  expect((await commit(app, id)).statusCode).toBe(502);
  return id;
}

function sessionRow(id: string) {
  return getStore().db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
}
function escrowCount(): number {
  return getRepos().escrows.findAll().length;
}

describe("settlement_failed session — status transition + safe recovery", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    if (ORIG.mock === undefined) delete process.env.MOCK_SETTLEMENT;
    else process.env.MOCK_SETTLEMENT = ORIG.mock;
    if (ORIG.pk === undefined) delete process.env.PCC_GATEWAY_PRIVATE_KEY;
    else process.env.PCC_GATEWAY_PRIVATE_KEY = ORIG.pk;
  });

  // ── 1. failure transition ────────────────────────────────────────────────
  it("real-settlement commit failure moves the session to settlement_failed (502 body unchanged)", async () => {
    const id = await toReview(app, "fail-transition");
    process.env.MOCK_SETTLEMENT = "false";
    delete process.env.PCC_GATEWAY_PRIVATE_KEY;

    const res = await commit(app, id);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("settlement_failed");
    expect(res.json().sessionId).toBe(id);

    expect(sessionRow(id)!.status).toBe("settlement_failed");
    // No escrow was minted (pre-flight throw before any on-chain call).
    expect(escrowCount()).toBe(0);
  });

  it("a naive /commit retry on a settlement_failed session is 409-blocked", async () => {
    const id = await toSettlementFailed(app, "naive-commit");
    const res = await commit(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("settlement failed");
    // Still settlement_failed, still zero escrows — no double-mint.
    expect(sessionRow(id)!.status).toBe("settlement_failed");
    expect(escrowCount()).toBe(0);
  });

  // ── 2. retry: escrow-already-exists → RESUME, never re-mint ───────────────
  it("retry RESUMES from an escrow recorded by cwmId — no second escrow minted", async () => {
    const id = await toSettlementFailed(app, "resume-by-cwm");
    const before = sessionRow(id)!;
    expect(before.cwmId).toBeTruthy();

    // Simulate the partial-failure window: the on-chain escrow WAS minted and its DB
    // row written (createJobFromSession line ~560), but job/scope wiring then threw —
    // so the escrow row exists (keyed by the session's cwmId) but the session never
    // got its escrowAddress. Recovery must find and reuse it, not mint a new one.
    const ESCROW = "0xabc0000000000000000000000000000000000001";
    getRepos().escrows.insert({
      id: "esc-recorded-1",
      cwmId: before.cwmId!,
      contractAddress: ESCROW,
      payer: before.userAgentId,
      totalAmount: "10.00",
      currency: "USDC",
      status: "created",
      createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 86_400_000).toISOString(),
      version: "v2",
    } as any);
    expect(escrowCount()).toBe(1);

    const res = await retry(app, id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resumed).toBe(true);
    expect(body.escrowAddress).toBe(ESCROW);

    // No NEW escrow minted; session recovered to committed against the existing one.
    expect(escrowCount()).toBe(1);
    expect(sessionRow(id)!.status).toBe("committed");
    expect(sessionRow(id)!.escrowAddress).toBe(ESCROW);
  });

  it("retry RESUMES from an escrow already recorded on the session row — no re-mint", async () => {
    const id = await toSettlementFailed(app, "resume-by-session");
    const ESCROW = "0xdef0000000000000000000000000000000000002";
    // Defensive belt: even without an escrows-table row, a real escrowAddress already
    // on the session is proof an escrow exists → resume, never mint.
    getStore().db.update(negotiationSessions)
      .set({ escrowAddress: ESCROW })
      .where(eq(negotiationSessions.id, id)).run();

    const res = await retry(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().resumed).toBe(true);
    expect(res.json().escrowAddress).toBe(ESCROW);
    expect(escrowCount()).toBe(0); // nothing minted
    expect(sessionRow(id)!.status).toBe("committed");
  });

  // ── 3. retry: no escrow + ambiguous failure → FAIL CLOSED ─────────────────
  it("retry FAILS CLOSED when the failure was ambiguous (an escrow may exist but is unrecorded)", async () => {
    const id = await toSettlementFailed(app, "ambiguous");
    // Rewrite the latest settlement_failed marker to the ambiguous class — i.e. a
    // failure where the gateway key WAS present, so an on-chain escrow may have been
    // minted before the throw. With no recorded escrow, a re-mint could duplicate it.
    const row = sessionRow(id)!;
    const transitions = (row.transitions as any[]).map((t) =>
      t.to === "settlement_failed"
        ? { ...t, reason: "settlement_failed:onchain_maybe_minted" }
        : t,
    );
    getStore().db.update(negotiationSessions)
      .set({ transitions: transitions as any })
      .where(eq(negotiationSessions.id, id)).run();

    process.env.MOCK_SETTLEMENT = "false";
    const res = await retry(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("settlement_unrecoverable_ambiguous");
    // Refused — no mint, session stays settlement_failed for manual resolution / cancel.
    expect(escrowCount()).toBe(0);
    expect(sessionRow(id)!.status).toBe("settlement_failed");
  });

  // ── 4. retry: no escrow + provably pre-flight failure → safe to re-mint ───
  it("retry re-mints when the failure was provably pre-flight (config fixed → mock mode succeeds), exactly one escrow", async () => {
    const id = await toSettlementFailed(app, "safe-remint");
    // Marker is PREFLIGHT (no key at failure). Operator "fixes config": here we flip
    // to mock mode so the re-mint completes deterministically in-process.
    expect(escrowCount()).toBe(0);
    process.env.MOCK_SETTLEMENT = "true";

    const res = await retry(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(true);
    expect(res.json().escrowAddress).toBeTruthy();
    // Exactly ONE escrow — the re-mint, no duplicate.
    expect(escrowCount()).toBe(1);
    expect(sessionRow(id)!.status).toBe("committed");
  });

  it("retry in REAL mode with the config still broken re-fails safely — never mints", async () => {
    const id = await toSettlementFailed(app, "safe-still-broken");
    // Still no key → retry re-attempts (marker is safe) but throws pre-flight again.
    process.env.MOCK_SETTLEMENT = "false";
    delete process.env.PCC_GATEWAY_PRIVATE_KEY;

    const res = await retry(app, id);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("settlement_failed");
    // Back to settlement_failed, still zero escrows — a failing retry never double-mints.
    expect(sessionRow(id)!.status).toBe("settlement_failed");
    expect(escrowCount()).toBe(0);
  });

  it("retry on a non-settlement_failed session is rejected", async () => {
    const id = await toReview(app, "wrong-state");
    const res = await retry(app, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("nothing to retry");
  });

  // ── 5. cancel closes a settlement_failed session cleanly ──────────────────
  it("DELETE cancels a settlement_failed session cleanly", async () => {
    const id = await toSettlementFailed(app, "cancel");
    const res = await cancel(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(true);
    expect(sessionRow(id)!.status).toBe("cancelled");
  });
});
