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
  INTAKE_PROVENANCE_VALUES,
  MILESTONE_IMPLIES,
  type IntakeFieldDef,
  type IntakeMilestone,
} from "./fields.js";
import { scanIntakeStrings, type IntakeSecretHit } from "./secret-scan.js";

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

// ── validateIntake — R2 rules 4-6 as a milestone gate ───────────────────

export interface IntakeValidationReport {
  /** True iff every check below is clean. */
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
  /** Where a string anywhere in the record matches a secret/sensitive-value
   *  detector (`scanIntakeStrings`): `{path, kind}` only, never the text. A
   *  record with a hit is not ok — reject it, do not store or log it. */
  secretsInText: IntakeSecretHit[];
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

/** Recursively collect any INTAKE_FORBIDDEN_KEYS key (loosely matched — see
 *  isForbiddenKey) found as an object key inside `node` (arrays are walked,
 *  primitives are ignored). The literal key encountered is recorded (not its
 *  canonical spelling), so the report shows exactly what was found. */
function collectForbiddenKeys(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectForbiddenKeys(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (isForbiddenKey(key)) out.add(key);
    collectForbiddenKeys(value, out);
  }
}

/** Does this answer's value satisfy `field`'s own shape rules (schema shape,
 *  and — for sensitive fields — the {set:true}-only rule, which `valueSchema`
 *  already encodes for every sensitive field in INTAKE_FIELDS)? */
function valueSatisfiesField(field: IntakeFieldDef, value: unknown): boolean {
  return field.valueSchema.safeParse(value).success;
}

/**
 * Validate an intake record against one milestone gate. Enforces:
 *   - rule 4 (never-defaulted): a `neverDefault` field only satisfies a
 *     milestone with provenance "human" or "confirmed"; an unconfirmed
 *     probe/research answer on a neverDefault field is ALWAYS flagged
 *     (independent of milestone) via `neverDefaultViolations`.
 *   - rule 5 (sensitive): a `sensitive` field's value must be exactly
 *     {set: true} — never the real payload.
 *   - rule 6 (provenance + source): structural — enforced by
 *     `IntakeAnswerSchema` at record-construction time, not re-checked here.
 * Milestone matching is CUMULATIVE (review fix): a field is required for
 * `milestone` if its own `requiredFor` contains `milestone` OR any milestone
 * that `milestone` implies (MILESTONE_IMPLIES in fields.ts — e.g. accept-jobs
 * implies publish, so a record missing a publish-level field can never be
 * "ready" for accept-jobs; tier2 implies tier1, register-device, identify and
 * register). "optional" implies nothing, so an optional field never blocks
 * any other milestone.
 */
export function validateIntake(
  record: IntakeRecord,
  milestone: IntakeMilestone,
): IntakeValidationReport {
  const impliedMilestones: ReadonlySet<IntakeMilestone> = new Set(MILESTONE_IMPLIES[milestone]);
  const neverDefaultViolations = new Set<string>();
  const forbiddenKeyHits = new Set<string>();
  const sensitiveViolations = new Set<string>();
  const unknownFields = new Set<string>();
  const secretsInText = scanIntakeStrings(record);

  for (const [fieldId, answer] of Object.entries(record.answers)) {
    const field = FIELD_INDEX.get(fieldId);
    if (!field) unknownFields.add(fieldId);
    if (isForbiddenKey(fieldId)) forbiddenKeyHits.add(fieldId);

    const keyHits = new Set<string>();
    collectForbiddenKeys(answer.value, keyHits);
    collectForbiddenKeys(answer.source, keyHits);
    for (const key of keyHits) forbiddenKeyHits.add(`${fieldId}.${key}`);

    if (!field) continue;

    if (field.neverDefault && (answer.provenance === "probe" || answer.provenance === "research")) {
      neverDefaultViolations.add(fieldId);
    }
    if (field.sensitive && !valueSatisfiesField(field, answer.value)) {
      sensitiveViolations.add(fieldId);
    }
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
    if (!valueSatisfiesField(field, answer.value)) {
      missing.push(field.id);
      continue;
    }
  }

  const neverDefaultList = [...neverDefaultViolations];
  const forbiddenKeys = [...forbiddenKeyHits];
  const sensitiveList = [...sensitiveViolations];
  const unknownList = [...unknownFields];

  return {
    ok:
      missing.length === 0 &&
      neverDefaultList.length === 0 &&
      forbiddenKeys.length === 0 &&
      sensitiveList.length === 0 &&
      unknownList.length === 0 &&
      secretsInText.length === 0,
    missing,
    neverDefaultViolations: neverDefaultList,
    forbiddenKeys,
    sensitiveViolations: sensitiveList,
    unknownFields: unknownList,
    secretsInText,
  };
}

// ── Execution-mode tier cap (addendum: "may only LOWER the tier") ───────

/** Highest tier representable when no cap applies. Callers `Math.min()` their
 *  own computed tier against this — the cap is a ceiling, never a floor. */
export const NO_EXECUTION_MODE_CAP = 3 as const;

/**
 * The tier ceiling `evidence.executionMode` imposes, independent of anything
 * else in the record: "mock"/"dry_run" caps at 0 (mirrors evidence/primitives.ts
 * `confirm.execution_mode`'s `gates: true` negative gate); "real", or no answer
 * yet, imposes no cap. This can only LOWER an otherwise-eligible tier — it is
 * never itself a source of eligibility, so callers combine it via
 * `Math.min(computedTier, executionModeTierCap(record))`.
 */
export function executionModeTierCap(record: IntakeRecord): 0 | 1 | 2 | 3 {
  const mode = record.answers["evidence.executionMode"]?.value;
  return mode === "mock" || mode === "dry_run" ? 0 : NO_EXECUTION_MODE_CAP;
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
