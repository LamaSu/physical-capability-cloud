/**
 * The closed set of reasons the economics compiler refuses (docs/ECONOMIC_AGREEMENTS.md §3).
 *
 * A refusal is a first-class result, not an exception and not an empty array. Every code here is
 * provoked by at least one test; a refusal that cannot be provoked is not implemented.
 */

export const REFUSAL_PHASES = ["schema", "structure", "rights", "money"] as const;
export type RefusalPhase = (typeof REFUSAL_PHASES)[number];

export const REFUSAL_CODES = {
  // schema
  SCHEMA_INVALID: "schema",
  // structure
  DUPLICATE_ID: "structure",
  DUPLICATE_LICENSE_SUBJECT: "structure",
  UNKNOWN_REFERENCE: "structure",
  SPLIT_CYCLE: "structure",
  SPLIT_TOO_DEEP: "structure",
  DUPLICATE_SPLIT_MEMBER: "structure",
  FEE_INVALID: "structure",
  OFFER_EXPIRED: "structure",
  ECONOMICS_UNDECIDED_OD4: "structure",
  INVALID_BOUNDS: "structure",
  SCHEDULE_HASH_MISMATCH: "structure",
  RATE_PIN_MISMATCH: "structure",
  // rights
  RIGHTS_UNKNOWN: "rights",
  LICENSE_NOT_IN_FORCE: "rights",
  AUTHORITY_BELOW_FLOOR: "rights",
  RIGHTS_INCOMPATIBLE: "rights",
  LICENSE_PAYMENT_MISSING: "rights",
  LICENSE_PAYMENT_UNMATCHED: "rights",
  RATE_UNVERIFIED: "rights",
  // money
  GROSS_OUT_OF_RANGE: "money",
  UNKNOWN_MEASURE: "money",
  OVER_ALLOCATED: "money",
  MULTIPLE_RESIDUALS: "money",
  UNALLOCATED_REMAINDER: "money",
  UNRESOLVED_PARTY: "money",
  FORBIDDEN_RECIPIENT: "money",
  TOO_MANY_LEGS: "money",
} as const satisfies Record<string, RefusalPhase>;

export type RefusalCode = keyof typeof REFUSAL_CODES;

export interface Refusal {
  code: RefusalCode;
  message: string;
  /** The offending objects: party, unit, clause, split, license or component ids, outermost first. */
  path: string[];
}

export function refusal(code: RefusalCode, message: string, path: string[]): Refusal {
  return { code, message, path };
}

/** Paths compare element by element (byte order), and a path sorts before any path it prefixes. */
export function comparePaths(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * The canonical refusal list (§3): one refusal per (code, path), the first message kept (messages are
 * informative, never part of a refusal's identity), sorted by phase, then code, then path.
 */
export function sortRefusals(refusals: readonly Refusal[]): Refusal[] {
  const seen = new Set<string>();
  const unique: Refusal[] = [];
  for (const r of refusals) {
    const key = `${r.code}\u0000${r.path.join("\u0000")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const phaseIndex = (c: RefusalCode) => REFUSAL_PHASES.indexOf(REFUSAL_CODES[c]);
  return unique.sort((a, b) => {
    const p = phaseIndex(a.code) - phaseIndex(b.code);
    if (p !== 0) return p;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return comparePaths(a.path, b.path);
  });
}
