/**
 * Canonical money-status display: the ONE exact mapping every PCC surface uses to
 * render escrow / settlement state (read-route contract sec-A + rule 1).
 *
 * WHY THIS EXISTS. Master grew five competing escrow-status vocabularies
 * (`EscrowStatus`, `Escrow.status`, the dashboard DTO, the V-next `UnitState`,
 * the context-pack summary) and every surface re-inferred them. The shipped kit
 * used a greedy substring regex, so "refunded" matched "funded" and a REFUND
 * rendered as a green completed PAYMENT: the contract's forbidden-asserter
 * CRITICAL. This module replaces inference with exact tables.
 *
 * RULES (steward ruling #2490: money rendering fails CLOSED)
 *  - Settlement tone comes ONLY from an authoritative settlement READ MODEL,
 *    classified by its SOURCE SCHEMA (classifySettlementRecord): a V-next
 *    /lifecycle or /receipt whose fields agree. A bare word never proves payment,
 *    so the flat word table (MONEY_STATUS_MAP) has NO green entry at all.
 *  - Green is exactly V-next state 8 (SETTLED_RELEASED) read from a record whose
 *    unitState / finalState / isAllocated / isTerminal agree. Any disagreement,
 *    and any record that is not a settlement read model (a job, an A2A task),
 *    is unknown.
 *  - Refunds are `refunded`: final, payees NOT paid. Decided-but-not-paid-out
 *    states (6, 7) are `waiting`: a claim can still be outstanding.
 *  - Words that mean different things in different DTOs take the conservative
 *    reading: bare SETTLED is unmapped (it covers both 8 and 9); COMPLETED ends
 *    many non-money DTOs (jobs, steps, batch claims where paid != completed);
 *    RELEASED fires at ALLOCATION for V-next (escrow #2580 F7).
 *  - Only a plain status string is classified. A non-string, or a string with
 *    punctuation, control or non-ASCII characters ("RELEASED?", "releaſed",
 *    ["RELEASED"]), is rejected, never "cleaned up", and is unknown.
 *  - Unknown / unmapped values FAIL CLOSED to `unknown`, which is never green.
 *
 * MIRROR. `apps/dashboard/public/ui-kit/v1/pcc-ui.js` is a vanilla browser asset
 * with no bundler, so it cannot import this module. It embeds the same tables and
 * adapter between its `<status-map v2>` markers, and
 * `packages/spec/src/__tests__/money-status.conformance.test.ts` proves in CI that
 * they agree (every key, tone and label; the adapter over wire-shape fixtures).
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
 * characters) is REJECTED to "" and so classifies as unknown: "RELEASED?" is never "RELEASED".
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

// Every value of the documented spec escrow vocabularies must have a flat-table entry: `tsc`
// fails at the `satisfies` below if one is missing.
type SpecMoneyKey = Uppercase<EscrowStatus> | Uppercase<Escrow["status"]>;

/**
 * The flat table for BARE status words (legacy escrow records, list rows). Keys are normalized
 * (see normalizeMoneyStatus). It deliberately contains NO `settled` (green) tone: a bare word is
 * never authoritative settlement state. Frozen at every level.
 */
const FLAT = {
  // V-next UnitState names, as bare words (a read model is classified by classifySettlementRecord).
  // AWAITING_FUNDING is intentionally absent: state 0 is unreachable (unitState() reverts), so a
  // claim of it is a read error (escrow #2580 F3).
  FUNDED_ACTIVE: entry("running", "active - funds committed, no outcome yet"),
  PRIMARY_ASSERTED: entry("waiting", "primary assertion accepted - not final"),
  CHALLENGED: entry("waiting", "challenged - not final"),
  BACKUP_PENDING: entry("waiting", "escalated to backup - not final"),
  BACKUP_ASSERTED: entry("waiting", "backup assertion accepted - not final"),
  RELEASE_ALLOCATED: entry("waiting", "release decided - payout outstanding"),
  REFUND_ALLOCATED: entry("waiting", "refund decided - payer not yet refunded"),
  SETTLED_RELEASED: entry("waiting", "reported released - not confirmed by a settlement read"),
  SETTLED_REFUNDED: entry("refunded", "payer refunded - payees NOT paid"),

  // `Escrow.status` (spec types/settlement.ts).
  CREATED: entry("waiting", "escrow created - unfunded"),
  FUNDED: entry("waiting", "funds held - not released"),
  ACTIVE: entry("running", "active"),
  COMPLETING: entry("waiting", "completing - not yet final"),
  COMPLETED: entry("waiting", "completed - settlement not confirmed"),
  DISPUTED: entry("failed", "disputed"),
  REFUNDED: entry("refunded", "payer refunded - operator NOT paid"),

  // `EscrowStatus` (spec types/common.ts). Labels follow the type's own comments.
  UNFUNDED: entry("waiting", "unfunded"),
  LOCKED: entry("running", "funds locked - step in progress"),
  RELEASING: entry("waiting", "releasing - challenge window open, not yet paid"),
  RELEASED: entry("waiting", "released - not confirmed by a settlement read"),
  SLASHED: entry("failed", "bond slashed"),

  // Dashboard escrow DTO (apps/dashboard/src/types/dto.ts).
  PENDING: entry("waiting", "pending - not yet funded"),
  EXPIRED: entry("failed", "expired - not released"),

  // Context-pack escrow summary (gateway routes/context-pack.ts).
  MILESTONE_MET: entry("waiting", "milestone met - release pending"),
} satisfies { readonly [K in SpecMoneyKey]: MoneyStatusEntry } & Readonly<Record<string, MoneyStatusEntry>>;

export const MONEY_STATUS_MAP: Readonly<Record<string, MoneyStatusEntry>> = Object.freeze(FLAT);

export interface MoneyStatusClassification {
  readonly key: string;
  readonly tone: MoneyTone;
  /** Honest label, or null when the status is not a known money state. */
  readonly label: string | null;
  readonly known: boolean;
}

const UNKNOWN = (key: string, label: string | null = null): MoneyStatusClassification =>
  Object.freeze({ key, tone: "unknown" as const, label, known: false });

/**
 * Classify a BARE money status word for display. Exact key lookup; anything unmapped is
 * `unknown`. Never `settled`: a bare word is not settlement state (classifySettlementRecord is).
 * Generic success words ("done", "success", "ok") are not money states.
 */
export function classifyMoneyStatus(s: unknown): MoneyStatusClassification {
  const key = normalizeMoneyStatus(s);
  if (key !== "" && Object.prototype.hasOwnProperty.call(MONEY_STATUS_MAP, key)) {
    const e = MONEY_STATUS_MAP[key]!;
    return Object.freeze({ key, tone: e.tone, label: e.label, known: true });
  }
  return UNKNOWN(key);
}

// ── V-next settlement read models: classified by SOURCE SCHEMA ─────────────
// `enum UnitState` in packages/contracts/src/libraries/VNextSettlementLib.sol:25, by ordinal
// (frozen in docs/VNEXT_SETTLEMENT_ABI.md sec. 6). @pcc/spec cannot import @pcc/contracts, so the
// table is pinned to the Solidity; the conformance test re-reads the enum from that file.
export const VNEXT_UNIT_STATES = Object.freeze([
  "AWAITING_FUNDING", "FUNDED_ACTIVE", "PRIMARY_ASSERTED", "CHALLENGED", "BACKUP_PENDING",
  "BACKUP_ASSERTED", "RELEASE_ALLOCATED", "REFUND_ALLOCATED", "SETTLED_RELEASED", "SETTLED_REFUNDED",
] as const);
export type VNextUnitStateName = (typeof VNEXT_UNIT_STATES)[number];

/** Presentation of each reachable V-next state (1..9) read from a consistent read model. */
export const VNEXT_STATE_PRESENTATION: Readonly<Record<Exclude<VNextUnitStateName, "AWAITING_FUNDING">, MoneyStatusEntry>> = Object.freeze({
  FUNDED_ACTIVE: entry("running", "active - funds committed, no outcome yet"),
  PRIMARY_ASSERTED: entry("waiting", "primary assertion accepted - not final"),
  CHALLENGED: entry("waiting", "challenged - not final"),
  BACKUP_PENDING: entry("waiting", "escalated to backup - not final"),
  BACKUP_ASSERTED: entry("waiting", "backup assertion accepted - not final"),
  RELEASE_ALLOCATED: entry("waiting", "release decided - payout outstanding"),
  REFUND_ALLOCATED: entry("waiting", "refund decided - payer not yet refunded"),
  SETTLED_RELEASED: entry("settled", "released - payout distribution discharged"),
  SETTLED_REFUNDED: entry("refunded", "refunded - payer refunded, payees NOT paid"),
});

/** The read models' `phase` for each reachable state (gateway unit-state-mapper PHASE_BY_STATE). */
export const VNEXT_PHASE: Readonly<Record<Exclude<VNextUnitStateName, "AWAITING_FUNDING">, string>> = Object.freeze({
  FUNDED_ACTIVE: "active", PRIMARY_ASSERTED: "contest", CHALLENGED: "contest",
  BACKUP_PENDING: "escalation", BACKUP_ASSERTED: "escalation",
  RELEASE_ALLOCATED: "allocated", REFUND_ALLOCATED: "allocated",
  SETTLED_RELEASED: "settled", SETTLED_REFUNDED: "settled",
});

/**
 * The V-next state NAME for a wire value: an integer 1..9 or its exact name. 0 is a read error
 * (unitState() reverts UnitNotFound for a missing unit, so a "0" never describes a real unit);
 * anything else is null.
 */
export function vnextUnitStateName(v: unknown): Exclude<VNextUnitStateName, "AWAITING_FUNDING"> | null {
  let i = -1;
  if (typeof v === "number" && Number.isInteger(v)) i = v;
  else if (typeof v === "string") i = (VNEXT_UNIT_STATES as readonly string[]).indexOf(v);
  return i >= 1 && i <= 9 ? (VNEXT_UNIT_STATES[i] as Exclude<VNextUnitStateName, "AWAITING_FUNDING">) : null;
}

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const FROM_TABLE = (name: keyof typeof VNEXT_STATE_PRESENTATION): MoneyStatusClassification => {
  const e = VNEXT_STATE_PRESENTATION[name];
  return Object.freeze({ key: name, tone: e.tone, label: e.label, known: true });
};
const DISAGREE = () => UNKNOWN("", "settlement fields disagree - not shown as final");
const INCOMPLETE = () => UNKNOWN("", "incomplete settlement record - not shown as final");
const NOT_A_SETTLEMENT_RECORD = () => UNKNOWN("", "not a settlement record");

/** A legacy escrow record (spec `Escrow`): a string `status` plus escrow-only fields. */
function isLegacyEscrowRecord(o: Record<string, unknown>): boolean {
  if (typeof o.status !== "string") return false;
  return has(o, "contractAddress") || has(o, "escrowAddress") || Array.isArray(o.milestones) || has(o, "cwmId") || has(o, "totalAmount");
}

/**
 * Classify a record by its SOURCE SCHEMA (steward #2490 / #2688; product-qa #2594; escrow #2580):
 *  - V-next /lifecycle ({unitState, finalState, isAllocated, isTerminal}): unitState must be 1..9
 *    and every present field must agree with it. A FINAL state (8, 9) additionally needs all three
 *    corroborating fields present: absence is not corroboration.
 *  - V-next /receipt ({finalState, isAllocated}, no unitState): finalState counts only when it is
 *    terminal (8 or 9) and isAllocated is present and true; finalState null + isAllocated means
 *    "decided, not paid out"; anything else fails closed.
 *  - A legacy escrow record: the flat word table on `status` (never green).
 *  - Anything else (a job, an A2A task, a bare value): "not a settlement record" (unknown).
 */
export function classifySettlementRecord(record: unknown): MoneyStatusClassification {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return NOT_A_SETTLEMENT_RECORD();
  const o = record as Record<string, unknown>;

  // The read models' own field semantics (gateway settlement/unit-state-mapper.ts, served by
  // /api/settlement/units/:id/lifecycle and /receipt): `isTerminal` is true for 8/9 only;
  // `isAllocated` means "outcome decided, money NOT fully moved" and is true for 6/7 ONLY, so a
  // settled record says isAllocated:false; `finalState` names 8/9 and is null otherwise; `phase`
  // follows VNEXT_PHASE. Every field present must agree, and a FINAL state needs them all.
  if (has(o, "unitState")) {
    const name = vnextUnitStateName(o.unitState);
    if (name === null) return UNKNOWN("", "unreadable unit state");
    const ord = VNEXT_UNIT_STATES.indexOf(name);
    const terminal = ord >= 8;
    const allocated = ord === 6 || ord === 7;
    if (has(o, "finalState") && (o.finalState ?? null) !== (terminal ? name : null)) return DISAGREE();
    if (has(o, "isAllocated") && o.isAllocated !== allocated) return DISAGREE();
    if (has(o, "isTerminal") && o.isTerminal !== terminal) return DISAGREE();
    if (has(o, "phase") && o.phase !== VNEXT_PHASE[name]) return DISAGREE();
    if (terminal && !(has(o, "finalState") && has(o, "isAllocated") && has(o, "isTerminal") && has(o, "phase"))) return INCOMPLETE();
    return FROM_TABLE(name);
  }

  // A /receipt carries finalState, phase and isAllocated (no unitState, no isTerminal).
  if (has(o, "finalState")) {
    const fs = o.finalState;
    const final = fs === "SETTLED_RELEASED" || fs === "SETTLED_REFUNDED";
    if (has(o, "isTerminal") && o.isTerminal !== final) return DISAGREE();
    if (final) {
      if (!has(o, "isAllocated") || !has(o, "phase")) return INCOMPLETE();
      if (o.isAllocated !== false || o.phase !== "settled") return DISAGREE();
      return FROM_TABLE(fs);
    }
    if (fs === null && o.isAllocated === true) {
      if (has(o, "phase") && o.phase !== "allocated") return DISAGREE();
      return Object.freeze({ key: "ALLOCATED", tone: "waiting" as const, label: "outcome decided - not yet paid out", known: true });
    }
    if (fs === null && o.isAllocated === false) {
      if (has(o, "phase") && !(o.phase === "active" || o.phase === "contest" || o.phase === "escalation")) return DISAGREE();
      return Object.freeze({ key: "IN_FLIGHT", tone: "waiting" as const, label: "in progress - no outcome decided", known: true });
    }
    return UNKNOWN("", "unreadable final state");
  }

  if (isLegacyEscrowRecord(o)) return classifyMoneyStatus(o.status);
  return NOT_A_SETTLEMENT_RECORD();
}

// ── Coverage ───────────────────────────────────────────────────────────────
// The `satisfies` on FLAT is the compile-time guarantee. These records list the same keys for
// the runtime coverage test (the dashboard DTO and context-pack vocabularies are listed there).
const ESCROW_STATUS_COVERAGE: { readonly [K in EscrowStatus as Uppercase<K>]: true } = {
  UNFUNDED: true, FUNDED: true, LOCKED: true, RELEASING: true,
  RELEASED: true, DISPUTED: true, REFUNDED: true, SLASHED: true,
};
const ESCROW_RECORD_STATUS_COVERAGE: { readonly [K in Escrow["status"] as Uppercase<K>]: true } = {
  CREATED: true, FUNDED: true, ACTIVE: true, COMPLETING: true,
  COMPLETED: true, DISPUTED: true, REFUNDED: true,
};

/** Every documented spec money status, normalized. Used by the coverage tests. */
export const DOCUMENTED_SPEC_MONEY_STATUSES: readonly string[] = Object.freeze(
  [...Object.keys(ESCROW_STATUS_COVERAGE), ...Object.keys(ESCROW_RECORD_STATUS_COVERAGE)],
);
