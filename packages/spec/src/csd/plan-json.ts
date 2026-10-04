/**
 * Plain-JSON content an accepted plan may carry for a node: its execution `inputs` (e.g. the document
 * hash, pages, copies) and `constraints` (e.g. a deadline, max retries). Reconciliation row N25:
 * "the deal seals execution inputs".
 *
 * This is the caller's CONTENT, not authority. It says WHAT a node does, never who is paid or how
 * much. The accepted deal seals it through each node's canonical-plan hash, so it must be exactly
 * JSON, and bounded:
 *   - allowed: null, booleans, finite numbers, strings, arrays and plain objects;
 *   - refused: an INTEGER outside ±(2^53 − 1) (number policy D5: VCR, the oracle and @pcc/spec #359 all
 *     refuse to hash one, so sealing it would seal a deal nobody can recompute; see the
 *     shared crossrepo-accepted-bundle-v1 vector's `policyD5`). Send a larger value as a decimal string;
 *   - refused: undefined, NaN, ±Infinity, bigint, function and symbol VALUES, array holes (an index
 *     must be the array's OWN element: a prototype cannot fill a hole), and objects whose prototype is
 *     not Object.prototype or null (Date, Map, class instances, ...);
 *   - refused: a string value or key that is not well-formed UTF-16 (a lone surrogate). It has no UTF-8
 *     encoding, and canonicalizers disagree on how to escape it, so it could not be hashed the same way
 *     by every consumer;
 *   - ignored, exactly as JSON.stringify ignores them: symbol-keyed and non-enumerable properties;
 *   - refused: the key "__proto__" (so no copy can ever set a prototype);
 *   - bounded: depth, keys per object, array length, string length, key length, total values and
 *     canonical size (PLAN_JSON_LIMITS). The size bound is checked AS the copy grows, on a sound lower
 *     bound (string and key lengths), so an oversized input is refused before it is fully read. The key
 *     bound counts EVERY own string key, enumerable or not, and is checked right after the one key-list
 *     read, before any descriptor is read. Key lengths are checked before any key is sorted or compared.
 *
 * What an in-process caller can still do: a proxy's `ownKeys` trap hands over a key list the engine
 * copies before any bound can run, and a getter or trap can run arbitrary code. These bounds cap the
 * work THIS function does per key. The size of a SERIALIZED input is bounded where it arrives (the HTTP
 * body limit). Proxies and getters come only from in-process server code, never from a request body.
 *
 * `copyPlanJson` reads every property, key list and length EXACTLY ONCE into owned, frozen data. A
 * getter, a proxy or a mutation during the read cannot make the copy disagree with itself. The key
 * checks use a fixed priority and the keys are then visited in sorted order, so which refusal an input
 * gets never depends on key insertion order. A throw while reading is a refusal ("unreadable"), never
 * an exception, and the thrown value is never inspected.
 */

import { canonicalize } from "../util/canonical.js";

export const PLAN_JSON_LIMITS = Object.freeze({
  /** The top-level object is depth 1. */
  maxDepth: 8,
  maxKeysPerObject: 64,
  maxArrayLength: 256,
  /** UTF-16 code units, per string value. */
  maxStringLength: 4096,
  maxKeyLength: 128,
  /** Every object, array and primitive counts as one value. */
  maxValues: 1024,
  /** UTF-8 bytes of the canonical form. */
  maxCanonicalBytes: 8192,
});

export type PlanJsonValue = null | boolean | number | string | readonly PlanJsonValue[] | PlanJsonObject;
export interface PlanJsonObject {
  readonly [key: string]: PlanJsonValue;
}

export type PlanJsonRefusal =
  | "not-an-object"
  | "unsupported-value"
  | "non-finite-number"
  | "unsafe-integer"
  | "reserved-key"
  | "too-deep"
  | "too-many-keys"
  | "array-too-long"
  | "string-too-long"
  | "key-too-long"
  | "ill-formed-string"
  | "too-many-values"
  | "too-large"
  | "unreadable";

export type PlanJsonCopy = { ok: true; value: PlanJsonObject } | { ok: false; reason: PlanJsonRefusal };

/** The canonical empty object: what an absent `inputs` or `constraints` means. */
export const EMPTY_PLAN_JSON: PlanJsonObject = Object.freeze({});

/** A lone surrogate: a high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Well-formed UTF-16: no lone surrogate (astra round 6, E). */
function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE.test(s);
}

function isPlainPrototype(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Copy an untrusted value into an owned, frozen plain-JSON OBJECT, or refuse it with a reason.
 * `undefined` is not accepted here: callers decide what absence means (see `EMPTY_PLAN_JSON`).
 */
export function copyPlanJson(untrusted: unknown): PlanJsonCopy {
  const L = PLAN_JSON_LIMITS;
  let values = 0;
  // A running LOWER bound on the canonical form's UTF-8 size: every string value and key contributes at
  // least its UTF-16 length. Past the limit the input is refused before the rest is read.
  let sizeFloor = 0;
  // A refusal found while copying. Thrown as this function's own token so the catch never inspects a
  // caller's thrown value.
  const STOP = Object.freeze({});
  let reason: PlanJsonRefusal = "unreadable";
  const refuse = (r: PlanJsonRefusal): never => {
    reason = r;
    throw STOP;
  };

  const copy = (v: unknown, depth: number): PlanJsonValue => {
    if (++values > L.maxValues) refuse("too-many-values");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return refuse("non-finite-number");
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) return refuse("unsafe-integer"); // D5
      return Object.is(v, -0) ? 0 : v;
    }
    if (typeof v === "string") {
      if (v.length > L.maxStringLength) return refuse("string-too-long");
      if (!isWellFormed(v)) return refuse("ill-formed-string");
      if ((sizeFloor += v.length) > L.maxCanonicalBytes) return refuse("too-large");
      return v;
    }
    if (typeof v !== "object") return refuse("unsupported-value"); // undefined (array holes too), bigint, function, symbol
    if (depth > L.maxDepth) refuse("too-deep");
    if (Array.isArray(v)) {
      const n: unknown = v.length;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return refuse("unreadable");
      if (n > L.maxArrayLength) refuse("array-too-long");
      const out: PlanJsonValue[] = [];
      for (let i = 0; i < n; i++) {
        // The element must be the array's OWN. A hole is refused even when a prototype supplies index i
        // (astra round 6, B): reading v[i] alone would copy the inherited value.
        if (!Object.prototype.hasOwnProperty.call(v, i)) return refuse("unsupported-value");
        const item: unknown = v[i];
        out.push(copy(item, depth + 1));
      }
      return Object.freeze(out);
    }
    if (!isPlainPrototype(v)) return refuse("unsupported-value");
    // The key list is read ONCE (Reflect.ownKeys, one call; Object.keys would read every key's descriptor
    // first) and bounded before anything else reads the object (astra round 6, B). The count covers every
    // own string key, enumerable or not; symbol keys are ignored, as JSON.stringify ignores them.
    const own = Reflect.ownKeys(v);
    let stringKeys = 0;
    for (const k of own) if (typeof k === "string" && ++stringKeys > L.maxKeysPerObject) refuse("too-many-keys");
    // Each key is checked BEFORE anything sorts or compares it, with a fixed priority, so the refusal
    // never depends on key insertion order.
    let reserved = false;
    let tooLong = false;
    let illFormed = false;
    for (const k of own) {
      if (typeof k !== "string") continue;
      if (k === "__proto__") reserved = true;
      else if (k.length > L.maxKeyLength) tooLong = true;
      else if (!isWellFormed(k)) illFormed = true;
    }
    if (reserved) refuse("reserved-key");
    if (tooLong) refuse("key-too-long");
    if (illFormed) refuse("ill-formed-string");
    const keys: string[] = [];
    for (const k of own) {
      if (typeof k !== "string") continue;
      const d = Reflect.getOwnPropertyDescriptor(v, k);
      if (d !== undefined && d.enumerable === true) keys.push(k); // non-enumerable: ignored, as JSON.stringify ignores it
    }
    keys.sort();
    const out: Record<string, PlanJsonValue> = {};
    for (const k of keys) {
      if ((sizeFloor += k.length) > L.maxCanonicalBytes) refuse("too-large");
      const item: unknown = (v as Record<string, unknown>)[k];
      Object.defineProperty(out, k, { value: copy(item, depth + 1), enumerable: true, writable: false, configurable: false });
    }
    return Object.freeze(out);
  };

  try {
    if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) return { ok: false, reason: "not-an-object" };
    const value = copy(untrusted, 1) as PlanJsonObject;
    if (new TextEncoder().encode(canonicalize(value)).length > L.maxCanonicalBytes) return { ok: false, reason: "too-large" };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, reason: e === STOP ? reason : "unreadable" };
  }
}
