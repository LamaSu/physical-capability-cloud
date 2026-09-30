/**
 * Device intake — JSON Schema 2020-12 generation.
 *
 * A minimal, hand-rolled zod-shape -> JSON-Schema-fragment converter. This
 * package intentionally carries no `zod-to-json-schema` dependency (spec
 * constraint: no third-party installs); the converter only needs to cover the
 * finite set of zod primitives actually used by `INTAKE_FIELDS[].valueSchema`
 * (string/number/boolean/enum/literal(true)/object/array/optional) — it is a
 * DOCUMENTATION-grade projection, not a re-implementation of validation.
 * Runtime validation always goes through the zod schemas directly
 * (`validateIntake`, `IntakeAnswerSchema.safeParse`), never through this
 * generated schema.
 */

import { z } from "zod";
import { INTAKE_FIELDS, INTAKE_PROVENANCE_VALUES, type IntakeFieldDef } from "./fields.js";

type ZodCheck = { kind: string; value?: unknown; inclusive?: boolean; regex?: RegExp };

function unwrapOptional(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema._def as { typeName: string; innerType?: z.ZodTypeAny };
  return def.typeName === z.ZodFirstPartyTypeKind.ZodOptional && def.innerType
    ? unwrapOptional(def.innerType)
    : schema;
}

/**
 * Project one zod schema to a JSON-Schema-2020-12 fragment. Falls back to `{}`
 * (permissive/"any") for any zod construct outside the covered set — this
 * keeps the converter total (never throws) at the cost of precision on
 * constructs the field registry doesn't currently use.
 */
export function zodToJsonSchemaFragment(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as {
    typeName: string;
    checks?: ZodCheck[];
    values?: readonly string[];
    value?: unknown;
    type?: z.ZodTypeAny;
    innerType?: z.ZodTypeAny;
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
    shape?: () => Record<string, z.ZodTypeAny>;
    unknownKeys?: string;
    options?: readonly z.ZodTypeAny[];
  };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const fragment: Record<string, unknown> = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") fragment.minLength = check.value;
        else if (check.kind === "max") fragment.maxLength = check.value;
        else if (check.kind === "regex" && check.regex) fragment.pattern = check.regex.source;
        else if (check.kind === "email") fragment.format = "email";
        else if (check.kind === "url") fragment.format = "uri";
        else if (check.kind === "datetime") fragment.format = "date-time";
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
        }
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
      const fragment: Record<string, unknown> = {
        type: "array",
        items: def.type ? zodToJsonSchemaFragment(def.type) : {},
      };
      if (def.minLength) fragment.minItems = def.minLength.value;
      if (def.maxLength) fragment.maxItems = def.maxLength.value;
      return fragment;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
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
      return def.innerType ? zodToJsonSchemaFragment(def.innerType) : {};
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { anyOf: (def.options ?? []).map((o) => zodToJsonSchemaFragment(o)) };
    default:
      return {};
  }
}

function fieldAnnotations(field: IntakeFieldDef): Record<string, unknown> {
  const annotations: Record<string, unknown> = {
    "x-pcc-class": field.class,
    "x-pcc-fills": field.fills.map((f) => `${f.artifact}:${f.path}`),
    "x-pcc-requiredFor": field.requiredFor,
    "x-pcc-neverDefault": field.neverDefault ?? false,
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

/**
 * Build the full device-intake JSON Schema (2020-12). Deterministic key order
 * (properties are inserted in `INTAKE_FIELDS` order) so the committed
 * `device-intake.schema.json` diff is stable across regenerations.
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
            doc: { type: "string", minLength: 1 },
            section: { type: "string" },
            url: { type: "string", format: "uri" },
          },
          required: ["doc"],
          additionalProperties: false,
        },
      },
      required: ["value", "provenance"],
      additionalProperties: false,
      question: field.question,
      ...fieldAnnotations(field),
    };
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "pcc://onboarding/device-intake.schema.json",
    title: "PCC Device Intake",
    description:
      "One entry per permanent intake field id. Each answer records a value, its provenance, and (for research/confirmed provenance) a source. x-pcc-* annotations carry the R2 policy: class, fills, requiredFor, neverDefault, sensitive, why, and evidence-primitive status.",
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
