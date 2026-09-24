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

/** Deterministic order (§3): phase, then code, then path joined with "/". */
export function sortRefusals(refusals: readonly Refusal[]): Refusal[] {
  const phaseIndex = (c: RefusalCode) => REFUSAL_PHASES.indexOf(REFUSAL_CODES[c]);
  return [...refusals].sort((a, b) => {
    const p = phaseIndex(a.code) - phaseIndex(b.code);
    if (p !== 0) return p;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const pa = a.path.join("/");
    const pb = b.path.join("/");
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
}
