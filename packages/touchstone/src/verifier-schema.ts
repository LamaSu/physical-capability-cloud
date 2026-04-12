/**
 * Schema-validation verifier — verifies a touchstone result by validating the
 * executor's output against a JSON Schema (represented as a validation function).
 *
 * This module is deliberately schema-library agnostic.  It accepts a
 * `validate` function that returns either `{ success: true }` or
 * `{ success: false; errors: string[] }`.  Callers can adapt Zod, Ajv, or any
 * other validator to this interface trivially.
 */

import type { TouchstoneResult } from "./types.js";

// ---------------------------------------------------------------------------
// Validation function interface
// ---------------------------------------------------------------------------

/** Result of a schema validation. */
export interface SchemaValidationOutcome {
  success: boolean;
  errors?: string[];
}

/**
 * A validation function that checks a value against a schema.
 * Any schema library (Zod, Ajv, etc.) can be adapted to this shape.
 */
export type SchemaValidator = (value: unknown) => SchemaValidationOutcome;

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/**
 * Verify that `actual` conforms to the given schema.
 *
 * @param taskId    The touchstone task identifier.
 * @param validate  A schema validation function.
 * @param actual    The executor's actual output.
 * @returns A `TouchstoneResult` with `passed: true` when the output is valid.
 */
export function verifySchemaMatch(
  taskId: string,
  validate: SchemaValidator,
  actual: unknown,
): TouchstoneResult {
  const start = performance.now();

  const outcome = validate(actual);
  const passed = outcome.success;

  const executionTimeMs = Math.round(performance.now() - start);

  const errors = outcome.errors ?? [];

  return {
    taskId,
    passed,
    score: passed ? 1.0 : 0.0,
    verificationDetails: passed
      ? "Schema validation passed: output conforms to the expected schema."
      : `Schema validation failed: ${errors.join("; ") || "unknown validation error"}.`,
    executionTimeMs,
  };
}
