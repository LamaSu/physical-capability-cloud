/**
 * Device intake — what "tier1" / "tier2" readiness may and may not claim.
 *
 * Tier readiness means ONLY that the intake holds what a LIVE verifier could be
 * fed; it never means the device is assured. `validateIntake` (index.ts)
 * therefore fails closed in two ways for the tier milestones (and any
 * milestone implying them):
 *
 *   - Stub evidence. Every evidence primitive that a required tier field maps
 *     to (`IntakeFieldDef.evidencePrimitive`) must be `status: "active"` with
 *     `verifierStatus: "live"` in EVIDENCE_PRIMITIVES (the registry itself, not
 *     the status the field declared). Anything else — a stub, a planned
 *     verifier, a reserved/deprecated primitive, an id the registry does not
 *     know — is reported in `stubPrimitives`.
 *   - Facts that prove nothing. An answer can satisfy its field's schema and
 *     still be useless to the verifier its primitive feeds (a camera that
 *     sees neither the work area nor the output, a controller that does not
 *     export its own log). TIER_SUBSTANCE_RULES lists, per field, the value
 *     the primitive needs; a shape-valid answer that fails its rule is
 *     reported in `insubstantial`.
 */

import { getPrimitive } from "../../evidence/primitives.js";
import { INTAKE_FIELDS, type IntakeMilestone } from "./fields.js";

const TIER_MILESTONES: readonly IntakeMilestone[] = ["tier1", "tier2"];

const nonBlank = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/** YYYY-MM-DD naming a day that exists (month 01-12, leap years honoured).
 *  Not compared with today: freshness is the verifier's concern, and the
 *  validator has no clock. */
function isRealCalendarDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

type Rule = (value: unknown) => boolean;
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * Per tier field, what a shape-valid answer must also be for its primitive to
 * be fed. Each rule sees the value that already satisfied the field's schema.
 *
 *   calibration.lastDate              a real calendar date           (decl.self_attested)
 *   calibration.procedureRef          not blank                      (decl.self_attested)
 *   evidence.executorDeviceId         not blank
 *   evidence.observerDeviceIds        no blank entry (an empty list is an honest "no observer")
 *   evidence.executionMode            exactly "real"                 (confirm.execution_mode;
 *                                     mock/dry_run hard-caps at tier 0)
 *   evidence.controllerRunLog         exportsOwnLogPerJob === true   (machine.execution_log)
 *   evidence.instrumentSignsOutput    true                           (ident.registered_key)
 *   evidence.referenceSample          available === true and a non-blank expectedResultRef
 *                                                                    (measure.io_test_pair)
 *   evidence.camera                   seesWorkArea === true, seesOutput === true and a
 *                                     non-blank captureDeviceId      (capture.photo_nonced)
 *   evidence.approver                 a non-blank name               (approval.expert)
 *
 * evidence.operatorPresence has no rule: always, sometimes and never are all
 * honest answers.
 */
const TIER_SUBSTANCE_RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["calibration.lastDate", isRealCalendarDate],
  ["calibration.procedureRef", nonBlank],
  ["evidence.executorDeviceId", nonBlank],
  ["evidence.observerDeviceIds", (v) => Array.isArray(v) && v.every(nonBlank)],
  ["evidence.executionMode", (v) => v === "real"],
  ["evidence.controllerRunLog", (v) => asRecord(v).exportsOwnLogPerJob === true],
  ["evidence.instrumentSignsOutput", (v) => v === true],
  [
    "evidence.referenceSample",
    (v) => asRecord(v).available === true && nonBlank(asRecord(v).expectedResultRef),
  ],
  [
    "evidence.camera",
    (v) =>
      asRecord(v).seesWorkArea === true && asRecord(v).seesOutput === true && nonBlank(asRecord(v).captureDeviceId),
  ],
  ["evidence.approver", (v) => nonBlank(asRecord(v).name)],
]);

/** The field ids that have a substance rule (a test pins that every tier field
 *  that maps to an evidence primitive is among them). */
export const TIER_SUBSTANCE_RULE_FIELDS: readonly string[] = Object.freeze([...TIER_SUBSTANCE_RULES.keys()].sort());

/** Is `field` required by a tier milestone in `implied`? */
function requiredByTier(requiredFor: readonly IntakeMilestone[], implied: ReadonlySet<IntakeMilestone>): boolean {
  return requiredFor.some((rf) => TIER_MILESTONES.includes(rf) && implied.has(rf));
}

/**
 * The evidence primitives mapped by tier fields that `implied` (a milestone's
 * implication closure) requires and that are NOT `active` + `live` in
 * EVIDENCE_PRIMITIVES, sorted and de-duplicated. Empty for a milestone that
 * implies neither tier.
 */
export function stubPrimitivesFor(implied: ReadonlySet<IntakeMilestone>): string[] {
  const stubs = new Set<string>();
  for (const field of INTAKE_FIELDS) {
    if (!field.evidencePrimitive || !requiredByTier(field.requiredFor, implied)) continue;
    const primitive = getPrimitive(field.evidencePrimitive.id);
    if (!(primitive?.status === "active" && primitive.verifierStatus === "live")) stubs.add(field.evidencePrimitive.id);
  }
  return [...stubs].sort();
}

/**
 * Required tier fields (in registry order) whose answer is present, satisfied
 * its own schema (`parsedValues` holds those values) and still fails its
 * substance rule. An absent or malformed answer is `missing` /
 * `invalidFields`, not reported here.
 */
export function insubstantialTierFields(
  implied: ReadonlySet<IntakeMilestone>,
  parsedValues: ReadonlyMap<string, unknown>,
): string[] {
  const insubstantial: string[] = [];
  for (const field of INTAKE_FIELDS) {
    const rule = TIER_SUBSTANCE_RULES.get(field.id);
    if (!rule || !requiredByTier(field.requiredFor, implied) || !parsedValues.has(field.id)) continue;
    if (!rule(parsedValues.get(field.id))) insubstantial.push(field.id);
  }
  return insubstantial;
}
