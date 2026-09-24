/**
 * R13 over HTTP, end to end: ISSUE a reservation (POST /api/settlement/reservations), ACCEPT a plan
 * against it (POST /api/settlement/agent-plans/accept), then READ it back sealed. Both routes run on ONE
 * durable BudgetReservationStore (real SQLite, in memory).
 *
 * STAND-INS, labelled as such:
 *   - the request-ceiling reader (#335's authorizedCeiling is a JS number today);
 *   - the payer-wallet binding (gateway N1/N21);
 *   - live rows, evidence's gate and map, and the encoder, as in the other route tests.
 */
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import type { EvidenceRequirement } from "@pcc/spec";
import { BudgetReservationStore, createDatabase } from "@pcc/store";
import { agentPlanRoutes, type AgentPlanRouteDeps } from "../routes/agent-plans.js";
import { MAX_RESERVATION_TTL_SEC, MIN_RESERVATION_TTL_SEC, reservationRoutes, type ReservationIssueWiring } from "../routes/reservations.js";
import type { DealEncoder } from "../services/agent-plan-deal.js";
import type { ExternalPlanSubmission, SeamDeps } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { reservationWiring } from "../services/reservation-store.js";

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";
const PROGRAM = `0x${"d2".repeat(32)}`;
const BUYER = "agent:buyer-1";
const WALLET = A("11");

const CAPS: LiveCapability[] = [
  { id: "cap-print", type: PRINT, kernelId: "k-print", pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" }, assuranceTiers: [0, 1, 2], tenantId: null },
  { id: "cap-mail", type: "mail.drop", kernelId: "k-mail", pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null },
];
const KERNELS: LiveKernel[] = [
  { id: "k-print", operatorAddress: A("aa"), status: "online" },
  { id: "k-mail", operatorAddress: A("bb"), status: "online" },
];
const EVIDENCE: Record<string, EvidenceRequirement[]> = {
  [`${PRINT}|tier2`]: [{ requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 }],
  "courier-route|tier0": [{ requirementId: "drop.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
};
const encoder: DealEncoder = (plan) =>
  plan.jobs.map((j) => ({ jobId: j.jobId, unitIds: j.units.map((_, m) => `0x${createHash("sha256").update(`${plan.acceptedDealDigest}|${j.jobId}|${m}`).digest("hex")}`) }));

/** Requests and their owners; ceilings in exact base units (the stand-in for an exact #335). */
const REQUESTS: Record<string, { owner: string; currency: string; ceilingBaseUnits: bigint }> = {
  "req-42": { owner: BUYER, currency: "USDC", ceilingBaseUnits: 30_000_000n },
  "req-theirs": { owner: "agent:someone-else", currency: "USDC", ceilingBaseUnits: 30_000_000n },
};

function world(over: Partial<ReservationIssueWiring> = {}) {
  const { sqlite } = createDatabase(":memory:");
  const store = new BudgetReservationStore(sqlite);
  store.ensureSchema();
  let n = 0;
  const issue: ReservationIssueWiring = {
    store,
    requestCeiling: (requestId, principal) => {
      const r = REQUESTS[requestId];
      return r && r.owner === principal ? { currency: r.currency, ceilingBaseUnits: r.ceilingBaseUnits } : null;
    },
    payerFor: (principal) => (principal === BUYER ? WALLET : null),
    now: () => NOW,
    newId: () => `resv_test_${++n}`,
    ...over,
  };
  const wiring = reservationWiring(store);
  const seam: SeamDeps = {
    revalidation: {
      loadCapabilities: (ids) => CAPS.filter((c) => ids.includes(c.id)),
      loadKernels: (ids) => KERNELS.filter((k) => ids.includes(k.id)),
      csdForType: (t) => (t === PRINT ? PRINT : t === "mail.drop" ? "courier-route" : null),
    },
    resolveProgram: (csd, tierKey) => (csd === PRINT && tierKey === "tier2" ? PROGRAM : null),
    assertProgramForTier: ({ committedProgramHash }) => (committedProgramHash === PROGRAM ? { ok: true } : { ok: false, code: "program-hash-mismatch" }),
    evidenceFor: (csd, tierKey) => EVIDENCE[`${csd}|${tierKey}`] ?? null,
    loadReservation: wiring.loadReservation,
    policy: { feeBps: 235, feeRecipient: A("fe"), reclaimAfterSec: 7 * 24 * 3600 },
    now: () => NOW,
  };
  const accept: AgentPlanRouteDeps = { revalidation: seam.revalidation, accept: { seam, encodeDeal: encoder, consumeReservation: wiring.consumeReservation } };
  return { store, issue, accept };
}

async function appWith(w: { issue: ReservationIssueWiring | { missing: string[] }; accept: AgentPlanRouteDeps }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    if (typeof p === "string" && p) (req as unknown as { operatorId?: string }).operatorId = p;
  });
  await app.register(reservationRoutes, { wiring: () => w.issue });
  await app.register(agentPlanRoutes, { deps: () => w.accept });
  await app.ready();
  return app;
}

const AS = (principal: string) => ({ "x-test-principal": principal });
const issueBody = (over: Record<string, unknown> = {}) => ({
  requestId: "req-42",
  currency: "USDC",
  maxAmountBaseUnits: "20000000",
  purpose: "print and mail the filing",
  expiresInSec: 3600,
  ...over,
});
const issue = (app: FastifyInstance, body: unknown, principal = BUYER) =>
  app.inject({ method: "POST", url: "/api/settlement/reservations", payload: body as object, headers: AS(principal) });
const dag = (reservationId: string): ExternalPlanSubmission => ({
  requestId: "req-42",
  reservationId,
  nodes: [
    { nodeId: "mail", capabilityId: "cap-mail", price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: "k-mail", operator: A("bb") },
    { nodeId: "print", capabilityId: "cap-print", price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: "k-print", operator: A("aa"), committedProgramHash: PROGRAM },
  ],
  edges: [{ from: "print", to: "mail" }],
});

describe("R13 over HTTP: issue -> accept -> read, on one durable store", () => {
  it("the whole path: 201 issues with server terms, accept seals it, and the principal reads it back consumed", async () => {
    const w = world();
    const app = await appWith(w);
    const res = await issue(app, issueBody({ reservationId: "resv-mine", principal: "agent:attacker", payer: A("99"), ceiling: "1" }));
    expect(res.statusCode).toBe(201);
    const r = res.json().reservation;
    expect(r).toMatchObject({ reservationId: "resv_test_1", requestId: "req-42", currency: "USDC", maxAmountBaseUnits: "20000000", payerAddress: WALLET, state: "issued", expiresAt: NOW + 3600, minTier: null });
    const accepted = await app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: dag(r.reservationId), headers: AS(BUYER) });
    expect(accepted.statusCode).toBe(200);
    const digest = accepted.json().plan.acceptedDealDigest;
    const read = await app.inject({ method: "GET", url: `/api/settlement/reservations/${r.reservationId}`, headers: AS(BUYER) });
    expect(read.statusCode).toBe(200);
    expect(read.json().reservation).toMatchObject({ state: "consumed", consumedDealDigest: digest, consumedAt: NOW });
    expect((await app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: dag(r.reservationId), headers: AS(BUYER) })).statusCode).toBe(409);
  });

  it("authority: no principal is 401; another principal's request or reservation is 404, exactly like a missing one; no bound wallet is 409", async () => {
    const w = world();
    const app = await appWith(w);
    expect((await app.inject({ method: "POST", url: "/api/settlement/reservations", payload: issueBody() })).statusCode).toBe(401);
    const theirs = await issue(app, issueBody({ requestId: "req-theirs" }));
    const missing = await issue(app, issueBody({ requestId: "req-404" }));
    expect([theirs.statusCode, missing.statusCode]).toEqual([404, 404]);
    expect(theirs.json()).toEqual(missing.json());
    const mine = (await issue(app, issueBody())).json().reservation.reservationId;
    const asOther = await app.inject({ method: "GET", url: `/api/settlement/reservations/${mine}`, headers: AS("agent:someone-else") });
    const nothing = await app.inject({ method: "GET", url: "/api/settlement/reservations/resv_nope", headers: AS("agent:someone-else") });
    expect([asOther.statusCode, nothing.statusCode]).toEqual([404, 404]);
    expect(asOther.json()).toEqual(nothing.json());
    const noWallet = await appWith(world({ payerFor: () => null }));
    expect((await issue(noWallet, issueBody())).json()).toEqual({ error: "no-payer-wallet" });
  });

  it("exact money and bounds: amounts are canonical base-unit STRINGS; the ceiling is exact; the TTL and floor are bounded; the currency must be the request's", async () => {
    const app = await appWith(world());
    for (const amount of [20000000, "0", "-1", "1.5", "020000000", "2e7", "", "1".repeat(79)]) {
      expect([amount, (await issue(app, issueBody({ maxAmountBaseUnits: amount }))).statusCode]).toEqual([amount, 400]);
    }
    for (const ttl of [MIN_RESERVATION_TTL_SEC - 1, MAX_RESERVATION_TTL_SEC + 1, 3600.5, "3600"]) {
      expect([ttl, (await issue(app, issueBody({ expiresInSec: ttl }))).statusCode]).toEqual([ttl, 400]);
    }
    for (const minTier of [4, -1, 1.5, "2"]) expect([minTier, (await issue(app, issueBody({ minTier }))).statusCode]).toEqual([minTier, 400]);
    expect((await issue(app, issueBody({ currency: "USDT" }))).json()).toEqual({ error: "currency-mismatch" });
    // The ceiling is 30 USDC: 20 + 10 fits exactly; one more base unit does not.
    expect((await issue(app, issueBody())).statusCode).toBe(201);
    expect((await issue(app, issueBody({ maxAmountBaseUnits: "10000001" }))).json()).toEqual({ error: "over-request-ceiling" });
    expect((await issue(app, issueBody({ maxAmountBaseUnits: "10000000", minTier: 2 }))).json().reservation).toMatchObject({ maxAmountBaseUnits: "10000000", minTier: 2 });
  });

  it("production wiring answers 503 on both endpoints and lists what is missing; a thrown resolver is a generic 500 that leaks nothing", async () => {
    const prod = await appWith({ issue: { missing: ["reservation-store"] }, accept: world().accept });
    const i = await issue(prod, issueBody());
    expect([i.statusCode, i.json().error]).toEqual([503, "issue-not-wired"]);
    expect((await prod.inject({ method: "GET", url: "/api/settlement/reservations/x", headers: AS(BUYER) })).statusCode).toBe(503);
    const faulty = await appWith(world({ requestCeiling: () => { throw new Error("db password in message"); } }));
    const f = await issue(faulty, issueBody());
    expect([f.statusCode, f.json()]).toEqual([500, { error: "internal-error" }]);
  });
});
