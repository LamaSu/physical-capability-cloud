/**
 * Untrusted input, read once (docs/ECONOMIC_AGREEMENTS.md §3, "Reading the input").
 *
 * The compiler's entry points take `unknown`. Before any schema check they copy it into plain JSON data,
 * reading every property exactly once. Code after that works only on the copy, so an accessor, a Proxy
 * trap or a mutation by the caller can neither throw out of the compiler nor show it two different
 * values of one field. Anything that is not plain JSON data is refused, never coerced:
 *   - accessor properties, symbol keys, sparse arrays, cycles;
 *   - functions, bigint, undefined, and objects with a prototype other than Object.prototype or null
 *     (Date, Map, class instances). A `toJSON` method is not called.
 * Depth, array length and total size are bounded far above any valid agreement, so an adversarial
 * input costs bounded work.
 */

export const MAX_INPUT_DEPTH = 64;
export const MAX_INPUT_ARRAY_LENGTH = 65_536;
export const MAX_INPUT_NODES = 1_000_000;

export type SnapshotResult = { ok: true; value: unknown } | { ok: false; reason: string };

export interface SnapshotOptions {
  /**
   * Copy only what the canonical form writes, the same with or without the evidence profile's D5:
   *   - an object member whose value is undefined is dropped, as `canonicalize` drops it;
   *   - a number it cannot write is refused: one that is not finite, or of magnitude above 2^53 - 1
   *     (every double from 2^53 up is an integer outside the safe range, which D5 refuses).
   */
  canonical?: boolean;
}

class NotPlainData extends Error {}

export function snapshotJson(value: unknown, options: SnapshotOptions = {}): SnapshotResult {
  const canonical = options.canonical === true;
  let nodes = 0;
  const onPath = new Set<object>();

  const copy = (v: unknown, depth: number, where: string): unknown => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES) throw new NotPlainData(`more than ${MAX_INPUT_NODES} values`);
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (canonical && !(Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER)) {
        throw new NotPlainData(`${where} is ${v}, a number the canonical form cannot write (send it as a decimal string)`);
      }
      return v;
    }
    if (typeof v !== "object") throw new NotPlainData(`${where} is a ${typeof v}, not JSON data`);
    if (depth >= MAX_INPUT_DEPTH) throw new NotPlainData(`${where} nests deeper than ${MAX_INPUT_DEPTH}`);
    if (onPath.has(v)) throw new NotPlainData(`${where} contains itself`);
    onPath.add(v);
    try {
      if (Array.isArray(v)) {
        const length = v.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_INPUT_ARRAY_LENGTH) {
          throw new NotPlainData(`${where} has more than ${MAX_INPUT_ARRAY_LENGTH} entries`);
        }
        const out: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, i);
          if (d === undefined) throw new NotPlainData(`${where}[${i}] is a hole`);
          if (!("value" in d)) throw new NotPlainData(`${where}[${i}] is an accessor`);
          out.push(copy(d.value, depth + 1, `${where}[${i}]`));
        }
        return out;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new NotPlainData(`${where} is not a plain object`);
      const out: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(v)) {
        if (typeof key === "symbol") throw new NotPlainData(`${where} has a symbol key`);
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (d === undefined || !d.enumerable) continue; // as JSON.stringify: only own enumerable keys
        if (!("value" in d)) throw new NotPlainData(`${where}.${key} is an accessor`);
        if (canonical && d.value === undefined) continue; // canonicalize drops an undefined member
        // defineProperty, not assignment: a "__proto__" key stays an ordinary own key and is refused by
        // the closed schema, instead of replacing the copy's prototype.
        Object.defineProperty(out, key, {
          value: copy(d.value, depth + 1, `${where}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    } finally {
      onPath.delete(v);
    }
  };

  try {
    return { ok: true, value: copy(value, 0, "input") };
  } catch (e) {
    // A Proxy trap or an engine limit can throw anything; none of it escapes as an exception.
    return { ok: false, reason: e instanceof NotPlainData ? e.message : "the input could not be read as JSON data" };
  }
}

