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

export const EVIDENCE_DELEGATION_TIME_RULES_CONTRACT = "pcc.evidence.delegation-time-rules.v1";

/** Clock tolerance between a device, the gateway and the oracle, in seconds. */
export const EVIDENCE_CLOCK_SKEW_SECONDS = 300;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Unix seconds of an RFC 3339 timestamp with an explicit offset, the fraction
 * dropped; null for anything else (a missing offset, lowercase `t`/`z`, a
 * calendar date that does not exist, a leap second, a year before 1970, more
 * than 9 fractional digits, a non-string). A mirror in another language
 * applies the same rules (delegation-rules.vectors.json).
 */
export function parseEvidenceTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string") return null;
  const m = RFC3339.exec(ts);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // Date.UTC rolls an impossible date over (Feb 30 -> Mar 2) and maps years
  // 0-99 to 19xx: the round trip catches both.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offsetSeconds = 0;
  if (m[8] !== "Z") {
    const offsetHours = Number(m[10]);
    const offsetMinutes = Number(m[11]);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetSeconds = (offsetHours * 60 + offsetMinutes) * 60 * (m[9] === "-" ? -1 : 1);
  }
  return ms / 1000 - offsetSeconds;
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

/** Check a session key's scope and parent label against the job being settled. Never throws. */
export function checkDelegationScope(delegation: unknown, expected: DelegationScopeExpectation): DelegationScopeResult {
  if (typeof delegation !== "object" || delegation === null) return { ok: false, reason: "malformed-delegation" };
  const d = delegation as { parentAgentId?: unknown; scope?: unknown };
  const scope = d.scope as { contractIds?: unknown; maxSignatures?: unknown } | null | undefined;
  if (typeof scope !== "object" || scope === null || !Array.isArray(scope.contractIds)) {
    return { ok: false, reason: "malformed-delegation" };
  }
  // Every index must be an own string: `every` skips holes and `includes` reads
  // inherited indices, so a sparse or prototype-backed list could name the job
  // without holding it (cross-family review E3).
  const ids = scope.contractIds as unknown[];
  let names = false;
  for (let i = 0; i < ids.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(ids, i) || typeof ids[i] !== "string") {
      return { ok: false, reason: "malformed-delegation" };
    }
    if (ids[i] === expected.settlingJobId) names = true;
  }
  if (ids.length === 0) return { ok: false, reason: "contract-ids-empty" };
  if (!names) return { ok: false, reason: "contract-not-allowed" };
  if (!Number.isSafeInteger(scope.maxSignatures) || (scope.maxSignatures as number) < 1) {
    return { ok: false, reason: "max-signatures-invalid" };
  }
  if (
    expected.sessionSignedEventCount !== undefined &&
    !(
      Number.isSafeInteger(expected.sessionSignedEventCount) &&
      expected.sessionSignedEventCount >= 0 &&
      expected.sessionSignedEventCount <= (scope.maxSignatures as number)
    )
  ) {
    return { ok: false, reason: "scope-signatures-exhausted" };
  }
  if (expected.operatorPrincipalId !== undefined && d.parentAgentId !== expected.operatorPrincipalId) {
    return { ok: false, reason: "parent-not-operator" };
  }
  return { ok: true };
}

/** An own property's value, or undefined: never one read through the prototype chain. */
function ownValue(o: unknown, key: string): unknown {
  return typeof o === "object" && o !== null && Object.prototype.hasOwnProperty.call(o, key)
    ? (o as Record<string, unknown>)[key]
    : undefined;
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

const UNIX_SECONDS = /^(0|[1-9][0-9]*)$/;

/** Unix seconds from a bound's decimal string; null for anything else (a number included). */
export function parseEvidenceTimeBound(value: unknown): number | null {
  if (typeof value !== "string" || !UNIX_SECONDS.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
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
  if (
    typeof window !== "object" ||
    window === null ||
    !Number.isSafeInteger(window.notBefore) ||
    !Number.isSafeInteger(window.notAfter) ||
    window.notBefore > window.notAfter ||
    !Number.isSafeInteger(skewSeconds) ||
    skewSeconds < 0
  ) {
    return { ok: false, reason: "malformed-window" };
  }
  let start: number | null = null;
  let end: number | null = null;
  if (bounds !== undefined) {
    // Own properties only, as for event timestamps: an inherited bound is not the package's.
    start = parseEvidenceTimeBound(ownValue(bounds, "start"));
    end = parseEvidenceTimeBound(ownValue(bounds, "end"));
    if (start === null || end === null) return { ok: false, reason: "malformed-time-bounds" };
    if (start > end) return { ok: false, reason: "time-bounds-inverted" };
  }
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const t = parseEvidenceTimestamp(
      typeof e === "object" && e !== null && Object.prototype.hasOwnProperty.call(e, "timestamp")
        ? (e as { timestamp: unknown }).timestamp
        : undefined,
    );
    if (t === null) return { ok: false, reason: "event-time-malformed", eventIndex: i };
    const seconds = Math.floor(t);
    if (seconds < window.notBefore - skewSeconds || seconds > window.notAfter + skewSeconds) {
      return { ok: false, reason: "event-time-outside-window", eventIndex: i };
    }
    if (start !== null && end !== null && (seconds < start - skewSeconds || seconds > end + skewSeconds)) {
      return { ok: false, reason: "event-outside-bounds", eventIndex: i };
    }
  }
  return { ok: true };
}
