// Minimal Zod -> JSON Schema converter, scoped to the shapes web-extract
// actually feeds Claude (object roots with primitive / array / nested-object
// children, optional fields). We avoid pulling in zod-to-json-schema (~30 kB
// dep, half a meg of source) because the surface we exercise is small.
//
// Supported: ZodObject, ZodArray, ZodString, ZodNumber, ZodBoolean, ZodEnum,
// ZodLiteral, ZodOptional, ZodNullable, ZodDefault, ZodUnion (union of
// literals -> enum), ZodAny.
//
// Anything we don't recognise is emitted as `{}` (any), with a console.warn
// in dev. Throwing would be too aggressive — JSON Schema "everything-allowed"
// is a safe fallback that the model will mostly ignore.
//
// Ported verbatim from `LamaSu/navi` packages/backend/src/tools/zod-json-schema.ts.

import { z, type ZodTypeAny } from "zod";

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean;
  [k: string]: unknown;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName;

  if (!def || !typeName) return {};

  switch (typeName) {
    case "ZodObject": {
      const shape = ((schema as unknown) as z.ZodObject<z.ZodRawShape>).shape as Record<string, ZodTypeAny>;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        properties[key] = describeWithDescription(val);
        if (!isOptional(val)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      out.additionalProperties = false;
      attachDescription(schema, out);
      return out;
    }
    case "ZodArray": {
      const inner = (def as { type?: ZodTypeAny }).type;
      const out: JsonSchema = {
        type: "array",
        items: inner ? zodToJsonSchema(inner) : {},
      };
      attachDescription(schema, out);
      return out;
    }
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      attachDescription(schema, out);
      return out;
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      attachDescription(schema, out);
      return out;
    }
    case "ZodBoolean": {
      const out: JsonSchema = { type: "boolean" };
      attachDescription(schema, out);
      return out;
    }
    case "ZodEnum": {
      const values = (def as { values?: unknown[] }).values ?? [];
      const out: JsonSchema = { type: "string", enum: values };
      attachDescription(schema, out);
      return out;
    }
    case "ZodNativeEnum": {
      const obj = (def as { values?: Record<string, unknown> }).values ?? {};
      const out: JsonSchema = { enum: Object.values(obj) };
      attachDescription(schema, out);
      return out;
    }
    case "ZodLiteral": {
      const value = (def as { value?: unknown }).value;
      const out: JsonSchema = { const: value };
      if (typeof value === "string") out.type = "string";
      else if (typeof value === "number") out.type = "number";
      else if (typeof value === "boolean") out.type = "boolean";
      attachDescription(schema, out);
      return out;
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault": {
      const inner = (def as { innerType?: ZodTypeAny }).innerType;
      return inner ? zodToJsonSchema(inner) : {};
    }
    case "ZodUnion": {
      const options = (def as { options?: ZodTypeAny[] }).options ?? [];
      // Union of literals -> enum
      const allLiterals = options.every(
        (o) => (o as { _def?: { typeName?: string } })._def?.typeName === "ZodLiteral"
      );
      if (allLiterals && options.length > 0) {
        const values = options.map(
          (o) => (o as unknown as { _def: { value: unknown } })._def.value
        );
        return { enum: values };
      }
      // Otherwise emit anyOf
      return { anyOf: options.map(zodToJsonSchema) };
    }
    case "ZodAny":
    case "ZodUnknown":
      return {};
    default:
      // eslint-disable-next-line no-console
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[zod-json-schema] unhandled ${typeName}, emitting empty schema`);
      }
      return {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const tn = (schema as { _def?: { typeName?: string } })._def?.typeName;
  return tn === "ZodOptional" || tn === "ZodDefault";
}

function describeWithDescription(schema: ZodTypeAny): JsonSchema {
  const out = zodToJsonSchema(schema);
  attachDescription(schema, out);
  return out;
}

function attachDescription(schema: ZodTypeAny, out: JsonSchema): void {
  const desc = (schema as { description?: string }).description;
  if (desc && !out.description) out.description = desc;
}
