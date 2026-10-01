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

// Everything the encoder uses at call time is captured here, when the module
// loads, and the code below calls only these captured functions. A prototype or
// global that is polluted or replaced AFTER this point (an indexed setter on
// Array.prototype, Array.prototype.push, JSON.stringify, the String global,
// WeakSet.prototype.has ...) cannot change a byte of the output.
//
// Two rules keep Array.prototype out of it. The encoder never looks up a method
// on an array or on its input (no push / sort / join / for...of, no spread, no
// array destructuring: each of those reaches Array.prototype), and it never
// writes an array index that has no own property (an inherited indexed setter
// would run). The only arrays it touches are the ones Reflect.ownKeys returns,
// which the engine creates with every index an own data property; it writes to
// them only at indices that already exist. The text is built by concatenation.
const getOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
const getPrototypeOf = Reflect.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const isFiniteNumber = Number.isFinite;
const isIntegerNumber = Number.isInteger;
const isSafeIntegerNumber = Number.isSafeInteger;
const toNumber = Number;
const toText = String;
const quote = JSON.stringify; // string escaping, byte-for-byte what JSON transport writes
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const WeakSetConstructor = WeakSet;
// `set.has(v)` looks the method up on the set at call time; these do not.
const call = Function.prototype.call;
const weakSetAdd = call.bind(WeakSet.prototype.add) as unknown as (set: WeakSet<object>, value: object) => void;
const weakSetHas = call.bind(WeakSet.prototype.has) as unknown as (set: WeakSet<object>, value: unknown) => boolean;
const weakSetDelete = call.bind(WeakSet.prototype.delete) as unknown as (set: WeakSet<object>, value: object) => void;

/** What dataValueOf returns for a descriptor that does not describe a data property. Module-private, so it never equals a value read from input. */
const NOT_DATA = Symbol("canonicalize: not a data property");

/**
 * A descriptor describes a data property only when it OWNS `value` and has no
 * own `get` or `set`. Ownership is judged by asking the captured reflection for
 * the descriptor's OWN property, never with `in` (which also finds an inherited
 * `value`, `get`, `set` or `enumerable` on a polluted Object.prototype) and never
 * with a method taken from Object.prototype (hasOwnProperty captured before a
 * pre-load pollution is the polluter's function, not the engine's). A field is
 * read only from the own descriptor that proved it exists.
 *
 * Returns the property's value, or NOT_DATA for an accessor.
 */
function dataValueOf(descriptor: object): unknown {
  const value = getOwnPropertyDescriptor(descriptor, "value");
  if (value === undefined) return NOT_DATA;
  if (getOwnPropertyDescriptor(descriptor, "get") !== undefined) return NOT_DATA;
  if (getOwnPropertyDescriptor(descriptor, "set") !== undefined) return NOT_DATA;
  return value.value;
}

/** Whether a descriptor OWNS `enumerable: true` (a complete descriptor always owns it). */
function isEnumerable(descriptor: object): boolean {
  const enumerable = getOwnPropertyDescriptor(descriptor, "enumerable");
  return enumerable !== undefined && enumerable.value === true;
}

/**
 * Every NonCanonicalValueError is registered here as it is constructed, and the
 * boundary in canonicalize recognises its own errors ONLY by membership. A thrown
 * value is never inspected: `instanceof` would run a hostile Proxy's
 * getPrototypeOf trap and any property read its get trap, and a trap that throws
 * from inside the check would let a plain Error out past the typed boundary.
 */
const CANONICAL_ERRORS = new WeakSetConstructor<object>();

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
    weakSetAdd(CANONICAL_ERRORS, this);
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
    return canonicalizeAt(value, "$", new WeakSetConstructor());
  } catch (err) {
    if (weakSetHas(CANONICAL_ERRORS, err)) throw err; // ours: classified by identity, never inspected
    // A Proxy trap threw (whatever it threw), or the value nests too deeply to walk: not a plain JSON tree.
    throw new NonCanonicalValueError("$", "a value that could not be read as a plain JSON tree");
  }
}

function canonicalizeAt(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    throw new NonCanonicalValueError(path, "undefined (JSON has no undefined; omit the member instead)");
  }
  if (typeof value === "string") {
    return quote(value);
  }
  if (typeof value === "boolean") {
    return toText(value);
  }
  if (typeof value === "number") {
    if (!isFiniteNumber(value)) throw new NonCanonicalValueError(path, toText(value));
    if (isIntegerNumber(value) && !isSafeIntegerNumber(value)) {
      throw new NonCanonicalValueError(
        path,
        `the integer ${toText(value)}, outside the safe range (send it as a decimal string)`,
      );
    }
    return toText(value);
  }
  if (typeof value === "object") {
    if (weakSetHas(ancestors, value)) throw new NonCanonicalValueError(path, "a cyclic reference");
    weakSetAdd(ancestors, value);
    try {
      return isArray(value)
        ? canonicalArray(value, path, ancestors)
        : canonicalObject(value, path, ancestors);
    } finally {
      weakSetDelete(ancestors, value);
    }
  }
  throw new NonCanonicalValueError(path, `a ${typeof value}`);
}

function canonicalArray(arr: unknown[], path: string, ancestors: WeakSet<object>): string {
  if (getPrototypeOf(arr) !== ARRAY_PROTOTYPE) {
    throw new NonCanonicalValueError(path, "an array with a substituted prototype or an Array subclass");
  }
  const length = arrayLength(arr, path); // read once
  let out = "[";
  for (let i = 0; i < length; i++) {
    const at = `${path}[${i}]`;
    const d = getOwnPropertyDescriptor(arr, i);
    if (d === undefined) throw new NonCanonicalValueError(at, "a hole in a sparse array (or an inherited index)");
    const element = dataValueOf(d);
    if (element === NOT_DATA) throw new NonCanonicalValueError(at, "an accessor element");
    if (i !== 0) out += ",";
    out += canonicalizeAt(element, at, ancestors);
  }
  const keys = ownKeys(arr);
  const count = keys.length;
  for (let k = 0; k < count; k++) {
    const key = keys[k];
    if (key === "length") continue;
    if (typeof key === "symbol") throw new NonCanonicalValueError(`${path}[${toText(key)}]`, "a symbol-keyed property");
    const index = toNumber(key);
    if (!(isIntegerNumber(index) && index >= 0 && index < length && toText(index) === key)) {
      throw new NonCanonicalValueError(`${path}.${key}`, "a named property on an array");
    }
  }
  return out + "]";
}

/**
 * An array's length, read from its OWN `length` data descriptor through the
 * captured reflection. `arr.length` is a [[Get]]: on a Proxy it runs the `get`
 * trap, which is input code outside the reflection traps. A Proxy's
 * getOwnPropertyDescriptor trap is a reflection trap, but the engine only
 * insists that `length` stays a compatible non-configurable data property, so the
 * reported value can be anything: it must be a non-negative safe integer, or the
 * array is refused. (The element loop and the own-key check in canonicalArray
 * then refuse a length that disagrees with the elements the array really has.)
 */
function arrayLength(arr: unknown[], path: string): number {
  const descriptor = getOwnPropertyDescriptor(arr, "length");
  const length = descriptor === undefined ? NOT_DATA : dataValueOf(descriptor);
  if (typeof length !== "number" || !isSafeIntegerNumber(length) || length < 0) {
    throw new NonCanonicalValueError(path, "an array whose length is not an own data property holding a non-negative safe integer");
  }
  return length;
}

function canonicalObject(obj: object, path: string, ancestors: WeakSet<object>): string {
  const proto = getPrototypeOf(obj);
  if (proto !== OBJECT_PROTOTYPE && proto !== null) {
    // A constant reason: reading the value's constructor could run its code.
    throw new NonCanonicalValueError(path, "a non-plain object (its prototype is not Object.prototype or null)");
  }
  const keys = ownKeys(obj);
  const count = keys.length;
  for (let i = 0; i < count; i++) {
    const key = keys[i];
    if (typeof key === "symbol") throw new NonCanonicalValueError(`${path}[${toText(key)}]`, "a symbol-keyed property");
  }
  sortByCodeUnits(keys as string[], count);
  let out = "{";
  let first = true;
  for (let i = 0; i < count; i++) {
    const key = keys[i] as string;
    const at = `${path}.${key}`;
    const d = getOwnPropertyDescriptor(obj, key);
    if (d === undefined) throw new NonCanonicalValueError(at, "a property that vanished while it was read");
    const member = dataValueOf(d);
    if (member === NOT_DATA) throw new NonCanonicalValueError(at, "an accessor property");
    if (!isEnumerable(d)) throw new NonCanonicalValueError(at, "a non-enumerable property");
    if (member === undefined) continue; // omitted, as JSON.stringify omits it
    if (first) first = false;
    else out += ",";
    out += quote(key) + ":" + canonicalizeAt(member, at, ancestors);
  }
  return out + "}";
}

/**
 * Sort `keys[0 .. count)` ascending by UTF-16 code units, which is what `<` does
 * on strings and what the default Array.prototype.sort did. Heapsort: in place,
 * O(n log n) however the keys arrive (a quadratic sort would let a wide object
 * stall a hash), and it only reads and assigns indices that already exist as
 * own properties of the engine-made key array, so neither a replaced
 * Array.prototype.sort nor an inherited indexed setter can be reached. Keys are
 * unique (a Proxy's ownKeys result cannot repeat a key), so stability is moot.
 */
function sortByCodeUnits(keys: string[], count: number): void {
  for (let root = (count >> 1) - 1; root >= 0; root--) siftDown(keys, root, count);
  for (let end = count - 1; end > 0; end--) {
    const largest = keys[0];
    keys[0] = keys[end];
    keys[end] = largest;
    siftDown(keys, 0, end);
  }
}

function siftDown(keys: string[], start: number, end: number): void {
  let root = start;
  for (;;) {
    let child = 2 * root + 1;
    if (child >= end) return;
    if (child + 1 < end && keys[child] < keys[child + 1]) child++;
    if (!(keys[root] < keys[child])) return;
    const moved = keys[root];
    keys[root] = keys[child];
    keys[child] = moved;
    root = child;
  }
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
