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
  planHashOf,
  payoutsConserve,
  stepIdBytes32,
  type CanonicalPlan,
  type CompiledAcceptedPlan,
  type ComposeResponse,
  type EvidenceRequirement,
  type NodeUnitBinding,
} from "@pcc/spec";
import {
  acceptExternalPlan,
  planIdForReservation,
  snapshotSubmission,
  submissionDigest,
  type EconomicsBinding,
  type ExternalPlanSubmission,
  type ReservationRecord,
  type SeamDeps,
  type SeamResult,
} from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { submissionFromComposeResponse } from "../services/compose-plan-adapter.js";
import { presentPlan, type PresentPlanArgs } from "../services/plan-presentation.js";

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
    const wrong = presentPlan({ submission: agentDag(), outcome, sealed: { reservationId: "resv-1", acceptedDealDigest: `0x${"ab".repeat(32)}` }, asOf: ASOF });
    expect(wrong).toMatchObject({ layer: "C", state: "compiled", deal: { sealed: false } });
    expect(wrong.nodes.map((n) => [n.nodeId, n.state])).toEqual([["mail", "compiled"], ["print", "compiled"]]);
    expect(store.consume("resv-1", CTX.principal, outcome.plan, NOW)).toEqual({ ok: true });
    // the right digest recorded under ANOTHER reservation is not this plan's seal
    expect(presentPlan({ submission: agentDag(), outcome, sealed: { reservationId: "resv-other", acceptedDealDigest: store.sealed("resv-1")! }, asOf: ASOF }).layer).toBe("C");
    const p = presentPlan({ submission: agentDag(), outcome, sealed: { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! }, asOf: ASOF });
    expect(p).toMatchObject({ layer: "B", state: "sealed", deal: { sealed: true, acceptedDealDigest: outcome.plan.acceptedDealDigest } });
    expect(p.nodes.map((n) => [n.nodeId, n.state])).toEqual([["mail", "sealed"], ["print", "sealed"]]);
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

  it("a malformed submission renders as 'invalid' without throwing, and shows nothing", () => {
    const junk = { requestId: Object.create(null), reservationId: 5, nodes: [null, { nodeId: "x", capabilityId: Object.create(null) }], edges: [null, { from: 1, to: "x" }] };
    let p: ReturnType<typeof presentPlan> | undefined;
    expect(() => {
      p = presentPlan({ submission: junk as unknown as ExternalPlanSubmission, asOf: ASOF });
    }).not.toThrow();
    expect(p).toEqual({ schema: "pcc.plan-presentation.v1", layer: "C", state: "invalid", invalid: { reason: "malformed-submission" }, requestId: null, reservationId: null, asOf: ASOF, nodes: [], edges: [], unknowns: ["time-estimate"] });
  });
});

describe("seam read-once (the review pattern of #351/#355): every input is read once into owned data", () => {
  it("a node getter never runs: the program cross-check cannot be shown one value and use another (round 3: refused)", () => {
    let reads = 0;
    const dag = agentDag();
    dag.nodes[1] = Object.defineProperty({ ...dag.nodes[1]! }, "committedProgramHash", {
      enumerable: true,
      get: () => (reads++ === 0 ? PROGRAM : `0x${"66".repeat(32)}`),
    });
    const r = acceptExternalPlan(dag, CTX, world().deps);
    expect(reads).toBe(0);
    expect(refusal(r)).toMatchObject({ stage: "submission", reason: "malformed-submission" });
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

describe("PlanPresentation hardening (astra review of #357): bound, intact, validated, total", () => {
  const ASOF = "2026-09-24T13:00:00.000Z";
  const reseal = (p: Omit<CompiledAcceptedPlan, "acceptedDealDigest">): CompiledAcceptedPlan => ({ ...p, acceptedDealDigest: acceptedDealDigest(p) });
  const accepted = () => {
    const { store, deps } = world();
    const outcome = acceptExternalPlan(agentDag(), CTX, deps);
    if (!outcome.ok) throw new Error("setup");
    return { store, outcome };
  };

  it("a genuine sealed outcome paired with ANOTHER submission is invalid, never Layer B", () => {
    const { store, outcome } = accepted();
    expect(store.consume("resv-1", CTX.principal, outcome.plan, NOW)).toEqual({ ok: true });
    const seal = { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! };
    const others: ExternalPlanSubmission[] = [
      { ...agentDag(), nodes: [agentDag().nodes[0]!, { ...agentDag().nodes[1]!, capabilityId: "cap-evil" }] },
      { ...agentDag(), edges: [] },
      { ...agentDag(), reservationId: "resv-2" },
    ];
    for (const submission of others) {
      const p = presentPlan({ submission, outcome, sealed: seal, asOf: ASOF });
      expect(p).toMatchObject({ layer: "C", state: "invalid", invalid: { reason: "submission-mismatch" }, nodes: [] });
    }
  });

  it("a plan altered after sealing (old digest kept) is invalid; a RE-sealed plan bound elsewhere is invalid too", () => {
    const { store, outcome } = accepted();
    expect(store.consume("resv-1", CTX.principal, outcome.plan, NOW)).toEqual({ ok: true });
    const seal = { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! };
    const altered = { ...outcome, plan: { ...outcome.plan, jobs: outcome.plan.jobs.map((j) => ({ ...j, units: j.units.map((u) => ({ ...u, payouts: [{ recipient: A("66"), amount: u.n }] })) })) } };
    expect(presentPlan({ submission: agentDag(), outcome: altered, sealed: seal, asOf: ASOF })).toMatchObject({ layer: "C", state: "invalid", invalid: { reason: "plan-integrity" } });
    const { acceptedDealDigest: _d, ...rest } = outcome.plan;
    const elsewhere = { ...outcome, plan: reseal({ ...rest, requestId: "req-other" }) };
    expect(presentPlan({ submission: agentDag(), outcome: elsewhere, asOf: ASOF })).toMatchObject({ state: "invalid", invalid: { reason: "plan-binding" } });
    const uneven = { ...outcome, plan: reseal({ ...rest, jobs: rest.jobs.map((j, i) => (i === 0 ? { ...j, units: j.units.map((u) => ({ ...u, reclaimAt: u.reclaimAt + 1n })) } : j)) }) };
    expect(presentPlan({ submission: agentDag(), outcome: uneven, asOf: ASOF })).toMatchObject({ state: "invalid", invalid: { reason: "plan-integrity" } });
  });

  it("a forged verdict status, a malformed verdict list, or an outcome without its submission digest is invalid", () => {
    const { outcome } = accepted();
    const cases: unknown[] = [
      { ...outcome, verdicts: [{ ...outcome.verdicts[0]!, status: "sealed" }, outcome.verdicts[1]!] },
      { ...outcome, verdicts: {} },
      { ...outcome, verdicts: [null, null] },
      { ...outcome, submissionDigest: undefined },
      { ...outcome, plan: { ...outcome.plan, totalObligationBaseUnits: "9750000" } },
      null,
      Object.defineProperty({}, "ok", { get: () => { throw new Error("x"); } }),
    ];
    for (const c of cases) {
      let p: ReturnType<typeof presentPlan> | undefined;
      expect(() => {
        p = presentPlan({ submission: agentDag(), outcome: c as SeamResult, asOf: ASOF });
      }).not.toThrow();
      expect(p?.state).toBe("invalid");
      expect(p?.layer).toBe("C");
      expect(p?.nodes).toEqual([]);
    }
  });

  it("a forged status inside a REFUSAL's verdicts is invalid, never a node shown as 'sealed'", () => {
    const d = submissionDigest(snapshotSubmission(agentDag())!);
    const forged = { ok: false, refusal: { stage: "revalidation", verdicts: [{ nodeId: "print", status: "sealed", reason: "x" }] }, submissionDigest: d } as unknown as SeamResult;
    const p = presentPlan({ submission: agentDag(), outcome: forged, asOf: ASOF });
    expect(p).toMatchObject({ state: "invalid", layer: "C", nodes: [] });
  });

  it("an empty or mixed revalidation refusal is 'refused', never a re-quote", () => {
    const d = submissionDigest(snapshotSubmission(agentDag())!);
    const empty = { ok: false, refusal: { stage: "revalidation", verdicts: [] }, submissionDigest: d } as unknown as SeamResult;
    expect(presentPlan({ submission: agentDag(), outcome: empty, asOf: ASOF }).state).toBe("refused");
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, capabilityId: "ghost" };
    const mixed = acceptExternalPlan(dag, CTX, world().deps);
    expect(presentPlan({ submission: dag, outcome: mixed, asOf: ASOF }).state).toBe("refused");
  });

  it("a non-string asOf, or a throwing getter anywhere in the arguments, is invalid and never throws", () => {
    const { outcome } = accepted();
    const inputs: unknown[] = [
      { submission: agentDag(), outcome, asOf: 5 },
      Object.defineProperty({ submission: agentDag(), asOf: ASOF }, "outcome", { enumerable: true, get: () => { throw new Error("x"); } }),
      null,
    ];
    for (const i of inputs) {
      let p: ReturnType<typeof presentPlan> | undefined;
      expect(() => {
        p = presentPlan(i as PresentPlanArgs);
      }).not.toThrow();
      expect(p?.state).toBe("invalid");
    }
  });
});

describe("PlanPresentation (astra review of #357, round 2b): the contract is bound to its hash and its unit; verdicts cover the nodes exactly", () => {
  const ASOF = "2026-09-30T12:00:00.000Z";
  type Unsealed = Omit<CompiledAcceptedPlan, "acceptedDealDigest">;
  const unsealed = (p: CompiledAcceptedPlan): Unsealed => {
    const { acceptedDealDigest: _d, ...rest } = p;
    return rest;
  };
  const reseal = (p: Unsealed): CompiledAcceptedPlan => ({ ...p, acceptedDealDigest: acceptedDealDigest(p) });
  const accepted = () => {
    const { store, deps } = world();
    const outcome = acceptExternalPlan(agentDag(), CTX, deps);
    if (!outcome.ok) throw new Error("setup");
    return { store, outcome };
  };
  /** The deal with one node's binding rewritten and its digest recomputed, so only a binding check can refuse it. */
  const rebind = (plan: CompiledAcceptedPlan, nodeId: string, edit: (b: NodeUnitBinding) => NodeUnitBinding): CompiledAcceptedPlan =>
    reseal({ ...unsealed(plan), nodeToUnit: plan.nodeToUnit.map((b) => (b.nodeId === nodeId ? edit(b) : b)) });
  /** A binding whose contract was edited AND whose carried planHash was recomputed: only the field under test disagrees. */
  const recut = (edit: (cp: CanonicalPlan) => CanonicalPlan) => (b: NodeUnitBinding): NodeUnitBinding => {
    const canonicalPlan = edit(b.canonicalPlan);
    return { ...b, canonicalPlan, planHash: planHashOf(canonicalPlan) };
  };
  const printUnitEdit = (plan: CompiledAcceptedPlan, edit: (u: CompiledAcceptedPlan["jobs"][number]["units"][number]) => CompiledAcceptedPlan["jobs"][number]["units"][number]): CompiledAcceptedPlan =>
    reseal({ ...unsealed(plan), jobs: plan.jobs.map((j) => (j.nodeIds.includes("print") ? { ...j, units: j.units.map(edit) } : j)) });
  /** Presents `plan` as if the reservation store had sealed exactly that deal's digest. */
  const sealedAs = (outcome: Extract<SeamResult, { ok: true }>, plan: CompiledAcceptedPlan) =>
    presentPlan({ submission: agentDag(), outcome: { ...outcome, plan }, sealed: { reservationId: "resv-1", acceptedDealDigest: plan.acceptedDealDigest }, asOf: ASOF });
  /** The four facts that matter, compact: layer, state, the invalid reason and how many nodes are shown. */
  const shape = (p: ReturnType<typeof presentPlan>) => [p.layer, p.state, p.invalid?.reason ?? null, p.nodes.length];
  const refusedAsBinding = (p: ReturnType<typeof presentPlan>) => expect(shape(p)).toEqual(["C", "invalid", "plan-binding", 0]);
  const refusedAsMalformed = (p: ReturnType<typeof presentPlan>, why?: string) => expect(shape(p), why).toEqual(["C", "invalid", "malformed-outcome", 0]);
  const cpOf = (plan: CompiledAcceptedPlan, nodeId: string) => plan.nodeToUnit.find((b) => b.nodeId === nodeId)!;

  it("control: a deal resealed unchanged is still sealed, so each case below can fail only on its own field", () => {
    const { outcome } = accepted();
    const same = rebind(outcome.plan, "print", (b) => b);
    expect(same.acceptedDealDigest).toBe(outcome.plan.acceptedDealDigest);
    expect(shape(sealedAs(outcome, same))).toEqual(["B", "sealed", null, 2]);
  });

  it("M1 planHash: the hash shown with a unit is the hash of the contract shown with it, never an older one", () => {
    const { store, outcome } = accepted();
    const old = cpOf(outcome.plan, "print").planHash;
    // The contract's inputs are edited, the old planHash is kept and the deal digest is recomputed and sealed.
    const plan = rebind(outcome.plan, "print", (b) => ({ ...b, canonicalPlan: { ...b.canonicalPlan, inputs: { pages: 3 } } }));
    expect(cpOf(plan, "print").planHash).toBe(old);
    expect(store.consume("resv-1", CTX.principal, plan, NOW)).toEqual({ ok: true }); // a recomputed digest satisfies the store
    const sealed = presentPlan({ submission: agentDag(), outcome: { ...outcome, plan }, sealed: { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! }, asOf: ASOF });
    refusedAsBinding(sealed);
    // Unsealed, the same deal is refused too; and so is a carried hash that no contract hashes to.
    refusedAsBinding(presentPlan({ submission: agentDag(), outcome: { ...outcome, plan }, asOf: ASOF }));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", (b) => ({ ...b, planHash: `sha256:${"00".repeat(32)}` }))));
  });

  it("M1 step: the contract's step is the binding's step", () => {
    const { outcome } = accepted();
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, job: { ...cp.job, stepId: "mail" } })))));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", (b) => ({ ...b, stepId: "mail" }))));
  });

  it("M1 operator: the contract's operator is the binding's operator, in whatever hex case", () => {
    const { outcome } = accepted();
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, operator: OP_MAIL })))));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", (b) => ({ ...b, operator: OP_MAIL }))));
    // Hex case carries no meaning: the compiler lowercases the contract and keeps the binding's own case.
    const upper = rebind(outcome.plan, "print", (b) => ({ ...b, operator: `0x${OP_PRINT.slice(2).toUpperCase()}` as typeof b.operator }));
    expect(upper.acceptedDealDigest).toBe(outcome.plan.acceptedDealDigest);
    expect(shape(sealedAs(outcome, upper))).toEqual(["B", "sealed", null, 2]);
  });

  it("M1 tier: the contract's tier is the binding's tier", () => {
    const { outcome } = accepted();
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, assurance: { ...cp.assurance, tier: 1 } })))));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", (b) => ({ ...b, tier: 1 }))));
  });

  it("M1 program: the contract's committed program is the binding's, in whatever hex case, and null only for null", () => {
    const { outcome } = accepted();
    const other = `0x${"e3".repeat(32)}`;
    const withProgram = (committedProgramHash: string | null) => recut((cp) => ({ ...cp, assurance: { ...cp.assurance, committedProgramHash } }));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", withProgram(other))));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", withProgram(null))));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", (b) => ({ ...b, committedProgramHash: other }))));
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "mail", withProgram(PROGRAM)))); // the mail binding commits no program
    const upper = rebind(outcome.plan, "print", (b) => ({ ...b, committedProgramHash: `0x${PROGRAM.slice(2).toUpperCase()}` }));
    expect(upper.acceptedDealDigest).toBe(outcome.plan.acceptedDealDigest);
    expect(shape(sealedAs(outcome, upper))).toEqual(["B", "sealed", null, 2]);
  });

  it("M1 amount: the contract's amount is the unit's gross, as the exact canonical base-unit string", () => {
    const { outcome } = accepted();
    expect(cpOf(outcome.plan, "print").canonicalPlan.amount.baseUnits).toBe("6500000");
    for (const baseUnits of ["6500001", "0", "06500000", "6500000.0", "6.5e6", " 6500000"]) {
      refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, amount: { ...cp.amount, baseUnits } })))));
    }
    // The other direction: the unit's gross moves and the contract stays.
    refusedAsBinding(sealedAs(outcome, printUnitEdit(outcome.plan, (u) => ({ ...u, g: u.g + 1n }))));
  });

  it("M1 amount under an economics agreement: the contract's amount is the unit's gross (the agreement's), not the operator's quote", () => {
    const LICENSOR = A("c1");
    const HASH = (b: string) => `0x${b.repeat(32)}`;
    const split: EconomicsBinding["splitNet"] = (units) => ({
      ok: true,
      agreementHash: HASH("a1"),
      economicTermsHash: HASH("e1"),
      rightsTermsHash: HASH("f1"),
      units: units.map((u) => {
        const royalty = (u.g - u.quote) / 2n;
        const legs = royalty > 0n ? [{ recipient: u.payoutAddress, amount: (u.n - royalty).toString() }, { recipient: LICENSOR, amount: royalty.toString() }] : [{ recipient: u.payoutAddress, amount: u.n.toString() }];
        return { unitRef: u.nodeId, gross: u.g.toString(), fee: u.f.toString(), net: u.n.toString(), payouts: legs };
      }),
    });
    const economics: EconomicsBinding = { unitGross: () => ({ ok: true, gross: { print: 7_000_000n, mail: 3_250_000n } }), splitNet: split };
    const outcome = acceptExternalPlan(agentDag(), CTX, { ...world().deps, economics });
    if (!outcome.ok) throw new Error("setup");
    expect(cpOf(outcome.plan, "print").canonicalPlan.amount.baseUnits).toBe("7000000"); // the quote is 6500000
    expect(shape(sealedAs(outcome, outcome.plan))).toEqual(["B", "sealed", null, 2]); // an honest agreement deal still presents
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, amount: { ...cp.amount, baseUnits: "6500000" } })))));
  });

  it("M1 currency: the contract's currency is the deal's currency", () => {
    const { outcome } = accepted();
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, amount: { ...cp.amount, currency: "USDT" } })))));
    refusedAsBinding(sealedAs(outcome, reseal({ ...unsealed(outcome.plan), currency: "USDT" })));
  });

  it("M1 decimals: the contract's decimals are the deal's decimals", () => {
    const { outcome } = accepted();
    refusedAsBinding(sealedAs(outcome, rebind(outcome.plan, "print", recut((cp) => ({ ...cp, amount: { ...cp.amount, decimals: 18 } })))));
    refusedAsBinding(sealedAs(outcome, reseal({ ...unsealed(outcome.plan), currencyDecimals: 18 })));
  });

  it("M2 duplicates: two copies of one node's verdict cannot stand in for both nodes", () => {
    const { store, outcome } = accepted();
    expect(store.consume("resv-1", CTX.principal, outcome.plan, NOW)).toEqual({ ok: true });
    const seal = { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! };
    const [first, second] = outcome.verdicts;
    for (const verdicts of [[first!, first!], [second!, second!]]) {
      refusedAsMalformed(presentPlan({ submission: agentDag(), outcome: { ...outcome, verdicts }, sealed: seal, asOf: ASOF }));
    }
  });

  /** A re-quote from the real seam: top-level verdicts for every node, nested verdicts for the non-current ones. */
  const requoteOf = (prices: { mail?: string; print?: string }) => {
    const dag = agentDag();
    dag.nodes = dag.nodes.map((n) => ({ ...n, price: prices[n.nodeId as "mail" | "print"] ?? n.price }));
    const outcome = acceptExternalPlan(dag, CTX, world().deps);
    if (outcome.ok || outcome.refusal.stage !== "revalidation" || !outcome.verdicts) throw new Error("setup");
    return { dag, outcome, top: outcome.verdicts, nested: outcome.refusal.verdicts };
  };
  const presentFor = (dag: ExternalPlanSubmission, outcome: SeamResult) => presentPlan({ submission: dag, outcome, asOf: ASOF });

  it("M2 coverage: a node without a verdict is invalid, with a plan or without one", () => {
    const { dag, outcome, top, nested } = requoteOf({ print: "5.00" });
    expect(presentFor(dag, outcome).state).toBe("needs-requote"); // control: the seam's own shape
    refusedAsMalformed(presentFor(dag, { ...outcome, verdicts: top.filter((v) => v.nodeId !== "mail") } as SeamResult), "a refusal with no verdict for mail");
    refusedAsMalformed(presentFor(dag, { ...outcome, verdicts: [] } as SeamResult), "a refusal with an empty top-level list");
    // Every node has a verdict and one has two, the nested list repeating it: only the exact-cover rule refuses this.
    const twiceStale = { ...outcome, verdicts: [...top, top[1]!], refusal: { stage: "revalidation", verdicts: [...nested, nested[0]!] } } as SeamResult;
    refusedAsMalformed(presentFor(dag, twiceStale), "a stale node covered twice, both lists agreeing");
    // With a plan this was already refused by the count check; it stays refused.
    const { outcome: ok } = accepted();
    refusedAsMalformed(presentFor(agentDag(), { ...ok, verdicts: ok.verdicts.slice(1) }), "a plan with one verdict for two nodes");
  });

  it("M2 agreement: a revalidation refusal's nested verdicts are exactly the top-level verdicts that are not current", () => {
    const { dag, outcome, top, nested } = requoteOf({ print: "5.00" });
    expect(nested.map((v) => [v.nodeId, v.status])).toEqual([["print", "stale"]]); // control
    const printStale = nested[0]!;
    const refusalWith = (verdicts: typeof nested): SeamResult => ({ ...outcome, refusal: { stage: "revalidation", verdicts } } as SeamResult);
    const cases: Array<[string, SeamResult]> = [
      ["another status for the same node", { ...outcome, verdicts: top.map((v) => (v.nodeId === "print" ? { nodeId: "print", status: "missing", reason: "capability-not-found" } : v)) } as SeamResult],
      ["a node the top-level list calls current", refusalWith([{ ...printStale, nodeId: "mail" }, printStale])],
      ["a node the top-level list does not name", refusalWith([printStale, { nodeId: "ghost", status: "missing", reason: "capability-not-found" }])],
      ["the same stale node twice", refusalWith([printStale, printStale])],
      ["the right status on the wrong node", refusalWith([{ ...printStale, nodeId: "mail" }])],
      ["a nested list with no top-level list", { ok: false, refusal: outcome.refusal, submissionDigest: outcome.submissionDigest } as SeamResult],
      ["a later-stage refusal beside a verdict that is not current", { ...outcome, refusal: { stage: "economics", reason: "quote-not-covered", nodeId: "print" } } as SeamResult],
    ];
    for (const [why, bad] of cases) refusedAsMalformed(presentFor(dag, bad), why);
    // And the other way round: a non-current top-level node that the nested list leaves out.
    const both = requoteOf({ mail: "1.00", print: "5.00" });
    expect(presentFor(both.dag, both.outcome).state).toBe("needs-requote"); // control
    const leftOut = { ...both.outcome, refusal: { stage: "revalidation", verdicts: both.nested.filter((v) => v.nodeId === "print") } } as SeamResult;
    refusedAsMalformed(presentFor(both.dag, leftOut), "a non-current node left out of the nested list");
  });

  it("M2 pins: the seam's own refusals are still presented (a mixed refusal, an empty nested list, a node submitted twice)", () => {
    // A missing capability beside a current node: nested is [print], top-level is both nodes.
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, capabilityId: "ghost" };
    const mixed = presentFor(dag, acceptExternalPlan(dag, CTX, world().deps));
    expect(mixed.state).toBe("refused");
    expect(mixed.nodes.map((n) => [n.nodeId, n.state])).toEqual([["mail", "current"], ["print", "missing"]]);
    // R10 gives a node id submitted twice ONE verdict, so the node list repeats it and the verdict list does not.
    const twice = { ...agentDag(), nodes: [...agentDag().nodes, agentDag().nodes[1]!] };
    const dup = presentFor(twice, acceptExternalPlan(twice, CTX, world().deps));
    expect(dup.state).toBe("refused");
    expect(dup.nodes.map((n) => [n.nodeId, n.state])).toEqual([["mail", "current"], ["print", "invalid-claim"], ["print", "invalid-claim"]]);
    // R10 gives an id it cannot read one verdict PER CLAIM, so two nodes with the same unreadable id have two.
    const unreadable = { ...agentDag(), nodes: [{ ...agentDag().nodes[0]!, nodeId: "bad id" }, { ...agentDag().nodes[0]!, nodeId: "bad id" }, agentDag().nodes[1]!] };
    const twoBad = presentFor(unreadable, acceptExternalPlan(unreadable, CTX, world().deps));
    expect(twoBad.state).toBe("refused");
    expect(twoBad.nodes.map((n) => [n.nodeId, n.state])).toEqual([["bad id", "invalid-claim"], ["bad id", "invalid-claim"], ["print", "current"]]);
    // Before R10 there are no verdicts at all, and the nodes stay proposed.
    const early = presentFor(agentDag(), acceptExternalPlan(agentDag(), { principal: "agent:intruder" }, world().deps));
    expect(early.state).toBe("refused");
    expect(early.nodes.every((n) => n.state === "proposed")).toBe(true);
  });
});

describe("N25 through the seam: the accepted deal seals each node's execution inputs", () => {
  const DOC = "e62809887a42910a8af353d240984a2c971d5bc5567f9e0b046b5c14557dd8f3";
  /** The agent's DAG with execution JSON: which document, how many pages, by when, to whom. */
  const withExec = (over: { print?: Record<string, unknown>; mail?: Record<string, unknown> } = {}): ExternalPlanSubmission => {
    const d = agentDag();
    return {
      ...d,
      nodes: d.nodes.map((n) =>
        n.nodeId === "print"
          ? { ...n, inputs: { documentHash: DOC, pages: 2, copies: 1 }, constraints: { deadline: "2026-09-30T00:00:00.000Z" }, ...over.print }
          : { ...n, inputs: { recipient: { name: "Clerk of Court", city: "New York" } }, ...over.mail },
      ),
    };
  };
  const accept = (sub: ExternalPlanSubmission, deps = world().deps) => {
    const r = acceptExternalPlan(sub, CTX, deps);
    if (!r.ok) throw new Error(JSON.stringify(r.refusal));
    return r;
  };
  const binding = (plan: CompiledAcceptedPlan, id: string) => plan.nodeToUnit.find((b) => b.nodeId === id)!;

  it("each node's canonicalPlan carries the agent's inputs and constraints next to the server's terms; the store's recompute seals it", () => {
    const { store, deps } = world();
    const r = accept(withExec(), deps);
    const print = binding(r.plan, "print");
    expect(print.canonicalPlan.inputs).toEqual({ documentHash: DOC, pages: 2, copies: 1 });
    expect(print.canonicalPlan.constraints).toEqual({ deadline: "2026-09-30T00:00:00.000Z" });
    expect(print.canonicalPlan.payTo).toBe(OP_PRINT.toLowerCase()); // the server's payee, not the agent's
    expect(print.canonicalPlan.amount).toEqual({ baseUnits: "6500000", currency: "USDC", decimals: 6 });
    expect(binding(r.plan, "mail").canonicalPlan.constraints).toEqual({});
    for (const b of r.plan.nodeToUnit) expect(b.planHash).toBe(planHashOf(b.canonicalPlan));
    expect(store.consume("resv-1", CTX.principal, r.plan, NOW)).toEqual({ ok: true }); // recompute-and-compare passes
  });

  it("one input byte changes the node's planHash and the deal; absent and {} are the same deal but different submissions", () => {
    const base = accept(withExec());
    const other = accept(withExec({ print: { inputs: { documentHash: DOC, pages: 3, copies: 1 } } }));
    expect(binding(other.plan, "print").planHash).not.toBe(binding(base.plan, "print").planHash);
    expect(other.plan.acceptedDealDigest).not.toBe(base.plan.acceptedDealDigest);
    expect(binding(other.plan, "mail").planHash).toBe(binding(base.plan, "mail").planHash);
    const explicitEmpty = accept(withExec({ mail: { constraints: {} } }));
    expect(explicitEmpty.plan.acceptedDealDigest).toBe(base.plan.acceptedDealDigest);
    expect(explicitEmpty.submissionDigest).not.toBe(base.submissionDigest);
  });

  it("invalid execution JSON is refused naming every bad field in order, before any reservation is read", () => {
    let loads = 0;
    const { deps } = world();
    const counting: SeamDeps = { ...deps, loadReservation: (id) => (loads++, deps.loadReservation(id)) };
    const sub = withExec({
      print: { inputs: { pages: Number.NaN }, constraints: [] },
      mail: { inputs: { when: new Date(0) } },
    });
    const r = acceptExternalPlan(sub, CTX, counting);
    expect(r.ok === false && r.refusal).toEqual({
      stage: "submission",
      reason: "invalid-execution-json",
      fields: [
        { nodeId: "mail", field: "inputs", reason: "unsupported-value" },
        { nodeId: "print", field: "constraints", reason: "not-an-object" },
        { nodeId: "print", field: "inputs", reason: "non-finite-number" },
      ],
    });
    expect(r.ok === false && r.submissionDigest).toBe(submissionDigest(snapshotSubmission(sub)!));
    expect(loads).toBe(0);
  });

  it("execution JSON is owned: a flipping getter on node.inputs never runs (round 3: refused); mutating accepted inputs later changes nothing", () => {
    const flipping = withExec();
    const flipPrint = flipping.nodes.find((n) => n.nodeId === "print")!;
    const first = flipPrint.inputs!;
    let reads = 0;
    Object.defineProperty(flipPrint, "inputs", { enumerable: true, get: () => (reads++ === 0 ? first : { documentHash: DOC, pages: 99 }) });
    expect(refusal(acceptExternalPlan(flipping, CTX, world().deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(reads).toBe(0);
    const sub = withExec();
    const inputs = sub.nodes.find((n) => n.nodeId === "print")!.inputs!;
    const r = accept(sub);
    expect(r.plan.acceptedDealDigest).toBe(accept(withExec()).plan.acceptedDealDigest);
    (inputs as { pages: number }).pages = 42;
    expect(binding(r.plan, "print").canonicalPlan.inputs).toEqual({ documentHash: DOC, pages: 2, copies: 1 });
  });

  it("the submission digest covers execution JSON, so a presentation cannot bind another submission's inputs", () => {
    const d = (s: ExternalPlanSubmission) => submissionDigest(snapshotSubmission(s)!);
    expect(d(withExec({ print: { inputs: { documentHash: DOC, pages: 3, copies: 1 } } }))).not.toBe(d(withExec()));
    expect(d(withExec({ print: { constraints: { deadline: "2026-09-30T00:00:00.001Z" } } }))).not.toBe(d(withExec()));
    // AS EVALUATED: invalid JSON evaluates to its refusal reason (NaN and Infinity alike, one outcome),
    // exactly as a non-primitive where a primitive belongs evaluates to NOT_DATA; valid JSON never collides with it.
    expect(d(withExec({ print: { inputs: { pages: Number.NaN } } }))).toBe(d(withExec({ print: { inputs: { pages: Infinity } } })));
    expect(d(withExec({ print: { inputs: { pages: Number.NaN } } }))).not.toBe(d(withExec({ print: { inputs: { pages: 2 } } })));
    expect(d(withExec())).toBe(d(withExec())); // deterministic
  });
});

describe("PlanPresentation and N25: what each unit runs on is shown only from the intact, bound, sealed deal", () => {
  const ASOF = "2026-09-24T15:30:00.000Z";
  const DOC = "e62809887a42910a8af353d240984a2c971d5bc5567f9e0b046b5c14557dd8f3";
  const sub = (): ExternalPlanSubmission => {
    const d = agentDag();
    return {
      ...d,
      nodes: d.nodes.map((n) => (n.nodeId === "print" ? { ...n, inputs: { documentHash: DOC, pages: 2 }, constraints: { deadline: "2026-09-30" } } : n)),
    };
  };
  const reseal = (p: Omit<CompiledAcceptedPlan, "acceptedDealDigest">): CompiledAcceptedPlan => ({ ...p, acceptedDealDigest: acceptedDealDigest(p) });
  const accepted = () => {
    const { store, deps } = world();
    const s = sub();
    const outcome = acceptExternalPlan(s, CTX, deps);
    if (!outcome.ok) throw new Error("setup");
    return { store, s, outcome };
  };

  it("a sealed deal shows each unit's execution (planHash, inputs, constraints) and the deal's agreementHash", () => {
    const { store, s, outcome } = accepted();
    expect(store.consume("resv-1", CTX.principal, outcome.plan, NOW)).toEqual({ ok: true });
    const p = presentPlan({ submission: s, outcome, sealed: { reservationId: "resv-1", acceptedDealDigest: store.sealed("resv-1")! }, asOf: ASOF });
    expect([p.layer, p.state]).toEqual(["B", "sealed"]);
    const print = p.nodes.find((n) => n.nodeId === "print")!;
    const printBinding = outcome.plan.nodeToUnit.find((b) => b.nodeId === "print")!;
    expect(print.execution).toEqual({ planHash: printBinding.planHash, inputs: { documentHash: DOC, pages: 2 }, constraints: { deadline: "2026-09-30" } });
    expect(p.nodes.find((n) => n.nodeId === "mail")!.execution).toEqual({ planHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), inputs: {}, constraints: {} });
    expect(p.deal?.agreementHash).toBeNull();
    // A deal that carries an agreement (economics' split) shows exactly its agreementHash.
    const { acceptedDealDigest: _d, ...rest } = outcome.plan;
    const withAgreement = reseal({ ...rest, agreementHash: `0x${"ab".repeat(32)}` });
    const shown = presentPlan({ submission: s, outcome: { ...outcome, plan: withAgreement }, asOf: ASOF });
    expect(shown.deal?.agreementHash).toBe(`0x${"ab".repeat(32)}`);
    const proposed = presentPlan({ submission: s, asOf: ASOF });
    expect(proposed.nodes.every((n) => n.execution === undefined)).toBe(true); // a proposal shows no sealed execution
  });

  it("execution content altered under the old hashes is plan-integrity; a resealed plan whose contract names another node is plan-binding", () => {
    const { s, outcome } = accepted();
    const { acceptedDealDigest: _d, ...rest } = outcome.plan;
    const patch = (i: number, cp: Record<string, unknown>) => ({ ...rest, nodeToUnit: rest.nodeToUnit.map((b, k) => (k === i ? { ...b, canonicalPlan: { ...b.canonicalPlan, ...cp } } : b)) });
    const i = rest.nodeToUnit.findIndex((b) => b.nodeId === "print");
    const altered = { ...outcome, plan: { ...patch(i, { inputs: { documentHash: DOC, pages: 3 } }), acceptedDealDigest: outcome.plan.acceptedDealDigest } };
    expect(presentPlan({ submission: s, outcome: altered as SeamResult, asOf: ASOF }).invalid).toEqual({ reason: "plan-integrity" });
    const renamed = { ...outcome, plan: reseal(patch(i, { planNodeId: "mail" }) as Omit<CompiledAcceptedPlan, "acceptedDealDigest">) };
    expect(presentPlan({ submission: s, outcome: renamed as SeamResult, asOf: ASOF }).invalid).toEqual({ reason: "plan-binding" });
    const otherPlan = { ...outcome, plan: reseal(patch(i, { planId: "plan.other" }) as Omit<CompiledAcceptedPlan, "acceptedDealDigest">) };
    expect(presentPlan({ submission: s, outcome: otherPlan as SeamResult, asOf: ASOF }).invalid).toEqual({ reason: "plan-binding" });
  });

  it("non-JSON execution content inside an outcome is invalid, never shown and never a throw", () => {
    const { s, outcome } = accepted();
    const i = outcome.plan.nodeToUnit.findIndex((b) => b.nodeId === "print");
    for (const bad of [{ pages: Number.NaN }, [], { when: new Date(0) }]) {
      const plan = { ...outcome.plan, nodeToUnit: outcome.plan.nodeToUnit.map((b, k) => (k === i ? { ...b, canonicalPlan: { ...b.canonicalPlan, inputs: bad } } : b)) };
      let p: ReturnType<typeof presentPlan> | undefined;
      expect(() => {
        p = presentPlan({ submission: s, outcome: { ...outcome, plan } as unknown as SeamResult, asOf: ASOF });
      }).not.toThrow();
      expect(p?.state).toBe("invalid");
      expect(p?.nodes).toEqual([]);
      // Resealed, so integrity alone would pass: only the JSON check refuses it. Content with no canonical
      // form (NaN, a Date) can't be resealed once canonicalize refuses it (D5, #359): the sealing refuses,
      // which is stronger. Either way nothing non-JSON is ever shown.
      const { acceptedDealDigest: _d, ...rest } = plan as unknown as CompiledAcceptedPlan;
      let resealedPlan: CompiledAcceptedPlan | undefined;
      try {
        resealedPlan = reseal(rest);
      } catch (err) {
        expect((err as Error).name).toBe("NonCanonicalValueError");
      }
      if (resealedPlan) {
        const resealed = presentPlan({ submission: s, outcome: { ...outcome, plan: resealedPlan } as unknown as SeamResult, asOf: ASOF });
        expect(resealed.invalid).toEqual({ reason: "malformed-outcome" });
      }
    }
  });

  it("the seam's invalid-execution-json refusal is shown as refused, with one code per bad field and nothing sealed", () => {
    const bad = { ...sub(), nodes: sub().nodes.map((n) => (n.nodeId === "mail" ? { ...n, inputs: { a: Number.NaN }, constraints: [] as unknown as Record<string, unknown> } : n)) };
    const outcome = acceptExternalPlan(bad, CTX, world().deps);
    const p = presentPlan({ submission: bad, outcome, asOf: ASOF });
    expect([p.layer, p.state]).toEqual(["C", "refused"]);
    expect(p.refusal).toEqual({
      stage: "submission",
      reason: "invalid-execution-json",
      codes: ["constraints:not-an-object@mail", "inputs:non-finite-number@mail"],
    });
    expect(p.nodes.every((n) => n.execution === undefined && n.state === "proposed")).toBe(true);
  });
});

describe("R15 through the seam (economics option b: royalties on top): the agreement grosses units up; the reservation covers it", () => {
  const LICENSOR = A("c1");
  const HASH = (b: string) => `0x${b.repeat(32)}`;
  /** A stand-in for economics' netSplitterFor: the licensor gets part of the gross-up; legs conserve n exactly. */
  const standInSplit: EconomicsBinding["splitNet"] = (units) => ({
    ok: true,
    agreementHash: HASH("a1"),
    economicTermsHash: HASH("e1"),
    rightsTermsHash: HASH("f1"),
    units: units.map((u) => {
      const royalty = (u.g - u.quote) / 2n;
      return {
        unitRef: u.nodeId,
        gross: u.g.toString(),
        fee: u.f.toString(),
        net: u.n.toString(),
        payouts: royalty > 0n
          ? [{ recipient: u.payoutAddress, amount: (u.n - royalty).toString() }, { recipient: LICENSOR, amount: royalty.toString() }]
          : [{ recipient: u.payoutAddress, amount: u.n.toString() }],
      };
    }),
  });
  const econ = (gross: Record<string, bigint>, over: Partial<EconomicsBinding> = {}): EconomicsBinding => ({ unitGross: () => ({ ok: true, gross }), splitNet: standInSplit, ...over });
  const withEcon = (economics: unknown) => ({ ...world().deps, economics }) as SeamDeps;

  it("each unit's gross is the agreement's; the operator's live quote reaches the splitter; the deal seals the agreementHash and the royalty legs", () => {
    const seen: Array<{ nodeId: string; quote: bigint; g: bigint }> = [];
    const binding = econ({ print: 7_000_000n, mail: 3_250_000n }, {
      splitNet: (units) => {
        for (const u of units) seen.push({ nodeId: u.nodeId, quote: u.quote, g: u.g });
        return standInSplit(units);
      },
    });
    const r = acceptExternalPlan(agentDag(), CTX, withEcon(binding));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).toEqual([
      { nodeId: "print", quote: 6_500_000n, g: 7_000_000n },
      { nodeId: "mail", quote: 3_250_000n, g: 3_250_000n },
    ]);
    expect(r.plan.totalObligationBaseUnits).toBe(10_250_000n);
    expect(r.plan.agreementHash).toBe(HASH("a1"));
    const printUnit = r.plan.jobs.flatMap((j) => j.units).find((u) => u.g === 7_000_000n)!;
    expect(printUnit.payouts.map((p) => p.recipient)).toEqual([OP_PRINT, LICENSOR]);
    expect(printUnit.payouts.reduce((a, p) => a + p.amount, 0n)).toBe(printUnit.n);
  });

  it("refused at the economics stage, before the compile: an agreement refusal, an unreadable answer, a missing unit gross, a gross below the quote", () => {
    const boom = () => {
      throw new Error("x");
    };
    const cases: Array<[unknown, unknown]> = [
      [econ({}, { unitGross: () => ({ ok: false, code: "economics:SCHEMA_INVALID" }) }), { stage: "economics", reason: "agreement-refused", code: "economics:SCHEMA_INVALID" }],
      [econ({}, { unitGross: () => null as never }), { stage: "economics", reason: "agreement-unreadable" }],
      [econ({}, { unitGross: () => ({ ok: true, gross: "x" }) as never }), { stage: "economics", reason: "agreement-unreadable" }],
      [econ({}, { unitGross: () => Object.defineProperty({ ok: true }, "gross", { get: boom }) as never }), { stage: "economics", reason: "agreement-unreadable" }],
      [econ({ print: 7_000_000n }), { stage: "economics", nodeId: "mail", reason: "unit-gross-missing" }],
      [econ({ print: 7_000_000n, mail: 3_000_000 as unknown as bigint }), { stage: "economics", nodeId: "mail", reason: "unit-gross-missing" }],
      [econ({ print: 6_499_999n, mail: 3_250_000n }), { stage: "economics", nodeId: "print", reason: "quote-not-covered" }],
    ];
    for (const [binding, expected] of cases) {
      const r = acceptExternalPlan(agentDag(), CTX, withEcon(binding));
      expect(r.ok === false && r.refusal).toEqual(expected);
    }
  });

  it("the reservation must cover the GROSSED-UP total, not the operators' quotes", () => {
    const r = acceptExternalPlan(agentDag(), CTX, withEcon(econ({ print: 15_000_000n, mail: 6_000_000n })));
    expect(r.ok === false && r.refusal.stage === "compile" && r.refusal.violations.map((v) => v.code)).toEqual(["obligation-exceeds-reservation"]);
  });

  it("economics wiring that is not { unitGross, splitNet } functions is a wiring fault; a method-style binding keeps its receiver and is called once", () => {
    for (const bad of [null, 1, {}, { unitGross: () => ({ ok: true, gross: {} }) }, { splitNet: standInSplit }]) {
      expect(() => acceptExternalPlan(agentDag(), CTX, withEcon(bad))).toThrow(TypeError);
    }
    class Binding {
      calls = { unitGross: 0, splitNet: 0 };
      constructor(private readonly gross: Record<string, bigint>) {}
      unitGross() {
        this.calls.unitGross++;
        return { ok: true as const, gross: this.gross };
      }
      splitNet(units: Parameters<EconomicsBinding["splitNet"]>[0]) {
        this.calls.splitNet++;
        return standInSplit(units);
      }
    }
    const b = new Binding({ print: 7_000_000n, mail: 3_250_000n });
    expect(acceptExternalPlan(agentDag(), CTX, withEcon(b)).ok).toBe(true);
    expect(b.calls).toEqual({ unitGross: 1, splitNet: 1 });
  });
});

describe("PlanPresentation and R15: an economics refusal is shown as refused, with the node and economics' code", () => {
  it("a missing unit gross, a gross below the quote, and an agreement refusal each render as refused (Layer C), never a re-quote", () => {
    const ASOF = "2026-09-24T16:00:00.000Z";
    const split: EconomicsBinding["splitNet"] = () => ({ ok: false, code: "unused" });
    const cases: Array<[EconomicsBinding, { stage: string; reason: string; nodeId?: string; codes?: string[] }]> = [
      [{ unitGross: () => ({ ok: true, gross: { print: 7_000_000n } }), splitNet: split }, { stage: "economics", reason: "unit-gross-missing", nodeId: "mail" }],
      [{ unitGross: () => ({ ok: true, gross: { print: 6_000_000n, mail: 3_250_000n } }), splitNet: split }, { stage: "economics", reason: "quote-not-covered", nodeId: "print" }],
      [{ unitGross: () => ({ ok: false, code: "economics:SCHEMA_INVALID" }), splitNet: split }, { stage: "economics", reason: "agreement-refused", codes: ["economics:SCHEMA_INVALID"] }],
    ];
    for (const [economics, refusalView] of cases) {
      const outcome = acceptExternalPlan(agentDag(), CTX, { ...world().deps, economics });
      const p = presentPlan({ submission: agentDag(), outcome, asOf: ASOF });
      expect([p.layer, p.state]).toEqual(["C", "refused"]);
      expect(p.refusal).toEqual(refusalView);
    }
  });
});

describe("round 2 of #356 (astra review of a16095a5): capture order, and a snapshot that keeps no two values encoded alike", () => {
  type Revalidation = SeamDeps["revalidation"];
  /** Swap every nested R10 dependency for a fabricated one: any effect would change the outcome. */
  const swapR10 = (rv: Revalidation) => {
    const m = rv as { -readonly [K in keyof Revalidation]: Revalidation[K] };
    m.loadCapabilities = () => [];
    m.loadKernels = () => [];
    m.csdForType = () => null;
  };

  it("A: a submission getter that would swap a nested R10 dependency never runs (round 3: refused)", () => {
    const { deps } = world();
    const loadCapabilities = deps.revalidation.loadCapabilities;
    let runs = 0;
    const dag = agentDag();
    Object.defineProperty(dag, "requestId", {
      enumerable: true,
      get: () => {
        runs++;
        swapR10(deps.revalidation);
        return "req-42";
      },
    });
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(runs).toBe(0);
    expect(deps.revalidation.loadCapabilities).toBe(loadCapabilities);
  });

  it("A: a reservation callback that swaps a nested R10 dependency changes nothing", () => {
    const baseline = acceptExternalPlan(agentDag(), CTX, world().deps);
    const { deps } = world();
    const sneaky: SeamDeps = {
      ...deps,
      loadReservation: (id) => {
        swapR10(deps.revalidation); // the same object sneaky.revalidation points at
        return deps.loadReservation(id);
      },
    };
    expect(acceptExternalPlan(agentDag(), CTX, sneaky)).toEqual(baseline);
  });

  it("C: a submission getter cannot become the reservation's owner by editing the authenticated principal (round 3: it never runs)", () => {
    const ctx: { principal: string; tenantId?: string | null } = { principal: "agent:intruder" };
    let runs = 0;
    const dag = agentDag();
    Object.defineProperty(dag, "requestId", {
      enumerable: true,
      get: () => {
        runs++;
        ctx.principal = CTX.principal;
        return "req-42";
      },
    });
    expect(refusal(acceptExternalPlan(dag, ctx, world().deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(runs).toBe(0);
    expect(ctx.principal).toBe("agent:intruder");
    // Control: without the getter, the intruder is still not the owner.
    expect(refusal(acceptExternalPlan(agentDag(), ctx, world().deps))).toEqual({ stage: "reservation", reason: "wrong-principal" });
  });

  it("C: a submission getter cannot switch the tenant to see another tenant's capability", () => {
    const { deps } = world();
    const scoped: SeamDeps = {
      ...deps,
      revalidation: {
        ...deps.revalidation,
        loadCapabilities: (ids) => deps.revalidation.loadCapabilities(ids).map((c) => (c.id === "cap-print" ? { ...c, tenantId: "tenant-2" } : c)),
      },
    };
    // Control: the tenant matters. Acting for tenant-2 sees the capability; acting for tenant-1 does not.
    expect(acceptExternalPlan(agentDag(), { principal: CTX.principal, tenantId: "tenant-2" }, scoped).ok).toBe(true);
    const asTenant1 = acceptExternalPlan(agentDag(), { principal: CTX.principal, tenantId: "tenant-1" }, scoped);
    expect(asTenant1.ok === false && asTenant1.verdicts?.find((v) => v.nodeId === "print")).toEqual({ nodeId: "print", status: "missing", reason: "capability-not-found" });
    const ctx: { principal: string; tenantId?: string | null } = { principal: CTX.principal, tenantId: "tenant-1" };
    let runs = 0;
    const dag = agentDag();
    Object.defineProperty(dag, "requestId", {
      enumerable: true,
      get: () => {
        runs++;
        ctx.tenantId = "tenant-2";
        return "req-42";
      },
    });
    // Round 3: the getter never runs, so the tenant is never switched.
    expect(refusal(acceptExternalPlan(dag, ctx, scoped))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(runs).toBe(0);
    expect(ctx.tenantId).toBe("tenant-1");
  });

  it("A: an R10 callable that is not a function is a wiring fault raised BEFORE any submission property is read", () => {
    const { deps } = world();
    let reads = 0;
    const dag = agentDag();
    Object.defineProperty(dag, "requestId", {
      enumerable: true,
      get: () => {
        reads++;
        return "req-42";
      },
    });
    for (const key of ["loadCapabilities", "loadKernels", "csdForType"] as const) {
      const broken = { ...deps, revalidation: { ...deps.revalidation, [key]: "not a function" } } as unknown as SeamDeps;
      expect(() => acceptExternalPlan(dag, CTX, broken)).toThrow(/revalidation as \{ loadCapabilities, loadKernels, csdForType \}/);
    }
    expect(reads).toBe(0);
  });

  it("A: the pinned R10 dependencies keep their original receiver (method-style loaders still work)", () => {
    const { deps } = world();
    class Live {
      constructor(private readonly base: SeamDeps["revalidation"]) {}
      loadCapabilities(ids: string[]) {
        return this.base.loadCapabilities(ids);
      }
      loadKernels(ids: string[]) {
        return this.base.loadKernels(ids);
      }
      csdForType(t: string) {
        return this.base.csdForType(t);
      }
    }
    const baseline = acceptExternalPlan(agentDag(), CTX, deps);
    expect(acceptExternalPlan(agentDag(), CTX, { ...deps, revalidation: new Live(deps.revalidation) })).toEqual(baseline);
  });

  it("B: a symbol is NOT_DATA and -0 is 0 in the snapshot, so the digest never collides on them; distinct values still differ", () => {
    const withSymbol = snapshotSubmission({ ...agentDag(), requestId: Symbol("x") as unknown as string })!;
    const withObject = snapshotSubmission({ ...agentDag(), requestId: {} as unknown as string })!;
    expect(withSymbol.requestId).toBe(withObject.requestId); // one owned NOT_DATA
    expect(submissionDigest(withSymbol)).toBe(submissionDigest(withObject));
    const withPrice = (price: unknown) => ({ ...agentDag(), nodes: [{ ...agentDag().nodes[0]!, price: price as string }, agentDag().nodes[1]!] });
    const negative = snapshotSubmission(withPrice(-0))!;
    const positive = snapshotSubmission(withPrice(0))!;
    expect(Object.is(negative.nodes[0]!.price, 0)).toBe(true);
    expect(submissionDigest(negative)).toBe(submissionDigest(positive));
    const digests = [withPrice(0), withPrice("0"), withPrice(null), withPrice(undefined)].map((d) => submissionDigest(snapshotSubmission(d)!));
    expect(new Set(digests).size).toBe(4);
  });
});

describe("astra, round 3 of #356: no caller code runs inside the seam", () => {
  /** A method-style R10 whose rows live on its receiver, as in astra's reproduction. */
  function methodStyleWorld() {
    const { deps } = world();
    const counts = { loadCapabilities: 0, loadReservation: 0 };
    const rv = {
      capabilityRows: LIVE_CAPS,
      loadCapabilities(this: { capabilityRows: LiveCapability[] }, ids: string[]) {
        counts.loadCapabilities++;
        return this.capabilityRows.filter((c) => ids.includes(c.id));
      },
      loadKernels: (ids: string[]) => LIVE_KERNELS.filter((k) => ids.includes(k.id)),
      csdForType: (t: string) => CSD_OF_TYPE[t] ?? null,
    };
    const load = deps.loadReservation;
    const d: SeamDeps = { ...deps, revalidation: rv, loadReservation: (id) => (counts.loadReservation++, load(id)) };
    return { deps: d, rv, counts };
  }
  /** The live rows as a forger would like them: print at 0.01 instead of 6.50. */
  const FORGED: LiveCapability[] = LIVE_CAPS.map((c) =>
    c.id === "cap-print" ? { ...c, pricing: { currency: "USDC", baseCost: "0.01", minimum: "0.01" } } : c,
  );
  /** A plan that claims print at 0.01: stale against the real rows. */
  const cheapPrint = (): ExternalPlanSubmission => {
    const dag = agentDag();
    (dag.nodes[1] as { price: string }).price = "0.01";
    return dag;
  };

  it("a submission getter that rewrites a loader's receiver state is refused before anything runs", () => {
    const honest = methodStyleWorld();
    const baseline = acceptExternalPlan(cheapPrint(), CTX, honest.deps);
    expect(baseline.ok).toBe(false); // the real rows say 6.50
    const { deps, rv, counts } = methodStyleWorld();
    let getterRuns = 0;
    const dag = cheapPrint();
    Object.defineProperty(dag, "requestId", {
      enumerable: true,
      get: () => {
        getterRuns++;
        rv.capabilityRows = FORGED;
        return "req-42";
      },
    });
    const r = acceptExternalPlan(dag, CTX, deps);
    expect(getterRuns).toBe(0);
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts).toEqual({ loadCapabilities: 0, loadReservation: 0 });
  });

  it("a Proxy submission is refused without invoking a single trap", () => {
    const { deps, counts } = methodStyleWorld();
    let traps = 0;
    const target = agentDag();
    const dag = new Proxy(target, {
      get: (t, k, r) => (traps++, Reflect.get(t, k, r)),
      getOwnPropertyDescriptor: (t, k) => (traps++, Reflect.getOwnPropertyDescriptor(t, k)),
      ownKeys: (t) => (traps++, Reflect.ownKeys(t)),
      getPrototypeOf: (t) => (traps++, Reflect.getPrototypeOf(t)),
    });
    const r = acceptExternalPlan(dag, CTX, deps);
    expect(traps).toBe(0);
    expect(refusal(r)).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts).toEqual({ loadCapabilities: 0, loadReservation: 0 });
  });

  it("a getter nested in a node's execution inputs is refused and never runs", () => {
    const { deps, rv, counts } = methodStyleWorld();
    let runs = 0;
    const dag = cheapPrint();
    const inputs: Record<string, unknown> = {};
    Object.defineProperty(inputs, "pages", {
      enumerable: true,
      get: () => {
        runs++;
        rv.capabilityRows = FORGED;
        return 2;
      },
    });
    (dag.nodes[1] as { inputs?: unknown }).inputs = inputs;
    const r = acceptExternalPlan(dag, CTX, deps);
    expect(runs).toBe(0);
    expect(refusal(r)).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  });

  it("an accessor inside an execution-JSON array is refused and never runs", () => {
    const { deps, counts } = methodStyleWorld();
    let runs = 0;
    const dag = agentDag();
    const list: unknown[] = [1, 2];
    Object.defineProperty(list, 0, { enumerable: true, get: () => (runs++, 1) });
    (dag.nodes[1] as { inputs?: unknown }).inputs = { list };
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(runs).toBe(0);
    expect(counts.loadCapabilities).toBe(0);
  });

  it("an array with another prototype is never read", () => {
    const { deps, counts } = methodStyleWorld();
    class Edges extends Array {}
    const dag = agentDag();
    const edges = Edges.from(dag.edges) as unknown as ExternalPlanSubmission["edges"];
    expect(acceptExternalPlan({ ...dag, edges }, CTX, deps).ok).toBe(false);
    expect(counts.loadCapabilities).toBe(0);
  });

  it("caller data nested deeper than the copy's bound is refused before anything runs", () => {
    const { deps, counts } = methodStyleWorld();
    const dag = agentDag();
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    (dag.nodes[1] as { inputs?: unknown }).inputs = deep;
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  });

  it("caller data holding more values than the copy's bound is refused before anything runs", () => {
    const { deps, counts } = methodStyleWorld();
    const dag = agentDag();
    // Each list is within the length bound; together they exceed the value bound.
    (dag.nodes[1] as { inputs?: unknown }).inputs = { a: new Array(600_000).fill(0), b: new Array(600_000).fill(0) };
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  });

  it("a list whose length exceeds the copy's bound is refused without walking it", () => {
    const { deps, counts } = methodStyleWorld();
    const dag = agentDag();
    (dag.nodes[1] as { inputs?: unknown }).inputs = { holes: new Array(2 ** 31) };
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  });

  it("a symbol-keyed property in caller data is refused: JSON never produces one, and a skipped key goes uncounted (astra, round 4 of #356)", () => {
    const { deps, counts } = methodStyleWorld();
    const dag = agentDag();
    (dag.nodes[1] as { inputs?: unknown }).inputs = { pages: 1, [Symbol("extra")]: 2 };
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  });

  it("a plain object wider than the copy's bound in symbol keys is refused (astra, round 4 of #356)", () => {
    const { deps, counts } = methodStyleWorld();
    const dag = agentDag();
    const wide: Record<symbol, number> = {};
    for (let i = 0; i <= 1_000_000; i++) wide[Symbol()] = 0;
    (dag.nodes[1] as { inputs?: unknown }).inputs = wide;
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  }, 120_000);

  it("a plain object wider than the copy's bound in string keys is refused (astra, round 4 of #356)", () => {
    const { deps, counts } = methodStyleWorld();
    const dag = agentDag();
    const wide: Record<string, number> = {};
    for (let i = 0; i <= 1_000_000; i++) wide[`k${i}`] = 0;
    (dag.nodes[1] as { inputs?: unknown }).inputs = wide;
    expect(refusal(acceptExternalPlan(dag, CTX, deps))).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  }, 120_000);

  it("a getter on a node field is refused and never runs", () => {
    const { deps, counts } = methodStyleWorld();
    let runs = 0;
    const dag = agentDag();
    Object.defineProperty(dag.nodes[0], "price", { enumerable: true, get: () => (runs++, "3.25") });
    const r = acceptExternalPlan(dag, CTX, deps);
    expect(runs).toBe(0);
    expect(refusal(r)).toMatchObject({ stage: "submission", reason: "malformed-submission" });
    expect(counts.loadCapabilities).toBe(0);
  });

  it("a class-instance submission is refused: only plain data is read", () => {
    class Dag {
      constructor(readonly requestId: string, readonly reservationId: string, readonly nodes: unknown[], readonly edges: unknown[]) {}
    }
    const src = agentDag();
    const r = acceptExternalPlan(new Dag(src.requestId, src.reservationId, src.nodes, src.edges) as unknown as ExternalPlanSubmission, CTX, methodStyleWorld().deps);
    expect(refusal(r)).toMatchObject({ stage: "submission", reason: "malformed-submission" });
  });

  it("an accessor in the authenticated context never runs, and the request is refused", () => {
    const { deps, counts } = methodStyleWorld();
    let runs = 0;
    const ctx = {} as { principal: string };
    Object.defineProperty(ctx, "principal", { enumerable: true, get: () => (runs++, "agent:buyer-1") });
    const r = acceptExternalPlan(agentDag(), ctx, deps);
    expect(runs).toBe(0);
    expect(r.ok).toBe(false);
    expect(counts.loadCapabilities).toBe(0);
  });
});
