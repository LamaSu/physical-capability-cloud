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
import { isProseClaim } from "./plain-text-claims.js";

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
 * Classify a record's FIELDS by the settlement read routes' own semantics (steward #2490 / #2688;
 * product-qa #2594; escrow #2580, #3163; gateway settlement/unit-state-mapper):
 *  - with `unitState` (1..9; 0 is a read error): every present field must agree with it. A FINAL
 *    state (8, 9) needs finalState, isAllocated and phase present (isTerminal is cross-checked when
 *    present; /receipt, which gains unitState per #3163, carries no isTerminal).
 *  - /receipt without unitState ({finalState, phase, isAllocated}): final only with isAllocated FALSE
 *    and phase "settled"; finalState null + isAllocated true is "decided, not paid out", + false is
 *    "in progress"; anything else fails closed.
 *  - A legacy escrow record: the flat word table on `status` (never green).
 *  - Anything else (a job, an A2A task, a bare value): "not a settlement record" (unknown).
 * This classifies FIELDS only; field shape is not provenance. To DISPLAY a settlement state use
 * classifySettlementRead(), which also needs to know where the record came from.
 */
export function classifySettlementRecord(record: unknown): MoneyStatusClassification {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return NOT_A_SETTLEMENT_RECORD();
  const o = record as Record<string, unknown>;

  // The read models' own field semantics (gateway settlement/unit-state-mapper.ts, served by
  // /api/settlement/units/:id/lifecycle and /receipt): `isTerminal` is true for 8/9 only;
  // `isAllocated` means "outcome decided, money NOT fully moved" and is true for 6/7 ONLY, so a
  // settled record says isAllocated:false; `finalState` names 8/9 and is null otherwise; `phase`
  // follows VNEXT_PHASE. Every field present must agree, and a FINAL state needs unitState,
  // finalState, isAllocated and phase. isTerminal is cross-checked when present but not required:
  // /receipt gains unitState (escrow ruling #3163, additive) but carries no isTerminal, and the
  // 6-vs-7 direction is keyed off unitState, never off finalState.
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
    if (terminal && !(has(o, "finalState") && has(o, "isAllocated") && has(o, "phase"))) return INCOMPLETE();
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

/** The only routes whose LIVE reads may present a FINAL settlement state (settlement-read.ts UNIT_ID_RE). */
export const SETTLEMENT_READ_ROUTE = /^\/api\/settlement\/units\/0x[0-9a-fA-F]{64}\/(receipt|lifecycle)$/;

/**
 * Display classification of a settlement record, given WHERE it came from (astra r2 on #313, F1: field
 * shape is not provenance). A FINAL V-next presentation (settled 8, refunded 9) is shown only for a LIVE
 * read of an exact per-unit settlement route. A baked snapshot, a fallback, a stream event, or a
 * settled-shaped body from any other route is unknown. Every other classification passes through
 * unchanged: non-final states claim nothing final, and the flat table has no green.
 */
export function classifySettlementRead(
  record: unknown,
  source: { path?: unknown; live?: unknown } | null | undefined,
): MoneyStatusClassification {
  const c = classifySettlementRecord(record);
  const vnext = record !== null && typeof record === "object" && !Array.isArray(record)
    && (has(record as Record<string, unknown>, "unitState") || has(record as Record<string, unknown>, "finalState"));
  if (!vnext || (c.tone !== "settled" && c.tone !== "refunded")) return c;
  const path = source && typeof source.path === "string" ? source.path.split("?")[0]! : "";
  if (source && source.live === true && SETTLEMENT_READ_ROUTE.test(path)) return c;
  return UNKNOWN("", "final state not shown - not a live read of a settlement route");
}

// ── Pill text (astra r4 on #313, F6; astra r5 on #313, F7-F9) ───────────────
// The tone decides the colour, and the TEXT may not claim more. A blacklist of "final money" tokens
// (astra r4) missed explicit claims it didn't enumerate (astra r5 F7: PAYEE_RECEIVED_FUNDS,
// FUNDS_TRANSFERRED_TO_PAYEE, ... never matched a token, so they rendered bare) and over-qualified
// ordinary non-money text with a settlement-flavoured suffix (astra r5 F9: a job status "running!" read
// "... - settlement unconfirmed" even though a job is not a settlement surface at all). So the rule now
// fails CLOSED over a CLOSED safe vocabulary instead of failing open over an open blacklist: unverified
// text is shown as-is ONLY when it normalizes to a word on the surface's OWN safe list; anything else --
// any claim this module does not affirmatively recognize as safe, spelled however -- is qualified, with
// a suffix that matches the surface. There is no "unsafe" list to keep enumerating.
//
// SAFE_STATUS_WORDS (non-money surfaces: jobs, kernels, capabilities, agents, artifacts, csd, sensors,
// devices, skills...). Ordinary lifecycle/health words only. No outcome here is ever a payment claim, so
// an unverified value on a non-money surface reads "status unverified", never "settlement unconfirmed"
// (astra r5 F9). Sources: the kit's own GENERIC_STATES, plus the documented non-money status enums:
// KernelJobStatus (job-lifecycle.ts:38), CapabilityNodeStatus (requests.ts:21), CompositionStatus
// (composition.ts:170), the kernel status schemas (schemas/index.ts:270), DeviceHealthStatus
// (kernel.ts:37), ApprovalStatus (operator-policy.ts:210), licensing.ts:149, primitives.ts:76/88.
export const SAFE_STATUS_WORDS: readonly string[] = Object.freeze([
  "RUNNING", "IN_PROGRESS", "PROGRESS", "STREAMING", "BUILDING", "CONNECTING",
  "PENDING", "QUEUED", "WAITING", "PAUSED", "REVIEW", "CONFIRM", "NEEDS_INPUT", "NEEDS_YOU",
  "ERROR", "FAILED", "DENIED", "CANCELLED", "CANCELED", "REJECTED",
  "DONE", "COMPLETE", "COMPLETED", "OK", "SUCCESS", "SUCCEEDED", "RESOLVED", "READY",
  "DISPATCHED", "ACCEPTED", "PREPARING", "EXECUTING", "COLLECTING_EVIDENCE", "AWAITING_PICKUP", "TIMED_OUT",
  "ONLINE", "OFFLINE", "MAINTENANCE", "SUSPENDED", "HEALTHY", "DEGRADED", "UNKNOWN",
  "BIDDING", "ASSIGNED", "PROPOSED", "OVER_BUDGET", "NO_PATH_FOUND", "APPROVED", "EXPIRED",
  "ACTIVE", "INACTIVE", "REVOKED", "IDLE", "BUSY", "DRAFT", "DEPRECATED", "RESERVED", "LIVE", "STUB", "PLANNED",
]);

// SAFE_MONEY_STATUS_WORDS (money surfaces): in-progress and failure words ONLY -- no success-ish word
// (done, ok, approved, completed, ...) is here, because on money data "done" is not "paid" (steward
// #2490) and this module has no way to tell, from a bare success word alone, which one a caller meant.
// A money-surface value that is not on this list is always qualified, even a non-final, merely-decided
// word like RELEASE_ALLOCATED: astra r4's honest-label lookup (dataStatusText / settlementLabel) is the
// path that names those by their own direction-explicit label; this function has no such table to
// consult, so it stays conservative.
export const SAFE_MONEY_STATUS_WORDS: readonly string[] = Object.freeze([
  "RUNNING", "IN_PROGRESS", "PROGRESS", "PENDING", "QUEUED", "WAITING", "PAUSED", "REVIEW",
  "ERROR", "FAILED", "DENIED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "UNKNOWN",
]);

export const UNCONFIRMED_SUFFIX = " - settlement unconfirmed";
export const UNVERIFIED_SUFFIX = " - status unverified";

/**
 * The text of a status pill: the value itself when it is verified, empty, or normalizes to a word on the
 * surface's own safe list (SAFE_MONEY_STATUS_WORDS when `money` is true, SAFE_STATUS_WORDS otherwise);
 * any other unverified text -- a money claim this module does not recognize as safe, a decorated or
 * non-ASCII look-alike, anything at all -- is shown qualified, with a suffix that matches the surface:
 * money data reads "settlement unconfirmed" (astra r4 F6), a non-money surface reads "status unverified"
 * (astra r5 F9) so an ordinary job status is never given a payment-flavoured qualifier it has no claim to.
 */
export function statusPillText(raw: unknown, verified: boolean, money: boolean): string {
  const t = raw == null ? "" : String(raw);
  if (verified || t === "") return t;
  const k = normalizeMoneyStatus(t);
  const safe = money ? SAFE_MONEY_STATUS_WORDS : SAFE_STATUS_WORDS;
  if (k !== "" && safe.includes(k)) return t;
  return "reported status: " + t + (money ? UNCONFIRMED_SUFFIX : UNVERIFIED_SUFFIX);
}

/**
 * The text of a free-text server MESSAGE shown outside a pill, such as a run window's latest line (astra
 * r6 F12). A message cannot be checked against a vocabulary, so it is never presented as PCC's own claim:
 * it is attributed to its source ("reported: ..."), and on money data it also says the settlement is
 * unconfirmed. Only `verified` shows it plainly, and for any secondary text (a message, a timeline entry,
 * a latest line) callers pass a VERIFIED PAYEE PAYMENT there, never a verified refund: a refund proves the
 * payees were NOT paid, so it vouches for no other claim (astra r6 F10).
 */
export function reportedText(raw: unknown, verified: boolean, money: boolean): string {
  const t = raw == null ? "" : String(raw);
  if (verified || t === "") return t;
  return "reported: " + t + (money ? UNCONFIRMED_SUFFIX : "");
}

// These closed grammars are mirrored by the dependency-free plain browser kit.
// Conformance compares accepted and rejected inputs against the real shipped bytes.
export const PLAIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PLAIN_HEX_RE = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
export const PLAIN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
export const PLAIN_TRACE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Identifiers keep their spelling only inside the bounded ASCII grammar. */
export function idText(raw: unknown): string {
  return typeof raw === "string" && PLAIN_ID_RE.test(raw) ? raw : reportedText(raw, false, false);
}

/** Addresses and transaction hashes admit exactly their two wire lengths. */
export function hexText(raw: unknown): string {
  return typeof raw === "string" && PLAIN_HEX_RE.test(raw) ? raw : "unrecognised value";
}

/** Canonical UTC, calendar-valid, and in the same 2000..2100 era as the IR kit. */
export function canonicalPlainTime(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = PLAIN_TIME_RE.exec(raw);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  const ms = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  if (year < 2000 || year > 2100) return false;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day &&
    d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second &&
    d.getUTCMilliseconds() === ms;
}

/** Preserve the kit's locale-formatted timestamp after the UTC grammar check. */
export function timeText(raw: unknown): string {
  if (!canonicalPlainTime(raw)) return "time not reported";
  const d = new Date(raw);
  try { return d.toLocaleString(); } catch { return d.toISOString(); }
}

/** An invalid trace is omitted, so arbitrary response-header text is never shown. */
export function traceText(raw: unknown): string {
  return typeof raw === "string" && PLAIN_TRACE_RE.test(raw) ? "trace " + raw : "";
}

/** Operator-chosen names are visibly framed; claims use PCC's withheld notice. */
export function nameText(raw: unknown): string {
  if (typeof raw !== "string") return reportedText(raw, false, false);
  return isProseClaim(raw) ? "name withheld: stated money or verification" : "name: " + raw;
}

/** Editable defaults admit only the field kind's wire value, without coercion. */
export function fieldDefaultText(kind: unknown, raw: unknown): string {
  if (kind === "number" || kind === "integer") return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
  if (kind === "string") return typeof raw === "string" && !isProseClaim(raw) ? raw : "";
  return "";
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
