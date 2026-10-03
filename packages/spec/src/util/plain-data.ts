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
 *
 * The copy holds exactly what canonical hashing covers, and nothing else:
 *   - every copied object has a NULL prototype, so no value can be read
 *     through inheritance (a polluted `Object.prototype`, changed after the
 *     check, would otherwise supply terms the hash never covered);
 *   - `-0` becomes `0`, as `canonicalize` writes both as "0";
 *   - a key named `__proto__` is refused;
 *   - no code supplied with the data runs: a proxy, an accessor (a getter or
 *     setter), an array with a nonstandard prototype, and an array index that
 *     is not the array's own data (a hole, or one served by a prototype) are
 *     refused through property descriptors, never by reading them;
 *   - building the copy runs no inherited setter either: array elements are
 *     installed with `Object.defineProperty`, and objects have no prototype.
 */

import { types } from "node:util";


class NotPlainData extends Error {}

export type PlainDataCopy = { ok: true; value: unknown } | { ok: false; reason: string };

export function plainDataCopy(value: unknown): PlainDataCopy {
  const ancestors = new Set<object>();
  const walk = (v: unknown, path: string): unknown => {
    const at = path || "<root>";
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new NotPlainData(`${at}: a non-finite number`);
      return Object.is(v, -0) ? 0 : v;
    }
    if (typeof v !== "object") throw new NotPlainData(`${at}: a ${typeof v} is not JSON data`);
    if (types.isProxy(v)) throw new NotPlainData(`${at}: a proxy`);
    if (ancestors.has(v)) throw new NotPlainData(`${at}: a cycle`);
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype) throw new NotPlainData(`${at}: an array with a nonstandard prototype`);
        const length = v.length;
        const out: unknown[] = new Array(length);
        for (let i = 0; i < length; i++) {
          const element = Object.getOwnPropertyDescriptor(v, i);
          if (element === undefined) throw new NotPlainData(`${at}[${i}]: a hole in a sparse array`);
          if (!("value" in element)) throw new NotPlainData(`${at}[${i}]: an accessor (a getter or setter)`);
          const item: unknown = element.value;
          if (item === undefined) throw new NotPlainData(`${at}[${i}]: undefined in an array`);
          // Installed as the copy's own data property. An assignment would run a
          // setter that Array.prototype serves for this index (astra pack 158).
          Object.defineProperty(out, i, { value: walk(item, `${path}[${i}]`), writable: true, enumerable: true, configurable: true });
        }
        return out;
      }
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new NotPlainData(`${at}: not a plain object`);
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(v)) {
        // `out["__proto__"] = x` would set the copy's PROTOTYPE, not a property: the
        // value would be read through inheritance but never hashed. JSON.parse makes
        // it an ordinary own key, so it reaches here; no PCC document uses it.
        if (key === "__proto__") throw new NotPlainData(`${at}: a key named __proto__ is refused`);
        const member = Object.getOwnPropertyDescriptor(v, key);
        if (member === undefined) continue;
        if (!("value" in member)) throw new NotPlainData(`${path ? `${path}.${key}` : key}: an accessor (a getter or setter)`);
        const item: unknown = member.value;
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
    // A getter or proxy can throw anything, including a value that `instanceof`,
    // `.message` or `String()` would throw on in turn; never format a foreign value.
    let reason = "not JSON data (reading it threw)";
    try {
      if (err instanceof NotPlainData) reason = err.message;
    } catch {
      // keep the generic reason
    }
    return { ok: false, reason };
  }
}
