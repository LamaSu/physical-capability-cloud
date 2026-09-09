/**
 * Plan card — the display-ready shape a front end (the Runtype Persona widget)
 * renders as the step-3 "here's the plan" confirmation, WITHOUT re-deriving
 * anything from the raw decompose JSON.
 *
 * The decomposer emits a `DecompositionResult` full of node ids, dependency
 * arrays, and match internals. A chat UI should show: the legs in plain
 * language, the total, the ETA, whether it can actually be committed, and — if
 * not — WHY, in words a person can act on. This module is that projection.
 *
 * It is a PURE function over the decompose output. It invents nothing: every
 * price and name comes from a matched capability; an unmatched leg is reported
 * as unfulfillable rather than shown with a plausible placeholder price (the
 * UNMATCHED_UNIT_COST=10 trap — a matched-looking number on a leg nothing
 * matched). `committable` mirrors the composition commitment guard exactly, so
 * the card never invites a user to confirm a plan the money path will refuse.
 */

import type { DecompositionResult, CapabilityNode } from "@pcc/spec";

export interface PlanLeg {
  /** Stable id, for the UI to key on — not shown to the user. */
  id: string;
  /** Human title, e.g. "Print your document". */
  title: string;
  /** One line of what happens. */
  detail: string;
  /** Was a real provider matched for this leg? */
  matched: boolean;
  /** Provider name when matched (e.g. "Mail Drop (USPS acceptance)"). */
  provider: string | null;
  /** Fixed-precision price string, e.g. "5.00". Null when unmatched. */
  price: string | null;
  currency: string;
  /** Rough hours for this leg. */
  etaHours: number;
  /** Ordered predecessor leg ids (for a UI that draws the flow). */
  after: string[];
}

export interface PlanCard {
  legs: PlanLeg[];
  /** Sum of MATCHED leg prices only, fixed-precision. */
  total: string;
  currency: string;
  /** Critical-path hours (what the user waits), not the sum of all legs. */
  etaHours: number;
  /**
   * True iff every leg matched a real capability. Mirrors the compositionRoot
   * commitment guard: an uncommittable plan must not be presented as "Confirm".
   */
  committable: boolean;
  /**
   * When not committable, the plain-language reason — the names of the legs
   * that have no provider yet. Empty when committable.
   */
  unfulfillable: string[];
  /** A ready-to-render one-liner for the UI's blocked state, or null. */
  blockedMessage: string | null;
}

function isMatched(n: CapabilityNode): boolean {
  // A leg is committable-matched only if it matched AND carries the deal digest
  // — the exact pair the commitment guard requires. matchStatus alone is not
  // enough: a matched node missing its digest is uncommittable.
  return n.matchStatus === "matched" && typeof n.matchedCapabilityDigest === "string";
}

function currencyOf(result: DecompositionResult): string {
  // The decomposer prices in one currency; read it off the first priced node,
  // default USDC. (CapabilityNode has no currency field of its own; the
  // registry capabilities the legs matched are USDC on this deployment.)
  return "USDC";
}

/** Project a decompose result into the display-ready plan card. Pure. */
export function toPlanCard(result: DecompositionResult): PlanCard {
  const currency = currencyOf(result);
  const nodes = result.nodes ?? [];

  const legs: PlanLeg[] = nodes.map((n: CapabilityNode) => {
    const matched = isMatched(n);
    return {
      id: n.id,
      title: n.name,
      detail: n.description,
      matched,
      provider: matched ? (n.matchedCapabilityName ?? n.matchedCapabilityId ?? null) : null,
      // Only a matched leg gets a price. An unmatched leg's estimatedCost is a
      // placeholder (UNMATCHED_UNIT_COST) and must NOT be shown as real money.
      price: matched ? n.estimatedCost.toFixed(2) : null,
      currency,
      etaHours: n.estimatedHours,
      after: n.dependencies ?? [],
    };
  });

  // Total = matched legs only. Never let a placeholder price into the number a
  // user is asked to approve.
  const totalNum = legs.reduce((s, l) => s + (l.price ? Number(l.price) : 0), 0);

  // ETA = the critical path, i.e. the longest dependency chain's hours, not the
  // sum (legs on parallel tracks overlap). Fall back to the max single leg when
  // the critical path is absent.
  const byId = new Map(legs.map((l) => [l.id, l]));
  let etaHours = 0;
  if (Array.isArray(result.criticalPath) && result.criticalPath.length > 0) {
    etaHours = result.criticalPath.reduce((s: number, id: string) => s + (byId.get(id)?.etaHours ?? 0), 0);
  } else {
    etaHours = legs.reduce((m, l) => Math.max(m, l.etaHours), 0);
  }

  const unfulfillable = legs.filter((l) => !l.matched).map((l) => l.title);
  const committable = legs.length > 0 && unfulfillable.length === 0;

  const blockedMessage = committable
    ? null
    : legs.length === 0
      ? "No plan could be formed for this request."
      : `Can't fulfill ${unfulfillable.length} step(s) yet — no provider for: ${unfulfillable.join(", ")}.`;

  return {
    legs,
    total: totalNum.toFixed(2),
    currency,
    etaHours: Math.round(etaHours * 10) / 10,
    committable,
    unfulfillable,
    blockedMessage,
  };
}
