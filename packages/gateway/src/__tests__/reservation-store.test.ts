/**
 * R13 through the gateway: the accept route and seam over the DURABLE BudgetReservationStore (real
 * SQLite, in memory). The consume protocol refuses a plan it did not compile before the store is
 * touched, and the store re-checks authority atomically.
 *
 * STAND-INS, labelled as such: the live rows, evidence's gate and map, and a deterministic encoder.
 */
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import { acceptedDealDigest, type CompiledAcceptedPlan, type EvidenceRequirement } from "@pcc/spec";
import { BudgetReservationStore, createDatabase } from "@pcc/store";
import { agentPlanRoutes, type AgentPlanRouteDeps } from "../routes/agent-plans.js";
import type { DealEncoder } from "../services/agent-plan-deal.js";
import { acceptExternalPlan, type ExternalPlanSubmission, type SeamDeps } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { reservationWiring } from "../services/reservation-store.js";

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const PAYER = A("11");
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";
const PROGRAM = `0x${"d2".repeat(32)}`;
const BUYER = "agent:buyer-1";

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

function world(issue: { minTier?: number | null } = {}) {
  const { sqlite } = createDatabase(":memory:");
  const store = new BudgetReservationStore(sqlite);
  store.ensureSchema();
  const issued = store.issue({
    reservationId: "resv-1",
    principal: BUYER,
    payerAddress: PAYER,
    currency: "USDC",
    maxAmountBaseUnits: 20_000_000n,
    purpose: "accept plan for req-42",
    requestId: "req-42",
    minTier: issue.minTier ?? null,
    expiresAt: NOW + 3600,
    now: NOW,
    requestCeilingBaseUnits: 100_000_000n,
  });
  if (!issued.ok) throw new Error(issued.reason);
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
  const deps: AgentPlanRouteDeps = { revalidation: seam.revalidation, accept: { seam, encodeDeal: encoder, consumeReservation: wiring.consumeReservation } };
  return { store, wiring, seam, deps };
}

function dag(over: Partial<ExternalPlanSubmission> = {}): ExternalPlanSubmission {
  return {
    requestId: "req-42",
    reservationId: "resv-1",
    nodes: [
      { nodeId: "mail", capabilityId: "cap-mail", price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: "k-mail", operator: A("bb") },
      { nodeId: "print", capabilityId: "cap-print", price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: "k-print", operator: A("aa"), committedProgramHash: PROGRAM },
    ],
    edges: [{ from: "print", to: "mail" }],
    ...over,
  };
}

async function appWith(deps: AgentPlanRouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    if (typeof p === "string" && p) (req as unknown as { operatorId?: string }).operatorId = p;
  });
  await app.register(agentPlanRoutes, { deps: () => deps });
  await app.ready();
  return app;
}
const accept = (app: FastifyInstance, payload: unknown) =>
  app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: payload as object, headers: { "x-test-principal": BUYER } });

function compiled(w = world()): CompiledAcceptedPlan {
  const r = acceptExternalPlan(dag(), { principal: BUYER }, w.seam);
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.plan;
}
const reseal = (p: Omit<CompiledAcceptedPlan, "acceptedDealDigest">): CompiledAcceptedPlan => ({ ...p, acceptedDealDigest: acceptedDealDigest(p) });

describe("R13 through the accept route: the durable store seals exactly once", () => {
  it("200 seals the recomputed digest in the row; a second accept is 409; the row keeps the first seal", async () => {
    const { store, deps } = world();
    const app = await appWith(deps);
    const first = await accept(app, dag());
    expect(first.statusCode).toBe(200);
    const digest = first.json().plan.acceptedDealDigest;
    expect(store.findById("resv-1")).toMatchObject({ state: "consumed", consumedDealDigest: digest, consumedAt: NOW });
    // The sealed deal is stored as the digest's own preimage (#3231): the bytes hash to exactly this digest.
    const stored = store.sealedDealPreimage("resv-1")!;
    expect(`0x${createHash("sha256").update(stored, "utf8").digest("hex")}`).toBe(digest);
    expect(JSON.parse(stored).jobs).toHaveLength(2);
    const second = await accept(app, dag());
    expect(second.statusCode).toBe(409);
    expect(store.findById("resv-1")!.consumedDealDigest).toBe(digest);
  });

  it("two concurrent accepts: exactly one is sealed", async () => {
    const { store, deps } = world();
    const app = await appWith(deps);
    const codes = (await Promise.all([accept(app, dag()), accept(app, dag())])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(store.findById("resv-1")!.state).toBe("consumed");
  });

  it("loadReservation maps the durable row exactly: bigint maximum, payer, and a floor only when set", () => {
    expect(world().wiring.loadReservation("resv-1")).toEqual({
      reservationId: "resv-1",
      principal: BUYER,
      requestId: "req-42",
      currency: "USDC",
      maxAmountBaseUnits: 20_000_000n,
      expiresAt: NOW + 3600,
      state: "issued",
      payer: PAYER,
    });
    expect(world({ minTier: 2 }).wiring.loadReservation("resv-1")!.minTier).toBe(2);
    expect(world().wiring.loadReservation("resv-404")).toBeNull();
  });
});

describe("the consume protocol refuses a plan it did not compile, and the store re-checks authority", () => {
  it("a tampered digest, another reservation's plan, or a carried total that the units do not sum to: refused before the store", () => {
    const w = world();
    const plan = compiled(w);
    const { acceptedDealDigest: _d, ...rest } = plan;
    const cases: Array<[CompiledAcceptedPlan, string]> = [
      [{ ...plan, acceptedDealDigest: `0x${"00".repeat(32)}` }, "digest-mismatch"],
      [{ ...plan, jobs: plan.jobs.map((j, i) => (i === 0 ? { ...j, units: j.units.map((u) => ({ ...u, g: u.g + 1n })) } : j)) }, "digest-mismatch"],
      [reseal({ ...rest, reservationId: "resv-2", planId: "plan.resv-2" }), "wrong-binding"],
      [reseal({ ...rest, totalObligationBaseUnits: rest.totalObligationBaseUnits - 1n }), "obligation-mismatch"],
    ];
    for (const [p, reason] of cases) expect([reason, w.wiring.consumeReservation("resv-1", BUYER, p, NOW)]).toEqual([reason, { ok: false, reason }]);
    expect(w.store.findById("resv-1")!.state).toBe("issued");
  });

  it("a RESEALED plan passes integrity but not authority: another payer, another principal, expiry, the floor", () => {
    const plan = compiled();
    const { acceptedDealDigest: _d, ...rest } = plan;
    const w = world({ minTier: 2 });
    const otherPayer = reseal({ ...rest, jobs: rest.jobs.map((j) => ({ ...j, payer: A("22") })) });
    expect(w.wiring.consumeReservation("resv-1", BUYER, otherPayer, NOW)).toEqual({ ok: false, reason: "wrong-payer" });
    // EVERY job's payer is checked: one job paying from another wallet is enough to refuse, first or last.
    for (const k of [0, rest.jobs.length - 1]) {
      const oneJob = reseal({ ...rest, jobs: rest.jobs.map((j, i) => (i === k ? { ...j, payer: A("22") } : j)) });
      expect([k, w.wiring.consumeReservation("resv-1", BUYER, oneJob, NOW)]).toEqual([k, { ok: false, reason: "wrong-payer" }]);
    }
    expect(w.wiring.consumeReservation("resv-1", "agent:intruder", plan, NOW)).toEqual({ ok: false, reason: "wrong-principal" });
    expect(w.wiring.consumeReservation("resv-1", BUYER, plan, NOW + 3600)).toEqual({ ok: false, reason: "expired" });
    // The mail unit is tier 0 while the payer's floor is 2: refused even if the seam's own check were bypassed.
    expect(w.wiring.consumeReservation("resv-1", BUYER, plan, NOW)).toEqual({ ok: false, reason: "below-min-tier" });
    expect(w.store.findById("resv-1")!.state).toBe("issued");
    expect(world().wiring.consumeReservation("resv-1", BUYER, plan, NOW)).toEqual({ ok: true });
  });
});
