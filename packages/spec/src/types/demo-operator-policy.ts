/**
 * Demo Operator Policy — policy-driven agent decisions for the vibecodenights
 * pizza demo (see packages/gateway/src/routes/pizza-demo.ts).
 *
 * IMPORTANT — this is the DEMO policy, intentionally distinct from the
 * production `OperatorPolicy` in ./operator-policy.ts. That production type is a
 * kernel-wide guardrail object (approval modes, rate limits, pricing-rule
 * stacks, smart-contract bond/challenge params) consumed by the kernel
 * policy-engine, job-submit, negotiation, paid-job-flow, etc. THIS type is a
 * small, demo-scoped object describing how one shop's / driver's *agent* reacts
 * to a single incoming job offer. They share the concept "an operator's policy"
 * but not a schema, so they live in separate files with distinct names — the
 * demo must never clobber the production policy system.
 *
 * The pure evaluator `decideOnOffer(policy, offer)` lives in the gateway route
 * (packages/gateway/src/routes/operator-policy.ts) so it can be unit-tested and
 * imported by the pizza-demo dispatch logic.
 */

/** How an operator's agent handles incoming job offers. */
export type DemoPolicyMode = "auto" | "negotiate" | "always-prompt";

/**
 * Numeric gates that drive auto / negotiate decisions. Every field is optional:
 * an unset field means "no gate of this kind".
 */
export interface DemoPolicyRules {
  /**
   * Price floor. In `auto` mode an offer below this is auto-declined; in
   * `negotiate` mode an offer below this triggers a counter-offer.
   */
  minPriceUSD?: number;
  /** Refuse (auto-decline) if the assignee already has this many jobs running. */
  maxConcurrent?: number;
  /**
   * Human-escalation ceiling. Orders priced AT OR ABOVE this prompt the human
   * even in `auto` / `negotiate` mode — they are too high-value to auto-handle.
   * Orders below it stay on the auto-accept fast-path. (Named for the accept
   * side: the agent auto-accepts orders priced *under* this USD amount.)
   */
  autoAcceptUnderUSD?: number;
  /** Refuse if the deadline (seconds from now) is tighter than this. */
  requireDeadlineMinSec?: number;
}

/** Tuning for `negotiate` mode counter-offers. */
export interface DemoPolicyNegotiation {
  /** Counter price = offered price × this. e.g. 1.2 = ask for 20% more. Default 1.2. */
  counterPriceMultiplier?: number;
  /** Give up (auto-decline) after this many counters on one assignment. Default 1. */
  maxCounterOffers?: number;
}

/** What an operator policy applies to: a capability type + a specific assignee. */
export interface DemoPolicyScope {
  /** e.g. "make-pizza" | "delivered-pizza" */
  capabilityType: string;
  /** e.g. "shop-roma" | "driver-alex" */
  assigneeSlug: string;
}

/** A single operator's agent policy. One per assignee slug in the demo. */
export interface DemoOperatorPolicy {
  policyId: string;
  ownerId: string;
  scope: DemoPolicyScope;
  mode: DemoPolicyMode;
  /** Gates for `auto` / `negotiate` mode. Ignored in `always-prompt` mode. */
  rules: DemoPolicyRules;
  /** Only consulted in `negotiate` mode. */
  negotiation?: DemoPolicyNegotiation;
  createdAt: string;
  updatedAt: string;
}

/** A job offer presented to an operator's agent for one decision. */
export interface DemoJobOffer {
  /** Capability type of the offered job, e.g. "make-pizza". */
  capabilityType: string;
  /** Offered payout to the operator, in USD. */
  priceUSD: number;
  /** Deadline in seconds from now. */
  deadlineSec: number;
  /** How many jobs the assignee already has running (accepted / in-progress). */
  currentConcurrent: number;
  /** Counter-offers already issued on this assignment (drives give-up). Default 0. */
  counterOffersSoFar?: number;
}

/** The four outcomes an operator's agent can return for an offer. */
export type PolicyDecision =
  | { kind: "auto-accept" }
  | { kind: "auto-decline"; reason: string }
  | { kind: "counter-offer"; newPriceUSD: number }
  | { kind: "prompt-human" };
