/**
 * Delegation-scope and event-time rules at settlement
 * (`pcc.evidence.delegation-time-rules.v1`).
 *
 * The evidence lane's rulings on the oracle's audit questions (bus #3338 and
 * #3345). They are public and deterministic, so that the gateway, the verifier
 * and the oracle's /settle apply one rule (the lockstep rule).
 *
 * Delegation scope (`checkDelegationScope`), for the session key that signed
 * the bundle digest:
 *   - `scope.contractIds` is non-empty and includes the settling job, byte for
 *     byte. An empty list is refused; it never means "any contract";
 *   - `scope.maxSignatures` is an integer >= 1, and when the consumer counts
 *     the bundle's session-signed events, there are no more of them than
 *     `maxSignatures` (the oracle's rule at /settle, bus #3344). A count across
 *     bundles needs the gateway's session store (the async path's sequence
 *     acceptance), since /settle is stateless;
 *   - when the consumer knows the funded operator, `parentAgentId` equals that
 *     operator's principal id byte for byte (`pcc.evidence.principal-id.v1`:
 *     `eip155:<chainId>:0x<40 lowercase hex>`). The key is bound elsewhere, by
 *     the delegation signature under the funded device key. This makes the
 *     signed label say the same thing.
 *   The delegation is judged on OWN DATA only, each field read once: a
 *   property that is inherited, an accessor (its getter is never called) or
 *   missing is refused with the reason for a missing one, and the function
 *   never throws. A mirror reads the same way (JSON cannot encode these cases,
 *   so they are pinned in the JavaScript tests, not in the vectors).
 *
 * Event time (`checkEventTimes`):
 *   - every event `timestamp` is RFC 3339 with an explicit offset (`Z` or
 *     `+hh:mm` / `-hh:mm`), uppercase `T` and `Z`. Anything else is refused,
 *     including Unix-second strings;
 *   - every event lies in `[notBefore - skew, notAfter + skew]`. The consumer
 *     sets `notBefore` to the delegation's `issuedAt`, and `notAfter` to the
 *     earlier of its `expiresAt` and the verified receipt's `receivedAt`. The
 *     key signs the bundle once, after every event, while it is valid, so an
 *     event outside that window contradicts its own signature;
 *   - when a settlement package carries `evidenceTimeBounds`, its `start` and
 *     `end` are decimal strings of Unix seconds, as in the canonical integrated
 *     settlement-vector golden (bus #3567, which corrects #3542). Also
 *     `start <= end`, and every event lies in `[start - skew, end + skew]`. The
 *     bounds stay claimed-only: they may narrow the window, never widen it.
 *
 * `EVIDENCE_CLOCK_SKEW_SECONDS` (300) is the one tolerance both sides use.
 * Seconds are whole: a fractional part is dropped before comparing.
 */

import { hasOwn, uncurryThis } from "../util/primordials.js";

export const EVIDENCE_DELEGATION_TIME_RULES_CONTRACT = "pcc.evidence.delegation-time-rules.v1";

/** Clock tolerance between a device, the gateway and the oracle, in seconds. */
export const EVIDENCE_CLOCK_SKEW_SECONDS = 300;

/** `text`'s ASCII digits in [from, to) as a number, or -1 when one of them is not a digit. */
function digitsAt(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const unit = StringCharCodeAt(text, i);
    if (unit < 0x30 || unit > 0x39) return -1;
    n = n * 10 + (unit - 0x30);
  }
  return n;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Days from 1970-01-01 to a valid proleptic-Gregorian date (year >= 1970), by integer arithmetic only. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = (y - (y % 400)) / 400;
  const yearOfEra = y - era * 400;
  const shiftedMonth = month > 2 ? month - 3 : month + 9;
  const dayOfYear = (153 * shiftedMonth + 2 - ((153 * shiftedMonth + 2) % 5)) / 5 + day - 1;
  const dayOfEra = yearOfEra * 365 + (yearOfEra - (yearOfEra % 4)) / 4 - (yearOfEra - (yearOfEra % 100)) / 100 + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Unix seconds of an RFC 3339 timestamp with an explicit offset, the fraction
 * dropped; null for anything else (a missing offset, lowercase `t`/`z`, a
 * calendar date that does not exist, a leap second, a year before 1970, more
 * than 9 fractional digits, a non-string). A mirror in another language
 * applies the same rules (delegation-rules.vectors.json).
 *
 * The grammar is `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|(+|-)HH:MM)`, read code unit by
 * code unit; the date is checked against the calendar and turned into days by
 * integer arithmetic. No RegExp, no Date and no global is consulted at call
 * time, so nothing replaced after this module loads can change an answer (the
 * binding leg calls this; see subject-binding.ts). It answers exactly what the
 * RegExp-and-Date.UTC version it replaces answered (a differential test pins it).
 */
export function parseEvidenceTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const length = ts.length;
  if (length < 20) return null;
  if (
    StringCharCodeAt(ts, 4) !== 0x2d ||
    StringCharCodeAt(ts, 7) !== 0x2d ||
    StringCharCodeAt(ts, 10) !== 0x54 ||
    StringCharCodeAt(ts, 13) !== 0x3a ||
    StringCharCodeAt(ts, 16) !== 0x3a
  ) {
    return null;
  }
  const year = digitsAt(ts, 0, 4);
  const month = digitsAt(ts, 5, 7);
  const day = digitsAt(ts, 8, 10);
  const hour = digitsAt(ts, 11, 13);
  const minute = digitsAt(ts, 14, 16);
  const second = digitsAt(ts, 17, 19);
  if (year < 0 || month < 0 || day < 0 || hour < 0 || minute < 0 || second < 0) return null;
  let at = 19;
  if (StringCharCodeAt(ts, at) === 0x2e) {
    let end = at + 1;
    while (end < length) {
      const unit = StringCharCodeAt(ts, end);
      if (unit < 0x30 || unit > 0x39) break;
      end++;
    }
    const fractionDigits = end - (at + 1);
    if (fractionDigits < 1 || fractionDigits > 9) return null;
    at = end;
  }
  let offsetSeconds = 0;
  const designator = StringCharCodeAt(ts, at);
  if (designator === 0x5a) {
    if (at + 1 !== length) return null;
  } else if (designator === 0x2b || designator === 0x2d) {
    if (at + 6 !== length || StringCharCodeAt(ts, at + 3) !== 0x3a) return null;
    const offsetHours = digitsAt(ts, at + 1, at + 3);
    const offsetMinutes = digitsAt(ts, at + 4, at + 6);
    if (offsetHours < 0 || offsetMinutes < 0 || offsetHours > 23 || offsetMinutes > 59) return null;
    offsetSeconds = (offsetHours * 60 + offsetMinutes) * 60 * (designator === 0x2d ? -1 : 1);
  } else {
    return null;
  }
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  if (day > daysInMonth(year, month)) return null;
  return daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds;
}

export type DelegationScopeRuleCode =
  | "malformed-delegation"
  | "contract-ids-empty"
  | "contract-not-allowed"
  | "max-signatures-invalid"
  | "scope-signatures-exhausted"
  | "parent-not-operator";

export type DelegationScopeResult = { ok: true } | { ok: false; reason: DelegationScopeRuleCode };

/** What the settling consumer knows independently of the evidence. */
export interface DelegationScopeExpectation {
  /** The job being settled (the job record's id, never one read from the evidence). */
  settlingJobId: string;
  /** The funded operator's principal id, when the consumer holds the funded triple. */
  operatorPrincipalId?: string;
  /** How many events of the bundle the session key vouches for, when the consumer counts them. */
  sessionSignedEventCount?: number;
}

// Captured when this module loads, so that code run later (a patched `Object`, a
// polluted prototype) cannot change how the rules read the evidence they judge.
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const isArray = Array.isArray;
const isSafeInteger = Number.isSafeInteger;
// The time path (parseEvidenceTimestamp, parseEvidenceTimeBound, checkEventTimes) runs inside
// the LO-EV-9 binding leg, which must not look anything up at call time.
const StringCharCodeAt = uncurryThis(String.prototype.charCodeAt) as (text: string, index: number) => number;

/** What `ownData` answers for a property that is not an own data property. */
const NOT_OWN_DATA = Symbol("not-own-data");

/**
 * The value of an OWN DATA property of `holder`, read once through its
 * descriptor; `NOT_OWN_DATA` when `holder` is not an object or the property is
 * missing, inherited from a prototype, or an accessor. A getter is never called,
 * so what a rule reads is what is stored, never what a getter answers this time
 * (cross-family review E3b, finding M1). It throws only for a hostile proxy, and
 * `checkDelegationScope` catches that.
 */
function ownData(holder: unknown, key: string | number): unknown {
  if (typeof holder !== "object" || holder === null) return NOT_OWN_DATA;
  const descriptor = getOwnPropertyDescriptor(holder, key);
  return descriptor !== undefined && hasOwn(descriptor, "value") ? descriptor.value : NOT_OWN_DATA;
}

/**
 * Check a session key's scope and parent label against the job being settled.
 * Never throws. It reads `scope`, `scope.contractIds` (its length and every
 * index), `scope.maxSignatures` and `parentAgentId` as OWN DATA properties of the
 * delegation, each once: an inherited or accessor property, or one that is
 * missing, is not the delegation's and is refused with the reason for a missing
 * one (`malformed-delegation`, `max-signatures-invalid`, `parent-not-operator`).
 * No new reason code.
 */
export function checkDelegationScope(delegation: unknown, expected: DelegationScopeExpectation): DelegationScopeResult {
  try {
    return judgeDelegationScope(delegation, expected);
  } catch {
    // Something the rule cannot read (a hostile proxy, an `expected` that throws) is a
    // delegation it cannot vouch for.
    return { ok: false, reason: "malformed-delegation" };
  }
}

function judgeDelegationScope(delegation: unknown, expected: DelegationScopeExpectation): DelegationScopeResult {
  const { settlingJobId, operatorPrincipalId, sessionSignedEventCount } = expected;
  if (typeof delegation !== "object" || delegation === null) return { ok: false, reason: "malformed-delegation" };
  const scope = ownData(delegation, "scope");
  if (typeof scope !== "object" || scope === null) return { ok: false, reason: "malformed-delegation" };
  const ids = ownData(scope, "contractIds");
  if (!isArray(ids)) return { ok: false, reason: "malformed-delegation" };
  // Every index must be an own data string: `every` skips holes and `includes` reads
  // inherited indices, so a sparse or prototype-backed list could name the job
  // without holding it (cross-family review E3), and an accessor element could
  // answer differently each time it is read.
  const length = ownData(ids, "length");
  if (typeof length !== "number" || !isSafeInteger(length) || length < 0) {
    return { ok: false, reason: "malformed-delegation" };
  }
  let names = false;
  for (let i = 0; i < length; i++) {
    const id = ownData(ids, i);
    if (typeof id !== "string") return { ok: false, reason: "malformed-delegation" };
    if (id === settlingJobId) names = true;
  }
  if (length === 0) return { ok: false, reason: "contract-ids-empty" };
  if (!names) return { ok: false, reason: "contract-not-allowed" };
  const maxSignatures = ownData(scope, "maxSignatures");
  if (typeof maxSignatures !== "number" || !isSafeInteger(maxSignatures) || maxSignatures < 1) {
    return { ok: false, reason: "max-signatures-invalid" };
  }
  if (
    sessionSignedEventCount !== undefined &&
    !(isSafeInteger(sessionSignedEventCount) && sessionSignedEventCount >= 0 && sessionSignedEventCount <= maxSignatures)
  ) {
    return { ok: false, reason: "scope-signatures-exhausted" };
  }
  if (operatorPrincipalId !== undefined && ownData(delegation, "parentAgentId") !== operatorPrincipalId) {
    return { ok: false, reason: "parent-not-operator" };
  }
  return { ok: true };
}

export type EventTimeRuleCode =
  | "malformed-window"
  | "malformed-time-bounds"
  | "time-bounds-inverted"
  | "event-time-malformed"
  | "event-time-outside-window"
  | "event-outside-bounds";

export type EventTimeResult = { ok: true } | { ok: false; reason: EventTimeRuleCode; eventIndex?: number };

/** The delegation's life, capped by receipt: `[issuedAt, min(expiresAt, receivedAt)]`, in Unix seconds. */
export interface EventTimeWindow {
  notBefore: number;
  notAfter: number;
}

/** A settlement package's `evidenceTimeBounds`: decimal strings of Unix seconds (FinalMilestonePackageV2). */
export interface EvidenceTimeBounds {
  start: string;
  end: string;
}

/**
 * Unix seconds from a bound's decimal string; null for anything else (a number
 * included): `0`, or a non-zero digit followed by digits, that is a safe integer.
 * Read code unit by code unit, as `parseEvidenceTimestamp` is.
 */
export function parseEvidenceTimeBound(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > 1 && StringCharCodeAt(value, 0) === 0x30) return null;
  const n = digitsAt(value, 0, value.length);
  return n >= 0 && isSafeInteger(n) ? n : null;
}

/**
 * Check every event's timestamp against the delegation window and, when
 * given, the package's evidence time bounds. Returns the first failure.
 * Never throws.
 */
export function checkEventTimes(
  events: readonly unknown[],
  window: EventTimeWindow,
  bounds?: EvidenceTimeBounds,
  skewSeconds: number = EVIDENCE_CLOCK_SKEW_SECONDS,
): EventTimeResult {
  // Own data only, each read once; nothing here is looked up at call time.
  const notBefore = ownData(window, "notBefore");
  const notAfter = ownData(window, "notAfter");
  if (
    typeof notBefore !== "number" ||
    typeof notAfter !== "number" ||
    !isSafeInteger(notBefore) ||
    !isSafeInteger(notAfter) ||
    notBefore > notAfter ||
    !isSafeInteger(skewSeconds) ||
    skewSeconds < 0
  ) {
    return { ok: false, reason: "malformed-window" };
  }
  let start: number | null = null;
  let end: number | null = null;
  if (bounds !== undefined) {
    // Own properties only, as for event timestamps: an inherited bound is not the package's.
    const startValue = ownData(bounds, "start");
    const endValue = ownData(bounds, "end");
    start = parseEvidenceTimeBound(startValue === NOT_OWN_DATA ? undefined : startValue);
    end = parseEvidenceTimeBound(endValue === NOT_OWN_DATA ? undefined : endValue);
    if (start === null || end === null) return { ok: false, reason: "malformed-time-bounds" };
    if (start > end) return { ok: false, reason: "time-bounds-inverted" };
  }
  const length = ownData(events, "length");
  const count = typeof length === "number" && isSafeInteger(length) && length >= 0 ? length : 0;
  for (let i = 0; i < count; i++) {
    const timestamp = ownData(ownData(events, i), "timestamp");
    const seconds = parseEvidenceTimestamp(timestamp === NOT_OWN_DATA ? undefined : timestamp);
    if (seconds === null) return { ok: false, reason: "event-time-malformed", eventIndex: i };
    if (seconds < notBefore - skewSeconds || seconds > notAfter + skewSeconds) {
      return { ok: false, reason: "event-time-outside-window", eventIndex: i };
    }
    if (start !== null && end !== null && (seconds < start - skewSeconds || seconds > end + skewSeconds)) {
      return { ok: false, reason: "event-outside-bounds", eventIndex: i };
    }
  }
  return { ok: true };
}
