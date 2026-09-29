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
 * EVALUATE ONLY WHAT YOU HASHED. canonicalize hashes exactly the own,
 * enumerable, string-keyed data properties it reads. It reads each one once,
 * from its own descriptor, and never runs a getter. It refuses what a plain
 * JSON tree cannot hold: a non-enumerable, symbol-keyed or accessor property,
 * or a named property on an array. What it cannot do is make an arbitrary
 * JavaScript object answer a LATER read the same way:
 *   - a Proxy can answer [[Get]] differently from its descriptors;
 *   - an inherited (polluted) property is readable but never hashed.
 * So a consumer that must evaluate what it hashed parses the canonical text
 * back (JSON.parse) and reads that snapshot with own-property reads, as
 * LO-EV-9's verifyEvidenceSubjectBinding does. It never re-reads the object it
 * was handed.
 */

import type { EvidenceEvent, EvidenceBundle } from "../types/evidence.js";
import type { SHA256 } from "../types/common.js";

// Reflection captured at load, so a later polluted prototype or replaced
// method cannot change how a descriptor is judged.
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const hasOwn = (o: object, key: PropertyKey): boolean => apply(hasOwnProperty, o, [key]) as boolean;

/**
 * A descriptor describes a data property only when it OWNS `value` and has no
 * own `get` or `set`. `"value" in d` would also find an inherited `value` (a
 * polluted Object.prototype) and let an accessor pass as data.
 */
function isDataDescriptor(d: PropertyDescriptor): boolean {
  return hasOwn(d, "value") && !hasOwn(d, "get") && !hasOwn(d, "set");
}

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
 *
 * A `toJSON` on Object.prototype or Array.prototype (a polluted prototype) is
 * refused too: JSON.stringify would then transport something other than the
 * canonical text. Every failure, including one thrown by a Proxy trap or a too
 * deeply nested value, surfaces as NonCanonicalValueError.
 */
export function canonicalize(value: unknown): string {
  try {
    if (getOwnPropertyDescriptor(OBJECT_PROTOTYPE, "toJSON") !== undefined ||
      getOwnPropertyDescriptor(ARRAY_PROTOTYPE, "toJSON") !== undefined) {
      throw new NonCanonicalValueError("$", "a value under a prototype that defines toJSON (JSON transport would differ)");
    }
    return canonicalizeAt(value, "$", new Set());
  } catch (err) {
    if (err instanceof NonCanonicalValueError) throw err;
    // A Proxy trap threw, or the value nests too deeply to walk: not a plain JSON tree.
    throw new NonCanonicalValueError("$", "a value that could not be read as a plain JSON tree");
  }
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
  if (getPrototypeOf(arr) !== ARRAY_PROTOTYPE) {
    throw new NonCanonicalValueError(path, "an array with a substituted prototype or an Array subclass");
  }
  const length = arr.length; // read once
  const items: string[] = [];
  for (let i = 0; i < length; i++) {
    const at = `${path}[${i}]`;
    const d = getOwnPropertyDescriptor(arr, i);
    if (d === undefined) throw new NonCanonicalValueError(at, "a hole in a sparse array (or an inherited index)");
    if (!isDataDescriptor(d)) throw new NonCanonicalValueError(at, "an accessor element");
    items.push(canonicalizeAt(d.value, at, ancestors));
  }
  for (const key of ownKeys(arr)) {
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
  const proto = getPrototypeOf(obj);
  if (proto !== OBJECT_PROTOTYPE && proto !== null) {
    // A constant reason: reading the value's constructor could run its code.
    throw new NonCanonicalValueError(path, "a non-plain object (its prototype is not Object.prototype or null)");
  }
  const keys: string[] = [];
  for (const key of ownKeys(obj)) {
    if (typeof key === "symbol") throw new NonCanonicalValueError(`${path}[${String(key)}]`, "a symbol-keyed property");
    keys.push(key);
  }
  const pairs: string[] = [];
  for (const key of keys.sort()) {
    const at = `${path}.${key}`;
    const d = getOwnPropertyDescriptor(obj, key);
    if (d === undefined) throw new NonCanonicalValueError(at, "a property that vanished while it was read");
    if (!isDataDescriptor(d)) throw new NonCanonicalValueError(at, "an accessor property");
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
