/**
 * Device intake — what the tier-intake milestones ("tier1-intake-complete",
 * "tier2-intake-complete") may and may not claim.
 *
 * They mean ONLY that the intake holds substantive answers a tier-1 / tier-2
 * evidence program will need. They confer no tier readiness and no assurance:
 * whether a device can reach a tier — which committed verification program
 * applies, whether its verifiers are live, whether its parameters can be built —
 * is decided by the evidence lane at activation, never by intake and never from
 * the evidence registry's mutable verifierStatus (astra pack 120c, HIGH 5).
 *
 * What intake does check, for those milestones (and any milestone implying
 * them): an answer can satisfy its field's schema and still be empty for the
 * program it will feed (a camera that sees neither the work area nor the
 * output, a controller that does not export its own log).
 * TIER_SUBSTANCE_RULES lists, per field, the value it must have; a
 * shape-valid answer that fails its rule is reported in `insubstantial`.
 */

import { INTAKE_FIELDS, type IntakeMilestone } from "./fields.js";

const TIER_MILESTONES: readonly IntakeMilestone[] = ["tier1-intake-complete", "tier2-intake-complete"];

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
 * Per tier-intake field, what a shape-valid answer must also be to be of use
 * to the evidence program it will feed (named per field below, for reference
 * only). Each rule sees the value that already satisfied the field's schema.
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
