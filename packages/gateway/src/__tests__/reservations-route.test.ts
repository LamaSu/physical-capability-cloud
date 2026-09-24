/**
 * R13 over HTTP, end to end: ISSUE a reservation (POST /api/settlement/reservations), ACCEPT a plan
 * against it (POST /api/settlement/agent-plans/accept), then READ it back sealed. Both routes run on ONE
 * durable BudgetReservationStore (real SQLite, in memory).
 *
 * Set PCC_HTTP_TRACE_OUT=<path> to write the MC 9 end-to-end exchange (requests and responses) as JSON.
 *
 * STAND-INS, labelled as such:
 *   - the request-ceiling reader (#335's authorizedCeiling is a JS number today);
 * MC 9's parent-unit terms are REAL: derived from the sealed deal the store keeps (amendment #3231).
 *   - the payer-wallet binding (gateway N1/N21);
 *   - live rows, evidence's gate and map, and the encoder, as in the other route tests.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import type { EvidenceRequirement } from "@pcc/spec";
import { BudgetReservationStore, createDatabase } from "@pcc/store";
import { agentPlanRoutes, type AgentPlanRouteDeps } from "../routes/agent-plans.js";
import { MAX_RESERVATION_TTL_SEC, MIN_RESERVATION_TTL_SEC, reservationRoutes, type ParentUnitResolver, type ReservationIssueWiring } from "../routes/reservations.js";
import type { DealEncoder } from "../services/agent-plan-deal.js";
import type { ExternalPlanSubmission, SeamDeps } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { reservationWiring } from "../services/reservation-store.js";
import { sealedDealParentUnits } from "../services/sealed-deal-parent-units.js";

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";
const PROGRAM = `0x${"d2".repeat(32)}`;
const BUYER = "agent:buyer-1";
const WALLET = A("11");
const OPERATOR = A("aa"); // the print unit's operator, authenticated by its wallet
const OPERATOR_WALLET = A("a9");

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
  "req-child": { owner: OPERATOR, currency: "USDC", ceilingBaseUnits: 0n }, // the operator's subcontract request
  "req-child-usdt": { owner: OPERATOR, currency: "USDT", ceilingBaseUnits: 0n },
};

function world(over: Partial<ReservationIssueWiring> = {}, reclaimAfterSec = 7 * 24 * 3600) {
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
    payerFor: (principal) => (principal === BUYER ? WALLET : principal === OPERATOR ? OPERATOR_WALLET : null),
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
    policy: { feeBps: 235, feeRecipient: A("fe"), reclaimAfterSec },
    now: () => NOW,
  };
  const accept: AgentPlanRouteDeps = { revalidation: seam.revalidation, accept: { seam, encodeDeal: encoder, consumeReservation: wiring.consumeReservation } };
  return { store, issue, accept };
}

async function appWith(w: { issue: ReservationIssueWiring | { missing: string[] }; accept: AgentPlanRouteDeps; parentUnits?: ParentUnitResolver | { missing: string[] } }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    if (typeof p === "string" && p) (req as unknown as { operatorId?: string }).operatorId = p;
  });
  await app.register(reservationRoutes, { wiring: () => w.issue, ...(w.parentUnits ? { parentUnits: () => w.parentUnits! } : {}) });
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

describe("MC 9: bounded child authority over HTTP (#2301)", () => {
  const childBody = (unit: string, over: Record<string, unknown> = {}) => ({ unit, requestId: "req-child", currency: "USDC", maxAmountBaseUnits: "4000000", purpose: "subcontract the envelope stuffing", expiresInSec: 3600, ...over });
  const child = (app: FastifyInstance, parentId: string, body: unknown, principal: string = OPERATOR) =>
    app.inject({ method: "POST", url: `/api/settlement/reservations/${parentId}/children`, payload: body as object, headers: AS(principal) });

  async function sealedParent(over: Partial<ReservationIssueWiring> = {}, reclaimAfterSec?: number) {
    const w = world(over, reclaimAfterSec);
    const app = await appWith({ ...w, parentUnits: sealedDealParentUnits(w.store) });
    const parent = (await issue(app, issueBody())).json().reservation.reservationId;
    const accepted = await app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: dag(parent), headers: AS(BUYER) });
    expect(accepted.statusCode).toBe(200);
    const plan = accepted.json().plan;
    const print = plan.nodeToUnit.find((b: { nodeId: string }) => b.nodeId === "print");
    const printUnit = `${print.jobId}#${print.milestoneIndex}`;
    const n = BigInt(plan.jobs[print.jobIndex].units[print.milestoneIndex].n);
    return { w, app, parent, printUnit, n, plan };
  }

  it("end to end: the print unit's operator carves a child from the sealed deal with ITS OWN wallet, and a subcontracted child plan is accepted against it", async () => {
    const { app, parent, printUnit } = await sealedParent();
    const res = await child(app, parent, childBody(printUnit));
    expect(res.statusCode).toBe(201);
    const c = res.json().reservation;
    expect(c).toMatchObject({ parentReservationId: parent, parentUnit: printUnit, payerAddress: OPERATOR_WALLET, maxAmountBaseUnits: "4000000", requestId: "req-child", state: "issued" });
    // The operator subcontracts the mail drop to another operator, paid from the child reservation.
    const sub: ExternalPlanSubmission = { requestId: "req-child", reservationId: c.reservationId, nodes: [dag(c.reservationId).nodes[0]!], edges: [] };
    const accepted = await app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: sub, headers: AS(OPERATOR) });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().plan.jobs[0].payer).toBe(OPERATOR_WALLET); // never the parent payer
    if (process.env.PCC_HTTP_TRACE_OUT) {
      const parentRead = (await app.inject({ method: "GET", url: `/api/settlement/reservations/${parent}`, headers: AS(BUYER) })).json();
      const childRead = (await app.inject({ method: "GET", url: `/api/settlement/reservations/${c.reservationId}`, headers: AS(OPERATOR) })).json();
      const acceptedBody = accepted.json();
      writeFileSync(
        process.env.PCC_HTTP_TRACE_OUT,
        JSON.stringify(
          {
            note: "R9 + R13 + MC 9 over HTTP on ONE durable reservation store (real SQLite, in memory). Generated by reservations-route.test.ts. Stand-ins (labelled): request ceilings, payer wallets, live rows, evidence's gate and map, the deal encoder. The parent unit's terms are REAL: derived from the sealed deal the store keeps (amendment #3231).",
            step1_payerIssues: { request: { method: "POST", url: "/api/settlement/reservations", principal: BUYER, body: issueBody() }, response: { status: 201, reservationId: parent, state: "issued" } },
            step2_parentDealSealed: { note: "POST /api/settlement/agent-plans/accept by the payer (see the accept route's tests for the full response); the parent reservation read back afterwards:", reservation: parentRead.reservation },
            step3_operatorCarvesChild: { request: { method: "POST", url: `/api/settlement/reservations/${parent}/children`, principal: OPERATOR, body: childBody(printUnit) }, reservation: c },
            step4_childPlanAccepted: {
              request: { method: "POST", url: "/api/settlement/agent-plans/accept", principal: OPERATOR, body: sub },
              response: {
                acceptedDealDigest: acceptedBody.plan.acceptedDealDigest,
                payer: acceptedBody.plan.jobs[0].payer,
                totalObligationBaseUnits: acceptedBody.plan.totalObligationBaseUnits,
                dealBindings: acceptedBody.dealBindings,
                sealed: acceptedBody.sealed,
                presentation: { layer: acceptedBody.presentation.layer, state: acceptedBody.presentation.state },
              },
            },
            step5_childReadBack: childRead.reservation,
          },
          null,
          2,
        ) + "\n",
      );
    }
  });

  it("bounds: all children of the unit fit its n; none outlives its reclaimAt; the parent payer's wallet is refused; before the parent is sealed it is 409", async () => {
    const { app, parent, printUnit, n, plan } = await sealedParent();
    expect((await child(app, parent, childBody(printUnit, { requestId: "req-42" }))).json()).toEqual({ error: "request-not-found" }); // the child's request must be the operator's own
    expect((await child(app, parent, childBody(printUnit, { currency: "USDT" }))).json()).toEqual({ error: "currency-mismatch" });
    // The child's OWN request must be in the reservation's currency too, even when the parent's matches.
    expect((await child(app, parent, childBody(printUnit, { requestId: "req-child-usdt" }))).json()).toEqual({ error: "currency-mismatch" });
    expect((await child(app, parent, childBody(printUnit, { maxAmountBaseUnits: (n + 1n).toString() }))).json()).toEqual({ error: "over-parent-unit" });
    expect((await child(app, parent, childBody(printUnit, { maxAmountBaseUnits: (n - 1n).toString() }))).statusCode).toBe(201);
    expect((await child(app, parent, childBody(printUnit, { maxAmountBaseUnits: "2" }))).json()).toEqual({ error: "over-parent-unit" }); // n - 1 + 2 > n
    expect((await child(app, parent, childBody(printUnit, { maxAmountBaseUnits: "1" }))).statusCode).toBe(201); // exactly n in total
    // A parent deal with a one-day reclaim window, so "outlives the unit" fits inside the TTL bound.
    const short = await sealedParent({}, 24 * 3600);
    const reclaimAt = Number(short.plan.jobs[0].units[0].reclaimAt);
    expect(reclaimAt).toBe(NOW + 24 * 3600);
    const outlives = await child(short.app, short.parent, childBody(short.printUnit, { expiresInSec: reclaimAt - NOW + 1 }));
    expect([outlives.statusCode, outlives.json()]).toEqual([422, { error: "child-outlives-parent-unit" }]);
    expect((await child(short.app, short.parent, childBody(short.printUnit, { expiresInSec: reclaimAt - NOW }))).statusCode).toBe(201); // exactly at reclaimAt
    const parentsWallet = await sealedParent({ payerFor: (p) => (p === BUYER || p === OPERATOR ? WALLET : null) });
    expect((await child(parentsWallet.app, parentsWallet.parent, childBody(parentsWallet.printUnit))).json()).toEqual({ error: "child-payer-is-parent-payer" });
    // A parent that is issued but not yet sealed has no sealed deal: the same 404 as a missing parent.
    const w = world();
    const app2 = await appWith({ ...w, parentUnits: sealedDealParentUnits(w.store) });
    const unsealed = (await issue(app2, issueBody())).json().reservation.reservationId;
    expect((await child(app2, unsealed, childBody(printUnit))).json()).toEqual({ error: "parent-unit-not-found" });
  });

  it("no oracle: another principal, a missing parent and an unknown unit are the same 404; production is 503; a malformed unit is 400", async () => {
    const { app, parent, printUnit } = await sealedParent();
    const asBuyer = await child(app, parent, childBody(printUnit), BUYER); // the payer is not the unit's operator
    const missing = await child(app, "resv_nope", childBody(printUnit));
    const noUnit = await child(app, parent, childBody("plan.x:0xaa#9"));
    expect([asBuyer.statusCode, missing.statusCode, noUnit.statusCode]).toEqual([404, 404, 404]);
    expect(new Set([asBuyer.body, missing.body, noUnit.body]).size).toBe(1);
    for (const unit of ["", "no-hash", "job#-1", "job#100", "job#01"]) expect([unit, (await child(app, parent, childBody(unit))).statusCode]).toEqual([unit, 400]);
    const prod = await appWith({ ...world() }); // no sealed-deal store wired
    const r = await child(prod, parent, childBody(printUnit));
    expect([r.statusCode, r.json().error]).toEqual([503, "issue-not-wired"]);
  });
});

describe("sealedDealParentUnits: parent-unit terms from the STORED sealed deal, fail closed", () => {
  it("derives operator, exact n and reclaimAt from the stored preimage; unknown, unsealed or unreadable deals are null", async () => {
    const w = world();
    const app = await appWith({ ...w, parentUnits: sealedDealParentUnits(w.store) });
    const parent = (await issue(app, issueBody())).json().reservation.reservationId;
    const resolve = sealedDealParentUnits(w.store);
    expect(resolve(parent, "anything#0")).toBeNull(); // issued, not sealed
    const plan = (await app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: dag(parent), headers: AS(BUYER) })).json().plan;
    const b = plan.nodeToUnit.find((x: { nodeId: string }) => x.nodeId === "print");
    const unit = `${b.jobId}#${b.milestoneIndex}`;
    const u = plan.jobs[b.jobIndex].units[b.milestoneIndex];
    expect(resolve(parent, unit)).toEqual({ reservationId: parent, unit, operator: A("aa"), netBaseUnits: BigInt(u.n), reclaimAt: Number(u.reclaimAt) });
    for (const bad of [`${b.jobId}#9`, "unknown-job#0", "no-hash", `#0`]) expect([bad, resolve(parent, bad)]).toEqual([bad, null]);
    expect(resolve("resv_nope", unit)).toBeNull();
    // Stored bytes that are not a deal (impossible through the store, which hashes them) still fail closed.
    const fake = { sealedDealPreimage: () => "not json" } as unknown as BudgetReservationStore;
    const noJobs = { sealedDealPreimage: () => '{"jobs":"x"}' } as unknown as BudgetReservationStore;
    const badN = { sealedDealPreimage: () => JSON.stringify({ jobs: [{ jobId: "j", operator: "0xaa", units: [{ milestoneIndex: "0", n: "1.5", reclaimAt: "1" }] }] }) } as unknown as BudgetReservationStore;
    // BigInt alone would accept hex and padded digits: only canonical base units count.
    const hexN = { sealedDealPreimage: () => JSON.stringify({ jobs: [{ jobId: "j", operator: "0xaa", units: [{ milestoneIndex: "0", n: "0x10", reclaimAt: "1" }] }] }) } as unknown as BudgetReservationStore;
    const padN = { sealedDealPreimage: () => JSON.stringify({ jobs: [{ jobId: "j", operator: "0xaa", units: [{ milestoneIndex: "0", n: " 16", reclaimAt: "1" }] }] }) } as unknown as BudgetReservationStore;
    for (const store of [fake, noJobs, badN, hexN, padN]) expect(sealedDealParentUnits(store)("p", "j#0")).toBeNull();
  });
});
