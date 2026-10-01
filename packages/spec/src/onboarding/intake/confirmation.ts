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

/**
 * `sha256:` + hex of the SHA-256 of the UTF-8 bytes of `canonicalize(value)`
 * (@pcc/spec's canonical JSON: keys sorted at every depth, no whitespace).
 * Producers use it for a confirmation event's `valueHash` (of `answer.value`)
 * and `sourceHash` (of `answer.source`), so the event and the validator hash
 * the same way.
 */
export function intakeValueHash(value: unknown): string {
  return `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalize(value))))}`;
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
