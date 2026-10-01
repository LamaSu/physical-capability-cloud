/**
 * Device intake — records, validation, and JSON Schema export.
 *
 * - fields.ts       — INTAKE_FIELDS (the single source of truth) + forbidden keys.
 * - json-schema.ts  — buildIntakeJsonSchema() (JSON Schema 2020-12 + x-pcc-* annotations).
 * - form-html.ts    — buildFormHtml() (the printable HTML form).
 * - this file       — IntakeAnswer/IntakeRecord + validateIntake() (R2 rules 4-6)
 *                      + intakeFieldArtifactMap() + the execution-mode tier cap.
 *
 * Source spec: returns/pcc-kits-work/intake-spec-item6-20260929.md, R2 rules 1-6
 * and the "Addendum, 16:40 PDT".
 */

import { z } from "zod";
import {
  INTAKE_FIELDS,
  INTAKE_FORBIDDEN_KEYS,
  INTAKE_MILESTONES,
  INTAKE_PROVENANCE_VALUES,
  MILESTONE_IMPLIES,
  type IntakeFieldDef,
  type IntakeMilestone,
} from "./fields.js";
import type { CsdRegistry } from "../../csd/registry.js";
import { intakeValueHash, isConfirmationRequired } from "./confirmation.js";
import { joinPath, pathSegment, scanIntakeStrings, type IntakeSecretHit } from "./secret-scan.js";
import {
  ESTOP_NONE_APPROVED_CAPABILITIES,
  checkSafetyLimits,
  numberParametersOf,
  type SafetyLimit,
} from "./safety-policy.js";
import { insubstantialTierFields, stubPrimitivesFor } from "./tier-readiness.js";
import { walkValue } from "./walk.js";

export * from "./fields.js";
export * from "./json-schema.js";
export * from "./form-html.js";
export { CONFIRMATION_REQUIRED_FIELDS, intakeValueHash } from "./confirmation.js";
export { ESTOP_NONE_APPROVED_CAPABILITIES } from "./safety-policy.js";
export {
  INTAKE_SECRET_KINDS,
  redactIntakeSecrets,
  scanIntakeStrings,
  type IntakeSecretHit,
  type IntakeSecretKind,
} from "./secret-scan.js";

// ── Answer + record shapes ──────────────────────────────────────────────

/**
 * Descriptive metadata, NOT authority: whoever builds the record writes the
 * provenance, so "human" or "confirmed" proves nothing by itself. What
 * authenticates a human is the confirmation store behind `IntakeAuthority`
 * (see `validateIntake`).
 */
export const IntakeProvenanceSchema = z.enum(INTAKE_PROVENANCE_VALUES);

export const IntakeSourceSchema = z
  .object({
    doc: z.string().min(1),
    section: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();
export type IntakeSource = z.infer<typeof IntakeSourceSchema>;

/** A pointer to the authenticated confirmation event that backs an answer. The
 *  reference is only a pointer; `validateIntake` resolves it through
 *  `IntakeAuthority` and checks what the store holds. */
export const IntakeConfirmationRefSchema = z.object({ eventId: z.string().min(1).max(256) }).strict();
export type IntakeConfirmationRef = z.infer<typeof IntakeConfirmationRefSchema>;

/**
 * R2 rule 6: every answer records its provenance. `research`/`confirmed`
 * provenance requires a `source` (a document id or URL the agent cites).
 * `confirmation`, when present, points at the confirmation event that backs the
 * answer; for fields in CONFIRMATION_REQUIRED_FIELDS it is required for the
 * answer to satisfy a milestone (the provenance label alone never is).
 */
export const IntakeAnswerSchema = z
  .object({
    value: z.unknown(),
    provenance: IntakeProvenanceSchema,
    source: IntakeSourceSchema.optional(),
    confirmation: IntakeConfirmationRefSchema.optional(),
  })
  .strict()
  .superRefine((answer, ctx) => {
    if ((answer.provenance === "research" || answer.provenance === "confirmed") && !answer.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `provenance "${answer.provenance}" requires a source`,
        path: ["source"],
      });
    }
  });
export type IntakeAnswer = z.infer<typeof IntakeAnswerSchema>;

export const INTAKE_RECORD_SCHEMA_ID = "pcc.device-intake.v1" as const;

export const IntakeRecordSchema = z
  .object({
    schema: z.literal(INTAKE_RECORD_SCHEMA_ID),
    answers: z.record(IntakeAnswerSchema),
  })
  .strict();
export type IntakeRecord = z.infer<typeof IntakeRecordSchema>;

// ── Authority: confirmation events, payout store, CSD lookup ────────────

/**
 * One authenticated human confirmation, as the confirmation store (e.g. the
 * ADK trace store) holds it. The store — not the record — is what
 * authenticates the human: `confirmedBy` is the identity the store verified
 * (`authMethod` says how), and the event binds the field id, the canonical
 * hash of the confirmed value (`intakeValueHash(answer.value)`) and of its
 * source (`intakeValueHash(answer.source)`), the device/project it is about,
 * a sequence and timestamp, the session challenge, and its own supersession
 * and revocation state.
 */
export interface IntakeConfirmationEvent {
  schema: "pcc.intake-confirmation.v1";
  eventId: string;
  fieldId: string;
  /** sha256:<hex> of canonicalize(answer.value) */
  valueHash: string;
  /** sha256:<hex> of canonicalize(answer.source), when the answer has one */
  sourceHash?: string;
  confirmedBy: { principal: string; authMethod: "siwe" | "api-key" | "session" };
  subject: { deviceRef: string; projectRef?: string };
  sequence: number;
  confirmedAt: string;
  challenge: string;
  supersededBy: string | null;
  revoked: boolean;
}

/** What `validateIntake` requires of an event the authority returns. Parsed
 *  before use, so a malformed event never confirms anything. */
export const IntakeConfirmationEventSchema = z.object({
  schema: z.literal("pcc.intake-confirmation.v1"),
  eventId: z.string().min(1),
  fieldId: z.string().min(1),
  valueHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  confirmedBy: z.object({
    principal: z.string().min(1),
    authMethod: z.enum(["siwe", "api-key", "session"]),
  }),
  subject: z.object({ deviceRef: z.string().min(1), projectRef: z.string().min(1).optional() }),
  sequence: z.number().int().nonnegative(),
  confirmedAt: z.string().datetime({ offset: true }),
  challenge: z.string().min(1),
  supersededBy: z.string().min(1).nullable(),
  revoked: z.boolean(),
}) satisfies z.ZodType<IntakeConfirmationEvent>;

/**
 * The authenticated sources `validateIntake` re-reads instead of trusting the
 * record. The caller supplies it; the record cannot. Subject binding is the
 * authority's job: `resolveConfirmation` must only return events for the
 * device/project being validated, and `payoutDestinationExists` must answer for
 * that same operator. An authority method that throws is treated as "not
 * confirmed" / "no payout destination" (fail-closed).
 */
export interface IntakeAuthority {
  /** The authenticated confirmation store (e.g. the ADK trace store). Returns null when unknown. */
  resolveConfirmation(eventId: string): IntakeConfirmationEvent | null;
  /** Re-reads the authoritative payout store (N21); never the record's {set:true}. */
  payoutDestinationExists(): boolean;
  /** CSD lookup for limit binding (section 4); defaults to loadBuiltinCsds(). */
  csdRegistry?: CsdRegistry;
}


// ── validateIntake — the runtime boundary ───────────────────────────────

export interface IntakeValidationReport {
  /** True iff every list below is empty. */
  ok: boolean;
  /** Field ids required for `milestone` that lack a satisfying answer. */
  missing: string[];
  /** Field ids in CONFIRMATION_REQUIRED_FIELDS (every `neverDefault` field and
   *  every field a `humanConfirmRequired` research entry fills — despite the
   *  name, not only the neverDefault ones) whose answer has provenance
   *  "probe" or "research" — a global invariant, checked over every answer
   *  present regardless of milestone (R2 rule 4: "never filled with a
   *  guess"). */
  neverDefaultViolations: string[];
  /** `fieldId` (or `fieldId.key`) pairs where an INTAKE_FORBIDDEN_KEYS key was
   *  found anywhere in an answer's value/source, or used as a field id itself.
   *  The comparison is NFKC-normalized, case-insensitive and ignores `_` and
   *  `-`. */
  forbiddenKeys: string[];
  /** Field ids marked `sensitive` whose stored value is not exactly {set: true}
   *  (R2 rule 5). */
  sensitiveViolations: string[];
  /** Keys in `record.answers` that are not a known INTAKE_FIELD_IDS entry. */
  unknownFields: string[];
  /** Where a string anywhere in the input matches a secret/sensitive-value
   *  detector (`scanIntakeStrings`): `{path, kind}` only, never the text. A
   *  record with a hit is not ok — reject it, do not store or log it. */
  secretsInText: IntakeSecretHit[];
  /** The input does not parse as an IntakeRecord (strict, provenance + source
   *  rules included), or `milestone` is not a known milestone: zod issue
   *  paths and messages, never values. When this is non-empty the milestone
   *  checks were not run, so `missing`, `neverDefaultViolations`,
   *  `sensitiveViolations` and `invalidFields` are empty; `forbiddenKeys`,
   *  `unknownFields` and `secretsInText` are still reported from the raw input. */
  structuralErrors: string[];
  /** Field ids that are present (whether or not `milestone` requires them) and
   *  whose value does not satisfy the field's own `valueSchema`. */
  invalidFields: string[];
  /** Field ids required for `milestone` that are in CONFIRMATION_REQUIRED_FIELDS
   *  and whose answer is present but not backed by an authenticated
   *  confirmation: provenance is not "human"/"confirmed", or there is no
   *  `confirmation` reference, or no `authority` was supplied, or the event
   *  the authority resolves does not match (unknown, wrong field id, value or
   *  source hash mismatch, revoked, superseded, or malformed). */
  unconfirmed: string[];
  /** `"payout.destination"` when `milestone` is (or implies) "get-paid" and
   *  `authority.payoutDestinationExists()` is not exactly true (or no authority
   *  was supplied): the record's `{set: true}` is never trusted for that. */
  unverified: string[];
  /** Problems with `safety.limits` against the CSD that `capability.type`
   *  names (looked up in `authority.csdRegistry`, else the built-in CSDs): one
   *  entry per bad limit (index and reason, never a value) — quantity not a
   *  number parameter of the CSD, unit outside the closed table or not the
   *  parameter's, bounds outside the parameter's range, duplicate quantity.
   *  `"unbound: no CSD"` when `capability.type` is absent or does not resolve
   *  and `milestone` requires safety.limits. */
  limitErrors: string[];
  /** Safety policy that blocks publish / accept-jobs (any milestone implying
   *  publish): `safety.estop` `{mechanism: "none"}` on a capability that is not
   *  in ESTOP_NONE_APPROVED_CAPABILITIES. */
  safetyBlocks: string[];
  /** Paths (`answers/<fieldId>/value/.../<key>`, characters outside printable
   *  ASCII written as `\u{hex}`) of every object key that contains a non-ASCII
   *  character, in an answer's value or source or as a field id. Keys come from
   *  a closed protocol vocabulary that is ASCII, so a non-ASCII key (a Cyrillic
   *  look-alike of "privateKey", say) is rejected outright, whatever it
   *  spells. Paths only, never values. */
  nonAsciiKeys: string[];
  /** For a milestone that is (or implies) tier1/tier2: the evidence primitives
   *  its required fields map to that are not `active` + `live` in
   *  EVIDENCE_PRIMITIVES (stub, planned, reserved, deprecated or unknown), sorted.
   *  A stub fails closed: tier readiness means only that the intake can feed a
   *  LIVE verifier, never that the device is assured. */
  stubPrimitives: string[];
  /** Field ids required by tier1/tier2 whose answer satisfies the field's
   *  schema but proves nothing for its primitive (e.g. a camera that sees
   *  neither the work area nor the output, `exportsOwnLogPerJob: false`); see
   *  TIER_SUBSTANCE_RULES in tier-readiness.ts. */
  insubstantial: string[];
}

/** Every list-valued member of the report: `ok` is true iff all are empty. The
 *  `satisfies` makes the compiler fail when a list is added without being
 *  counted here. */
type IntakeReportList = {
  [K in keyof IntakeValidationReport]: IntakeValidationReport[K] extends readonly unknown[] ? K : never;
}[keyof IntakeValidationReport];

const REPORT_LISTS = Object.keys({
  missing: true,
  neverDefaultViolations: true,
  forbiddenKeys: true,
  sensitiveViolations: true,
  unknownFields: true,
  secretsInText: true,
  structuralErrors: true,
  invalidFields: true,
  unconfirmed: true,
  unverified: true,
  limitErrors: true,
  safetyBlocks: true,
  stubPrimitives: true,
  insubstantial: true,
  nonAsciiKeys: true,
} satisfies Record<IntakeReportList, true>) as IntakeReportList[];

function emptyReport(): IntakeValidationReport {
  return {
    ok: false,
    missing: [],
    neverDefaultViolations: [],
    forbiddenKeys: [],
    sensitiveViolations: [],
    unknownFields: [],
    secretsInText: [],
    structuralErrors: [],
    invalidFields: [],
    unconfirmed: [],
    unverified: [],
    limitErrors: [],
    safetyBlocks: [],
    stubPrimitives: [],
    insubstantial: [],
    nonAsciiKeys: [],
  };
}

const FIELD_INDEX: ReadonlyMap<string, IntakeFieldDef> = new Map(
  INTAKE_FIELDS.map((f) => [f.id, f]),
);

/** NFKC, case and underscore/hyphen-insensitive normalization so
 *  `assurance_tier`, `AssuranceTier`, `private-key`, `PrivateKey`, `HASH` and a
 *  full-width spelling all match their canonical INTAKE_FORBIDDEN_KEYS
 *  spelling. NFKC folds compatibility forms only (full-width letters,
 *  ligatures); it does not fold look-alikes from other scripts — those are
 *  rejected by the non-ASCII key check instead. */
function normalizeForbiddenKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[_-]/g, "");
}

const FORBIDDEN_KEY_NORMALIZED_SET: ReadonlySet<string> = new Set(
  INTAKE_FORBIDDEN_KEYS.map(normalizeForbiddenKey),
);

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEY_NORMALIZED_SET.has(normalizeForbiddenKey(key));
}

function isRecordObject(node: unknown): node is Record<string, unknown> {
  return node !== null && typeof node === "object" && !Array.isArray(node);
}

/** Does `key` contain a character outside ASCII? */
function hasNonAscii(key: string): boolean {
  return /[^\x00-\x7f]/.test(key);
}

/** A zod issue as `path: description`. Only the issue code, static text and
 *  type names are used — never `issue.message` for built-in issues, because
 *  zod's own messages can quote the offending value. */
function describeIssue(issue: z.ZodIssue): string {
  const where = issue.path.length === 0 ? "(root)" : joinPath(issue.path.map(String));
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return `${where}: expected ${issue.expected}, received ${issue.received}`;
    case z.ZodIssueCode.custom:
      return `${where}: ${issue.message}`;
    case z.ZodIssueCode.invalid_string:
      return `${where}: invalid_string (${typeof issue.validation === "string" ? issue.validation : "pattern"})`;
    default:
      return `${where}: ${issue.code}`;
  }
}

/** Checks that read the RAW input, so they hold whether or not it parses (and
 *  see what a parse would drop, e.g. an `answers["__proto__"]` entry). */
function scanRawInput(input: unknown, report: IntakeValidationReport): void {
  report.secretsInText.push(...scanIntakeStrings(input));

  const answers = isRecordObject(input) && isRecordObject(input.answers) ? input.answers : {};
  const forbiddenKeyHits = new Set<string>();
  const unknownFields = new Set<string>();
  const nonAsciiKeys = new Set<string>();
  for (const [fieldId, answer] of Object.entries(answers)) {
    const shownId = pathSegment(fieldId);
    if (isForbiddenKey(fieldId)) forbiddenKeyHits.add(shownId);
    if (!FIELD_INDEX.has(fieldId)) unknownFields.add(shownId);
    if (hasNonAscii(fieldId)) nonAsciiKeys.add(joinPath(["answers", fieldId]));
    if (!isRecordObject(answer)) continue;

    // Keys inside the answer's value and source: a forbidden concept (reported
    // as `fieldId.key`) and a non-ASCII key (reported by path).
    for (const part of ["value", "source"] as const) {
      walkValue(answer[part], {
        key: (key, path) => {
          if (isForbiddenKey(key)) forbiddenKeyHits.add(`${shownId}.${pathSegment(key)}`);
          if (hasNonAscii(key)) nonAsciiKeys.add(joinPath(["answers", fieldId, part, ...path()]));
        },
      });
    }
  }
  report.forbiddenKeys.push(...forbiddenKeyHits);
  report.unknownFields.push(...unknownFields);
  report.nonAsciiKeys.push(...nonAsciiKeys);
}

/** Is `answer` (for `fieldId`) backed by a confirmation event that `authority`
 *  resolves and that matches it? Every failure — including an authority that
 *  throws or returns something malformed — is "no". */
function confirmationHolds(fieldId: string, answer: IntakeAnswer, authority: IntakeAuthority | undefined): boolean {
  if (answer.provenance !== "human" && answer.provenance !== "confirmed") return false;
  if (!answer.confirmation || !authority) return false;

  let resolved: unknown;
  try {
    resolved = authority.resolveConfirmation(answer.confirmation.eventId);
  } catch {
    return false;
  }
  const parsed = IntakeConfirmationEventSchema.safeParse(resolved);
  if (!parsed.success) return false;

  const event = parsed.data;
  if (event.eventId !== answer.confirmation.eventId) return false;
  if (event.fieldId !== fieldId) return false;
  if (event.valueHash !== intakeValueHash(answer.value)) return false;
  // The source is bound too: an event that carries a source hash confirms THAT
  // source, so an answer that dropped or changed it is not the confirmed one.
  const expectedSourceHash = answer.source === undefined ? undefined : intakeValueHash(answer.source);
  if (event.sourceHash !== expectedSourceHash) return false;
  return event.revoked === false && event.supersededBy === null;
}

function payoutDestinationExists(authority: IntakeAuthority | undefined): boolean {
  try {
    return authority?.payoutDestinationExists() === true;
  } catch {
    return false;
  }
}

/** The safety rules that depend on the selected capability (safety-policy.ts):
 *  `safety.limits` bound to the CSD, and `estop: none`. `parsedValues` holds the
 *  value of every present known field that satisfied its own schema. */
function checkSafetyPolicy(
  record: IntakeRecord,
  impliedMilestones: ReadonlySet<IntakeMilestone>,
  parsedValues: ReadonlyMap<string, unknown>,
  authority: IntakeAuthority | undefined,
  report: IntakeValidationReport,
): void {
  const capabilityType = parsedValues.get("capability.type");

  const limits = parsedValues.get("safety.limits") as readonly SafetyLimit[] | undefined;
  if (limits) {
    const parameters = numberParametersOf(capabilityType, authority?.csdRegistry);
    const limitsRequired = FIELD_INDEX.get("safety.limits")!.requiredFor.some((rf) => impliedMilestones.has(rf));
    if (!parameters && limitsRequired) report.limitErrors.push("unbound: no CSD");
    report.limitErrors.push(...checkSafetyLimits(limits, parameters));
  }

  const estop = parsedValues.get("safety.estop") as { mechanism: string } | undefined;
  if (
    estop?.mechanism === "none" &&
    impliedMilestones.has("publish") &&
    !(typeof capabilityType === "string" && ESTOP_NONE_APPROVED_CAPABILITIES.includes(capabilityType))
  ) {
    report.safetyBlocks.push('safety.estop: mechanism "none" is not approved for this capability');
  }
}

/** The milestone checks, over a record that already parsed. */
function checkParsedRecord(
  record: IntakeRecord,
  milestone: IntakeMilestone,
  authority: IntakeAuthority | undefined,
  report: IntakeValidationReport,
): void {
  const impliedMilestones: ReadonlySet<IntakeMilestone> = new Set(MILESTONE_IMPLIES[milestone]);
  const neverDefaultViolations = new Set<string>();
  const sensitiveViolations = new Set<string>();
  const invalidFields = new Set<string>();
  const valueValid = new Map<string, boolean>();
  const parsedValues = new Map<string, unknown>();

  // Every present known field, whatever the milestone: its value must satisfy
  // its own schema, and the global provenance/sensitive invariants hold.
  for (const [fieldId, answer] of Object.entries(record.answers)) {
    const field = FIELD_INDEX.get(fieldId);
    if (!field) continue;

    const result = field.valueSchema.safeParse(answer.value);
    const valid = result.success;
    valueValid.set(fieldId, valid);
    if (result.success) parsedValues.set(fieldId, result.data);
    if (!valid) invalidFields.add(fieldId);
    if (isConfirmationRequired(fieldId) && (answer.provenance === "probe" || answer.provenance === "research")) {
      neverDefaultViolations.add(fieldId);
    }
    if (field.sensitive && !valid) sensitiveViolations.add(fieldId);
  }

  const missing: string[] = [];
  const unconfirmed: string[] = [];
  for (const field of INTAKE_FIELDS) {
    if (!field.requiredFor.some((rf) => impliedMilestones.has(rf))) continue;
    const answer = record.answers[field.id];
    if (!answer) {
      missing.push(field.id);
      continue;
    }
    const needsConfirmation = isConfirmationRequired(field.id);
    if (needsConfirmation && answer.provenance !== "human" && answer.provenance !== "confirmed") {
      missing.push(field.id);
      unconfirmed.push(field.id);
      continue;
    }
    if (valueValid.get(field.id) !== true) {
      missing.push(field.id);
      continue;
    }
    if (needsConfirmation && !confirmationHolds(field.id, answer, authority)) unconfirmed.push(field.id);
  }

  // The record's {set: true} for the payout destination is a claim; get-paid
  // (and nothing else) re-reads the authoritative payout store instead.
  if (impliedMilestones.has("get-paid") && !payoutDestinationExists(authority)) {
    report.unverified.push("payout.destination");
  }

  checkSafetyPolicy(record, impliedMilestones, parsedValues, authority, report);
  report.stubPrimitives.push(...stubPrimitivesFor(impliedMilestones));
  report.insubstantial.push(...insubstantialTierFields(impliedMilestones, parsedValues));

  report.missing.push(...missing);
  report.unconfirmed.push(...unconfirmed);
  report.neverDefaultViolations.push(...neverDefaultViolations);
  report.sensitiveViolations.push(...sensitiveViolations);
  report.invalidFields.push(...invalidFields);
}

/**
 * Validate an UNPARSED intake record against one milestone gate. This is the
 * runtime boundary: `input` is `unknown`, it is parsed here, and nothing about
 * its shape is assumed.
 *
 *   1. The whole input is parsed with `IntakeRecordSchema` (strict; the
 *      provenance + source rule of IntakeAnswerSchema included). A parse
 *      failure returns `ok: false` with `structuralErrors` (zod paths and
 *      messages, never values) — it does not throw. An input that cannot even
 *      be read (a throwing getter) is also a structural error, never an
 *      exception. An unknown `milestone` is a structural error too.
 *   2. EVERY present known field's value is checked against its own
 *      `valueSchema`, independent of the milestone; a failure is listed in
 *      `invalidFields` and makes the report not ok even when the milestone
 *      does not require that field. (Sensitive fields: the value must be
 *      exactly {set: true}, R2 rule 5 — also listed in `sensitiveViolations`.)
 *   3. Every string anywhere in the input is scanned for secrets and
 *      sensitive values (`scanIntakeStrings`; see secret-scan.ts), reported in
 *      `secretsInText`. Forbidden keys, unknown field ids and non-ASCII keys are
 *      read from the raw input as well, so they are reported even when the
 *      parse fails. Every object key in an answer's value or source (and every
 *      field id) must be ASCII: keys come from a closed protocol vocabulary, so
 *      a non-ASCII key makes the report not ok (`nonAsciiKeys`, paths only),
 *      and forbidden keys are matched after NFKC normalization.
 *   4. Milestone readiness. A field in CONFIRMATION_REQUIRED_FIELDS (every
 *      `neverDefault` field, plus every field a `humanConfirmRequired`
 *      research entry fills, e.g. capability.parameters) satisfies a milestone
 *      ONLY when ALL of these hold: its provenance is "human" or "confirmed";
 *      the answer carries a `confirmation: {eventId}`; an `authority` was
 *      supplied; and `authority.resolveConfirmation(eventId)` returns an
 *      event with the same field id, a `valueHash` equal to
 *      `intakeValueHash(answer.value)`, a `sourceHash` equal to
 *      `intakeValueHash(answer.source)` (and none when the answer has no
 *      source), `revoked === false` and `supersededBy === null`. Otherwise it
 *      is listed in `unconfirmed` and the milestone is not ok. The provenance
 *      label alone is descriptive metadata, never authority; the authority's
 *      store is what authenticates the human. A confirmation-required answer
 *      with probe/research provenance is ALWAYS flagged, independent of
 *      milestone, via `neverDefaultViolations`.
 *      "get-paid" (and nothing that does not imply it) also needs
 *      `authority.payoutDestinationExists() === true`; otherwise
 *      "payout.destination" is listed in `unverified`.
 *   5. Safety limits bind to the selected CSD (safety-policy.ts): when
 *      `safety.limits` is present and well-formed, each entry's quantity must
 *      be a NUMBER parameter of the CSD that `capability.type` names (looked
 *      up in `authority.csdRegistry`, else the built-in CSDs), its unit must
 *      convert to that parameter's declared unit through a small closed table,
 *      it must lie within the parameter's own [min, max], and a quantity may
 *      appear once; problems go to `limitErrors` and make the report not ok
 *      for any milestone. When `capability.type` is absent or does not
 *      resolve, the limits cannot be validated and a milestone requiring
 *      safety.limits is not ready ("unbound: no CSD"). `safety.estop`
 *      `{mechanism: "none"}` blocks publish and every milestone implying it
 *      (accept-jobs, get-paid) unless `capability.type` is in
 *      ESTOP_NONE_APPROVED_CAPABILITIES (`safetyBlocks`).
 *   6. Tier readiness (tier1, tier2 and anything implying them) means only
 *      that the intake can feed a LIVE verifier, never that the device is
 *      assured, and it fails closed (tier-readiness.ts): every evidence
 *      primitive a required tier field maps to must be active + live in
 *      EVIDENCE_PRIMITIVES, else it is listed in `stubPrimitives`; and a
 *      shape-valid answer that proves nothing for its primitive (e.g. a camera
 *      that sees neither the work area nor the output) is listed in
 *      `insubstantial`. With the shipped registry (stub primitives) the tiers
 *      are not ready.
 * Milestone matching is CUMULATIVE (review fix): a field is required for
 * `milestone` if its own `requiredFor` contains `milestone` OR any milestone
 * that `milestone` implies (MILESTONE_IMPLIES in fields.ts — e.g. accept-jobs
 * implies publish, so a record missing a publish-level field can never be
 * "ready" for accept-jobs; tier2 implies tier1, register-device, identify and
 * register). "optional" implies nothing, so an optional field never blocks
 * any other milestone.
 *
 * Producers: call this before logging or persisting a record, and again before
 * any public projection; a record that is not ok is rejected, not stored.
 */
export function validateIntake(
  input: unknown,
  milestone: IntakeMilestone,
  authority?: IntakeAuthority,
): IntakeValidationReport {
  const report = emptyReport();
  try {
    const milestoneKnown = (INTAKE_MILESTONES as readonly string[]).includes(milestone);
    if (!milestoneKnown) report.structuralErrors.push("milestone: not a known intake milestone");

    scanRawInput(input, report);

    const parsed = IntakeRecordSchema.safeParse(input);
    if (!parsed.success) {
      report.structuralErrors.push(...parsed.error.issues.map(describeIssue));
    } else if (milestoneKnown) {
      checkParsedRecord(parsed.data, milestone, authority, report);
    }
  } catch {
    // An input that cannot be read (a throwing getter, a hostile proxy) fails
    // closed instead of throwing.
    report.structuralErrors.push("(root): input could not be read");
  }
  report.ok = REPORT_LISTS.every((list) => report[list].length === 0);
  return report;
}

// ── Execution-mode tier cap (addendum: "may only LOWER the tier") ───────

/** Highest tier representable when no cap applies. Callers `Math.min()` their
 *  own computed tier against this — the cap is a ceiling, never a floor. */
export const NO_EXECUTION_MODE_CAP = 3 as const;

/**
 * The tier ceiling `evidence.executionMode` imposes, independent of anything
 * else in the record, and FAIL-CLOSED: `input` is parsed here, and only an
 * answer whose value is exactly "real" imposes no cap (NO_EXECUTION_MODE_CAP).
 * Everything else returns 0 — "mock"/"dry_run" (mirrors evidence/primitives.ts
 * `confirm.execution_mode`'s `gates: true` negative gate), but also a missing
 * answer, a malformed answer or record (it does not parse), and any other
 * value or casing ("Real", "MOCK"). This can only LOWER an otherwise-eligible
 * tier — it is never itself a source of eligibility, so callers combine it via
 * `Math.min(computedTier, executionModeTierCap(record))`.
 */
export function executionModeTierCap(input: unknown): 0 | 1 | 2 | 3 {
  try {
    const parsed = IntakeRecordSchema.safeParse(input);
    if (!parsed.success) return 0;
    return parsed.data.answers["evidence.executionMode"]?.value === "real" ? NO_EXECUTION_MODE_CAP : 0;
  } catch {
    return 0;
  }
}

// ── Artifact map ─────────────────────────────────────────────────────────

/** Map of `artifact` name -> sorted, de-duplicated field ids that fill it. */
export function intakeFieldArtifactMap(): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};
  for (const field of INTAKE_FIELDS) {
    for (const fill of field.fills) {
      (map[fill.artifact] ??= new Set<string>()).add(field.id);
    }
  }
  const result: Record<string, string[]> = {};
  for (const [artifact, ids] of Object.entries(map)) {
    result[artifact] = [...ids].sort();
  }
  return result;
}
