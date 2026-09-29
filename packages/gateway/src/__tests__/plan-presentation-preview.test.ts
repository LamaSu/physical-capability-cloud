/**
 * PlanPresentation preview completeness (product pack section 5, item 6): three additive facts the
 * compiled/sealed read model was missing —
 *   (a) `assurance` per node: evidence strength actually committed, from the intact, bound plan's
 *       `canonicalPlan.assurance` ONLY (never the proposal);
 *   (b) `expiry`: the reservation's own expiry, shown only when the caller supplies a `reservation`
 *       that names THIS submission's reservation — a mismatch or malformed window is `invalid` /
 *       "plan-binding", exactly like the deal's own binding checks;
 *   (c) `unknowns`: an honest, always-present list of preview facts PCC has no trusted source for
 *       (today exactly `["time-estimate"]`) — never invented.
 *
 * Fixtures mirror external-plan-trace.test.ts's `agentDag`/`world` (same capabilities, kernels,
 * programs and evidence map) so the compiled `canonicalPlan.assurance` values are known ahead of time:
 * "print" lands at tier 2 with a committed program and two evidence requirements; "mail" lands at tier
 * 0 with no program and one evidence requirement. Those helpers are file-local to that test file (not
 * exported), so they are reproduced here rather than imported.
 */
import { describe, it, expect } from "vitest";
import type { EvidenceRequirement } from "@pcc/spec";
import { acceptExternalPlan, type ExternalPlanSubmission, type SeamDeps, type SeamResult } from "../services/external-plan-seam.js";
import type { LiveCapability, LiveKernel } from "../services/plan-snapshot-revalidation.js";
import { presentPlan, type SealRecord } from "../services/plan-presentation.js";

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const OP_PRINT = A("aa");
const OP_MAIL = A("bb");
const PAYER = A("11");
const FEE = A("fe");
const PROGRAM = `0x${"d2".repeat(32)}`;
const NOW = 1_900_000_000;
const PRINT = "document-print-and-mail";
const ASOF = "2026-09-28T00:00:00.000Z";

const RESERVATION_ID = "resv-1";
const RESERVATION_EXPIRES_AT = NOW + 3600;

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
/** Two evidence requirements for print's tier2 (order matters — asserted below), one for mail's tier0. */
const EVIDENCE: Record<string, EvidenceRequirement[]> = {
  [`${PRINT}|tier2`]: [
    { requirementId: "print.kernel-log", evidenceTypeId: "execution_completed", tier: 2 },
    { requirementId: "mail.carrier-scan", evidenceTypeId: "courier_pickup_confirmed", tier: 2 },
  ],
  "courier-route|tier0": [{ requirementId: "drop.declared", evidenceTypeId: "decl.self_attested", tier: 0 }],
};
/** print's expected assurance, exactly as the compiler must produce it from the fixtures above. */
const PRINT_ASSURANCE = {
  tier: 2,
  program: PROGRAM,
  evidence: [
    { evidenceTypeId: "execution_completed", tier: 2 },
    { evidenceTypeId: "courier_pickup_confirmed", tier: 2 },
  ],
};
const MAIL_ASSURANCE = { tier: 0, program: null, evidence: [{ evidenceTypeId: "decl.self_attested", tier: 0 }] };

const CTX = { principal: "agent:buyer-1" };

function world(now: number = NOW): SeamDeps {
  return {
    revalidation: {
      loadCapabilities: (ids) => LIVE_CAPS.filter((c) => ids.includes(c.id)),
      loadKernels: (ids) => LIVE_KERNELS.filter((k) => ids.includes(k.id)),
      csdForType: (t) => CSD_OF_TYPE[t] ?? null,
    },
    resolveProgram: (csd, tierKey) => PROGRAMS[`${csd}|${tierKey}`] ?? null,
    assertProgramForTier: ({ csd, tierKey, committedProgramHash }) =>
      committedProgramHash !== null && PROGRAMS[`${csd}|${tierKey}`] === committedProgramHash.toLowerCase()
        ? { ok: true }
        : { ok: false, code: "program-hash-mismatch" },
    evidenceFor: (csd, tierKey) => EVIDENCE[`${csd}|${tierKey}`] ?? null,
    loadReservation: (id) =>
      id === RESERVATION_ID
        ? { reservationId: RESERVATION_ID, principal: CTX.principal, requestId: "req-42", currency: "USDC", maxAmountBaseUnits: 20_000_000n, expiresAt: RESERVATION_EXPIRES_AT, state: "issued", payer: PAYER }
        : null,
    policy: { feeBps: 235, feeRecipient: FEE, reclaimAfterSec: 7 * 24 * 3600 },
    now: () => now,
  };
}

/** The agent's plan: mail and print, print gated on a committed tier2 program. */
function agentDag(over: Partial<ExternalPlanSubmission> = {}): ExternalPlanSubmission {
  return {
    requestId: "req-42",
    reservationId: RESERVATION_ID,
    nodes: [
      { nodeId: "mail", capabilityId: "cap-mail", price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: "k-mail", operator: OP_MAIL },
      { nodeId: "print", capabilityId: "cap-print", price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: "k-print", operator: OP_PRINT, committedProgramHash: PROGRAM },
    ],
    edges: [{ from: "print", to: "mail" }],
    ...over,
  };
}

/** Accept `dag` through the real seam; throws (failing the calling test loudly) if it was refused. */
function accept(dag: ExternalPlanSubmission = agentDag()): Extract<SeamResult, { ok: true }> {
  const outcome = acceptExternalPlan(dag, CTX, world());
  if (!outcome.ok) throw new Error(`setup: expected an accepted deal, got refusal: ${JSON.stringify(outcome.refusal)}`);
  return outcome;
}

/** A seal record for `outcome`'s OWN digest — presentPlan only checks the digest matches; it needs no real store. */
function sealedRecordFor(outcome: Extract<SeamResult, { ok: true }>): SealRecord {
  return { reservationId: RESERVATION_ID, acceptedDealDigest: outcome.plan.acceptedDealDigest };
}

/** Known-good junk that external-plan-trace.test.ts already proves renders as invalid/malformed-submission. */
const MALFORMED_SUBMISSION = {
  requestId: Object.create(null),
  reservationId: 5,
  nodes: [null, { nodeId: "x", capabilityId: Object.create(null) }],
  edges: [null, { from: 1, to: "x" }],
} as unknown as ExternalPlanSubmission;

describe("PlanPresentation.assurance (item 6): evidence strength, from the canonicalPlan only", () => {
  it("a compiled node's assurance equals exactly its canonicalPlan.assurance (tier, program, evidence type+tier, same order)", () => {
    const outcome = accept();
    const p = presentPlan({ submission: agentDag(), outcome, asOf: ASOF });
    expect(p.state).toBe("compiled");

    const print = p.nodes.find((n) => n.nodeId === "print")!;
    const printBinding = outcome.plan.nodeToUnit.find((b) => b.nodeId === "print")!;
    expect(print.assurance).toEqual({
      tier: printBinding.canonicalPlan.assurance.tier,
      program: printBinding.canonicalPlan.assurance.committedProgramHash,
      evidence: printBinding.canonicalPlan.assurance.evidence.map((e) => ({ evidenceTypeId: e.evidenceTypeId, tier: e.tier })),
    });
    // Pinned to the concrete fixture values too, so a regression that changes the fixture's meaning is caught.
    expect(print.assurance).toEqual(PRINT_ASSURANCE);

    const mail = p.nodes.find((n) => n.nodeId === "mail")!;
    expect(mail.assurance).toEqual(MAIL_ASSURANCE);
  });

  it("a sealed node's assurance is unchanged from compiled", () => {
    const outcome = accept();
    const p = presentPlan({ submission: agentDag(), outcome, sealed: sealedRecordFor(outcome), asOf: ASOF });
    expect(p.state).toBe("sealed");
    expect(p.nodes.find((n) => n.nodeId === "print")!.assurance).toEqual(PRINT_ASSURANCE);
    expect(p.nodes.find((n) => n.nodeId === "mail")!.assurance).toEqual(MAIL_ASSURANCE);
  });

  it("proposed nodes have no assurance", () => {
    const p = presentPlan({ submission: agentDag(), asOf: ASOF });
    expect(p.state).toBe("proposed");
    expect(p.nodes.length).toBeGreaterThan(0);
    expect(p.nodes.every((n) => n.assurance === undefined)).toBe(true);
  });

  it("stale nodes have no assurance (only the un-stale sibling is compiled)", () => {
    const dag = agentDag();
    dag.nodes[1] = { ...dag.nodes[1]!, price: "5.00" }; // print's live price is 6.50 -> stale, needs-requote
    const outcome = acceptExternalPlan(dag, CTX, world());
    const p = presentPlan({ submission: dag, outcome, asOf: ASOF });
    expect(p.state).toBe("needs-requote");
    const print = p.nodes.find((n) => n.nodeId === "print")!;
    expect(print.state).toBe("stale");
    expect(print.assurance).toBeUndefined();
  });

  it("a caller's submission cannot inject assurance: forged assurance-like fields on the proposal have no effect", () => {
    const forged = {
      ...agentDag(),
      nodes: agentDag().nodes.map((n) => ({ ...n, assurance: { tier: 3, program: "0xdeadbeef", evidence: [{ evidenceTypeId: "forged", tier: 3 }] } })),
    } as unknown as ExternalPlanSubmission;

    const proposed = presentPlan({ submission: forged, asOf: ASOF });
    expect(proposed.nodes.length).toBeGreaterThan(0);
    expect(proposed.nodes.every((n) => n.assurance === undefined)).toBe(true);

    const outcome = accept(); // the real, UNforged dag's accepted deal
    const compiled = presentPlan({ submission: forged, outcome, asOf: ASOF });
    expect(compiled.nodes.find((n) => n.nodeId === "print")!.assurance).toEqual(PRINT_ASSURANCE); // from canonicalPlan, not the forgery
  });
});

describe("PlanPresentation.expiry (item 6): the reservation's own expiry, shown only when supplied and matching", () => {
  it("no reservation supplied -> no expiry, proposed or compiled", () => {
    const proposed = presentPlan({ submission: agentDag(), asOf: ASOF });
    expect(proposed.expiry).toBeUndefined();

    const outcome = accept();
    const compiled = presentPlan({ submission: agentDag(), outcome, asOf: ASOF });
    expect(compiled.expiry).toBeUndefined();
  });

  it("a matching reservation shows reservationExpiresAt as ISO 8601; reclaimAt appears only once compiled", () => {
    const proposed = presentPlan({ submission: agentDag(), reservation: { reservationId: RESERVATION_ID, expiresAt: RESERVATION_EXPIRES_AT }, asOf: ASOF });
    expect(proposed.state).toBe("proposed");
    expect(proposed.expiry).toEqual({ reservationExpiresAt: new Date(RESERVATION_EXPIRES_AT * 1000).toISOString() });
    expect(proposed.expiry?.reclaimAt).toBeUndefined();

    const outcome = accept();
    const compiled = presentPlan({ submission: agentDag(), outcome, reservation: { reservationId: RESERVATION_ID, expiresAt: RESERVATION_EXPIRES_AT }, asOf: ASOF });
    expect(compiled.preview).toBeDefined();
    expect(compiled.expiry).toEqual({
      reservationExpiresAt: new Date(RESERVATION_EXPIRES_AT * 1000).toISOString(),
      reclaimAt: compiled.preview!.reclaimAt,
    });
  });

  it("a reservation naming another reservation id is invalid / plan-binding, and shows no nodes", () => {
    const p = presentPlan({ submission: agentDag(), reservation: { reservationId: "resv-other", expiresAt: RESERVATION_EXPIRES_AT }, asOf: ASOF });
    expect(p.state).toBe("invalid");
    expect(p.invalid).toEqual({ reason: "plan-binding" });
    expect(p.nodes).toEqual([]);
    expect(p.expiry).toBeUndefined();
  });

  it.each([-1, 1.5, "x"])("a malformed expiresAt (%p) is invalid / plan-binding, and shows no nodes", (bad) => {
    const p = presentPlan({
      submission: agentDag(),
      reservation: { reservationId: RESERVATION_ID, expiresAt: bad as unknown as number },
      asOf: ASOF,
    });
    expect(p.state).toBe("invalid");
    expect(p.invalid).toEqual({ reason: "plan-binding" });
    expect(p.nodes).toEqual([]);
  });

  it("a null reservation is the same as no reservation: no expiry", () => {
    const p = presentPlan({ submission: agentDag(), reservation: null, asOf: ASOF });
    expect(p.state).toBe("proposed");
    expect(p.expiry).toBeUndefined();
  });
});

describe("PlanPresentation.unknowns (item 6): an honest 'we don't know' list, never invented", () => {
  it("is exactly ['time-estimate'] in every state: proposed, needs-requote, refused, compiled, sealed, invalid", () => {
    const proposed = presentPlan({ submission: agentDag(), asOf: ASOF });
    expect(proposed.state).toBe("proposed");
    expect(proposed.unknowns).toEqual(["time-estimate"]);

    const staleDag = agentDag();
    staleDag.nodes[1] = { ...staleDag.nodes[1]!, price: "5.00" };
    const needsRequote = presentPlan({ submission: staleDag, outcome: acceptExternalPlan(staleDag, CTX, world()), asOf: ASOF });
    expect(needsRequote.state).toBe("needs-requote");
    expect(needsRequote.unknowns).toEqual(["time-estimate"]);

    const refused = presentPlan({ submission: agentDag(), outcome: acceptExternalPlan(agentDag(), { principal: "agent:intruder" }, world()), asOf: ASOF });
    expect(refused.state).toBe("refused");
    expect(refused.unknowns).toEqual(["time-estimate"]);

    const outcome = accept();
    const compiled = presentPlan({ submission: agentDag(), outcome, asOf: ASOF });
    expect(compiled.state).toBe("compiled");
    expect(compiled.unknowns).toEqual(["time-estimate"]);

    const sealed = presentPlan({ submission: agentDag(), outcome, sealed: sealedRecordFor(outcome), asOf: ASOF });
    expect(sealed.state).toBe("sealed");
    expect(sealed.unknowns).toEqual(["time-estimate"]);

    const invalid = presentPlan({ submission: MALFORMED_SUBMISSION, asOf: ASOF });
    expect(invalid.state).toBe("invalid");
    expect(invalid.unknowns).toEqual(["time-estimate"]);
  });
});
