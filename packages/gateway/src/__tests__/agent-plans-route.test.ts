/**
 * R9 over HTTP: POST /api/agent-plans/validate and POST /api/settlement/agent-plans/accept.
 *
 * REAL code on the path: the route, R10, the accept seam, R12 and PlanPresentation.
 * STAND-INS, labelled as such:
 *   - live rows, in memory;
 *   - evidence's program registry and gate (#349 is a draft);
 *   - the CSD-tier -> evidence map;
 *   - the R13 store. It implements the consume PROTOCOL: re-check, recompute the digest, consume once, seal.
 *   - escrow's encoder: deterministic ids. The real compiler (#367) is proven in composition's R14 probe.
 * A test hook stands in for the API gate: `x-test-principal` becomes `req.operatorId`, and
 * `x-test-tenant` becomes `req.tenantId`.
 */
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import { acceptedDealDigest, computeSubjectBlockHash, computeAcceptedPolicyDigest, type SubjectBlockFields, type CompiledAcceptedPlan, type EvidenceRequirement } from "@pcc/spec";
import { agentPlanRoutes, authenticatedPrincipal, type AgentPlanRouteDeps, type ConsumeReservation } from "../routes/agent-plans.js";
import { bindDeal, MAX_UNITS_PER_DEAL, type DealEncoder } from "../services/agent-plan-deal.js";
import { acceptExternalPlan, planIdForReservation, type ExternalPlanSubmission, type ReservationRecord, type SeamDeps } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const OP_PRINT = A("aa");
const OP_MAIL = A("bb");
const PAYER = A("11");
const FEE = A("fe");
const Z = A("cc");
const PROGRAM = `0x${"d2".repeat(32)}`;
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";
const BUYER = "agent:buyer-1";

const CAPS: LiveCapability[] = [
  { id: "cap-print", type: PRINT, kernelId: "k-print", pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" }, assuranceTiers: [0, 1, 2], tenantId: null },
  { id: "cap-mail", type: "mail.drop", kernelId: "k-mail", pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null },
];
const KERNELS: LiveKernel[] = [
  { id: "k-print", operatorAddress: OP_PRINT, status: "online" },
  { id: "k-mail", operatorAddress: OP_MAIL, status: "online" },
];
const CSD_OF_TYPE: Record<string, string> = { [PRINT]: PRINT, "mail.drop": "courier-route" };
const EVIDENCE: Record<string, EvidenceRequirement[]> = {
  [`${PRINT}|tier2`]: [{ requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 }],
  "courier-route|tier0": [{ requirementId: "drop.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
};
const RESERVATION: ReservationRecord = {
  reservationId: "resv-1",
  principal: BUYER,
  requestId: "req-42",
  currency: "USDC",
  maxAmountBaseUnits: 20_000_000n,
  expiresAt: NOW + 3600,
  state: "issued",
  payer: PAYER,
};

/** A stand-in for the R13 store: the consume PROTOCOL, in memory (the trace's, unchanged). */
class ReservationStoreStandIn {
  private rows = new Map<string, ReservationRecord & { sealedDigest?: string }>();
  issue(r: ReservationRecord): void {
    this.rows.set(r.reservationId, { ...r });
  }
  load = (id: string): ReservationRecord | null => {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  };
  state(id: string): string | undefined {
    return this.rows.get(id)?.state;
  }
  sealed(id: string): string | undefined {
    return this.rows.get(id)?.sealedDigest;
  }
  consume: ConsumeReservation = (id, principal, plan, now) => {
    const r = this.rows.get(id);
    if (!r) return { ok: false, reason: "not-found" };
    if (r.principal !== principal) return { ok: false, reason: "wrong-principal" };
    if (r.state !== "issued") return { ok: false, reason: "not-issued" };
    if (r.expiresAt <= now) return { ok: false, reason: "expired" };
    if (plan.planId !== planIdForReservation(id) || plan.reservationId !== id || plan.requestId !== r.requestId || plan.currency !== r.currency) {
      return { ok: false, reason: "wrong-binding" };
    }
    if (plan.jobs.some((j) => j.payer.toLowerCase() !== r.payer.toLowerCase())) return { ok: false, reason: "wrong-payer" };
    const derived = plan.jobs.reduce((acc, j) => acc + j.units.reduce((a, u) => a + u.g, 0n), 0n);
    if (derived !== plan.totalObligationBaseUnits || derived > r.maxAmountBaseUnits) return { ok: false, reason: "obligation" };
    const { acceptedDealDigest: carried, ...rest } = plan;
    if (acceptedDealDigest(rest) !== carried) return { ok: false, reason: "digest-mismatch" };
    r.state = "consumed";
    r.sealedDigest = carried;
    return { ok: true };
  };
}

/** Stand-in for escrow's encoder: one deterministic bytes32 per unit, derived from the deal and the unit's place. */
const unitIdOf = (plan: CompiledAcceptedPlan, jobId: string, m: number) =>
  `0x${createHash("sha256").update(`${plan.acceptedDealDigest}|${jobId}|${m}`).digest("hex")}`;
function policyFor(address: string) {
  const word = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
  const subject: SubjectBlockFields = {
    payer: word("a1"),
    operatorPrincipal: word("a2"),
    operatorSettlementAddress: address as `0x${string}`,
    authorizedTuplesRoot: word("a3"),
    expertSetRoot: word("a4"),
    executorSetRoot: word("a5"),
    expectedRecipient: word("a6"),
    targetSystemIdentity: word("a7"),
    committedProgramHash: word("a8"),
    recipeRef: word("a9"),
    sampleManifestRef: word("ab"),
    childrenRoot: word("ac"),
    operatingEnvelopeHash: word("ad"),
    expectedRouteArea: word("ae"),
    expectedLocationHash: word("af"),
    captureNonceAnchor: word("b1"),
    challengeAnchor: word("b2"),
    integrityGrade: 1,
  };
  const termsHash = word("bc");
  const bindingsRoot = word("cd");
  const acceptedPolicyDigest = computeAcceptedPolicyDigest({ termsHash, subjectBlockHash: computeSubjectBlockHash(subject), bindingsRoot });
  return { subject, termsHash, bindingsRoot, acceptedPolicyDigest };
}

const standInEncoder: DealEncoder = (plan) => plan.jobs.map((j) => ({
  jobId: j.jobId,
  unitIds: j.units.map((_, m) => unitIdOf(plan, j.jobId, m)),
  ...policyFor(j.operator.toLowerCase()),
}));

interface WorldOpts {
  caps?: LiveCapability[];
  kernels?: LiveKernel[];
  reservation?: Partial<ReservationRecord>;
  encoder?: DealEncoder;
  consume?: ConsumeReservation;
  now?: () => number;
}

function world(o: WorldOpts = {}) {
  const store = new ReservationStoreStandIn();
  store.issue({ ...RESERVATION, ...o.reservation });
  const caps = o.caps ?? CAPS;
  const kernels = o.kernels ?? KERNELS;
  const encoderCalls: number[] = [];
  const seam: SeamDeps = {
    revalidation: {
      loadCapabilities: (ids) => caps.filter((c) => ids.includes(c.id)),
      loadKernels: (ids) => kernels.filter((k) => ids.includes(k.id)),
      csdForType: (t) => CSD_OF_TYPE[t] ?? null,
    },
    resolveProgram: (csd, tierKey) => (csd === PRINT && tierKey === "tier2" ? PROGRAM : null),
    assertProgramForTier: ({ committedProgramHash }) => (committedProgramHash === PROGRAM ? { ok: true } : { ok: false, code: "program-hash-mismatch" }),
    evidenceFor: (csd, tierKey) => EVIDENCE[`${csd}|${tierKey}`] ?? null,
    loadReservation: store.load,
    policy: { feeBps: 235, feeRecipient: FEE, reclaimAfterSec: 7 * 24 * 3600 },
    now: o.now ?? (() => NOW),
  };
  const encoder = o.encoder ?? standInEncoder;
  const deps: AgentPlanRouteDeps = {
    revalidation: seam.revalidation,
    accept: {
      seam,
      encodeDeal: (plan) => {
        encoderCalls.push(plan.nodeToUnit.length);
        return encoder(plan);
      },
      consumeReservation: o.consume ?? store.consume,
    },
  };
  return { store, deps, encoderCalls };
}

async function appWith(deps?: AgentPlanRouteDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    const t = req.headers["x-test-tenant"];
    const r = req as unknown as { operatorId?: string; tenantId?: string };
    if (typeof p === "string" && p) r.operatorId = p;
    if (typeof t === "string" && t) r.tenantId = t;
  });
  await app.register(agentPlanRoutes, deps ? { deps: () => deps } : {});
  await app.ready();
  return app;
}

/** The agent's DAG, listed mail first although print must run first. */
function dag(over: Partial<ExternalPlanSubmission> = {}): ExternalPlanSubmission {
  return {
    requestId: "req-42",
    reservationId: "resv-1",
    nodes: [
      { nodeId: "mail", capabilityId: "cap-mail", price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: "k-mail", operator: OP_MAIL },
      { nodeId: "print", capabilityId: "cap-print", price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: "k-print", operator: OP_PRINT, committedProgramHash: PROGRAM },
    ],
    edges: [{ from: "print", to: "mail" }],
    ...over,
  };
}

const AS_BUYER = { "x-test-principal": BUYER };
const accept = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = AS_BUYER) =>
  app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: payload as object, headers });
const validate = (app: FastifyInstance, payload: unknown, headers: Record<string, string> = AS_BUYER) =>
  app.inject({ method: "POST", url: "/api/agent-plans/validate", payload: payload as object, headers });

/** n mail nodes spread over ceil(n/16) operators (16 units per operator is the job limit). */
function wide(n: number) {
  const caps: LiveCapability[] = [];
  const kernels: LiveKernel[] = [];
  const nodes: ExternalPlanSubmission["nodes"] = [];
  for (let i = 0; i < n; i++) {
    const op = Math.floor(i / 16);
    const kernelId = `k-${op}`;
    const operator = `0x${(0xc0 + op).toString(16).repeat(20)}` as `0x${string}`;
    if (!kernels.some((k) => k.id === kernelId)) kernels.push({ id: kernelId, operatorAddress: operator, status: "online" });
    caps.push({ id: `cap-${i}`, type: "mail.drop", kernelId, pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null });
    nodes.push({ nodeId: `n${String(i).padStart(3, "0")}`, capabilityId: `cap-${i}`, price: "3.25", currency: "USDC", tierKey: "tier0", kernelId, operator });
  }
  return { caps, kernels, submission: dag({ nodes, edges: [] }) };
}

describe("POST /api/agent-plans/validate: a read-only R10 pre-check", () => {
  it("a DAG that matches the live rows: every node current, money as exact strings, nothing reserved", async () => {
    const { store, deps } = world();
    const app = await appWith(deps);
    const res = await validate(app, { nodes: dag().nodes });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.verdicts.map((v: { nodeId: string; status: string }) => [v.nodeId, v.status])).toEqual([
      ["mail", "current"],
      ["print", "current"],
    ]);
    expect(body.verdicts[1].resolved.grossBaseUnits).toBe("6500000");
    expect(store.state("resv-1")).toBe("issued");
  });

  it("a stale price gets the live re-quote; a tenant in the BODY is ignored, the gate's tenant decides visibility", async () => {
    const scoped = CAPS.map((c) => (c.id === "cap-mail" ? { ...c, tenantId: "tenant-a" } : c));
    const { deps } = world({ caps: scoped });
    const app = await appWith(deps);
    const stale = dag().nodes.map((n) => (n.nodeId === "print" ? { ...n, price: "6.00" } : n));
    const res = await validate(app, { nodes: stale, tenantId: "tenant-a" });
    const body = res.json();
    expect(body.ok).toBe(false);
    const byId = Object.fromEntries(body.verdicts.map((v: { nodeId: string }) => [v.nodeId, v]));
    expect(byId.print.status).toBe("stale");
    expect(byId.print.live.priceDecimal).toBe("6.5");
    expect(byId.mail.status).toBe("missing"); // tenant-a's row is invisible without tenant-a's authentication
    const asTenant = await validate(app, { nodes: stale }, { ...AS_BUYER, "x-test-tenant": "tenant-a" });
    expect(Object.fromEntries(asTenant.json().verdicts.map((v: { nodeId: string; status: string }) => [v.nodeId, v.status])).mail).toBe("current");
  });

  it("no authenticated principal is 401; a body without a node list is 400", async () => {
    const app = await appWith(world().deps);
    expect((await validate(app, { nodes: dag().nodes }, {})).statusCode).toBe(401);
    for (const body of [{}, { nodes: "x" }, []]) expect((await validate(app, body)).statusCode).toBe(400);
  });
});

describe("POST /api/settlement/agent-plans/accept: seam -> deal binding -> ONE atomic consume", () => {
  it("production wiring answers 503, lists every missing piece, and consumes nothing", async () => {
    const app = await appWith(); // productionAgentPlanDeps
    const res = await accept(app, dag());
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("accept-not-wired");
    expect(body.missing.join(" ")).toMatch(/R13.*#349.*evidence.*fee-policy.*escrow #367/);
  });

  it("the whole path: 200 with the sealed deal, VCR's deal binding and a Layer-B presentation", async () => {
    const { store, deps } = world();
    const app = await appWith(deps);
    const res = await accept(app, dag());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const digest = body.plan.acceptedDealDigest;
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.plan.planId).toBe("plan.resv-1");
    expect(body.plan.totalObligationBaseUnits).toBe("9750000"); // 6.50 + 3.25 USDC, exact base units
    expect(body.sealed).toEqual({ reservationId: "resv-1", acceptedDealDigest: digest });
    expect(store.sealed("resv-1")).toBe(digest);
    expect(store.state("resv-1")).toBe("consumed");

    // VCR's binding (#2475, #2674): every node carries the deal digest and ALL unit ids; requires = direct predecessors.
    const bindings: Array<{ digest: string; units: string[]; nodeId: string; requires: string[] }> = body.dealBindings;
    expect(bindings.map((b) => b.nodeId)).toEqual(["print", "mail"]);
    const units = bindings[0]!.units;
    expect(units).toHaveLength(2);
    expect(new Set(units).size).toBe(2);
    for (const b of bindings) {
      expect(b.digest).toBe(digest);
      expect(b.units).toEqual(units);
    }
    const [printUnit, mailUnit] = units;
    expect(bindings[0]!.requires).toEqual([]); // print depends on nothing
    expect(bindings[1]!.requires).toEqual([printUnit]); // mail is released only after print
    expect(mailUnit).not.toBe(printUnit);

    expect(body.presentation.layer).toBe("B");
    expect(body.presentation.state).toBe("sealed");
    expect(body.presentation.deal).toMatchObject({ acceptedDealDigest: digest, sealed: true });
  });

  it("the principal is the gate's, never the body's; another principal's reservation is answered exactly like a missing one", async () => {
    const { store, deps } = world();
    const app = await appWith(deps);
    const theirs = await accept(app, { ...dag(), principal: BUYER }, { "x-test-principal": "agent:someone-else" });
    const none = await accept(app, dag({ reservationId: "resv-404" }), { "x-test-principal": "agent:someone-else" });
    expect(theirs.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);
    expect(theirs.json().refusal).toEqual({ stage: "reservation", reason: "not-found" });
    expect(none.json().refusal).toEqual(theirs.json().refusal);
    expect(theirs.json().presentation.refusal).toEqual(none.json().presentation.refusal);
    expect(theirs.body).not.toMatch(/wrong-principal/);
    expect(store.state("resv-1")).toBe("issued");
    expect((await accept(app, dag(), {})).statusCode).toBe(401);
    expect((await accept(app, { ...dag(), principal: BUYER }, {})).statusCode).toBe(401); // a body principal is not authentication
    expect(store.state("resv-1")).toBe("issued");
  });

  it("exactly once: a second accept is 409; of two concurrent accepts exactly one is sealed", async () => {
    const one = world();
    const app1 = await appWith(one.deps);
    expect((await accept(app1, dag())).statusCode).toBe(200);
    const again = await accept(app1, dag());
    expect(again.statusCode).toBe(409);
    expect(again.json().refusal).toEqual({ stage: "reservation", reason: "not-issued" });

    const two = world();
    const app2 = await appWith(two.deps);
    const codes = (await Promise.all([accept(app2, dag()), accept(app2, dag())])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(two.store.state("resv-1")).toBe("consumed");
  });

  it("N25 over HTTP: each node's inputs come back sealed in its canonicalPlan; invalid execution JSON is 400 and consumes nothing", async () => {
    const DOC = "e62809887a42910a8af353d240984a2c971d5bc5567f9e0b046b5c14557dd8f3";
    const withInputs = (inputs: unknown) => dag({ nodes: dag().nodes.map((n) => (n.nodeId === "print" ? { ...n, inputs: inputs as Record<string, unknown> } : n)) });
    const { store, deps } = world();
    const app = await appWith(deps);
    const res = await accept(app, withInputs({ documentHash: DOC, pages: 2 }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const print = body.plan.nodeToUnit.find((b: { nodeId: string }) => b.nodeId === "print");
    expect(print.canonicalPlan.inputs).toEqual({ documentHash: DOC, pages: 2 });
    expect(print.planHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const shown = body.presentation.nodes.find((n: { nodeId: string }) => n.nodeId === "print");
    expect(shown.execution).toEqual({ planHash: print.planHash, inputs: { documentHash: DOC, pages: 2 }, constraints: {} });
    expect(store.sealed("resv-1")).toBe(body.plan.acceptedDealDigest);

    // Over HTTP a client can send a non-object, or JSON beyond the bounds; both are 400 and consume nothing.
    const other = world();
    const otherApp = await appWith(other.deps);
    const keys = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]));
    for (const [inputs, reason] of [[["not", "an", "object"], "not-an-object"], [keys, "too-many-keys"]] as const) {
      const r = await accept(otherApp, withInputs(inputs));
      expect(r.statusCode).toBe(400);
      expect(r.json().refusal).toEqual({ stage: "submission", reason: "invalid-execution-json", fields: [{ nodeId: "print", field: "inputs", reason }] });
    }
    expect(other.store.state("resv-1")).toBe("issued");
  });

  it("a stale plan is refused with the live re-quote, shown as needs-requote, and consumes nothing", async () => {
    const { store, deps, encoderCalls } = world();
    const app = await appWith(deps);
    const res = await accept(app, dag({ nodes: dag().nodes.map((n) => (n.nodeId === "print" ? { ...n, price: "6.00" } : n)) }));
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.refusal.stage).toBe("revalidation");
    expect(body.presentation.state).toBe("needs-requote");
    expect(body.presentation.layer).toBe("C");
    expect(encoderCalls).toEqual([]);
    expect(store.state("resv-1")).toBe("issued");
  });

  it(`VCR's limit: ${MAX_UNITS_PER_DEAL} units are accepted; ${MAX_UNITS_PER_DEAL + 1} are refused BEFORE the encoder, and nothing is consumed`, async () => {
    const at = wide(MAX_UNITS_PER_DEAL);
    const ok = world({ caps: at.caps, kernels: at.kernels, reservation: { maxAmountBaseUnits: 10n ** 12n } });
    const res = await accept(await appWith(ok.deps), at.submission);
    expect(res.statusCode).toBe(200);
    expect(res.json().dealBindings[0].units).toHaveLength(MAX_UNITS_PER_DEAL);

    const over = wide(MAX_UNITS_PER_DEAL + 1);
    const refused = world({ caps: over.caps, kernels: over.kernels, reservation: { maxAmountBaseUnits: 10n ** 12n } });
    const r = await accept(await appWith(refused.deps), over.submission);
    expect(r.statusCode).toBe(422);
    expect(r.json().refusal).toEqual({ stage: "deal", reason: "too-many-units-for-deal", units: MAX_UNITS_PER_DEAL + 1 });
    expect(refused.encoderCalls).toEqual([]);
    expect(refused.store.state("resv-1")).toBe("issued");
  });

  it("an encoder that disagrees with the deal fails closed: 500, no binding, nothing consumed", async () => {
    const bad: Array<[string, DealEncoder]> = [
      ["a job missing", (plan) => standInEncoder(plan).slice(1)],
      ["a unit missing", (plan) => standInEncoder(plan).map((j, i) => (i === 0 ? { ...j, unitIds: [] } : j))],
      ["an extra (phantom) unit", (plan) => standInEncoder(plan).map((j, i) => (i === 0 ? { ...j, unitIds: [...j.unitIds, `0x${"ab".repeat(32)}`] } : j))],
      ["a duplicate id", (plan) => standInEncoder(plan).map((j) => ({ ...j, unitIds: [standInEncoder(plan)[0]!.unitIds[0]!] }))],
      ["another job id", (plan) => standInEncoder(plan).map((j, i) => (i === 0 ? { ...j, jobId: "other" } : j))],
      ["not a bytes32", (plan) => standInEncoder(plan).map((j) => ({ ...j, unitIds: j.unitIds.map((id) => id.slice(0, 20)) }))],
      ["not a list", () => ({}) as unknown as ReturnType<DealEncoder>],
      ["a throwing getter", (plan) => standInEncoder(plan).map((j) => Object.defineProperty({ ...j }, "unitIds", { get: () => { throw new Error("x"); } }))],
    ];
    for (const [name, encoder] of bad) {
      const { store, deps } = world({ encoder });
      const res = await accept(await appWith(deps), dag());
      expect([name, res.statusCode, res.json().error]).toEqual([name, 500, "deal-binding-failed"]);
      expect([name, store.state("resv-1")]).toEqual([name, "issued"]);
    }
  });

  it("only an explicit { ok: true } from the store is a seal: a public refusal is 409 with its code; anything else is a generic 500; never 'sealed'", async () => {
    // A documented conflict code of the caller's OWN reservation reaches the client.
    for (const reason of ["not-issued", "expired", "wrong-request", "wrong-currency", "over-reservation", "below-min-tier"]) {
      const { deps } = world({ consume: () => ({ ok: false, reason }) });
      const res = await accept(await appWith(deps), dag());
      expect([reason, res.statusCode, res.json()]).toEqual([reason, 409, { error: "reservation-conflict", reason }]);
    }
    // A store diagnostic, or a malformed answer, is never forwarded (astra, round 1 of #391): logged, generic 500.
    const answers: unknown[] = [
      { ok: false, reason: "digest-mismatch" },
      { ok: false, reason: "wrong-payer" },
      { ok: false, reason: "SQLITE_BUSY: database is locked at /var/lib/pcc/store.db" },
      { ok: false, reason: 5 },
      undefined,
      { ok: "yes" },
      null,
    ];
    for (const a of answers) {
      const { deps } = world({ consume: () => a as ReturnType<ConsumeReservation> });
      const res = await accept(await appWith(deps), dag());
      expect([a, res.statusCode, res.json()]).toEqual([a, 500, { error: "internal-error" }]);
      expect(res.body).not.toMatch(/"sealed"|SQLITE|digest-mismatch|wrong-payer/);
    }
  });

  it("one clock reading per request; a broken clock fails closed; a server fault is a generic 500 that leaks nothing", async () => {
    let reads = 0;
    const counted = world({ now: () => (reads++, NOW) });
    expect((await accept(await appWith(counted.deps), dag())).statusCode).toBe(200);
    expect(reads).toBe(1);
    for (const broken of [() => Number.NaN, () => Infinity, () => -1, () => "soon" as unknown as number]) {
      const { store, deps } = world({ now: broken });
      const res = await accept(await appWith(deps), dag());
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("clock-unavailable");
      expect(store.state("resv-1")).toBe("issued");
    }
    const faulty = world({
      encoder: () => {
        throw new Error("internal detail: key material");
      },
    });
    const res = await accept(await appWith(faulty.deps), dag());
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal-error" });
    expect(faulty.store.state("resv-1")).toBe("issued");
  });

  it("method-style wiring keeps its receiver", async () => {
    const base = world();
    class Wiring {
      constructor(
        readonly seam: SeamDeps,
        private readonly store: ReservationStoreStandIn,
      ) {}
      encodeDeal(plan: CompiledAcceptedPlan) {
        return standInEncoder(plan);
      }
      consumeReservation(id: string, principal: string, plan: CompiledAcceptedPlan, now: number) {
        return this.store.consume(id, principal, plan, now);
      }
    }
    const accept0 = base.deps.accept as { seam: SeamDeps };
    const deps: AgentPlanRouteDeps = { revalidation: base.deps.revalidation, accept: new Wiring(accept0.seam, base.store) };
    const res = await accept(await appWith(deps), dag());
    expect(res.statusCode).toBe(200);
    expect(base.store.state("resv-1")).toBe("consumed");
  });

  it("astra round 1 of #391: a seam whose methods use PRIVATE fields keeps working (called on the original seam, not a wrapper)", async () => {
    const base = world();
    const accept0 = base.deps.accept as { seam: SeamDeps; encodeDeal: DealEncoder; consumeReservation: ConsumeReservation };
    class PrivateSeam {
      readonly #inner: SeamDeps;
      constructor(inner: SeamDeps) {
        this.#inner = inner;
      }
      get revalidation() {
        return this.#inner.revalidation;
      }
      get policy() {
        return this.#inner.policy;
      }
      get economics() {
        return this.#inner.economics;
      }
      resolveProgram(csd: string, tierKey: string) {
        return this.#inner.resolveProgram(csd, tierKey);
      }
      assertProgramForTier(a: Parameters<SeamDeps["assertProgramForTier"]>[0]) {
        return this.#inner.assertProgramForTier(a);
      }
      evidenceFor(csd: string, tierKey: string) {
        return this.#inner.evidenceFor(csd, tierKey);
      }
      loadReservation(id: string) {
        return this.#inner.loadReservation(id);
      }
      now() {
        return this.#inner.now();
      }
    }
    const deps: AgentPlanRouteDeps = { revalidation: base.deps.revalidation, accept: { ...accept0, seam: new PrivateSeam(accept0.seam) as unknown as SeamDeps } };
    const res = await accept(await appWith(deps), dag());
    expect(res.statusCode).toBe(200);
    expect(base.store.state("resv-1")).toBe("consumed");
  });
});

describe("bindDeal (pure): the release order VCR enforces", () => {
  it("requires = DIRECT predecessors, in the deal's unit order: a diamond a->b, a->c, b->d, c->d", async () => {
    const caps: LiveCapability[] = ["a", "b", "c", "d"].map((x) => ({ id: `cap-${x}`, type: "mail.drop", kernelId: `k-${x}`, pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null }));
    const kernels: LiveKernel[] = ["a", "b", "c", "d"].map((x, i) => ({ id: `k-${x}`, operatorAddress: A((0xe1 + i).toString(16)), status: "online" }));
    const nodes = ["a", "b", "c", "d"].map((x, i) => ({ nodeId: x, capabilityId: `cap-${x}`, price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: `k-${x}`, operator: A((0xe1 + i).toString(16)) }));
    const edges = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const { deps } = world({ caps, kernels });
    const res = await accept(await appWith(deps), dag({ nodes, edges }));
    expect(res.statusCode).toBe(200);
    const bindings: Array<{ nodeId: string; units: string[]; requires: string[] }> = res.json().dealBindings;
    const units = bindings[0]!.units;
    const unitOf = (id: string) => units[bindings.findIndex((b) => b.nodeId === id)]!;
    const req = Object.fromEntries(bindings.map((b) => [b.nodeId, b.requires]));
    expect(req).toEqual({ a: [], b: [unitOf("a")], c: [unitOf("a")], d: [unitOf("b"), unitOf("c")] });
    for (const b of bindings) expect(b.requires).not.toContain(unitOf(b.nodeId)); // never itself
  });

  it("astra round 1 of #391: the node-to-unit map must be a bijection: two nodes on one unit, or a unit no node maps to, is an encoder mismatch", () => {
    const compiled = compiledPlan();
    const [b0, b1] = compiled.nodeToUnit;
    const twoOnOne = { ...compiled, nodeToUnit: [b0!, { ...b1!, jobIndex: b0!.jobIndex, milestoneIndex: b0!.milestoneIndex }] } as CompiledAcceptedPlan;
    expect(bindDeal(twoOnOne, [], standInEncoder)).toMatchObject({ ok: false, reason: "encoder-mismatch", detail: "binding-not-one-to-one" });
    const dangling = { ...compiled, nodeToUnit: [b0!] } as CompiledAcceptedPlan;
    expect(bindDeal(dangling, [], standInEncoder)).toMatchObject({ ok: false, reason: "encoder-mismatch", detail: "unit-count" });
    expect(bindDeal(compiled, [], standInEncoder).ok).toBe(true); // the intact plan still binds
  });

  it("astra round 1 of #391: interleaved same-operator nodes (a and c by one operator, b between them) bind to their OWN units", () => {
    const X = A("e1");
    const Y = A("e2");
    const opOf: Record<string, string> = { a: X, b: Y, c: X };
    const caps: LiveCapability[] = ["a", "b", "c"].map((x) => ({ id: `cap-${x}`, type: "mail.drop", kernelId: `k-${x}`, pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null }));
    const kernels: LiveKernel[] = ["a", "b", "c"].map((x) => ({ id: `k-${x}`, operatorAddress: opOf[x]!, status: "online" }));
    const nodes = ["a", "b", "c"].map((x) => ({ nodeId: x, capabilityId: `cap-${x}`, price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: `k-${x}`, operator: opOf[x]! }));
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const { deps } = world({ caps, kernels });
    const r = acceptExternalPlan(dag({ nodes, edges }), { principal: BUYER }, (deps.accept as { seam: SeamDeps }).seam);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.plan;
    expect(plan.jobs.map((j) => j.units.length).sort()).toEqual([1, 2]); // X's job holds a AND c; b sits between them
    const encoded = standInEncoder(plan);
    const unitOf = (nodeId: string) => {
      const b = plan.nodeToUnit.find((x) => x.nodeId === nodeId)!;
      return encoded[b.jobIndex]!.unitIds[b.milestoneIndex]!.toLowerCase();
    };
    expect(new Set(["a", "b", "c"].map(unitOf)).size).toBe(3);
    const bound = bindDeal(plan, edges, standInEncoder);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(Object.fromEntries(bound.bindings.map((b) => [b.nodeId, b.requires]))).toEqual({ a: [], b: [unitOf("a")], c: [unitOf("b")] });
  });

  it("an edge that names no node of the deal, or loops, is an edge-mismatch before the encoder runs; a throwing encoder propagates", () => {
    const compiled = compiledPlan();
    let calls = 0;
    const counting: DealEncoder = (p) => (calls++, standInEncoder(p));
    for (const edges of [[{ from: "print", to: "ghost" }], [{ from: "mail", to: "mail" }], [null], [{ from: 1, to: "mail" }]]) {
      expect(bindDeal(compiled, edges as never, counting)).toMatchObject({ ok: false, reason: "edge-mismatch" });
    }
    expect(calls).toBe(0);
    expect(() =>
      bindDeal(compiled, [], () => {
        throw new Error("server fault");
      }),
    ).toThrow("server fault");
  });
});

/** The deal the seam compiles for `dag()` (the pure path, no HTTP). */
function compiledPlan(): CompiledAcceptedPlan {
  const { deps } = world();
  const r = acceptExternalPlan(dag(), { principal: BUYER }, (deps.accept as { seam: SeamDeps }).seam);
  if (!r.ok) throw new Error("setup");
  return r.plan;
}

type PolicyJob = ReturnType<DealEncoder>[number] & ReturnType<typeof policyFor>;

function withPolicy(edit: (job: PolicyJob, index: number) => void): DealEncoder {
  return (plan) => standInEncoder(plan).map((j, i) => {
    const job = j as PolicyJob;
    edit(job, i);
    return job;
  });
}

async function checkPolicyRoute(name: string, encoder: DealEncoder, detail: string | null) {
  const { store, deps } = world({ encoder });
  const wiring = deps.accept as { consumeReservation: ConsumeReservation };
  const consume = wiring.consumeReservation;
  let consumeCount = 0;
  wiring.consumeReservation = (...args) => {
    consumeCount++;
    return consume(...args);
  };
  const app = await appWith(deps);
  try {
    const res = await accept(app, dag());
    if (detail === null) {
      expect.soft([name, res.statusCode, consumeCount, store.state("resv-1")]).toEqual([name, 200, 1, "consumed"]);
    } else {
      const body = res.json();
      expect.soft([name, res.statusCode, body.error, body.reason, body.detail]).toEqual([name, 500, "deal-binding-failed", "encoder-mismatch", detail]);
      expect.soft([name, consumeCount]).toEqual([name, 0]);
    }
  } finally {
    await app.close();
  }
}

describe("N447: accepted-policy digest and payout address binding", () => {
  it("N447 C2.1: a valid digest over another settlement address is refused before consume", async () => {
    await checkPolicyRoute("another address", withPolicy((job, i) => {
      if (i === 0) Object.assign(job, policyFor(Z));
    }), "settlement-address:0");
  });

  it("N447 C2.1b: settlement binds to the node's payTo, even when it differs from the operator", () => {
    for (const [name, address, detail] of [["operator", OP_PRINT, "settlement-address:0"], ["payTo", Z, null]] as const) {
      const plan = structuredClone(compiledPlan());
      plan.nodeToUnit.find((b) => b.jobIndex === 0)!.canonicalPlan.payTo = Z;
      const result = bindDeal(plan, [], withPolicy((job, i) => {
        if (i === 0) Object.assign(job, policyFor(address));
      }));
      if (detail === null) expect.soft([name, result.ok]).toEqual([name, true]);
      else expect.soft([name, result]).toEqual([name, { ok: false, reason: "encoder-mismatch", detail }]);
    }
  });

  it("N447 C2.2: every job is checked in order, with all four checks applied job by job", async () => {
    const rows = [
      ["swapped", OP_MAIL, OP_PRINT, "settlement-address:0"],
      ["first", Z, OP_MAIL, "settlement-address:0"],
      ["second", OP_PRINT, Z, "settlement-address:1"],
      ["mixed", Z, null, "settlement-address:0"],
    ] as const;
    for (const [name, first, second, detail] of rows) {
      await checkPolicyRoute(name, withPolicy((job, i) => {
        const address = i === 0 ? first : second;
        if (address === null) Reflect.deleteProperty(job, "subject");
        else Object.assign(job, policyFor(address));
      }), detail);
    }
  });

  it("N447 C2.3: an absent subject is a subject refusal, not a failed jobs snapshot", async () => {
    await checkPolicyRoute("absent subject", withPolicy((job, i) => {
      if (i === 0) Reflect.deleteProperty(job, "subject");
    }), "subject:0");
  });

  it("N447 C2.5: uppercase words pass, while a mixed-case subject address is refused", async () => {
    for (const name of ["upper words", "mixed-case address"]) {
      await checkPolicyRoute(name, withPolicy((job, i) => {
        if (i !== 0) return;
        if (name === "upper words") {
          for (const field of ["termsHash", "bindingsRoot", "acceptedPolicyDigest"] as const) {
            job[field] = `0x${job[field].slice(2).toUpperCase()}`;
          }
        } else {
          job.subject.operatorSettlementAddress = `0xA${OP_PRINT.slice(3)}`;
        }
      }), name === "upper words" ? null : "subject:0");
    }
  });

  it("N447 C2.6: a changed subject field fails the digest before comparing the address", async () => {
    for (const name of ["field", "field and address"]) {
      await checkPolicyRoute(name, withPolicy((job, i) => {
        if (i !== 0) return;
        job.subject.integrityGrade = 2;
        if (name === "field and address") job.subject.operatorSettlementAddress = Z;
      }), "policy-digest:0");
    }
  });

  it("N447 C2.7: a changing address getter is refused without ever running it", async () => {
    let reads = 0;
    await checkPolicyRoute("address getter", withPolicy((job, i) => {
      if (i !== 0) return;
      Object.assign(job, policyFor(Z));
      Object.defineProperty(job.subject, "operatorSettlementAddress", {
        enumerable: true,
        configurable: true,
        get: () => ++reads === 1 ? OP_PRINT : Z,
      });
    }), "subject:0");
    expect.soft(reads).toBe(0);
  });

  it("N447 C2.8: spec refuses inherited, extra, accessor, hidden, missing and malformed subject fields", async () => {
    const rows: Array<[string, (subject: SubjectBlockFields) => SubjectBlockFields]> = [
      ["inherited field", (s) => {
        const copy = { ...s };
        Reflect.deleteProperty(copy, "payer");
        return Object.assign(Object.create({ payer: s.payer }), copy);
      }],
      ["extra inherited field", (s) => Object.assign(Object.create({ extra: s.payer }), s)],
      ["extra own field", (s) => Object.assign(s, { extra: s.payer })],
      ["extra symbol field", (s) => Object.assign(s, { [Symbol("extra")]: s.payer })],
      ["throwing payer getter", (s) => Object.defineProperty(s, "payer", { enumerable: true, get: () => { throw new Error("getter"); } })],
      ["non-enumerable payer", (s) => Object.defineProperty(s, "payer", { enumerable: false })],
      ["missing integrityGrade", (s) => { Reflect.deleteProperty(s, "integrityGrade"); return s; }],
      ["short payer", (s) => ({ ...s, payer: s.payer.slice(0, -1) as `0x${string}` })],
    ];
    for (const [name, replace] of rows) {
      await checkPolicyRoute(name, withPolicy((job, i) => {
        if (i === 0) job.subject = replace(job.subject);
      }), "subject:0");
    }
  });

  it("N447 C2.9: third-party split legs do not supply the settlement address", () => {
    for (const [name, address, detail] of [["payTo", OP_PRINT, null], ["third party", Z, "settlement-address:0"]] as const) {
      const plan = structuredClone(compiledPlan());
      const unit = plan.jobs[0]!.units[0]!;
      const payTo = plan.nodeToUnit.find((b) => b.jobIndex === 0)!.canonicalPlan.payTo as `0x${string}`;
      unit.payouts = [{ recipient: Z, amount: 1n }, { recipient: payTo, amount: unit.n - 1n }];
      const result = bindDeal(plan, [], withPolicy((job, i) => {
        if (i === 0) Object.assign(job, policyFor(address));
      }));
      if (detail === null) expect.soft([name, result.ok]).toEqual([name, true]);
      else expect.soft([name, result]).toEqual([name, { ok: false, reason: "encoder-mismatch", detail }]);
    }
  });

  it("N447 C2.10: every node binding in an interleaved operator's job must match", () => {
    const X = A("e1");
    const Y = A("e2");
    const opOf: Record<string, string> = { a: X, b: Y, c: X };
    const caps: LiveCapability[] = ["a", "b", "c"].map((x) => ({ id: `cap-${x}`, type: "mail.drop", kernelId: `k-${x}`, pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null }));
    const kernels: LiveKernel[] = ["a", "b", "c"].map((x) => ({ id: `k-${x}`, operatorAddress: opOf[x]!, status: "online" }));
    const nodes = ["a", "b", "c"].map((x) => ({ nodeId: x, capabilityId: `cap-${x}`, price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: `k-${x}`, operator: opOf[x]! }));
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
    const { deps } = world({ caps, kernels });
    const compiled = acceptExternalPlan(dag({ nodes, edges }), { principal: BUYER }, (deps.accept as { seam: SeamDeps }).seam);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    for (const [name, address] of [["first", X], ["last", Z]] as const) {
      const plan = structuredClone(compiled.plan);
      plan.nodeToUnit.find((b) => b.nodeId === "c")!.canonicalPlan.payTo = Z;
      const result = bindDeal(plan, edges, withPolicy((job, i) => {
        if (i === 0) Object.assign(job, policyFor(address));
      }));
      expect.soft([name, result]).toEqual([name, { ok: false, reason: "encoder-mismatch", detail: "settlement-address:0" }]);
    }
  });

  it("N447 C2.11: all three words are form-checked before the subject", async () => {
    const rows: Array<[string, "termsHash" | "bindingsRoot" | "acceptedPolicyDigest", "absent" | "short", boolean]> = [];
    for (const field of ["termsHash", "bindingsRoot", "acceptedPolicyDigest"] as const) {
      rows.push([`${field} absent`, field, "absent", false], [`${field} short`, field, "short", false]);
    }
    rows.push(["short termsHash and absent subject", "termsHash", "short", true]);
    for (const [name, field, form, absentSubject] of rows) {
      await checkPolicyRoute(name, withPolicy((job, i) => {
        if (i !== 0) return;
        if (form === "absent") Reflect.deleteProperty(job, field);
        else job[field] = job[field].slice(0, -1) as `0x${string}`;
        if (absentSubject) Reflect.deleteProperty(job, "subject");
      }), "policy-hashes:0");
    }
  });

  it("N447 C2.12: each job-level policy field is read exactly once", async () => {
    const reads = { subject: 0, termsHash: 0, bindingsRoot: 0, acceptedPolicyDigest: 0 };
    await checkPolicyRoute("read once", withPolicy((job, i) => {
      if (i !== 0) return;
      const first = { ...job };
      const other = { ...policyFor(Z), termsHash: `0x${"de".repeat(32)}`, bindingsRoot: `0x${"ef".repeat(32)}` };
      for (const field of ["subject", "termsHash", "bindingsRoot", "acceptedPolicyDigest"] as const) {
        Object.defineProperty(job, field, { enumerable: true, configurable: true, get: () => ++reads[field] === 1 ? first[field] : other[field] });
      }
    }), null);
    expect.soft(reads).toEqual({ subject: 1, termsHash: 1, bindingsRoot: 1, acceptedPolicyDigest: 1 });
  });

  it("N447 C2.13: hash and address compare both use the subject's descriptor copy", async () => {
    let reads = 0;
    await checkPolicyRoute("proxy address", withPolicy((job, i) => {
      if (i !== 0) return;
      Object.assign(job, policyFor(Z));
      job.subject = new Proxy(job.subject, { get: (target, key, receiver) => {
        reads++;
        return key === "operatorSettlementAddress" ? OP_PRINT : Reflect.get(target, key, receiver);
      } });
    }), "settlement-address:0");
    expect.soft(reads).toBe(0);
  });

  it("N447 C2.14: unit-count refusal precedes policy checks", () => {
    for (const [name, detail] of [["dangling", "unit-count"], ["intact", "settlement-address:0"]] as const) {
      const plan = structuredClone(compiledPlan());
      if (name === "dangling") plan.nodeToUnit = plan.nodeToUnit.slice(0, 1);
      const result = bindDeal(plan, [], withPolicy((job, i) => {
        if (i === 0) Object.assign(job, policyFor(Z));
      }));
      expect.soft([name, result]).toEqual([name, { ok: false, reason: "encoder-mismatch", detail }]);
    }
  });
});

describe("authenticatedPrincipal", () => {
  it("is the gate's identity, lowercased and trimmed; nothing else counts", () => {
    const req = (x: Record<string, unknown>) => x as never;
    expect(authenticatedPrincipal(req({ operatorId: " Agent:Buyer-1 " }))).toBe("agent:buyer-1");
    expect(authenticatedPrincipal(req({ operatorId: null, userId: "0xABCdef" }))).toBe("0xabcdef");
    expect(authenticatedPrincipal(req({ operatorId: "", userId: null }))).toBeNull();
    expect(authenticatedPrincipal(req({ body: { principal: "agent:buyer-1" } }))).toBeNull();
    expect(authenticatedPrincipal(req({ operatorId: 42 }))).toBeNull();
  });
});
