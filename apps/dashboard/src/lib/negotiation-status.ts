/**
 * Negotiation session status → badge color and pipeline position (product-qa #36; D6: money and deal
 * status go through one exact map).
 *
 * The statuses are @pcc/spec's `SessionStatus`, which are lowercase. The page used to switch on
 * uppercase words the API never sends, so every state, settlement_failed included, rendered the same
 * gray. This table is EXACT and compile-time complete: `satisfies Record<SessionStatus, …>` makes tsc
 * fail if the type gains a value.
 *   - A bare session status is never green. "committed" means funds committed with no outcome yet
 *     (the gen-UI money doctrine, #313: green comes only from a settlement read model).
 *   - settlement_failed has the failure tone.
 *   - expired and cancelled are terminal, and nothing was paid: gray.
 *   - Anything else, including a value the API should never send, is gray (fail closed).
 * NegotiationSession folds into PlanPresentation (PX-8) later; its money tone will then come from
 * that read model.
 */
import type { SessionStatus } from "@pcc/spec";

export type SessionBadgeColor = "green" | "gold" | "red" | "gray";

const SESSION_STATUS_COLOR: Readonly<Record<SessionStatus, SessionBadgeColor>> = Object.freeze({
  created: "gray",
  configuring: "gray",
  quoted: "gold",
  reviewing: "gold",
  committed: "gold",
  settlement_failed: "red",
  expired: "gray",
  cancelled: "gray",
} as const satisfies Record<SessionStatus, SessionBadgeColor>);

/** Every status the spec defines, in the order above. */
export const SESSION_STATUSES = Object.freeze(Object.keys(SESSION_STATUS_COLOR) as SessionStatus[]);

/** The pipeline's happy path. settlement_failed, expired and cancelled are off it. */
export const SESSION_PIPELINE: readonly SessionStatus[] = Object.freeze(["created", "configuring", "quoted", "reviewing", "committed"]);

/** The badge color for a status from the API. Exact keys only; anything else is gray. */
export function sessionStatusColor(status: unknown): SessionBadgeColor {
  return typeof status === "string" && Object.prototype.hasOwnProperty.call(SESSION_STATUS_COLOR, status)
    ? SESSION_STATUS_COLOR[status as SessionStatus]
    : "gray";
}

/** The pipeline step for a status: -1 for a status off the happy path, or an unknown one. */
export function sessionPipelineIndex(status: unknown): number {
  return typeof status === "string" ? SESSION_PIPELINE.indexOf(status as SessionStatus) : -1;
}
