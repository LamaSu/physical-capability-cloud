/**
 * Job-offer actor authorization, shared by /api/job-offers and the legacy
 * /api/courier-jobs shim (kits K0 slice 2; board rule 7).
 *
 * A claim and every progress event are bound to the AUTHENTICATED principal:
 * the API key's operatorId or the SIWE session's userId. Never a body field
 * (`kernelId`, `by`, `driverAgent`) and never the legacy X-Posted-By header,
 * which a caller can set to anything. A missing actor fails closed.
 *
 * Who may post which event (N81 product rules; kits #3989, composition #4063):
 *   - in_progress, pickup, delivered, release: the claimant only. "delivered" is
 *     the claimant's ASSERTION, never success; "release" hands the offer back to
 *     open before delivery (a claimant's cancel);
 *   - cancelled, confirmed, disputed: the poster only. Only the poster ends an
 *     offer, and only the poster's "confirmed" makes a delivery a success;
 *   - settled: the server only (a linked job's evidence-path settlement). Every
 *     caller is refused, so a route answers 409;
 *   - everything else (note, progress_update, error, heartbeat, ...): the
 *     claimant or the poster.
 * The state machine (which transitions are valid) is composition's, in
 * JobOffersStore.recordEvent; this module only decides WHO may post.
 *
 * Recorded events carry the actor's ROLE ("claimant" | "poster") as `by`, not
 * the operatorId: offers and their event logs are publicly readable, and an
 * operatorId can be an email address.
 */

import { sameIdentity } from "../auth/actor.js";

/** Events that move an offer forward, or hand it back. Only the claimant may post them. */
export const CLAIMANT_ONLY_EVENTS: ReadonlySet<string> = new Set(["in_progress", "pickup", "delivered", "release"]);

/** Events that end or judge an offer. Only the poster may post them. */
export const POSTER_ONLY_EVENTS: ReadonlySet<string> = new Set(["cancelled", "confirmed", "disputed"]);

/** Events only the server records. No caller may post them. */
export const SERVER_ONLY_EVENTS: ReadonlySet<string> = new Set(["settled"]);

export type OfferEventDecision =
  | { ok: true; role: "claimant" | "poster" }
  | { ok: false; reason: "not_claimed" | "not_participant" | "server_only" };

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
  if (SERVER_ONLY_EVENTS.has(event)) return { ok: false, reason: "server_only" };
  const isClaimant = sameIdentity(actor, claimant);
  if (CLAIMANT_ONLY_EVENTS.has(event)) {
    if (!claimant) return { ok: false, reason: "not_claimed" };
    return isClaimant ? { ok: true, role: "claimant" } : { ok: false, reason: "not_participant" };
  }
  if (POSTER_ONLY_EVENTS.has(event)) {
    return sameIdentity(actor, poster) ? { ok: true, role: "poster" } : { ok: false, reason: "not_participant" };
  }
  if (isClaimant) return { ok: true, role: "claimant" };
  if (sameIdentity(actor, poster)) return { ok: true, role: "poster" };
  return { ok: false, reason: "not_participant" };
}
