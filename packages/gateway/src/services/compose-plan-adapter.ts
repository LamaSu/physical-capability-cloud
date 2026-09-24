/**
 * The server composer as ONE planner among many (reconciliation R9; product pack section 5, "SERVER
 * COMPOSER"): `/api/compose` output enters the same acceptance seam as any external agent's plan. It
 * is never canonical and gets no shortcut.
 *
 * This adapter only restates a `ComposeResponse` as the claims an agent would submit. Every claimed
 * value — including the composer's float `estimatedPriceUSD` — is then re-read and compared by R10
 * like anyone else's, so a composer that drifted from the live rows gets `stale` verdicts and a
 * re-quote, never an accepted deal on its own say-so.
 */

import type { ComposeResponse } from "@pcc/spec";
import type { ExternalPlanNode, ExternalPlanSubmission } from "./external-plan-seam.js";

export type ComposeAdapterRefusal =
  | { reason: "not-proposed"; status: string }
  | { reason: "proposal-expired" }
  | { reason: "malformed-proposal" };

export type ComposeAdapterResult =
  | { ok: true; submission: ExternalPlanSubmission }
  | { ok: false; refusal: ComposeAdapterRefusal };

/** The stable node id of a composer step. */
export function composeStepNodeId(index: number): string {
  return `step-${index}`;
}

/**
 * Restate a composer proposal as a plan submission. `currency` is the settlement token the caller
 * expects the composer's USD figures to be priced in; R10 checks it against each live row.
 */
export function submissionFromComposeResponse(
  res: ComposeResponse,
  args: { requestId: string; reservationId: string; currency: string; nowMs: number },
): ComposeAdapterResult {
  if (!res || !Array.isArray(res.steps)) return { ok: false, refusal: { reason: "malformed-proposal" } };
  if (res.status !== "proposed") return { ok: false, refusal: { reason: "not-proposed", status: String(res.status) } };
  const expires = Date.parse(res.expiresAt);
  if (!Number.isFinite(expires) || expires <= args.nowMs) return { ok: false, refusal: { reason: "proposal-expired" } };

  const indices = new Set<number>();
  for (const s of res.steps) {
    if (!s || !Number.isInteger(s.index) || s.index < 0 || indices.has(s.index)) {
      return { ok: false, refusal: { reason: "malformed-proposal" } };
    }
    indices.add(s.index);
  }
  const nodes: ExternalPlanNode[] = [];
  const edges: Array<{ from: string; to: string }> = [];
  for (const s of res.steps) {
    if (!Array.isArray(s.dependsOn) || typeof s.estimatedPriceUSD !== "number") {
      return { ok: false, refusal: { reason: "malformed-proposal" } };
    }
    nodes.push({
      nodeId: composeStepNodeId(s.index),
      capabilityId: s.capabilityId,
      capabilityType: s.capabilityType,
      kernelId: s.kernelId,
      operator: s.operatorAddress,
      // The composer's belief, verbatim. A float that is not a plain decimal ("1e-7") is refused by
      // R10 as a malformed claim; any other drift from the live row comes back as `stale`.
      price: String(s.estimatedPriceUSD),
      currency: args.currency,
      tierKey: `tier${s.assuranceTier}`,
    });
    for (const d of s.dependsOn) {
      if (!indices.has(d)) return { ok: false, refusal: { reason: "malformed-proposal" } };
      edges.push({ from: composeStepNodeId(d), to: composeStepNodeId(s.index) });
    }
  }
  return { ok: true, submission: { requestId: args.requestId, reservationId: args.reservationId, nodes, edges } };
}
