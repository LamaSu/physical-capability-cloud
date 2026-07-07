/**
 * A2A commit-path correctness (cross-review finding #1 / A-1).
 *
 * The negotiation route's N1 (liveness) and N3 (verbatim tier) fixes only
 * covered POST /api/negotiate/session/:id/*. The A2A adapter has a SECOND live
 * commit path — POST /a2a/tasks/send (pcc-quote / pcc-submit → commitPccSession)
 * — that wrote the SAME `sess-` table with none of those gates and re-introduced
 * the exact N3 bond-dollar tier derivation. These tests mirror the
 * negotiation-route correctness tests for the A2A path:
 *
 *   A-1a — commitPccSession rejects a cancelled session (shared liveness gate).
 *   A-1b — commitPccSession rejects an expired session and self-heals status.
 *   A-1c — commitPccSession rejects a stale quote (honors quote.validUntil).
 *   A-1d — pcc-submit carries the agreed tier verbatim (basic stays 1 when bond>5).
 *   A-1e — pcc-submit carries the agreed tier verbatim (full stays 2 when bond<5).
 *
 * Mock settlement is on; the createJobFromSession wiring runs offline.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  a2aTasksRoutes,
  createPccQuote,
  commitPccSession,
  __resetA2ATasksForTest,
} from "../routes/a2a-tasks.js";
import { initStore, closeStore, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";

const { negotiationSessions, shopKernels, capabilities } = schema;

const KERNEL = "kernel-a2a-test";
const CAP = "fdm";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_A2A_AUTH_DISABLED = "true";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const { db } = getStore();
  const now = new Date().toISOString();
  db.insert(shopKernels).values({
    id: KERNEL,
    name: "A2A Test Kernel",
    operatorAddress: "0xa2a",
    location: { lat: 0, lng: 0 },
    physicalAddress: "test",
    maxAssuranceTier: 2,
    publicKey: "a2a-key",
    reputation: 0,
    totalJobsCompleted: 0,
    status: "online",
    registeredAt: now,
    lastHeartbeat: now,
    version: "1.0.0",
  } as any).run();
  db.insert(capabilities).values({
    id: "cap-a2a-test",
    kernelId: KERNEL,
    type: CAP,
    name: "Test FDM",
    description: "A2A test FDM",
    materials: ["PLA"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "10", minimum: "5" },
    location: { lat: 0, lng: 0 },
    queueDepth: 0,
    availability: { timezone: "UTC", windows: {} },
  } as any).run();

  const app = Fastify({ logger: false });
  await app.register(a2aTasksRoutes);
  await app.ready();
  return app;
}

function rpcRequest(id: string | number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function sendSkill(
  app: FastifyInstance,
  id: string,
  skill: string,
  params: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/a2a/tasks/send",
    payload: rpcRequest(id, "tasks/send", { skill, params }),
    headers: { "content-type": "application/json" },
  });
}

/** What the OLD commit path derived from the bond dollar amount (the A-1/N3 bug). */
function oldBondDerivedTier(bondAmount: string): number {
  return bondAmount === "0.00" ? 0 : parseFloat(bondAmount) > 5 ? 2 : 1;
}

describe("A2A commit-path correctness (finding #1 / A-1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
    __resetA2ATasksForTest();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  // ── A-1a/b/c — liveness gate on the A2A commit path ──────────────────────

  async function quotedSession(agent: string): Promise<string> {
    const res = await sendSkill(app, `q-${agent}`, "pcc-quote", {
      userAgentId: agent,
      kernelId: KERNEL,
      capabilityType: CAP,
      selections: { quantity: 1, evidenceTier: "basic" },
    });
    expect(res.statusCode).toBe(200);
    const sessionId = res.json().result.pccSessionId as string;
    expect(sessionId).toMatch(/^sess-/);
    return sessionId;
  }

  it("A-1a: rejects commit on a cancelled session (no escrow for a dead deal)", async () => {
    const id = await quotedSession("a1a-cancel");
    const { db } = getStore();
    db.update(negotiationSessions).set({ status: "cancelled" }).where(eq(negotiationSessions.id, id)).run();

    await expect(commitPccSession(id)).rejects.toThrow(/cancelled/i);

    // No job was minted for the dead session.
    const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
    expect(row!.jobId).toBeNull();
    expect(row!.status).toBe("cancelled");
  });

  it("A-1b: rejects commit on an expired session and self-heals status=expired", async () => {
    const id = await quotedSession("a1b-expire");
    const { db } = getStore();
    db.update(negotiationSessions)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(negotiationSessions.id, id))
      .run();

    await expect(commitPccSession(id)).rejects.toThrow(/expired/i);

    // The shared gate self-heals the row so it stops being resurrectable.
    const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
    expect(row!.status).toBe("expired");
    expect(row!.jobId).toBeNull();
  });

  it("A-1c: rejects commit when the quote's validUntil has passed (no stale-price lock)", async () => {
    const id = await quotedSession("a1c-stale");
    const { db } = getStore();
    // Session is still live (not expired), but the QUOTE window has passed.
    const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
    const staleQuote = { ...(row!.quote as Record<string, unknown>), validUntil: new Date(Date.now() - 60_000).toISOString() };
    db.update(negotiationSessions).set({ quote: staleQuote as any }).where(eq(negotiationSessions.id, id)).run();

    await expect(commitPccSession(id)).rejects.toThrow(/quote expired/i);

    const after = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, id)).get();
    expect(after!.jobId).toBeNull();
  });

  it("A-1a-live: a cancelled session created via createPccQuote can't be committed", async () => {
    // Exercises the exported helpers directly end-to-end (no route), proving the
    // shared table + shared gate: createPccQuote mints, DELETE-equivalent cancels,
    // commit refuses.
    const q = await createPccQuote({
      userAgentId: "a1a-live",
      kernelId: KERNEL,
      capabilityType: CAP,
      selections: { quantity: 1, evidenceTier: "basic" },
    });
    const { db } = getStore();
    db.update(negotiationSessions).set({ status: "cancelled" }).where(eq(negotiationSessions.id, q.sessionId)).run();
    await expect(commitPccSession(q.sessionId)).rejects.toThrow(/cancelled/i);
  });

  // ── A-1d/e — agreed tier propagates verbatim (not re-derived from bond $) ──

  async function submitAndReadSession(agent: string, selections: Record<string, unknown>) {
    const res = await sendSkill(app, `s-${agent}`, "pcc-submit", {
      userAgentId: agent,
      kernelId: KERNEL,
      capabilityType: CAP,
      selections,
    });
    expect(res.statusCode).toBe(200);
    const sessionId = res.json().result.pccSessionId as string;
    const { db } = getStore();
    const row = db.select().from(negotiationSessions).where(eq(negotiationSessions.id, sessionId)).get();
    expect(row).toBeDefined();
    return row!;
  }

  it("A-1d: pcc-submit keeps tier 1 for evidenceTier 'basic' even when the bond > $5", async () => {
    // basic => tier 1 (5% bond). quantity 20 pushes the bond above $5, the exact
    // input where the old bond-derived logic wrongly jumped to tier 2.
    const row = await submitAndReadSession("a1d-basic", { evidenceTier: "basic", quantity: 20 });
    const quote = row.quote as Record<string, unknown>;
    const terms = row.contractTerms as Record<string, unknown>;

    expect(quote.assuranceTier).toBe(1); // persisted at pcc-quote from evidenceTier
    expect(parseFloat(quote.bondAmount as string)).toBeGreaterThan(5);
    // Genuine divergence: the old bond-derived logic would have said 2.
    expect(oldBondDerivedTier(quote.bondAmount as string)).toBe(2);
    // The fix: contract terms carry the agreed tier verbatim, not the bond-derived 2.
    expect(terms.assuranceTier).toBe(1);
  });

  it("A-1e: pcc-submit keeps tier 2 for evidenceTier 'full' even when the bond < $5", async () => {
    // full => tier 2 (15% bond). At quantity 1 the bond is a few dollars (< $5),
    // where the old bond-derived logic wrongly dropped to tier 1 — releasing funds
    // on weaker evidence than the buyer agreed to.
    const row = await submitAndReadSession("a1e-full", { evidenceTier: "full", quantity: 1 });
    const quote = row.quote as Record<string, unknown>;
    const terms = row.contractTerms as Record<string, unknown>;

    expect(quote.assuranceTier).toBe(2);
    const bond = parseFloat(quote.bondAmount as string);
    expect(bond).toBeGreaterThan(0);
    expect(bond).toBeLessThan(5);
    // Genuine divergence: the old bond-derived logic would have said 1.
    expect(oldBondDerivedTier(quote.bondAmount as string)).toBe(1);
    // The fix: contract terms carry the agreed tier verbatim, not the bond-derived 1.
    expect(terms.assuranceTier).toBe(2);
  });

  it("A-1f: tier 0 (no evidenceTier) still commits at tier 0", async () => {
    const row = await submitAndReadSession("a1f-default", { quantity: 1 });
    const quote = row.quote as Record<string, unknown>;
    const terms = row.contractTerms as Record<string, unknown>;
    expect(quote.assuranceTier).toBe(0);
    expect(terms.assuranceTier).toBe(0);
  });
});
