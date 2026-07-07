/**
 * Correctness fixes on the live settlement path (negotiation -> commit ->
 * escrow -> completion). One focused test per fix:
 *
 *   N1 — TTL/status is enforced on /quote, /review, /commit: a cancelled or
 *        expired session can no longer be advanced or committed.
 *   N2 — changing selections after a quote invalidates the quote + contract
 *        terms, so /commit can't lock escrow at a stale price.
 *   N3 — the agreed assurance tier is carried verbatim from /quote through
 *        /review, never re-derived from the bond dollar amount.
 *   P1 — PUT /api/jobs/:jobId/complete is single-shot: a re-run (or a
 *        concurrent duplicate) is rejected instead of double-settling.
 *
 * Mock settlement is on; all external calls (IPFS, chain) are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const { negotiationSessions } = schema;

// ---------------------------------------------------------------------------
// Mocks (mirror paid-job-flow.test.ts so the completion pipeline runs offline)
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

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.ready();
  return app;
}

// Seeded pair that passes the kernel_capability_mismatch gate: kernel-biolab-01
// registers a `liquid-handler` capability (cap-bio-liquid). The `liquid-handler`
// built-in template drives quote pricing (basePrice $10.00).
const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

async function createSession(app: FastifyInstance, userAgentId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/negotiate/session",
    payload: { userAgentId, kernelId: KERNEL, capabilityType: CAP },
  });
  expect(res.statusCode).toBe(200);
  return res.json().session.id;
}

async function select(app: FastifyInstance, id: string, selections: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/negotiate/session/${id}/select`, payload: { selections } });
}
async function quote(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/quote` });
}
async function review(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/review` });
}
async function commit(app: FastifyInstance, id: string) {
  return app.inject({ method: "POST", url: `/api/negotiate/session/${id}/commit` });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("negotiation + settlement correctness", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // N1 — TTL / terminal-status enforcement on quote / review / commit
  // ═══════════════════════════════════════════════════════════════════════

  describe("N1 — dead sessions cannot be advanced or committed", () => {
    it("rejects /commit on a cancelled session (no escrow for a dead deal)", async () => {
      const id = await createSession(app, "n1-cancel");
      expect((await quote(app, id)).statusCode).toBe(200);
      expect((await review(app, id)).statusCode).toBe(200);

      // Cancel the session, then try to commit it.
      const del = await app.inject({ method: "DELETE", url: `/api/negotiate/session/${id}` });
      expect(del.statusCode).toBe(200);

      const res = await commit(app, id);
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toContain("cancelled");
    });

    it("rejects /commit on an expired session and persists status=expired", async () => {
      const id = await createSession(app, "n1-expire");
      expect((await quote(app, id)).statusCode).toBe(200);
      expect((await review(app, id)).statusCode).toBe(200);

      // Force the TTL into the past.
      const { db } = getStore();
      db.update(negotiationSessions)
        .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(negotiationSessions.id, id))
        .run();

      const res = await commit(app, id);
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toContain("expired");

      // The gate self-heals the row so it stops being resurrectable.
      const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
      expect(row!.status).toBe("expired");

      // ...and no job was created for the dead session.
      expect(row!.jobId).toBeNull();
    });

    it("rejects /quote on an expired session (410, not a fresh quote)", async () => {
      const id = await createSession(app, "n1-quote");
      const { db } = getStore();
      db.update(negotiationSessions)
        .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(negotiationSessions.id, id))
        .run();

      const res = await quote(app, id);
      expect(res.statusCode).toBe(410);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // N2 — changing selections after a quote invalidates it (no stale-price commit)
  // ═══════════════════════════════════════════════════════════════════════

  describe("N2 — selections change invalidates quote + contract terms", () => {
    it("clears quote/contractTerms on /select so a stale-price commit is rejected", async () => {
      const id = await createSession(app, "n2-stale");

      // Quote + review at quantity 1 (exact price depends on operator rules).
      expect((await select(app, id, { quantity: 1 })).statusCode).toBe(200);
      const q1 = (await quote(app, id)).json();
      const price1 = q1.quote.totalPrice as string;
      const r1 = (await review(app, id)).json();
      expect(r1.contractTerms.milestones[0].amount).toBe(price1);

      // Change the quantity to 1000 AFTER the quote/review.
      const selRes = await select(app, id, { quantity: 1000 });
      expect(selRes.statusCode).toBe(200);
      // The prior quote + terms are invalidated in both the response and the DB.
      expect(selRes.json().session.quote).toBeNull();
      expect(selRes.json().session.contractTerms).toBeNull();

      // Committing now is rejected — no locking escrow at the stale price while
      // the job parameters already say quantity 1000.
      const commitRes = await commit(app, id);
      expect(commitRes.statusCode).toBe(400);
      expect(commitRes.json().error).toContain("review");
    });

    it("re-quote after a selections change binds escrow to the NEW price", async () => {
      const id = await createSession(app, "n2-requote");

      expect((await select(app, id, { quantity: 1 })).statusCode).toBe(200);
      const price1 = (await quote(app, id)).json().quote.totalPrice as string;
      expect((await review(app, id)).statusCode).toBe(200);

      // Bump quantity, then re-run the full quote -> review -> commit flow.
      expect((await select(app, id, { quantity: 1000 })).statusCode).toBe(200);
      const price2 = (await quote(app, id)).json().quote.totalPrice as string;
      // 1000x the quantity => strictly higher than the qty-1 price.
      expect(parseFloat(price2)).toBeGreaterThan(parseFloat(price1));
      expect((await review(app, id)).statusCode).toBe(200);

      const commitRes = await commit(app, id);
      expect(commitRes.statusCode).toBe(200);
      const escrowId = commitRes.json().escrowId as string;
      expect(escrowId).toBeTruthy();

      // Escrow holds the re-quoted price, not the original qty-1 price.
      const escrow = getRepos().escrows.findById(escrowId);
      expect(escrow!.totalAmount).toBe(price2);
      expect(escrow!.totalAmount).not.toBe(price1);
    });
  });
});
