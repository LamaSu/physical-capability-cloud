/**
 * Job-offer actor authorization, shared by /api/job-offers and the legacy
 * /api/courier-jobs shim (kits K0 slice 2; board rule 7).
 *
 * A claim and every progress event are bound to the AUTHENTICATED principal:
 * the API key's operatorId or the SIWE session's userId. Never a body field
 * (`kernelId`, `by`, `driverAgent`) and never the legacy X-Posted-By header,
 * which a caller can set to anything. A missing actor fails closed.
 *
 * Who may post which event:
 *   - status-advancing events (in_progress, pickup, delivered): the claimant only;
 *   - everything else (cancelled, note, progress_update, error, ...): the
 *     claimant or the poster.
 *
 * Recorded events carry the actor's ROLE ("claimant" | "poster") as `by`, not
 * the operatorId: offers and their event logs are publicly readable, and an
 * operatorId can be an email address.
 */

import { sameIdentity } from "../auth/actor.js";

/** Events that move an offer forward. Only the claimant may post them. */
export const CLAIMANT_ONLY_EVENTS: ReadonlySet<string> = new Set(["in_progress", "pickup", "delivered"]);

export type OfferEventDecision =
  | { ok: true; role: "claimant" | "poster" }
  | { ok: false; reason: "not_claimed" | "not_participant" };

/**
 * Decide whether `actor` may post `event` on an offer.
 *
 * @param claimant the offer's authenticated claimant (null when unclaimed or
 *   claimed before claimant binding existed; such offers accept
 *   status-advancing events from nobody).
 * @param poster the offer's recorded poster (posterDid), or null.
 */
export function authorizeOfferEvent(
  event: string,
  actor: string,
  claimant: string | null,
  poster: string | null,
): OfferEventDecision {
  const isClaimant = sameIdentity(actor, claimant);
  if (CLAIMANT_ONLY_EVENTS.has(event)) {
    if (!claimant) return { ok: false, reason: "not_claimed" };
    return isClaimant ? { ok: true, role: "claimant" } : { ok: false, reason: "not_participant" };
  }
  if (isClaimant) return { ok: true, role: "claimant" };
  if (sameIdentity(actor, poster)) return { ok: true, role: "poster" };
  return { ok: false, reason: "not_participant" };
}
