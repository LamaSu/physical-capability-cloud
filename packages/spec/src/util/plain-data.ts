/**
 * plainDataCopy — one owned, plain-data copy of an untrusted input.
 *
 * Checks that must hold for the exact data later evaluated (a committed
 * profile, a signed bundle) run on a copy, never on the caller's objects: a
 * getter, a proxy or a caller mutating across an `await` could answer one way to
 * the check and another way afterwards. The copy is made in ONE pass: every
 * own enumerable property is read exactly once, so the first read is the only
 * read. (Canonical JSON, parsed back, is not enough: `canonicalize` reads each
 * property twice.)
 *
 * Only JSON data is copied. Anything JSON cannot carry is refused, never
 * coerced: undefined inside an array, functions, symbols, bigints, NaN and
 * ±Infinity, cycles, sparse arrays, and objects that are neither plain nor
 * arrays (a Date, a Map, a class instance). An object member whose value is
 * undefined is dropped, as JSON and `canonicalize` both drop it.
 */

class NotPlainData extends Error {}

export type PlainDataCopy = { ok: true; value: unknown } | { ok: false; reason: string };

export function plainDataCopy(value: unknown): PlainDataCopy {
  const ancestors = new Set<object>();
  const walk = (v: unknown, path: string): unknown => {
    const at = path || "<root>";
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new NotPlainData(`${at}: a non-finite number`);
      return v;
    }
    if (typeof v !== "object") throw new NotPlainData(`${at}: a ${typeof v} is not JSON data`);
    if (ancestors.has(v)) throw new NotPlainData(`${at}: a cycle`);
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        const length = v.length;
        const out: unknown[] = new Array(length);
        for (let i = 0; i < length; i++) {
          if (!(i in v)) throw new NotPlainData(`${at}[${i}]: a hole in a sparse array`);
          const item: unknown = v[i];
          if (item === undefined) throw new NotPlainData(`${at}[${i}]: undefined in an array`);
          out[i] = walk(item, `${path}[${i}]`);
        }
        return out;
      }
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new NotPlainData(`${at}: not a plain object`);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v)) {
        const item: unknown = (v as Record<string, unknown>)[key];
        if (item === undefined) continue;
        out[key] = walk(item, path ? `${path}.${key}` : key);
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };
  try {
    return { ok: true, value: walk(value, "") };
  } catch (err) {
    return { ok: false, reason: err instanceof NotPlainData ? err.message : `not JSON data (${err instanceof Error ? err.message : String(err)})` };
  }
}
