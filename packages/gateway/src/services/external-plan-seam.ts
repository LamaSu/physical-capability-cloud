/**
 * The accept seam for an externally authored plan: reconciliation R9's pure part, chaining
 * R10 (live re-read) -> R11 (server-resolved programs, evidence's gate) -> R12 (the compiler).
 *
 *   agent DAG (claims) --R10--> live terms --R11--> programs --> AcceptedPlanInput --R12--> accepted deal
 *                                  reservation (durable, server-issued) ---^            (acceptedDealDigest)
 *
 * The agent supplies only the plan's SHAPE (nodes, edges), what it believes each node costs, and the
 * tier it buys each node at. Every other settlement term is the server's: operator and payout
 * address, gross, currency, program, evidence requirements, payer, fee, reclaim time, and the plan id
 * itself (derived from the reservation, so a caller cannot choose job ids that collide with another
 * plan's). The tier is the principal's purchase choice, constrained twice: R10 admits only a tier
 * the live row offers, and the reservation's `minTier`, when it carries one, is a floor — a delegated
 * agent cannot spend money the payer authorized for tier 2 on tier-0 work (invariant 11).
 *
 * This module performs no I/O: every read is an injected dependency, so the accept decision is a pure
 * function of (submission, principal, live state). The route (R9; it needs R28 money scopes) calls it
 * and then, in ONE transaction, consumes the reservation while sealing `plan.acceptedDealDigest` (R13).
 * The reservation checks here are an early pre-check; the consume must re-check them atomically and
 * RECOMPUTE the digest from the plan it encodes (the #351 consumer contract).
 */

import {
  compileAcceptedPlan,
  type Address,
  type CompileViolation,
  type CompiledAcceptedPlan,
  type EvidenceRequirement,
  type ProgramGate,
} from "@pcc/spec";
import {
  revalidatePlanSnapshots,
  type NodeVerdict,
  type ResolvedNodeTerms,
  type RevalidationDeps,
  type SnapshotClaim,
} from "./plan-snapshot-revalidation.js";

/** A node as the agent submits it: its R10 claim, plus an optional program it expects. */
export interface ExternalPlanNode extends SnapshotClaim {
  /** Optional cross-check. The program itself is always resolved server-side. */
  committedProgramHash?: string | null;
}

export interface ExternalPlanSubmission {
  requestId: string;
  /** The server-issued reservation (R13) this plan is to be funded from. */
  reservationId: string;
  nodes: ExternalPlanNode[];
  edges: Array<{ from: string; to: string }>;
}

/** What the R13 store returns for a reservation. The table itself is operator decision #2240. */
export interface ReservationRecord {
  reservationId: string;
  principal: string;
  requestId: string;
  currency: string;
  maxAmountBaseUnits: bigint;
  /** Unix seconds. */
  expiresAt: number;
  state: "issued" | "consumed" | "expired" | "released";
  /** The principal's paying wallet, recorded when the reservation was issued. */
  payer: Address;
  /** Optional floor: the lowest assurance tier the payer authorized this money for. */
  minTier?: number;
}

/** Server fee and timing policy. Never taken from the caller. */
export interface SettlementPolicy {
  feeBps: number;
  feeRecipient: Address;
  /** Seconds after acceptance at which the payer may reclaim an unsettled unit. */
  reclaimAfterSec: number;
}

export interface SeamDeps {
  revalidation: RevalidationDeps;
  /** R11: the program for (csd, tier), e.g. evidence's `resolveAcceptedProgram`; null when none. */
  resolveProgram(csd: string, tierKey: string): string | null;
  /** R11: evidence's `assertAcceptedProgramForTier`, bound to the CSD lookup. */
  assertProgramForTier: ProgramGate;
  /** The evidence requirements of a CSD tier (evidence owns this mapping); null when the tier has none. */
  evidenceFor(csd: string, tierKey: string): EvidenceRequirement[] | null;
  /** R13: a read of the durable reservation store. */
  loadReservation(reservationId: string): ReservationRecord | null;
  policy: SettlementPolicy;
  /** Unix seconds. */
  now(): number;
}

export interface SeamContext {
  /** The authenticated principal (from the route's auth, never from the body). */
  principal: string;
  tenantId?: string | null;
}

export type SeamRefusal =
  | { stage: "submission"; reason: "malformed-submission" }
  | {
      stage: "reservation";
      reason: "not-found" | "not-issued" | "expired" | "wrong-principal" | "wrong-request";
    }
  | { stage: "revalidation"; verdicts: NodeVerdict[] }
  | { stage: "currency"; nodeId: string; reason: "node-currency-differs-from-reservation" }
  | { stage: "tier"; nodeId: string; reason: "below-reservation-minimum" }
  | { stage: "program"; nodeId: string; reason: "claimed-program-mismatch" }
  | { stage: "evidence"; nodeId: string; reason: "no-evidence-contract-for-tier" }
  | { stage: "compile"; violations: CompileViolation[] };

export type SeamResult =
  | { ok: true; plan: CompiledAcceptedPlan; resolved: ResolvedNodeTerms[] }
  | { ok: false; refusal: SeamRefusal };

/** The plan id is derived from the reservation: one reservation, one plan, and no caller-chosen job ids. */
export function planIdForReservation(reservationId: string): string {
  return `plan.${reservationId}`;
}

export function acceptExternalPlan(sub: ExternalPlanSubmission, ctx: SeamContext, deps: SeamDeps): SeamResult {
  if (
    !sub ||
    typeof sub.requestId !== "string" ||
    typeof sub.reservationId !== "string" ||
    !Array.isArray(sub.nodes) ||
    !Array.isArray(sub.edges)
  ) {
    return { ok: false, refusal: { stage: "submission", reason: "malformed-submission" } };
  }

  // Authority first: the reservation is the server's record, read from the durable store. The id in
  // the submission is only a lookup key; authority is the stored record plus the authenticated
  // principal, and an empty principal matches nothing.
  const principal = ctx?.principal;
  if (typeof principal !== "string" || principal.length === 0) {
    return refuse({ stage: "reservation", reason: "wrong-principal" });
  }
  const resv = deps.loadReservation(sub.reservationId);
  if (!resv) return refuse({ stage: "reservation", reason: "not-found" });
  if (resv.principal !== principal) return refuse({ stage: "reservation", reason: "wrong-principal" });
  if (resv.requestId !== sub.requestId) return refuse({ stage: "reservation", reason: "wrong-request" });
  if (resv.state !== "issued") return refuse({ stage: "reservation", reason: "not-issued" });
  // Whole seconds (a `Date.now() / 1000` clock must not make BigInt throw). A broken clock is a
  // server fault: throw rather than let NaN compare as "not expired".
  const now = Math.floor(deps.now());
  if (!Number.isFinite(now)) throw new TypeError("acceptExternalPlan: deps.now() must return finite unix seconds");
  if (resv.expiresAt <= now) return refuse({ stage: "reservation", reason: "expired" });

  // R10: every claim against the live rows. Anything but `current` everywhere is refused with the
  // verdicts (a stale verdict carries the re-quote the agent can re-submit against).
  const revalidated = revalidatePlanSnapshots(sub.nodes, deps.revalidation, { tenantId: ctx.tenantId ?? null });
  if (!revalidated.ok) {
    return refuse({ stage: "revalidation", verdicts: revalidated.verdicts.filter((v) => v.status !== "current") });
  }
  const resolved = revalidated.verdicts.map((v) => (v as Extract<NodeVerdict, { status: "current" }>).resolved);
  const claimed = new Map(sub.nodes.map((n) => [n.nodeId, n]));

  const nodes = [];
  for (const r of resolved) {
    if (r.currency !== resv.currency) {
      return refuse({ stage: "currency", nodeId: r.nodeId, reason: "node-currency-differs-from-reservation" });
    }
    if (resv.minTier !== undefined && !(r.tier >= resv.minTier)) {
      return refuse({ stage: "tier", nodeId: r.nodeId, reason: "below-reservation-minimum" });
    }
    // R11: the program is the server's for (csd, tier). A claimed one is only a cross-check.
    const program = r.tier === 0 ? null : deps.resolveProgram(r.csd, r.tierKey);
    const claim: unknown = claimed.get(r.nodeId)!.committedProgramHash;
    if (claim !== undefined) {
      if (claim !== null && typeof claim !== "string") return refuse({ stage: "submission", reason: "malformed-submission" });
      if ((claim?.toLowerCase() ?? null) !== (program?.toLowerCase() ?? null)) {
        return refuse({ stage: "program", nodeId: r.nodeId, reason: "claimed-program-mismatch" });
      }
    }
    const evidence = deps.evidenceFor(r.csd, r.tierKey);
    if (!evidence) return refuse({ stage: "evidence", nodeId: r.nodeId, reason: "no-evidence-contract-for-tier" });
    nodes.push({
      nodeId: r.nodeId,
      capabilityId: r.capabilityId,
      capabilityType: r.capabilityType,
      csd: r.csd,
      tierKey: r.tierKey,
      operator: r.operator,
      payoutAddress: r.payoutAddress,
      grossBaseUnits: r.grossBaseUnits,
      matchedCapabilityDigest: r.matchedCapabilityDigest,
      committedProgramHash: program, // null here at a non-zero tier is refused by the compiler
      evidenceRequirements: evidence,
    });
  }

  // R12: the deterministic compile. The compiler re-checks the reservation's request, currency and
  // ceiling, gates every non-zero tier through evidence's program check, and seals the whole deal.
  const compiled = compileAcceptedPlan(
    {
      planId: planIdForReservation(resv.reservationId),
      requestId: sub.requestId,
      payer: resv.payer,
      currency: resv.currency,
      feeBps: deps.policy.feeBps,
      feeRecipient: deps.policy.feeRecipient,
      reclaimAt: BigInt(now) + BigInt(deps.policy.reclaimAfterSec),
      nodes,
      edges: sub.edges.map((e) => ({ from: e?.from, to: e?.to })),
      reservation: {
        reservationId: resv.reservationId,
        requestId: resv.requestId,
        currency: resv.currency,
        maxAmountBaseUnits: resv.maxAmountBaseUnits,
      },
    },
    { assertProgramForTier: deps.assertProgramForTier },
  );
  if (!compiled.ok) return refuse({ stage: "compile", violations: compiled.violations });
  return { ok: true, plan: compiled.plan, resolved };
}

function refuse(refusal: SeamRefusal): SeamResult {
  return { ok: false, refusal };
}
