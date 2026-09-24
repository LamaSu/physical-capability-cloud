/**
 * END-TO-END TRACE (pcc-composition return contract):
 *   an arbitrary agent DAG -> authoritative accepted deal -> reservation consumed -> V-next units ready.
 *
 * REAL code on the path: R10 `revalidatePlanSnapshots`, the accept seam, R12 `compileAcceptedPlan`
 * and `acceptedDealDigest`.
 * STAND-INS, labelled as such: the live rows (in memory, not the db repos); evidence's program
 * registry and gate (#349 is a draft); the CSD-tier -> evidence-requirement map (evidence owns it);
 * and the R13 reservation store (its table is operator decision #2240). The stand-in store implements
 * the consume PROTOCOL the real one must: re-check, recompute the digest, consume once, seal. It does
 * not prove database atomicity — that is R13's own test.
 *
 * Set PCC_TRACE_OUT=<path> to write the happy-path trace as JSON.
 */
import { writeFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  acceptedDealDigest,
  payoutsConserve,
  stepIdBytes32,
  type CompiledAcceptedPlan,
  type ComposeResponse,
  type EvidenceRequirement,
} from "@pcc/spec";
import {
  acceptExternalPlan,
  planIdForReservation,
  snapshotSubmission,
  submissionDigest,
  type ExternalPlanSubmission,
  type ReservationRecord,
  type SeamDeps,
  type SeamResult,
} from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { submissionFromComposeResponse } from "../services/compose-plan-adapter.js";
import { presentPlan } from "../services/plan-presentation.js";

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const OP_PRINT = A("aa");
const OP_MAIL = A("bb");
const PAYER = A("11");
const FEE = A("fe");
const PROGRAM = `0x${"d2".repeat(32)}`; // stand-in for evidence's registered tier-2 program hash
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";

// ── Stand-ins ────────────────────────────────────────────────────────────────────────────────────

const LIVE_CAPS: LiveCapability[] = [
  { id: "cap-print", type: PRINT, kernelId: "k-print", pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" }, assuranceTiers: [0, 1, 2], tenantId: null },
  { id: "cap-mail", type: "mail.drop", kernelId: "k-mail", pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" }, assuranceTiers: [0], tenantId: null },
];
const LIVE_KERNELS: LiveKernel[] = [
  { id: "k-print", operatorAddress: OP_PRINT, status: "online" },
  { id: "k-mail", operatorAddress: OP_MAIL, status: "online" },
];
const CSD_OF_TYPE: Record<string, string> = { [PRINT]: PRINT, "mail.drop": "courier-route" };
const PROGRAMS: Record<string, string> = { [`${PRINT}|tier2`]: PROGRAM };
const EVIDENCE: Record<string, EvidenceRequirement[]> = {
  [`${PRINT}|tier2`]: [
    { requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 },
    { requirementId: "mail.carrier-scan", evidenceTypeId: "courier_pickup_confirmed", tier: 2 },
  ],
  "courier-route|tier0": [{ requirementId: "drop.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
};

/** A stand-in for the R13 store: the consume PROTOCOL, in memory. */
class ReservationStoreStandIn {
  private rows = new Map<string, ReservationRecord & { sealedDigest?: string }>();
  issue(r: ReservationRecord): void {
    this.rows.set(r.reservationId, { ...r });
  }
  load = (id: string): ReservationRecord | null => {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  };
  sealed(id: string): string | undefined {
    return this.rows.get(id)?.sealedDigest;
  }
  /**
   * One atomic step. The real consume is called with the plan the server ITSELF just compiled — never
   * a compiled plan a caller presents — and still re-checks: authority (principal, state, expiry),
   * every binding the reservation fixes (plan id, request, currency, EACH job's payer), the obligation
   * DERIVED from the units (not the carried total), and the digest RECOMPUTED from the content.
   * A recomputed digest proves integrity, not authority: a resealed plan with another payer still fails.
   */
  consume(id: string, principal: string, plan: CompiledAcceptedPlan, now: number): { ok: true } | { ok: false; reason: string } {
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
    if (derived !== plan.totalObligationBaseUnits) return { ok: false, reason: "obligation-mismatch" };
    if (derived > r.maxAmountBaseUnits) return { ok: false, reason: "obligation-exceeds-reservation" };
    const { acceptedDealDigest: carried, ...rest } = plan;
    if (acceptedDealDigest(rest) !== carried) return { ok: false, reason: "digest-mismatch" };
    r.state = "consumed";
    r.sealedDigest = carried;
    return { ok: true };
  }
}

const RESERVATION: ReservationRecord = {
  reservationId: "resv-1",
  principal: "agent:buyer-1",
  requestId: "req-42",
  currency: "USDC",
  maxAmountBaseUnits: 20_000_000n,
  expiresAt: NOW + 3600,
  state: "issued",
  payer: PAYER,
};

function world(overrides: { reservation?: Partial<ReservationRecord>; programs?: Record<string, string>; evidence?: Record<string, EvidenceRequirement[]>; now?: number } = {}) {
  const store = new ReservationStoreStandIn();
  store.issue({ ...RESERVATION, ...overrides.reservation });
  const programs = overrides.programs ?? PROGRAMS;
  const evidence = overrides.evidence ?? EVIDENCE;
  const deps: SeamDeps = {
    revalidation: {
      loadCapabilities: (ids) => LIVE_CAPS.filter((c) => ids.includes(c.id)),
      loadKernels: (ids) => LIVE_KERNELS.filter((k) => ids.includes(k.id)),
      csdForType: (t) => CSD_OF_TYPE[t] ?? null,
    },
    resolveProgram: (csd, tierKey) => programs[`${csd}|${tierKey}`] ?? null,
    assertProgramForTier: ({ csd, tierKey, committedProgramHash }) =>
      committedProgramHash !== null && PROGRAMS[`${csd}|${tierKey}`] === committedProgramHash.toLowerCase()
        ? { ok: true }
        : { ok: false, code: "program-hash-mismatch" },
    evidenceFor: (csd, tierKey) => evidence[`${csd}|${tierKey}`] ?? null,
    loadReservation: store.load,
    policy: { feeBps: 235, feeRecipient: FEE, reclaimAfterSec: 7 * 24 * 3600 },
    now: () => overrides.now ?? NOW,
  };
  return { store, deps };
}

/** The agent's plan, listed the way an LLM might: mail first, although print must run first. */
function agentDag(over: Partial<ExternalPlanSubmission> = {}): ExternalPlanSubmission {
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

const CTX = { principal: "agent:buyer-1" };

function refusal(r: SeamResult) {
  expect(r.ok).toBe(false);
  return r.ok ? undefined : r.refusal;
}

const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

// ── The trace ────────────────────────────────────────────────────────────────────────────────────

describe("END-TO-END: agent DAG -> accepted deal -> reservation consumed -> V-next units ready", () => {
  it("runs the whole path and every settlement term is the server's", () => {
    const { store, deps } = world();
    const dag = agentDag();

    // 1-3. R10 re-read, R11 programs, R12 compile — through the seam.
    const accepted = acceptExternalPlan(dag, CTX, deps);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const plan = accepted.plan;
    expect(plan.planId).toBe(planIdForReservation("resv-1")); // server-derived, not caller-chosen
    expect(plan.totalObligationBaseUnits).toBe(9_750_000n);

    // One V-next job per operator, operator-address order; units in canonical plan order.
    expect(plan.jobs.map((j) => [j.operator, j.nodeIds])).toEqual([
      [OP_PRINT, ["print"]],
      [OP_MAIL, ["mail"]],
    ]);
    const [printUnit] = plan.jobs[0]!.units;
    const [mailUnit] = plan.jobs[1]!.units;
    expect(printUnit).toMatchObject({ requiredTier: 2, requestedTier: 2, g: 6_500_000n, f: 152_750n, n: 6_347_250n, feeBps: 235, feeRecipient: FEE });
    expect(mailUnit).toMatchObject({ requiredTier: 0, g: 3_250_000n, f: 76_375n, n: 3_173_625n });
    expect(plan.nodeToUnit.map((b) => [b.nodeId, b.jobIndex, b.milestoneIndex, b.tier, b.committedProgramHash])).toEqual([
      ["print", 0, 0, 2, PROGRAM],
      ["mail", 1, 0, 0, null],
    ]);

    // 4. R13 (stand-in): consume the reservation exactly once, sealing the recomputed deal digest.
    expect(store.consume("resv-1", CTX.principal, plan, NOW)).toEqual({ ok: true });
    expect(store.sealed("resv-1")).toBe(plan.acceptedDealDigest);
    expect(store.consume("resv-1", CTX.principal, plan, NOW)).toEqual({ ok: false, reason: "not-issued" }); // never twice

    // 5. V-next units ready for execution: every unit conserves exactly, carries its step id and the root.
    for (const job of plan.jobs) {
      expect(job.payer).toBe(PAYER);
      job.units.forEach((u, i) => {
        expect(u.milestoneIndex).toBe(BigInt(i));
        expect(u.f + u.n).toBe(u.g);
        expect(payoutsConserve(u.payouts, u.n)).toBe(true);
        expect(u.stepId).toBe(stepIdBytes32(job.nodeIds[i]!));
        expect(u.compositionRoot).toBe(plan.compositionRoot);
        expect(u.reclaimAt).toBe(BigInt(NOW + 7 * 24 * 3600));
      });
    }
    expect(printUnit!.payouts).toEqual([{ recipient: OP_PRINT, amount: 6_347_250n }]);

    if (process.env.PCC_TRACE_OUT) {
      writeFileSync(
        process.env.PCC_TRACE_OUT,
        JSON.stringify(
          plain({
            standIns: ["live rows (in memory)", "program registry + gate (#349 draft)", "CSD tier -> evidence map", "R13 reservation store (#2240)"],
            step1_agentDag: dag,
            step2_r10_resolved: accepted.resolved,
            step3_acceptedDeal: plan,
            step4_reservationConsumed: { reservationId: "resv-1", sealedDigest: store.sealed("resv-1"), secondConsume: "refused: not-issued" },
            step5_vnextUnitsReady: plan.jobs.map((j) => ({ jobId: j.jobId, operator: j.operator, payer: j.payer, units: j.units })),
          }),
          null,
          2,
        ),
      );
    }
  });

  it("the order the agent listed its nodes in cannot change the accepted deal", () => {
    const a = acceptExternalPlan(agentDag(), CTX, world().deps);
    const b = acceptExternalPlan(agentDag({ nodes: [...agentDag().nodes].reverse() }), CTX, world().deps);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.plan.acceptedDealDigest).toBe(a.plan.acceptedDealDigest);
  });
});

describe("the charter's required negatives, through the whole seam", () => {
  it("caller forges a cheaper snapshot -> refused at R10 with the live re-quote", () => {
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, price: "5.00" };
    const r = refusal(acceptExternalPlan(dag, CTX, world().deps));
    expect(r?.stage).toBe("revalidation");
    if (r?.stage === "revalidation") {
      expect(r.verdicts).toHaveLength(1);
      expect(r.verdicts[0]).toMatchObject({ nodeId: "print", status: "stale", diffs: [{ field: "price", claimed: "5", live: "6.5" }] });
    }
  });

  it("unapproved verification program -> refused (claimed mismatch, or none registered for the tier)", () => {
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, committedProgramHash: `0x${"66".repeat(32)}` };
    expect(refusal(acceptExternalPlan(dag, CTX, world().deps))).toEqual({ stage: "program", nodeId: "print", reason: "claimed-program-mismatch" });
    // no program registered for (csd, tier2), and the agent claims none: the compiler refuses the tier
    const noClaim = agentDag();
    const { committedProgramHash: _dropped, ...printWithoutClaim } = noClaim.nodes[1]!;
    noClaim.nodes[1] = printWithoutClaim;
    const r = refusal(acceptExternalPlan(noClaim, CTX, world({ programs: {} }).deps));
    expect(r?.stage).toBe("compile");
    if (r?.stage === "compile") expect(r.violations.map((v) => v.code)).toContain("program-required-for-tier");
  });

  it("expired reservation -> refused", () => {
    expect(refusal(acceptExternalPlan(agentDag(), CTX, world({ now: NOW + 3600 }).deps))).toEqual({ stage: "reservation", reason: "expired" });
  });

  it("a reservation for principal/request A used for B -> refused", () => {
    expect(refusal(acceptExternalPlan(agentDag(), { principal: "agent:intruder" }, world().deps))).toEqual({ stage: "reservation", reason: "wrong-principal" });
    expect(refusal(acceptExternalPlan(agentDag({ requestId: "req-other" }), CTX, world().deps))).toEqual({ stage: "reservation", reason: "wrong-request" });
  });

  it("obligation exceeds the reservation -> refused by the compiler", () => {
    const r = refusal(acceptExternalPlan(agentDag(), CTX, world({ reservation: { maxAmountBaseUnits: 9_749_999n } }).deps));
    expect(r?.stage).toBe("compile");
    if (r?.stage === "compile") expect(r.violations.map((v) => v.code)).toEqual(["obligation-exceeds-reservation"]);
  });

  it("an already-consumed reservation, and a double consume -> exactly one succeeds", () => {
    const { store, deps } = world();
    const first = acceptExternalPlan(agentDag(), CTX, deps);
    const second = acceptExternalPlan(agentDag(), CTX, deps); // accepted twice BEFORE either consume...
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const outcomes = [store.consume("resv-1", CTX.principal, first.plan, NOW), store.consume("resv-1", CTX.principal, second.plan, NOW)];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1); // ...but only one consume lands
    expect(refusal(acceptExternalPlan(agentDag(), CTX, deps))).toEqual({ stage: "reservation", reason: "not-issued" });
  });

  it("duplicate dispatch does not duplicate the obligation: a node listed twice is refused", () => {
    const dag = agentDag();
    const r = refusal(acceptExternalPlan({ ...dag, nodes: [...dag.nodes, dag.nodes[1]!] }, CTX, world().deps));
    expect(r?.stage).toBe("revalidation");
    if (r?.stage === "revalidation") expect(r.verdicts).toEqual([{ nodeId: "print", status: "invalid-claim", reason: "duplicate-node-id" }]);
  });

  it("a plan altered after acceptance is refused at consume: the store RECOMPUTES the digest", () => {
    const { store, deps } = world();
    const ok = acceptExternalPlan(agentDag(), CTX, deps);
    if (!ok.ok) throw new Error("setup");
    const tampered: CompiledAcceptedPlan = {
      ...ok.plan,
      jobs: ok.plan.jobs.map((j, i) => (i === 0 ? { ...j, units: j.units.map((u) => ({ ...u, payouts: [{ recipient: A("66"), amount: u.n }] })) } : j)),
    };
    expect(store.consume("resv-1", CTX.principal, tampered, NOW)).toEqual({ ok: false, reason: "digest-mismatch" });
    expect(store.consume("resv-1", CTX.principal, ok.plan, NOW)).toEqual({ ok: true });
  });

  it("caller-chosen settlement terms are ignored: planId and payout address come from the server", () => {
    const dag = agentDag() as ExternalPlanSubmission & { planId: string };
    dag.planId = "victim-plan";
    dag.nodes[1] = { ...dag.nodes[1]!, payoutAddress: A("66") } as (typeof dag.nodes)[number];
    const r = acceptExternalPlan(dag, CTX, world().deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.planId).toBe("plan.resv-1");
      const recipients = r.plan.jobs.flatMap((j) => j.units.flatMap((u) => u.payouts.map((p) => p.recipient)));
      expect(recipients).toEqual([OP_PRINT, OP_MAIL]);
      expect(r.resolved.map((x) => x.payoutAddress)).toEqual([OP_MAIL, OP_PRINT]); // by node id: mail, print
    }
  });

  it("a node priced in another currency than the reservation, or with no evidence contract for its tier -> refused", () => {
    expect(refusal(acceptExternalPlan(agentDag(), CTX, world({ reservation: { currency: "EURC" } }).deps))).toMatchObject({ stage: "currency" });
    expect(refusal(acceptExternalPlan(agentDag(), CTX, world({ evidence: { [`${PRINT}|tier2`]: EVIDENCE[`${PRINT}|tier2`]! } }).deps))).toEqual({
      stage: "evidence",
      nodeId: "mail",
      reason: "no-evidence-contract-for-tier",
    });
  });

  it("an empty principal matches nothing, even a reservation stored with an empty principal", () => {
    expect(refusal(acceptExternalPlan(agentDag(), { principal: "" }, world({ reservation: { principal: "" } }).deps))).toEqual({
      stage: "reservation",
      reason: "wrong-principal",
    });
    expect(refusal(acceptExternalPlan(agentDag(), undefined as unknown as { principal: string }, world().deps))).toEqual({
      stage: "reservation",
      reason: "wrong-principal",
    });
  });

  it("a fractional clock is floored (no BigInt throw); a broken clock fails closed", () => {
    const { deps } = world();
    const r = acceptExternalPlan(agentDag(), CTX, { ...deps, now: () => NOW + 0.75 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.jobs[0]!.units[0]!.reclaimAt).toBe(BigInt(NOW + 7 * 24 * 3600));
    expect(() => acceptExternalPlan(agentDag(), CTX, { ...deps, now: () => Number.NaN })).toThrow("finite unix seconds");
  });

  it("consume re-checks at consume time: expiry after acceptance, another principal, a resealed plan with another payer or total", () => {
    const { store, deps } = world();
    const ok = acceptExternalPlan(agentDag(), CTX, deps);
    if (!ok.ok) throw new Error("setup");
    const reseal = (p: Omit<CompiledAcceptedPlan, "acceptedDealDigest">): CompiledAcceptedPlan => ({ ...p, acceptedDealDigest: acceptedDealDigest(p) });
    const { acceptedDealDigest: _d, ...base } = ok.plan;
    expect(store.consume("resv-1", CTX.principal, ok.plan, NOW + 3600)).toEqual({ ok: false, reason: "expired" });
    expect(store.consume("resv-1", "agent:intruder", ok.plan, NOW)).toEqual({ ok: false, reason: "wrong-principal" });
    // a consistent, freshly RESEALED plan is still refused: integrity is not authority
    const otherPayer = reseal({ ...base, jobs: base.jobs.map((j) => ({ ...j, payer: A("77") })) });
    expect(store.consume("resv-1", CTX.principal, otherPayer, NOW)).toEqual({ ok: false, reason: "wrong-payer" });
    const understated = reseal({ ...base, totalObligationBaseUnits: 1n });
    expect(store.consume("resv-1", CTX.principal, understated, NOW)).toEqual({ ok: false, reason: "obligation-mismatch" });
    const otherPlanId = reseal({ ...base, planId: "plan.someone-else" });
    expect(store.consume("resv-1", CTX.principal, otherPlanId, NOW)).toEqual({ ok: false, reason: "wrong-binding" });
    expect(store.consume("resv-1", CTX.principal, ok.plan, NOW)).toEqual({ ok: true }); // the genuine one still lands
  });

  it("a server-resolved program that the evidence gate rejects -> refused by the compiler", () => {
    const dag = agentDag();
    const { committedProgramHash: _c, ...printWithoutClaim } = dag.nodes[1]!;
    dag.nodes[1] = printWithoutClaim;
    const r = refusal(acceptExternalPlan(dag, CTX, world({ programs: { [`${PRINT}|tier2`]: `0x${"99".repeat(32)}` } }).deps));
    expect(r?.stage).toBe("compile");
    if (r?.stage === "compile") expect(r.violations.map((v) => v.code)).toEqual(["program-gate-refused"]);
  });

  it("a tier below the reservation's minimum -> refused (a delegate cannot downgrade the payer's assurance)", () => {
    expect(refusal(acceptExternalPlan(agentDag(), CTX, world({ reservation: { minTier: 1 } }).deps))).toEqual({
      stage: "tier",
      nodeId: "mail",
      reason: "below-reservation-minimum",
    });
    const onlyPrint = agentDag({ nodes: [agentDag().nodes[1]!], edges: [] });
    expect(acceptExternalPlan(onlyPrint, CTX, world({ reservation: { minTier: 2 } }).deps).ok).toBe(true);
  });

  it("nested malformed nodes and edges get typed refusals, never a throw", () => {
    const d = agentDag();
    const cases: ExternalPlanSubmission[] = [
      { ...d, nodes: [null as unknown as ExternalPlanSubmission["nodes"][number], ...d.nodes] },
      { ...d, edges: [null as unknown as { from: string; to: string }] },
      { ...d, edges: [{ from: 5 as unknown as string, to: "mail" }] },
      { ...d, edges: [{ from: Object.create(null) as string, to: "mail" }] },
    ];
    for (const c of cases) {
      let r: SeamResult | undefined;
      expect(() => {
        r = acceptExternalPlan(c, CTX, world().deps);
      }).not.toThrow();
      expect(r?.ok).toBe(false);
    }
  });

  it("a malformed submission gets a typed refusal, never a throw", () => {
    for (const bad of [null, {}, { requestId: "req-42", reservationId: "resv-1", nodes: "x", edges: [] }]) {
      expect(refusal(acceptExternalPlan(bad as unknown as ExternalPlanSubmission, CTX, world().deps))).toEqual({ stage: "submission", reason: "malformed-submission" });
    }
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, committedProgramHash: 5 as unknown as string };
    expect(refusal(acceptExternalPlan(dag, CTX, world().deps))).toEqual({ stage: "submission", reason: "malformed-submission" });
  });
});

describe("the server composer is one planner among many: /api/compose output enters the SAME seam", () => {
  const proposal = (over: Partial<ComposeResponse> = {}, steps?: ComposeResponse["steps"]): ComposeResponse => ({
    compositionId: "comp-1",
    status: "proposed",
    steps: steps ?? [
      { index: 0, capabilityType: PRINT, capabilityId: "cap-print", kernelId: "k-print", operatorAddress: OP_PRINT, estimatedPriceUSD: 6.5, estimatedDurationMs: 1, assuranceTier: 2, dependsOn: [] },
      { index: 1, capabilityType: "mail.drop", capabilityId: "cap-mail", kernelId: "k-mail", operatorAddress: OP_MAIL, estimatedPriceUSD: 3.25, estimatedDurationMs: 1, assuranceTier: 0, dependsOn: [0] },
    ],
    totalPriceUSD: 9.75,
    totalDurationMs: 2,
    effectiveAssuranceTier: 0,
    budgetUSD: 20,
    budgetRemainingUSD: 10.25,
    optimizedFor: "price",
    expiresAt: new Date((NOW + 1800) * 1000).toISOString(),
    proposedAt: new Date(NOW * 1000).toISOString(),
    ...over,
  });
  const adapt = (p: ComposeResponse) => submissionFromComposeResponse(p, { requestId: "req-42", reservationId: "resv-1", currency: "USDC", nowMs: NOW * 1000 });

  it("a proposal that matches the live rows is accepted through the ordinary seam", () => {
    const a = adapt(proposal());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.submission.edges).toEqual([{ from: "step-0", to: "step-1" }]);
    const r = acceptExternalPlan(a.submission, CTX, world().deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.jobs.map((j) => j.nodeIds)).toEqual([["step-0"], ["step-1"]]);
  });

  it("the composer's float drift gets no shortcut: stale at R10, like anyone's", () => {
    const drift = proposal({}, proposal().steps.map((s) => (s.index === 0 ? { ...s, estimatedPriceUSD: 6.499999999 } : s)));
    const a = adapt(drift);
    if (!a.ok) throw new Error("adapter");
    const r = refusal(acceptExternalPlan(a.submission, CTX, world().deps));
    expect(r?.stage).toBe("revalidation");
    if (r?.stage === "revalidation") expect(r.verdicts[0]).toMatchObject({ nodeId: "step-0", status: "stale" });
    // an exponent-form float is not a plain decimal: a malformed claim, not a guess
    const tiny = adapt(proposal({}, proposal().steps.map((s) => (s.index === 0 ? { ...s, estimatedPriceUSD: 1e-7 } : s))));
    if (!tiny.ok) throw new Error("adapter");
    const t = refusal(acceptExternalPlan(tiny.submission, CTX, world().deps));
    expect(t?.stage === "revalidation" && t.verdicts[0]).toMatchObject({ status: "invalid-claim", reason: "malformed-price" });
  });

  it("structurally malformed proposals get a typed refusal before the seam — including values whose coercion throws", () => {
    const s = proposal().steps;
    const noString = { toString: null } as unknown;
    expect(adapt({ ...proposal(), status: noString as ComposeResponse["status"] })).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt({ ...proposal(), expiresAt: noString as string })).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt(proposal({}, [{ ...s[0]!, assuranceTier: noString as 0 }, s[1]!]))).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt(proposal({}, [{ ...s[0]!, assuranceTier: "2" as unknown as 2 }, s[1]!]))).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt(proposal({}, [{ ...s[0]!, capabilityId: undefined as unknown as string }, s[1]!]))).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt(proposal({}, [{ ...s[0]!, estimatedPriceUSD: Number.NaN }, s[1]!]))).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt(null as unknown as ComposeResponse)).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
  });

  it("expired, non-proposed and structurally malformed proposals never reach the seam", () => {
    expect(adapt(proposal({ expiresAt: new Date(NOW * 1000).toISOString() }))).toEqual({ ok: false, refusal: { reason: "proposal-expired" } });
    expect(adapt(proposal({ status: "over_budget" }))).toEqual({ ok: false, refusal: { reason: "not-proposed", status: "over_budget" } });
    const s = proposal().steps;
    expect(adapt(proposal({}, [s[0]!, { ...s[1]!, dependsOn: [7] }]))).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
    expect(adapt(proposal({}, [s[0]!, { ...s[1]!, index: 0 }]))).toEqual({ ok: false, refusal: { reason: "malformed-proposal" } });
  });
});

describe("PlanPresentation: the product read model, built only from server truth", () => {
  const ASOF = "2026-09-24T13:00:00.000Z";

  it("proposed only: Layer C, every node 'proposed', no preview and no deal", () => {
    const p = presentPlan({ submission: agentDag(), asOf: ASOF });
    expect(p).toMatchObject({ schema: "pcc.plan-presentation.v1", layer: "C", state: "proposed", requestId: "req-42", reservationId: "resv-1", asOf: ASOF });
    expect(p.nodes.map((n) => [n.nodeId, n.state])).toEqual([["mail", "proposed"], ["print", "proposed"]]);
    expect(p.preview).toBeUndefined();
    expect(p.deal).toBeUndefined();
  });

  it("compiled: live terms, the execution unit and exact money per node; preview totals; still Layer C", () => {
    const outcome = acceptExternalPlan(agentDag(), CTX, world().deps);
    const p = presentPlan({ submission: agentDag(), outcome, asOf: ASOF });
    expect(p.state).toBe("compiled");
    expect(p.layer).toBe("C"); // compiled is not accepted: nothing is sealed yet
    const print = p.nodes.find((n) => n.nodeId === "print")!;
    expect(print.state).toBe("compiled");
    expect(print.live).toMatchObject({ priceDecimal: "6.5", operator: OP_PRINT, csd: PRINT, assuranceTiers: [0, 1, 2] });
    expect(print.unit).toEqual({
      jobId: `plan.resv-1:${OP_PRINT}`,
      milestoneIndex: 0,
      stepId: "print",
      stepIdBytes32: stepIdBytes32("print"),
      tier: 2,
      committedProgramHash: PROGRAM,
    });
    expect(print.money?.net).toEqual({ baseUnits: "6347250", currency: "USDC", decimals: 6 });
    expect(p.preview).toEqual({
      gross: { baseUnits: "9750000", currency: "USDC", decimals: 6 },
      fee: { baseUnits: "229125", currency: "USDC", decimals: 6 },
      net: { baseUnits: "9520875", currency: "USDC", decimals: 6 },
      payoutsByRecipient: [
        { recipient: OP_PRINT, amount: { baseUnits: "6347250", currency: "USDC", decimals: 6 } },
        { recipient: OP_MAIL, amount: { baseUnits: "3173625", currency: "USDC", decimals: 6 } },
      ],
      tierByNode: [
        { nodeId: "mail", tier: 0 },
        { nodeId: "print", tier: 2 },
      ],
      reclaimAt: String(NOW + 7 * 24 * 3600),
    });
    expect(p.deal?.sealed).toBe(false);
  });

  it("sealed: Layer B only when the reservation store sealed EXACTLY this deal's digest", () => {
    const { store, deps } = world();
    const outcome = acceptExternalPlan(agentDag(), CTX, deps);
    if (!outcome.ok) throw new Error("setup");
    expect(presentPlan({ submission: agentDag(), outcome, sealedDigest: `0x${"ab".repeat(32)}`, asOf: ASOF }).layer).toBe("C");
    expect(store.consume("resv-1", CTX.principal, outcome.plan, NOW)).toEqual({ ok: true });
    const p = presentPlan({ submission: agentDag(), outcome, sealedDigest: store.sealed("resv-1"), asOf: ASOF });
    expect(p).toMatchObject({ layer: "B", state: "sealed", deal: { sealed: true, acceptedDealDigest: outcome.plan.acceptedDealDigest } });
    expect(p.nodes.every((n) => n.state === "sealed")).toBe(true);
  });

  it("content cannot raise authority: layer/state/sealed fields in the submission are ignored", () => {
    const forged = { ...agentDag(), layer: "B", state: "sealed", deal: { sealed: true } } as unknown as ExternalPlanSubmission;
    expect(presentPlan({ submission: forged, asOf: ASOF })).toMatchObject({ layer: "C", state: "proposed" });
    const outcome = acceptExternalPlan(agentDag(), CTX, world().deps);
    expect(presentPlan({ submission: forged, outcome, asOf: ASOF })).toMatchObject({ layer: "C", state: "compiled" });
  });

  it("needs-requote: the stale node carries its diffs and the live re-quote; the other node stays current", () => {
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, price: "5.00" };
    const p = presentPlan({ submission: dag, outcome: acceptExternalPlan(dag, CTX, world().deps), asOf: ASOF });
    expect(p.state).toBe("needs-requote");
    const print = p.nodes.find((n) => n.nodeId === "print")!;
    expect(print).toMatchObject({ state: "stale", diffs: [{ field: "price", claimed: "5", live: "6.5" }], live: { priceDecimal: "6.5" } });
    expect(p.nodes.find((n) => n.nodeId === "mail")!.state).toBe("current");
    expect(p.preview).toBeUndefined();
  });

  it("refused: before R10 the nodes stay 'proposed'; a missing capability is 'refused', never a re-quote", () => {
    const early = presentPlan({ submission: agentDag(), outcome: acceptExternalPlan(agentDag(), { principal: "agent:intruder" }, world().deps), asOf: ASOF });
    expect(early).toMatchObject({ state: "refused", refusal: { stage: "reservation", reason: "wrong-principal" } });
    expect(early.nodes.every((n) => n.state === "proposed")).toBe(true);
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, capabilityId: "ghost" };
    const gone = presentPlan({ submission: dag, outcome: acceptExternalPlan(dag, CTX, world().deps), asOf: ASOF });
    expect(gone.state).toBe("refused");
    expect(gone.nodes.find((n) => n.nodeId === "print")).toMatchObject({ state: "missing", reason: "capability-not-found" });
  });

  it("money is always exact base-unit strings, never a float", () => {
    const p = presentPlan({ submission: agentDag(), outcome: acceptExternalPlan(agentDag(), CTX, world().deps), asOf: ASOF });
    const amounts: string[] = [];
    JSON.stringify(p, (_k, v) => {
      if (v && typeof v === "object" && "baseUnits" in v) amounts.push((v as { baseUnits: string }).baseUnits);
      return v;
    });
    expect(amounts.length).toBeGreaterThan(8);
    for (const a of amounts) expect(a).toMatch(/^[0-9]+$/);
  });

  it("a malformed submission renders without throwing", () => {
    const junk = { requestId: Object.create(null), reservationId: 5, nodes: [null, { nodeId: "x", capabilityId: Object.create(null) }], edges: [null, { from: 1, to: "x" }] };
    expect(() => presentPlan({ submission: junk as unknown as ExternalPlanSubmission, asOf: ASOF })).not.toThrow();
    const p = presentPlan({ submission: junk as unknown as ExternalPlanSubmission, asOf: ASOF });
    expect(p.nodes.map((n) => n.nodeId)).toEqual(["x"]);
    expect(p.edges).toEqual([]);
  });
});

describe("seam read-once (the review pattern of #351/#355): every input is read once into owned data", () => {
  it("a node getter is read once: the program cross-check uses the value that was read", () => {
    let reads = 0;
    const dag = agentDag();
    dag.nodes[1] = Object.defineProperty({ ...dag.nodes[1]! }, "committedProgramHash", {
      enumerable: true,
      get: () => (reads++ === 0 ? PROGRAM : `0x${"66".repeat(32)}`),
    });
    const r = acceptExternalPlan(dag, CTX, world().deps);
    expect(reads).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("a callback that mutates the caller's submission cannot change the outcome", () => {
    const baseline = acceptExternalPlan(agentDag(), CTX, world().deps);
    expect(baseline.ok).toBe(true);
    const dag = agentDag();
    const { deps } = world();
    const sneaky: SeamDeps = {
      ...deps,
      loadReservation: (id) => {
        dag.nodes[1] = { ...dag.nodes[1]!, price: "0.01", committedProgramHash: `0x${"66".repeat(32)}` };
        dag.edges.length = 0;
        return deps.loadReservation(id);
      },
    };
    expect(acceptExternalPlan(dag, CTX, sneaky)).toEqual(baseline);
  });

  it("the reservation record is read once; a malformed record is a typed refusal", () => {
    let reads = 0;
    const { deps } = world();
    const flipping: SeamDeps = {
      ...deps,
      loadReservation: (id) => Object.defineProperty({ ...deps.loadReservation(id)! }, "principal", { enumerable: true, get: () => (reads++ === 0 ? CTX.principal : "agent:intruder") }),
    };
    expect(acceptExternalPlan(agentDag(), CTX, flipping).ok).toBe(true);
    expect(reads).toBe(1);
    for (const bad of [{ expiresAt: "soon" }, { minTier: 7 }, { minTier: "2" }]) {
      const r = acceptExternalPlan(agentDag(), CTX, world({ reservation: bad as unknown as Partial<ReservationRecord> }).deps);
      expect(r.ok === false && r.refusal).toEqual({ stage: "reservation", reason: "malformed-reservation" });
    }
    const throwing: SeamDeps = { ...deps, loadReservation: () => Object.defineProperty({}, "state", { get: () => { throw new Error("x"); } }) as ReservationRecord };
    expect(acceptExternalPlan(agentDag(), CTX, throwing)).toMatchObject({ ok: false, refusal: { stage: "reservation", reason: "malformed-reservation" } });
  });

  it("a dependency that cannot be read, or is not a function, is a defined wiring fault (TypeError)", () => {
    const { deps } = world();
    const unreadable = Object.defineProperty({ ...deps }, "evidenceFor", { get: () => { throw new Error("raw"); } }) as SeamDeps;
    expect(() => acceptExternalPlan(agentDag(), CTX, unreadable)).toThrow(/could not be read/);
    const badPolicy = { ...deps, policy: Object.defineProperty({}, "feeBps", { get: () => { throw new Error("raw"); } }) } as SeamDeps;
    expect(() => acceptExternalPlan(agentDag(), CTX, badPolicy)).toThrow(/could not be read/);
    expect(() => acceptExternalPlan(agentDag(), CTX, { ...deps, evidenceFor: null as unknown as SeamDeps["evidenceFor"] })).toThrow(TypeError);
  });

  it("method-style dependencies keep their receiver", () => {
    const { deps } = world();
    const methods = {
      ...deps,
      programs: PROGRAMS,
      resolveProgram(csd: string, tierKey: string) {
        return this.programs[`${csd}|${tierKey}`] ?? null;
      },
    };
    expect(acceptExternalPlan(agentDag(), CTX, methods).ok).toBe(true);
  });

  it("a throwing getter anywhere in the submission is a malformed submission, never an exception", () => {
    const dag = agentDag() as unknown as Record<string, unknown>;
    const bad = Object.defineProperty({ ...dag }, "edges", { get: () => { throw new Error("x"); } });
    let r: SeamResult | undefined;
    expect(() => {
      r = acceptExternalPlan(bad as unknown as ExternalPlanSubmission, CTX, world().deps);
    }).not.toThrow();
    expect(r).toEqual({ ok: false, refusal: { stage: "submission", reason: "malformed-submission" } });
  });

  it("every outcome after the snapshot carries the submission digest; it fingerprints the submission exactly", () => {
    const sub = agentDag();
    const snap = snapshotSubmission(sub)!;
    const d = submissionDigest(snap);
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
    const ok = acceptExternalPlan(sub, CTX, world().deps);
    expect(ok.ok && ok.submissionDigest).toBe(d);
    expect(ok.ok && ok.verdicts.map((v) => v.status)).toEqual(["current", "current"]);
    const refused = acceptExternalPlan(sub, { principal: "agent:intruder" }, world().deps);
    expect(refused.ok === false && refused.submissionDigest).toBe(d);
    const variants: ExternalPlanSubmission[] = [
      { ...sub, nodes: [sub.nodes[0]!, { ...sub.nodes[1]!, price: "6.5" }] }, // same amount, different spelling
      { ...sub, nodes: [sub.nodes[0]!, { ...sub.nodes[1]!, committedProgramHash: null }] }, // absent vs null differ
      { ...sub, edges: [] },
      { ...sub, nodes: [...sub.nodes].reverse() }, // order is part of what was submitted
    ];
    for (const v of variants) expect(submissionDigest(snapshotSubmission(v)!)).not.toBe(d);
    expect(submissionDigest(snapshotSubmission(agentDag())!)).toBe(d); // deterministic
  });
});
