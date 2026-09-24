/**
 * Canonical serialization and hashing for evidence events and bundles.
 *
 * Rules:
 * 1. JSON keys are sorted lexicographically at all depths.
 * 2. No whitespace.
 * 3. Numbers are not quoted.
 * 4. Null values are included; undefined values are omitted.
 * 5. SHA-256 of the canonical JSON produces the content hash.
 *
 * This ensures that identical data always produces the same hash,
 * regardless of key insertion order or formatting.
 */

import type { EvidenceEvent, EvidenceBundle } from "../types/evidence.js";
import type { SHA256 } from "../types/common.js";

/**
 * Raised when a value has no JSON form. Its canonical text could not survive
 * JSON transport or be reproduced by a non-JavaScript consumer, so a hash over
 * it could never be verified anywhere else.
 */
export class NonCanonicalValueError extends Error {
  readonly path: string;
  constructor(path: string, what: string) {
    super(`canonicalize: ${what} at ${path} has no JSON form; refusing to hash it`);
    this.name = "NonCanonicalValueError";
    this.path = path;
  }
}

/**
 * Canonicalize any value to a deterministic JSON string.
 * Keys sorted lexicographically at all depths.
 *
 * Only JSON values are accepted: strings, finite numbers, booleans, null,
 * arrays and plain objects (undefined object members are omitted, and an
 * undefined array element is null, as in JSON). Anything else — NaN, Infinity,
 * a bigint, a function, a symbol, a Date, a Map or any other non-plain object —
 * throws NonCanonicalValueError instead of producing text only this function
 * could reproduce.
 *
 * Numbers follow the evidence number policy D5 (evidence commitment profile v1
 * §1), which the oracle and VCR enforce too: an integer outside the safe range
 * (|n| > 2^53 - 1) has already lost precision and must travel as a decimal
 * string, so it is refused. A sparse-array hole and a cyclic reference are
 * refused as well; JSON has no form for either.
 */
export function canonicalize(value: unknown): string {
  return canonicalizeAt(value, "$", new Set());
}

function canonicalizeAt(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NonCanonicalValueError(path, String(value));
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new NonCanonicalValueError(
        path,
        `the integer ${String(value)}, outside the safe range (send it as a decimal string)`,
      );
    }
    return String(value);
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new NonCanonicalValueError(path, "a cyclic reference");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new NonCanonicalValueError(`${path}[${i}]`, "a hole in a sparse array");
          items.push(canonicalizeAt(value[i], `${path}[${i}]`, ancestors));
        }
        return "[" + items.join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "non-plain";
        throw new NonCanonicalValueError(path, `a ${name} object`);
      }
      const record = value as Record<string, unknown>;
      const pairs = Object.keys(record)
        .sort()
        .filter((k) => record[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonicalizeAt(record[k], `${path}.${k}`, ancestors));
      return "{" + pairs.join(",") + "}";
    } finally {
      ancestors.delete(value);
    }
  }
  throw new NonCanonicalValueError(path, `a ${typeof value}`);
}

/**
 * Compute SHA-256 hash of a string.
 * Uses Web Crypto API (available in Node 18+ and browsers).
 */
export async function sha256(input: string): Promise<SHA256> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  // Use Web Crypto API
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  return `sha256:${hashHex}` as SHA256;
}

/**
 * Hash an evidence event.
 * Hashes the canonical JSON of: type + timestamp + source + payload.
 */
export async function hashEvent(
  event: Omit<EvidenceEvent, "hash" | "id">
): Promise<SHA256> {
  const hashInput = {
    type: event.type,
    timestamp: event.timestamp,
    source: event.source,
    payload: event.payload,
  };
  return sha256(canonicalize(hashInput));
}

/**
 * Hash an evidence bundle.
 * Hashes the sorted array of all event hashes.
 */
export async function hashBundle(
  events: EvidenceEvent[]
): Promise<SHA256> {
  const sortedHashes = events.map((e) => e.hash).sort();
  return sha256(canonicalize(sortedHashes));
}

/**
 * Verify that a bundle hash matches its events.
 */
export async function verifyBundleHash(
  bundle: EvidenceBundle
): Promise<boolean> {
  const computed = await hashBundle(bundle.events);
  return computed === bundle.bundleHash;
}

/**
 * Verify that an event hash matches its contents.
 */
export async function verifyEventHash(
  event: EvidenceEvent
): Promise<boolean> {
  const computed = await hashEvent(event);
  return computed === event.hash;
}
