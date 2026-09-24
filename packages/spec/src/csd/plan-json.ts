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
 *   - refused: undefined, NaN, ±Infinity, bigint, function and symbol VALUES, array holes, and objects
 *     whose prototype is not Object.prototype or null (Date, Map, class instances, ...);
 *   - ignored, exactly as JSON.stringify ignores them: symbol-keyed and non-enumerable properties;
 *   - refused: the key "__proto__" (so no copy can ever set a prototype);
 *   - bounded: depth, keys per object, array length, string length, key length, total values and
 *     canonical size (PLAN_JSON_LIMITS). The size bound is checked AS the copy grows, on a sound lower
 *     bound (string and key lengths), so an oversized input is refused before it is fully read.
 *
 * `copyPlanJson` reads every property, key list and length EXACTLY ONCE into owned, frozen data. A
 * getter, a proxy or a mutation during the read cannot make the copy disagree with itself. Keys are
 * visited in sorted order, so which refusal an input gets never depends on key insertion order. A
 * throw while reading is a refusal ("unreadable"), never an exception, and the thrown value is never
 * inspected.
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
  | "too-many-values"
  | "too-large"
  | "unreadable";

export type PlanJsonCopy = { ok: true; value: PlanJsonObject } | { ok: false; reason: PlanJsonRefusal };

/** The canonical empty object: what an absent `inputs` or `constraints` means. */
export const EMPTY_PLAN_JSON: PlanJsonObject = Object.freeze({});

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
        const item: unknown = v[i];
        out.push(copy(item, depth + 1));
      }
      return Object.freeze(out);
    }
    if (!isPlainPrototype(v)) return refuse("unsupported-value");
    const keys = Object.keys(v);
    if (keys.length > L.maxKeysPerObject) refuse("too-many-keys"); // the bound before the sort it limits
    keys.sort();
    const out: Record<string, PlanJsonValue> = {};
    for (const k of keys) {
      if (k === "__proto__") refuse("reserved-key");
      if (k.length > L.maxKeyLength) refuse("key-too-long");
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
