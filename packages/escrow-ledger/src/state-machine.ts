/**
 * Explicit session state machine.
 *
 * States:
 *   created → configuring → quoted → reviewing → committed → executing → settled
 *
 * Plus error states reachable from most points:
 *   cancelled (terminal, soft-fail)
 *   disputed  (recoverable: → settled or → cancelled)
 *
 * Why explicit, not derived from a few flags?
 *  - The ledger's invariants depend on transitions (you cannot release
 *    funds from a session that hasn't reached "committed").
 *  - Future Postgres adapter will index sessions by state column.
 *  - Centralized substrate explicitly mirrors the on-chain enum so the
 *    eventual bridge between them stays trivial.
 */

import type { Session, SessionState } from "./types.js";
import { SessionStateSchema } from "./types.js";

export type TransitionEvent =
  | "configure"
  | "quote"
  | "review"
  | "commit"
  | "start_execution"
  | "settle"
  | "cancel"
  | "raise_dispute"
  | "resolve_dispute_in_favor_of_user"
  | "resolve_dispute_in_favor_of_operator";

const TRANSITIONS: Readonly<Record<SessionState, Partial<Record<TransitionEvent, SessionState>>>> = {
  created: {
    configure: "configuring",
    cancel: "cancelled",
  },
  configuring: {
    quote: "quoted",
    cancel: "cancelled",
  },
  quoted: {
    review: "reviewing",
    configure: "configuring", // back-edge: user changes their mind on selections
    cancel: "cancelled",
  },
  reviewing: {
    commit: "committed",
    configure: "configuring", // back-edge from review
    cancel: "cancelled",
  },
  committed: {
    start_execution: "executing",
    cancel: "cancelled",
  },
  executing: {
    settle: "settled",
    raise_dispute: "disputed",
    cancel: "cancelled",
  },
  disputed: {
    resolve_dispute_in_favor_of_user: "cancelled",
    resolve_dispute_in_favor_of_operator: "settled",
  },
  settled: {},
  cancelled: {},
};

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(["settled", "cancelled"]);

/** Public read-only view of valid transitions for a state. */
export function validTransitions(state: SessionState): TransitionEvent[] {
  return Object.keys(TRANSITIONS[state] ?? {}) as TransitionEvent[];
}

/** Whether a state is terminal (no further transitions). */
export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Apply a transition. Returns the new session, or throws on invalid transition. */
export function transition(session: Session, event: TransitionEvent, now?: string): Session {
  const next = TRANSITIONS[session.state]?.[event];
  if (!next) {
    throw new InvalidTransitionError(session.state, event);
  }
  // Validate to ensure the new state is well-formed (defends against future
  // typos in TRANSITIONS).
  SessionStateSchema.parse(next);

  return {
    ...session,
    state: next,
    updatedAt: now ?? new Date().toISOString(),
  };
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly event: TransitionEvent,
  ) {
    super(`Invalid transition: cannot fire "${event}" from state "${from}"`);
    this.name = "InvalidTransitionError";
  }
}
