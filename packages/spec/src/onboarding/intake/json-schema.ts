/**
 * Device intake — JSON Schema 2020-12 generation.
 *
 * A minimal, hand-rolled zod-shape -> JSON-Schema-fragment converter. This
 * package intentionally carries no `zod-to-json-schema` dependency (spec
 * constraint: no third-party installs); the converter only needs to cover the
 * finite set of zod primitives actually used by `INTAKE_FIELDS[].valueSchema`
 * (string/number/boolean/enum/literal(true)/object/array/optional/union, and
 * refinements). It is a DOCUMENTATION-grade projection, not a re-implementation
 * of validation: the generated schema says so in its `$comment`, and passing
 * it is NOT intake acceptance. Runtime validation always goes through the zod
 * schemas directly (`validateIntake`, `IntakeAnswerSchema.safeParse`), never
 * through this generated schema.
 *
 * The converter fails rather than guesses: a zod node or check it does not
 * cover THROWS (it never emits `{}`, which would accept anything), so a field
 * added with an unsupported schema breaks generation loudly instead of
 * silently widening the documented schema.
 */

import { z } from "zod";
import { CONTENT_HASH_LENGTH, CONTENT_HASH_PATTERN } from "../citation-rules.js";
import { isConfirmationRequired } from "./confirmation.js";
import { INTAKE_FIELDS, INTAKE_PROVENANCE_VALUES, type IntakeFieldDef } from "./fields.js";

type ZodCheck = { kind: string; value?: unknown; inclusive?: boolean; regex?: RegExp };

function unwrapOptional(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny };
  return def.typeName === z.ZodFirstPartyTypeKind.ZodOptional && def.innerType
    ? unwrapOptional(def.innerType)
    : schema;
}

/** The `$comment` on a node that wraps a refinement: the JSON Schema cannot
 *  express a zod `.refine`, so the projection is looser than the zod schema. */
const REFINEMENTS_NOT_REPRESENTED = "refinements not represented";

function unsupported(what: string): never {
  throw new Error(`zodToJsonSchemaFragment: unsupported ${what}`);
}

/**
 * Project one zod schema to a JSON-Schema-2020-12 fragment. Covers string,
 * number, boolean, literal, enum, array, object, optional and union nodes; a
 * `.refine` wrapper (ZodEffects) is converted through its inner schema with
 * `"$comment": "refinements not represented"` on that node. THROWS on any other
 * node — and on any string/number check it does not represent — instead of
 * emitting a permissive `{}`.
 */
export function zodToJsonSchemaFragment(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as {
    typeName: string;
    checks?: ZodCheck[];
    values?: readonly string[];
    value?: unknown;
    type?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
    schema?: z.ZodTypeAny;
    effect?: { type: string };
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
    shape?: () => Record<string, z.ZodTypeAny>;
    unknownKeys?: string;
    catchall?: z.ZodTypeAny;
    options?: readonly z.ZodTypeAny[];
  };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const fragment: Record<string, unknown> = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") fragment.minLength = check.value;
        else if (check.kind === "max") fragment.maxLength = check.value;
        else if (check.kind === "length") {
          fragment.minLength = check.value;
          fragment.maxLength = check.value;
        } else if (check.kind === "regex" && check.regex) fragment.pattern = check.regex.source;
        else if (check.kind === "email") fragment.format = "email";
        else if (check.kind === "url") fragment.format = "uri";
        else if (check.kind === "datetime") fragment.format = "date-time";
        else unsupported(`string check "${check.kind}"`);
      }
      return fragment;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const fragment: Record<string, unknown> = { type: "number" };
      for (const check of def.checks ?? []) {
        if (check.kind === "int") fragment.type = "integer";
        else if (check.kind === "min") {
          if (check.inclusive === false) fragment.exclusiveMinimum = check.value;
          else fragment.minimum = check.value;
        } else if (check.kind === "max") {
          if (check.inclusive === false) fragment.exclusiveMaximum = check.value;
          else fragment.maximum = check.value;
        } else if (check.kind === "multipleOf") fragment.multipleOf = check.value;
        else if (check.kind === "finite") {
          // a JSON number is always finite: nothing to add
        } else unsupported(`number check "${check.kind}"`);
      }
      return fragment;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: def.value };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...(def.values ?? [])] };
    case z.ZodFirstPartyTypeKind.ZodArray: {
      if (!def.type) unsupported("array without an element schema");
      const fragment: Record<string, unknown> = {
        type: "array",
        items: zodToJsonSchemaFragment(def.type),
      };
      if (def.minLength) fragment.minItems = def.minLength.value;
      if (def.maxLength) fragment.maxItems = def.maxLength.value;
      return fragment;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      if (def.catchall && (def.catchall._def as { typeName: string }).typeName !== z.ZodFirstPartyTypeKind.ZodNever) {
        unsupported("object catchall");
      }
      const shape = def.shape?.() ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const optional = value.isOptional();
        properties[key] = zodToJsonSchemaFragment(optional ? unwrapOptional(value) : value);
        if (!optional) required.push(key);
      }
      const fragment: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) fragment.required = required;
      if (def.unknownKeys === "strict") fragment.additionalProperties = false;
      return fragment;
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
      if (!def.innerType) unsupported("optional without an inner schema");
      return zodToJsonSchemaFragment(def.innerType);
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: (def.options ?? []).map((o) => zodToJsonSchemaFragment(o)) };
    case z.ZodFirstPartyTypeKind.ZodEffects: {
      // A refinement keeps the input shape, so the inner schema is the right
      // projection; a transform or preprocess can change what is accepted.
      if (def.effect?.type !== "refinement" || !def.schema) unsupported(`effect "${def.effect?.type ?? "unknown"}"`);
      return { ...zodToJsonSchemaFragment(def.schema), $comment: REFINEMENTS_NOT_REPRESENTED };
    }
    default:
      return unsupported(`zod node ${def.typeName}`);
  }
}

function fieldAnnotations(field: IntakeFieldDef): Record<string, unknown> {
  const annotations: Record<string, unknown> = {
    "x-pcc-class": field.class,
    "x-pcc-fills": field.fills.map((f) => `${f.artifact}:${f.path}`),
    "x-pcc-requiredFor": field.requiredFor,
    "x-pcc-neverDefault": field.neverDefault ?? false,
    "x-pcc-confirmationRequired": isConfirmationRequired(field.id),
    "x-pcc-sensitive": field.sensitive ?? false,
    "x-pcc-why": field.why,
  };
  if (field.selfDeclaredOnly) annotations["x-pcc-selfDeclaredOnly"] = true;
  if (field.ifUnknown) annotations["x-pcc-ifUnknown"] = field.ifUnknown;
  if (field.evidencePrimitive) {
    annotations["x-pcc-evidencePrimitive"] = {
      id: field.evidencePrimitive.id,
      status: field.evidencePrimitive.status,
      note:
        field.evidencePrimitive.status === "stub"
          ? "stub = proves nothing yet"
          : undefined,
    };
  }
  return annotations;
}

/** The operative warning carried by the generated schema (top-level `$comment`). */
export const INTAKE_JSON_SCHEMA_COMMENT =
  "Documentation/projection only. Passing this schema is not PCC intake acceptance. Consumers must use the authoritative Zod record parser, per-field validation, milestone validation, and confirmation/secret-policy checks.";

/**
 * Build the full device-intake JSON Schema (2020-12). DOCUMENTATION ONLY: the
 * top-level `$comment` and `x-pcc-authority` say so, and passing this schema is
 * not intake acceptance (it omits the cumulative milestone policy, the
 * human-confirmation requirement, `min <= max`, the secret scan and the
 * forbidden-key rules — all enforced by `validateIntake`). It does encode that
 * an answer with research/confirmed provenance carries a `source` (if/then).
 * Deterministic key order (properties are inserted in `INTAKE_FIELDS` order) so
 * the committed `device-intake.schema.json` diff is stable across
 * regenerations. Throws if a field's schema uses a zod node the converter does
 * not cover (see `zodToJsonSchemaFragment`).
 */
export function buildIntakeJsonSchema(): Record<string, unknown> {
  const answerProperties: Record<string, unknown> = {};
  for (const field of INTAKE_FIELDS) {
    answerProperties[field.id] = {
      type: "object",
      properties: {
        value: zodToJsonSchemaFragment(field.valueSchema),
        provenance: { type: "string", enum: [...INTAKE_PROVENANCE_VALUES] },
        source: {
          type: "object",
          properties: {
            doc: { type: "string", minLength: 1, pattern: "\\S" },
            section: { type: "string", pattern: "\\S" },
            // IntakeSourceSchema also requires https and no credentials; not represented here.
            url: { type: "string", format: "uri", $comment: "refinements not represented" },
            // The same format IntakeSourceSchema and a research citation accept (astra pack 120d).
            // The length bound keeps it exact in every regex dialect: some validators treat `$` as
            // matching before a final newline (Python's re.search), which JavaScript's does not (120e).
            contentHash: {
              type: "string",
              pattern: CONTENT_HASH_PATTERN.source,
              minLength: CONTENT_HASH_LENGTH,
              maxLength: CONTENT_HASH_LENGTH,
            },
          },
          required: ["doc"],
          additionalProperties: false,
        },
        confirmation: {
          type: "object",
          properties: { eventId: { type: "string", minLength: 1, maxLength: 256 } },
          required: ["eventId"],
          additionalProperties: false,
        },
      },
      required: ["value", "provenance"],
      // IntakeAnswerSchema: research/confirmed provenance requires a source.
      if: { properties: { provenance: { enum: ["research", "confirmed"] } }, required: ["provenance"] },
      then: { required: ["source"] },
      additionalProperties: false,
      question: field.question,
      ...fieldAnnotations(field),
    };
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "pcc://onboarding/device-intake.schema.json",
    $comment: INTAKE_JSON_SCHEMA_COMMENT,
    "x-pcc-authority": "documentation-only",
    title: "PCC Device Intake",
    description:
      "One entry per permanent intake field id. Each answer records a value, its provenance, (for research/confirmed provenance) a source, and optionally a confirmation reference. x-pcc-* annotations carry the R2 policy: class, fills, requiredFor, neverDefault, confirmationRequired, sensitive, why, and evidence-primitive status.",
    type: "object",
    properties: {
      schema: { const: "pcc.device-intake.v1" },
      answers: {
        type: "object",
        properties: answerProperties,
        additionalProperties: false,
      },
    },
    required: ["schema", "answers"],
    additionalProperties: false,
  };
}
