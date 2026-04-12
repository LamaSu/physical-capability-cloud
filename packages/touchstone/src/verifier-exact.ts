/**
 * Exact-match verifier — verifies a touchstone result via deep equality
 * or hash comparison.
 */

import type { TouchstoneResult } from "./types.js";

/**
 * Canonicalize a value to a stable JSON string for comparison.
 * Sorts object keys recursively to ensure deterministic output.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) {
    return "__undefined__";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  const entries = sorted.map(
    (k) => JSON.stringify(k) + ":" + canonicalize((value as Record<string, unknown>)[k]),
  );
  return "{" + entries.join(",") + "}";
}

/**
 * Verify that `actual` exactly matches `expected` via deep structural equality.
 *
 * Comparison is performed on canonical JSON representations with sorted keys,
 * so object key order does not affect the result.
 *
 * @param taskId  The touchstone task identifier.
 * @param expected  The ground-truth expected output.
 * @param actual    The executor's actual output.
 * @returns A `TouchstoneResult` with `passed: true` on exact match.
 */
export function verifyExactMatch(
  taskId: string,
  expected: unknown,
  actual: unknown,
): TouchstoneResult {
  const start = performance.now();

  const expectedCanon = canonicalize(expected);
  const actualCanon = canonicalize(actual);
  const passed = expectedCanon === actualCanon;

  const executionTimeMs = Math.round(performance.now() - start);

  return {
    taskId,
    passed,
    score: passed ? 1.0 : 0.0,
    verificationDetails: passed
      ? "Exact match: canonical representations are identical."
      : `Mismatch: expected ${expectedCanon.slice(0, 200)}, got ${actualCanon.slice(0, 200)}.`,
    executionTimeMs,
  };
}
