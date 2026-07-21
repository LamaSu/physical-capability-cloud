/**
 * Minimal, dependency-free validation of a tool's params against its generated
 * JSON-Schema (`input_schema`). We deliberately do NOT pull in ajv — the schema
 * subset we emit is small and known (types, enum, min/max, required, dataset
 * refs), so a hand-rolled checker keeps the adapter's runtime deps at zero
 * beyond @pcc/* + tweetnacl (clean Gate-A vet).
 */

import type { GalaxyToolSpec } from "./types.js";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface PropSchema {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  "x-galaxy-kind"?: string;
  "x-galaxy-datatype"?: string[];
}

function isDatasetRef(spec: PropSchema): boolean {
  return spec["x-galaxy-kind"] === "dataset-ref";
}

function checkOne(path: string, value: unknown, spec: PropSchema): ValidationError | null {
  // Dataset inputs accept a string id/url OR a {src,...} ref object.
  if (isDatasetRef(spec)) {
    const ok =
      typeof value === "string" ||
      (typeof value === "object" && value !== null && "src" in (value as object)) ||
      Array.isArray(value); // collections
    return ok ? null : { path, message: "expected a dataset reference (id/url string or {src,...})" };
  }

  if (spec.enum && !spec.enum.map(String).includes(String(value))) {
    return { path, message: `must be one of: ${spec.enum.join(", ")}` };
  }

  switch (spec.type) {
    case "integer":
      if (!Number.isInteger(Number(value))) return { path, message: "must be an integer" };
      break;
    case "number":
      if (Number.isNaN(Number(value))) return { path, message: "must be a number" };
      break;
    case "boolean":
      if (typeof value !== "boolean" && value !== "true" && value !== "false")
        return { path, message: "must be a boolean" };
      break;
    case "array":
      if (!Array.isArray(value)) return { path, message: "must be an array" };
      break;
    // "string" and unknown types: accept as-is
  }

  if (spec.type === "integer" || spec.type === "number") {
    const n = Number(value);
    if (spec.minimum !== undefined && n < spec.minimum)
      return { path, message: `must be >= ${spec.minimum}` };
    if (spec.maximum !== undefined && n > spec.maximum)
      return { path, message: `must be <= ${spec.maximum}` };
  }
  return null;
}

/**
 * Validate `params` (keyed by dotted param path) against `tool.input_schema`.
 * Reports missing required params AND unknown params (a typo'd key is a common
 * agent mistake we want to catch before hitting Galaxy).
 */
export function validateParams(
  tool: GalaxyToolSpec,
  params: Record<string, unknown>,
): ValidationResult {
  const schema = tool.input_schema as {
    properties?: Record<string, PropSchema>;
    required?: string[];
  };
  const props = schema.properties ?? {};
  const errors: ValidationError[] = [];

  for (const key of schema.required ?? []) {
    const v = params[key];
    if (v === undefined || v === null || v === "") {
      errors.push({ path: key, message: "required parameter missing" });
    }
  }

  for (const [key, value] of Object.entries(params)) {
    const spec = props[key];
    if (!spec) {
      errors.push({ path: key, message: `unknown parameter for tool '${tool.id}'` });
      continue;
    }
    if (value === undefined || value === null) continue;
    const err = checkOne(key, value, spec);
    if (err) errors.push(err);
  }

  return { valid: errors.length === 0, errors };
}
