/**
 * Device intake — which answers need an authenticated human confirmation, and
 * the hash a confirmation event binds.
 *
 * An answer's `provenance` ("human", "confirmed", ...) is descriptive metadata
 * written by whoever builds the record; it is not authority. For the facts
 * that decide safety, money and I/O limits, readiness (`validateIntake`)
 * instead resolves a confirmation reference against an authenticated store
 * (`IntakeAuthority` in index.ts) and compares what that store holds with the
 * answer: the field id, `intakeValueHash(answer.value)` and, when the answer
 * has one, `intakeValueHash(answer.source)`.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canonicalize } from "../../util/canonical.js";
import { RESEARCH_LIBRARY } from "../research/library.js";
import { INTAKE_FIELDS } from "./fields.js";
import { plainIntakeCopy } from "./plain-input.js";

/**
 * `sha256:` + hex of the SHA-256 of the UTF-8 bytes of `canonicalize(value)`
 * (@pcc/spec's canonical JSON: keys sorted at every depth, no whitespace), or
 * null when `value` has no exact JSON form. Producers use it for a confirmation
 * event's `valueHash` (of `answer.value`) and `sourceHash` (of `answer.source`),
 * so the event and the validator hash the same way.
 *
 * It is TOTAL: it never throws. It hashes one exact plain-data copy of `value`
 * (plain-input.ts, the intake's own boundary), and before canonicalize sees
 * anything it refuses (returns null) what has no exact JSON form:
 *   - NaN and plus or minus Infinity. A lenient canonicalizer writes them as
 *     null, so two different values could otherwise hash alike;
 *   - an integer beyond plus or minus (2^53 - 1), which JSON carries inexactly
 *     (D5);
 *   - undefined, a bigint, a function, a symbol, a non-plain object, an
 *     accessor, a cycle, and anything else the copy refuses.
 * A canonicalizer that still throws is caught, and the answer is null too. A
 * null hash confirms nothing: confirmationHolds treats it as no match.
 */
export function intakeValueHash(value: unknown): string | null {
  const plain = plainIntakeCopy(value);
  if (plain === null || !numbersAreExactJson(plain.value)) return null;
  try {
    return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalize(plain.value))))}`;
  } catch {
    return null;
  }
}

/** Every number in a plain-data tree is finite and, when it is an integer, a safe one. Iterative. */
function numbersAreExactJson(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === "number") {
      if (!Number.isFinite(node) || (Number.isInteger(node) && !Number.isSafeInteger(node))) return false;
    } else if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node !== null && typeof node === "object") {
      for (const key of Object.keys(node)) stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return true;
}

const CONFIRMATION_REQUIRED_SET: ReadonlySet<string> = new Set([
  // Every field the intake itself never defaults (money, safety, authority) ...
  ...INTAKE_FIELDS.filter((f) => f.neverDefault).map((f) => f.id),
  // ... plus every field a research entry marked `humanConfirmRequired` fills
  // (e.g. capability.parameters, which find-io-ranges fills but which is not
  // itself neverDefault).
  ...RESEARCH_LIBRARY.filter((e) => e.humanConfirmRequired).flatMap((e) => e.fills),
]);

/**
 * Field ids whose answer satisfies a milestone only when an authenticated
 * confirmation event backs it (see `validateIntake`): every `neverDefault`
 * field plus every field id in the `fills` of a RESEARCH_LIBRARY entry with
 * `humanConfirmRequired: true`. Derived in code from those two registries (a
 * new neverDefault field or a new humanConfirmRequired fill joins it
 * automatically); a test pins the result. Frozen and sorted, like
 * INTAKE_FIELD_IDS, so it cannot be changed at runtime.
 */
export const CONFIRMATION_REQUIRED_FIELDS: readonly string[] = Object.freeze([...CONFIRMATION_REQUIRED_SET].sort());

/** Does `fieldId`'s answer need an authenticated confirmation? Internal. */
export function isConfirmationRequired(fieldId: string): boolean {
  return CONFIRMATION_REQUIRED_SET.has(fieldId);
}
