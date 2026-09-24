/**
 * Canonical money-status display map: the ONE exact mapping every PCC surface
 * uses to render escrow / settlement state (read-route contract sec-A + rule 1).
 *
 * WHY THIS EXISTS. Master grew five competing escrow-status vocabularies
 * (`EscrowStatus`, `Escrow.status`, the dashboard DTO, the V-next `UnitState`,
 * the context-pack summary) and every surface re-inferred them. The shipped kit
 * used a greedy substring regex, so "refunded" matched "funded" and a REFUND
 * rendered as a green completed PAYMENT: the contract's forbidden-asserter
 * CRITICAL. This module replaces inference with an exact table.
 *
 * RULES
 *  - Exact normalized keys only. Never substring inference.
 *  - Nothing renders `settled` (green) unless it is a documented, FINAL
 *    release to the operator. Refunds are `refunded`: final, operator NOT paid.
 *  - Decided-but-not-moved states (RELEASE_ALLOCATED / REFUND_ALLOCATED) are
 *    `waiting`: a claim can still be outstanding (escrow #620).
 *  - Unknown / unmapped values FAIL CLOSED to `unknown`, which is never green.
 *  - A word that means different things in different DTOs takes the
 *    conservative reading. `SETTLED` is deliberately ABSENT: SettlementResultDTO
 *    uses it for operator-paid, but the V-next phase vocabulary uses "settled"
 *    for BOTH state 8 (released) and state 9 (refunded). A word that can mean
 *    "refunded" must never render as paid. Surfaces holding a SettlementResultDTO
 *    should render `finalState` / `unitState`, not the bare word. `COMPLETED` is
 *    NOT green for the same reason: it is the terminal state of many NON-money
 *    DTOs (jobs, skills, steps, executions, and batch claims, where `paid` and
 *    `completed` are different states), so a bare "completed" proves no payment.
 *  - Only a plain status word is classified. A non-string, or a string with
 *    punctuation, control or non-ASCII characters ("released!", ["released"]),
 *    normalizes to "" and is unknown.
 *
 * MIRROR. `apps/dashboard/public/ui-kit/v1/pcc-ui.js` is a vanilla browser
 * asset with no bundler, so it cannot import this module. It embeds a verbatim
 * copy between its `<status-map v2>` markers, and
 * `packages/spec/src/__tests__/money-status.conformance.test.ts` proves in CI
 * that the two tables agree key for key (same keys, tone, and label).
 *
 * Browser-safe: no Node imports.
 */

import type { EscrowStatus } from "../types/common.js";
import type { Escrow } from "../types/settlement.js";

/** Semantic tone. Presentation maps tone -> color; tone never comes from a manifest. */
export type MoneyTone = "settled" | "refunded" | "waiting" | "running" | "failed" | "unknown";

export interface MoneyStatusEntry {
  readonly tone: Exclude<MoneyTone, "unknown">;
  /** Honest, direction-explicit label (who was or was not paid). */
  readonly label: string;
}

/**
 * Normalize a status to its exact map key: trim, uppercase, separators (space, '-', '_') -> `_`.
 * Anything that is not a plain status word (a non-string, or punctuation, control or non-ASCII
 * characters) normalizes to "" and so classifies as unknown: "released!" or ["released"] is never paid.
 */
export function normalizeMoneyStatus(s: unknown): string {
  if (typeof s !== "string") return "";
  const t = s.trim();
  if (!/^[A-Za-z0-9 _-]+$/.test(t)) return "";
  return t.toUpperCase().replace(/[ _-]+/g, "_").replace(/^_+|_+$/g, "");
}

function entry(tone: MoneyStatusEntry["tone"], label: string): MoneyStatusEntry {
  return Object.freeze({ tone, label });
}

/**
 * The exact table. Keys are normalized (see normalizeMoneyStatus).
 * Frozen at every level: a runtime `.add`/assignment cannot turn a refund green.
 */
export const MONEY_STATUS_MAP: Readonly<Record<string, MoneyStatusEntry>> = Object.freeze({
  // V-next UnitState / finalState: the 10-state settlement machine (gateway
  // unit-state-mapper.ts, on-chain escrow #606; contract sec-A).
  AWAITING_FUNDING: entry("waiting", "awaiting funding"),
  FUNDED_ACTIVE: entry("running", "active"),
  PRIMARY_ASSERTED: entry("waiting", "in a challenge window"),
  CHALLENGED: entry("waiting", "challenged - appeal running"),
  BACKUP_PENDING: entry("waiting", "escalated to backup"),
  BACKUP_ASSERTED: entry("waiting", "backup asserted"),
  RELEASE_ALLOCATED: entry("waiting", "release allocated - payment incomplete"),
  REFUND_ALLOCATED: entry("waiting", "refund allocated - refund incomplete"),
  SETTLED_RELEASED: entry("settled", "operator distribution discharged"),
  SETTLED_REFUNDED: entry("refunded", "payer refunded - operator NOT paid"),

  // `Escrow.status` (spec types/settlement.ts).
  CREATED: entry("waiting", "escrow created - unfunded"),
  FUNDED: entry("waiting", "funds held - not released"),
  ACTIVE: entry("running", "active"),
  COMPLETING: entry("waiting", "completing - not yet final"),
  COMPLETED: entry("waiting", "completed - settlement not confirmed"), // ambiguous across DTOs: never green
  DISPUTED: entry("failed", "disputed"),
  REFUNDED: entry("refunded", "payer refunded - operator NOT paid"),

  // `EscrowStatus` (spec types/common.ts). Labels follow the type's own comments.
  UNFUNDED: entry("waiting", "unfunded"),
  LOCKED: entry("running", "funds locked - step in progress"),
  RELEASING: entry("waiting", "releasing - challenge window open, not yet paid"),
  RELEASED: entry("settled", "payment sent to operator"),
  SLASHED: entry("failed", "bond slashed"),

  // Dashboard escrow DTO (apps/dashboard/src/types/dto.ts).
  PENDING: entry("waiting", "pending - not yet funded"),
  EXPIRED: entry("failed", "expired - not released"),

  // Context-pack escrow summary (gateway routes/context-pack.ts).
  MILESTONE_MET: entry("waiting", "milestone met - release pending"),
});

export interface MoneyStatusClassification {
  readonly key: string;
  readonly tone: MoneyTone;
  /** Honest label, or null when the status is not a known money state. */
  readonly label: string | null;
  readonly known: boolean;
}

/**
 * Classify a money status for display. Exact key lookup; anything unmapped is
 * `unknown` (never `settled`). Generic success words ("done", "success", "ok")
 * are NOT money states: an off-schema status on a money response must never be
 * relabeled as paid.
 */
export function classifyMoneyStatus(s: unknown): MoneyStatusClassification {
  const key = normalizeMoneyStatus(s);
  if (Object.prototype.hasOwnProperty.call(MONEY_STATUS_MAP, key)) {
    const e = MONEY_STATUS_MAP[key]!;
    return { key, tone: e.tone, label: e.label, known: true };
  }
  return { key, tone: "unknown", label: null, known: false };
}

// ── Compile-time coverage ──────────────────────────────────────────────────
// If a documented spec vocabulary gains a value with no map entry, `tsc`
// fails here (and the conformance test checks the same keys at runtime).
type Key<S extends string> = Uppercase<S>;
const ESCROW_STATUS_COVERAGE: { readonly [K in EscrowStatus as Key<K>]: true } = {
  UNFUNDED: true, FUNDED: true, LOCKED: true, RELEASING: true,
  RELEASED: true, DISPUTED: true, REFUNDED: true, SLASHED: true,
};
const ESCROW_RECORD_STATUS_COVERAGE: { readonly [K in Escrow["status"] as Key<K>]: true } = {
  CREATED: true, FUNDED: true, ACTIVE: true, COMPLETING: true,
  COMPLETED: true, DISPUTED: true, REFUNDED: true,
};

/** Every documented spec money status, normalized. Used by the coverage tests. */
export const DOCUMENTED_SPEC_MONEY_STATUSES: readonly string[] = Object.freeze(
  [...Object.keys(ESCROW_STATUS_COVERAGE), ...Object.keys(ESCROW_RECORD_STATUS_COVERAGE)],
);
