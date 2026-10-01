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
import { joinPath, pathSegment, scanIntakeStrings, type IntakeSecretHit } from "./secret-scan.js";

export * from "./fields.js";
export * from "./json-schema.js";
export * from "./form-html.js";
export {
  INTAKE_SECRET_KINDS,
  redactIntakeSecrets,
  scanIntakeStrings,
  type IntakeSecretHit,
  type IntakeSecretKind,
} from "./secret-scan.js";

// ── Answer + record shapes ──────────────────────────────────────────────

export const IntakeProvenanceSchema = z.enum(INTAKE_PROVENANCE_VALUES);

export const IntakeSourceSchema = z
  .object({
    doc: z.string().min(1),
    section: z.string().optional(),
    url: z.string().url().optional(),
  })
  .strict();
export type IntakeSource = z.infer<typeof IntakeSourceSchema>;

/**
 * R2 rule 6: every answer records its provenance. `research`/`confirmed`
 * provenance requires a `source` (a document id or URL the agent cites).
 */
export const IntakeAnswerSchema = z
  .object({
    value: z.unknown(),
    provenance: IntakeProvenanceSchema,
    source: IntakeSourceSchema.optional(),
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

// ── validateIntake — the runtime boundary ───────────────────────────────

export interface IntakeValidationReport {
  /** True iff every list below is empty. */
  ok: boolean;
  /** Field ids required for `milestone` that lack a satisfying answer. */
  missing: string[];
  /** Field ids where a `neverDefault` field has an answer whose provenance is
   *  "probe" or "research" (unconfirmed) — a global invariant, checked over
   *  every answer present regardless of milestone (R2 rule 4: "never filled
   *  with a guess"). */
  neverDefaultViolations: string[];
  /** `fieldId` (or `fieldId.key`) pairs where an INTAKE_FORBIDDEN_KEYS key was
   *  found anywhere in an answer's value/source, or used as a field id itself. */
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
  };
}

const FIELD_INDEX: ReadonlyMap<string, IntakeFieldDef> = new Map(
  INTAKE_FIELDS.map((f) => [f.id, f]),
);

/** Case/underscore/hyphen-insensitive normalization so `assurance_tier`,
 *  `AssuranceTier`, `private-key`, `PrivateKey`, and `HASH` all match their
 *  canonical INTAKE_FORBIDDEN_KEYS spelling (review fix — was exact-match). */
function normalizeForbiddenKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
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

/** Collect any INTAKE_FORBIDDEN_KEYS key (loosely matched — see isForbiddenKey)
 *  found as an object key inside `root` (arrays are walked, primitives are
 *  ignored). The literal key encountered is recorded (not its canonical
 *  spelling), so the report shows exactly what was found. Iterative, so depth
 *  cannot overflow the stack; an object reachable twice is visited once. */
function collectForbiddenKeys(root: unknown, out: Set<string>): void {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (isForbiddenKey(key)) out.add(key);
      stack.push(value);
    }
  }
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
  for (const [fieldId, answer] of Object.entries(answers)) {
    const shownId = pathSegment(fieldId);
    if (isForbiddenKey(fieldId)) forbiddenKeyHits.add(shownId);
    if (!FIELD_INDEX.has(fieldId)) unknownFields.add(shownId);
    if (!isRecordObject(answer)) continue;

    const keyHits = new Set<string>();
    collectForbiddenKeys(answer.value, keyHits);
    collectForbiddenKeys(answer.source, keyHits);
    for (const key of keyHits) forbiddenKeyHits.add(`${shownId}.${pathSegment(key)}`);
  }
  report.forbiddenKeys.push(...forbiddenKeyHits);
  report.unknownFields.push(...unknownFields);
}

/** The milestone checks, over a record that already parsed. */
function checkParsedRecord(record: IntakeRecord, milestone: IntakeMilestone, report: IntakeValidationReport): void {
  const impliedMilestones: ReadonlySet<IntakeMilestone> = new Set(MILESTONE_IMPLIES[milestone]);
  const neverDefaultViolations = new Set<string>();
  const sensitiveViolations = new Set<string>();
  const invalidFields = new Set<string>();
  const valueValid = new Map<string, boolean>();

  // Every present known field, whatever the milestone: its value must satisfy
  // its own schema, and the global provenance/sensitive invariants hold.
  for (const [fieldId, answer] of Object.entries(record.answers)) {
    const field = FIELD_INDEX.get(fieldId);
    if (!field) continue;

    const valid = field.valueSchema.safeParse(answer.value).success;
    valueValid.set(fieldId, valid);
    if (!valid) invalidFields.add(fieldId);
    if (field.neverDefault && (answer.provenance === "probe" || answer.provenance === "research")) {
      neverDefaultViolations.add(fieldId);
    }
    if (field.sensitive && !valid) sensitiveViolations.add(fieldId);
  }

  const missing: string[] = [];
  for (const field of INTAKE_FIELDS) {
    if (!field.requiredFor.some((rf) => impliedMilestones.has(rf))) continue;
    const answer = record.answers[field.id];
    if (!answer) {
      missing.push(field.id);
      continue;
    }
    if (field.neverDefault && answer.provenance !== "human" && answer.provenance !== "confirmed") {
      missing.push(field.id);
      continue;
    }
    if (valueValid.get(field.id) !== true) {
      missing.push(field.id);
      continue;
    }
  }

  report.missing.push(...missing);
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
 *      `secretsInText`. Forbidden keys and unknown field ids are read from the
 *      raw input as well, so they are reported even when the parse fails.
 *   4. Milestone readiness (rule 4: a `neverDefault` field only satisfies a
 *      milestone with provenance "human" or "confirmed"; an unconfirmed
 *      probe/research answer on a neverDefault field is ALWAYS flagged
 *      independent of milestone via `neverDefaultViolations`).
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
export function validateIntake(input: unknown, milestone: IntakeMilestone): IntakeValidationReport {
  const report = emptyReport();
  try {
    const milestoneKnown = (INTAKE_MILESTONES as readonly string[]).includes(milestone);
    if (!milestoneKnown) report.structuralErrors.push("milestone: not a known intake milestone");

    scanRawInput(input, report);

    const parsed = IntakeRecordSchema.safeParse(input);
    if (!parsed.success) {
      report.structuralErrors.push(...parsed.error.issues.map(describeIssue));
    } else if (milestoneKnown) {
      checkParsedRecord(parsed.data, milestone, report);
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
