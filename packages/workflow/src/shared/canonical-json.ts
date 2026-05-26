/**
 * Deterministic canonical JSON for content-addressable hashing.
 *
 * Rules (adapted from @pcc/spec canonical.ts, close to RFC 8785):
 *   1. Object keys sorted lexicographically at every depth.
 *   2. No insignificant whitespace.
 *   3. `undefined` keys are omitted; `null` is preserved.
 *   4. Arrays preserve order.
 *   5. Numbers are serialized via JSON.stringify (no quoting, no NaN/Infinity).
 *
 * This module does NOT depend on @pcc/spec to keep the package standalone,
 * but the byte output is byte-equal for overlapping inputs.
 */

import type { CanonicalInput } from './types.js';

/** JSON value types the canonical serializer accepts. */
export type JsonLike =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonLike[]
  | { [k: string]: JsonLike };

/**
 * Serialize a value deterministically. Throws on non-JSON values
 * (functions, symbols, BigInt). NaN/Infinity are NOT permitted.
 */
export function canonicalJSON(value: JsonLike): string {
  if (value === undefined || value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJSON: non-finite number not allowed: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'bigint') {
    throw new Error('canonicalJSON: bigint is not a canonical JSON value');
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJSON(v ?? null));
    return '[' + items.join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, JsonLike>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error(`canonicalJSON: unsupported value type: ${typeof value}`);
}

/**
 * Treat the input as a CanonicalInput (no undefined at the top-level, etc).
 * This is a typed wrapper for callers already holding a CanonicalInput.
 */
export function canonicalJSONStrict(value: CanonicalInput): string {
  return canonicalJSON(value as JsonLike);
}

/**
 * Parse a canonical JSON string back into a plain JS value.
 * Round-tripping a canonical string through parse/canonicalJSON yields
 * an identical byte sequence.
 */
export function parseCanonical<T = unknown>(s: string): T {
  return JSON.parse(s) as T;
}
