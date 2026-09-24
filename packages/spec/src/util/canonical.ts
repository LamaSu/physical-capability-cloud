/**
 * Canonical serialization and hashing for evidence events and bundles.
 *
 * Rules:
 * 1. JSON keys are sorted lexicographically (UTF-16 code units) at all depths.
 * 2. No whitespace.
 * 3. Numbers are not quoted.
 * 4. Null values are included; undefined object members are omitted.
 * 5. SHA-256 of the canonical JSON produces the content hash.
 *
 * This ensures that identical data always produces the same hash,
 * regardless of key insertion order or formatting.
 *
 * EVALUATE ONLY WHAT YOU HASHED. A consumer that hashes a value and then reads
 * fields from it (a job id, a kernel id, a verdict) must read them from what
 * the hash covered. canonicalize therefore refuses anything that is not a
 * plain JSON tree, so a property the hash skipped (non-enumerable, inherited,
 * symbol-keyed, an accessor, a named property on an array) can never be the
 * one an evaluator reads.
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
 * Only a plain JSON tree is accepted: strings, finite numbers, booleans, null,
 * arrays and plain objects, where
 *   - an object has prototype Object.prototype or null and holds only own,
 *     enumerable, string-keyed DATA properties (no getters or setters, no
 *     non-enumerable or symbol-keyed properties). An undefined member is
 *     omitted, as JSON.stringify omits it;
 *   - an array is an ordinary Array (no subclass, no substituted prototype)
 *     whose every index is an own data property (a hole, or an index that
 *     exists only on a prototype, is refused) and which carries no named
 *     properties.
 * `undefined` as the whole value or as an array element is refused: JSON has
 * no form for it (JSON.stringify would silently write null). Anything else —
 * NaN, Infinity, a bigint, a function, a symbol, a Date, a Map or any other
 * non-plain object — throws NonCanonicalValueError too, instead of producing
 * text only this function could reproduce. Reading each value once, from its
 * own data descriptor, also means no getter ever runs here.
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
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new NonCanonicalValueError(path, "undefined (JSON has no undefined; omit the member instead)");
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
      return Array.isArray(value)
        ? canonicalArray(value, path, ancestors)
        : canonicalObject(value, path, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }
  throw new NonCanonicalValueError(path, `a ${typeof value}`);
}

function canonicalArray(arr: unknown[], path: string, ancestors: Set<object>): string {
  if (Object.getPrototypeOf(arr) !== Array.prototype) {
    throw new NonCanonicalValueError(path, "an array with a substituted prototype or an Array subclass");
  }
  const length = arr.length; // read once
  const items: string[] = [];
  for (let i = 0; i < length; i++) {
    const at = `${path}[${i}]`;
    const d = Object.getOwnPropertyDescriptor(arr, i);
    if (d === undefined) throw new NonCanonicalValueError(at, "a hole in a sparse array (or an inherited index)");
    if (!("value" in d)) throw new NonCanonicalValueError(at, "an accessor element");
    items.push(canonicalizeAt(d.value, at, ancestors));
  }
  for (const key of Reflect.ownKeys(arr)) {
    if (key === "length") continue;
    if (typeof key === "symbol") throw new NonCanonicalValueError(`${path}[${String(key)}]`, "a symbol-keyed property");
    const index = Number(key);
    if (!(Number.isInteger(index) && index >= 0 && index < length && String(index) === key)) {
      throw new NonCanonicalValueError(`${path}.${key}`, "a named property on an array");
    }
  }
  return "[" + items.join(",") + "]";
}

function canonicalObject(obj: object, path: string, ancestors: Set<object>): string {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? "non-plain";
    throw new NonCanonicalValueError(path, `a ${name} object`);
  }
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === "symbol") throw new NonCanonicalValueError(`${path}[${String(key)}]`, "a symbol-keyed property");
    keys.push(key);
  }
  const pairs: string[] = [];
  for (const key of keys.sort()) {
    const at = `${path}.${key}`;
    const d = Object.getOwnPropertyDescriptor(obj, key)!;
    if (!("value" in d)) throw new NonCanonicalValueError(at, "an accessor property");
    if (!d.enumerable) throw new NonCanonicalValueError(at, "a non-enumerable property");
    if (d.value === undefined) continue; // omitted, as JSON.stringify omits it
    pairs.push(JSON.stringify(key) + ":" + canonicalizeAt(d.value, at, ancestors));
  }
  return "{" + pairs.join(",") + "}";
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
