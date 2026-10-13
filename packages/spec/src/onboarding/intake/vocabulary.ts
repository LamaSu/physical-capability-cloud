/**
 * Device intake — the closed key vocabulary: every object key a well-formed
 * intake record can contain. A report or log line may show a key VERBATIM only
 * if it is in this set (or is an array index); any other key is written as a
 * one-way digest (see `pathSegment` in secret-scan.ts), because an unknown key
 * is exactly where a caller can paste a credential whose format no detector
 * recognizes (astra pack 120c, CRITICAL 1).
 *
 * The set is derived in code, never hand-listed: the INTAKE_FIELDS ids, every
 * property name reachable in a field's `valueSchema`, and the keys of the
 * record, answer, source and confirmation shapes. Internal to the intake module.
 */

import { z } from "zod";
import { INTAKE_FIELDS } from "./fields.js";

/** The structural keys of the record, an answer, its source and its confirmation reference. */
const STRUCTURAL_KEYS = [
  "schema",
  "answers",
  "value",
  "provenance",
  "source",
  "confirmation",
  "doc",
  "section",
  "url",
  "contentHash",
  "eventId",
] as const;

/** Every property name reachable in `schema`: object shapes, through arrays, optionals, unions and refinements. */
function collectPropertyNames(schema: z.ZodTypeAny, out: Set<string>, seen: Set<z.ZodTypeAny>): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = schema._def as Record<string, unknown> & { typeName?: string };
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      for (const [key, value] of Object.entries(shape)) {
        out.add(key);
        collectPropertyNames(value as z.ZodTypeAny, out, seen);
      }
      return;
    }
    case z.ZodFirstPartyTypeKind.ZodArray:
      collectPropertyNames(def.type as z.ZodTypeAny, out, seen);
      return;
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      collectPropertyNames(def.innerType as z.ZodTypeAny, out, seen);
      return;
    case z.ZodFirstPartyTypeKind.ZodEffects:
      collectPropertyNames(def.schema as z.ZodTypeAny, out, seen);
      return;
    case z.ZodFirstPartyTypeKind.ZodUnion:
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      for (const option of def.options as z.ZodTypeAny[]) collectPropertyNames(option, out, seen);
      return;
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      collectPropertyNames(def.left as z.ZodTypeAny, out, seen);
      collectPropertyNames(def.right as z.ZodTypeAny, out, seen);
      return;
    case z.ZodFirstPartyTypeKind.ZodTuple:
      for (const item of def.items as z.ZodTypeAny[]) collectPropertyNames(item, out, seen);
      return;
    case z.ZodFirstPartyTypeKind.ZodRecord:
      // A record's keys are free text, so none joins the vocabulary; its values can still hold objects.
      collectPropertyNames(def.valueType as z.ZodTypeAny, out, seen);
      return;
    default:
      return;
  }
}

function buildVocabulary(): ReadonlySet<string> {
  const keys = new Set<string>(STRUCTURAL_KEYS);
  const seen = new Set<z.ZodTypeAny>();
  for (const field of INTAKE_FIELDS) {
    keys.add(field.id);
    collectPropertyNames(field.valueSchema, keys, seen);
  }
  return keys;
}

/** Every key a well-formed intake record can contain. Internal: intake/index.ts does not re-export it. */
export const INTAKE_KEY_VOCABULARY: ReadonlySet<string> = buildVocabulary();
