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
 *
 * Nothing the copy calls can be changed after this module loads (astra pack
 * 162). It calls only the intrinsics captured below when the module loads,
 * plain loops and operators. It never calls a method looked up on a prototype
 * or a global at the time of the call, and it never uses the iterator
 * protocol. It reads a property descriptor through that descriptor's own
 * properties only, so a `value`, `get` or `set` written on Object.prototype is
 * never taken for the descriptor's.
 *
 * The boundary, named honestly: a realm whose intrinsics were replaced BEFORE
 * this module loaded hands it the replaced ones, and no in-process check can
 * tell. Load @pcc/spec before untrusted code.
 */

const ArrayCtor = Array;
const ArrayIsArray = Array.isArray;
const ArrayPrototype = Array.prototype;
const NumberIsFinite = Number.isFinite;
const ObjectCreate = Object.create;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectIs = Object.is;
const ObjectKeys = Object.keys;
const ObjectPrototype = Object.prototype;
const ObjectPrototypeHasOwnProperty = Object.prototype.hasOwnProperty;
const ProxyCtor = Proxy;
const ReflectApply = Reflect.apply;

/** An own-property check that consults no prototype, and no `call` that could be replaced. */
function hasOwn(o: object, key: PropertyKey): boolean {
  return ReflectApply(ObjectPrototypeHasOwnProperty, o, [key]) === true;
}

/** A data descriptor with a null prototype, so no inherited `get` or `set` is read as its own. */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = ObjectCreate(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/** An own data property's value: undefined when the property is absent, inherited or an accessor. */
function ownDataValue(o: unknown, key: string): unknown {
  if (o === null || (typeof o !== "object" && typeof o !== "function")) return undefined;
  const descriptor = ObjectGetOwnPropertyDescriptor(o, key);
  return descriptor !== undefined && hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

/** An OWN property's value, read through its own getter when it is an accessor (Node's global `process` is one). */
function ownValue(o: object, key: string): unknown {
  const descriptor = ObjectGetOwnPropertyDescriptor(o, key);
  if (descriptor === undefined) return undefined;
  if (hasOwn(descriptor, "value")) return descriptor.value;
  const get = hasOwn(descriptor, "get") ? descriptor.get : undefined;
  return typeof get === "function" ? ReflectApply(get, o, []) : undefined;
}

/** Every trap a proxy handler can define. */
const PROXY_TRAPS = [
  "apply",
  "construct",
  "defineProperty",
  "deleteProperty",
  "get",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
  "setPrototypeOf",
];

/**
 * `candidate`, when it tells a proxy from plain data without running a trap.
 * It is asked about two probe proxies, whose every trap is recorded, and two
 * plain values. It must answer exactly true, true, false, false, and no trap
 * may run. Otherwise this returns null.
 */
function trapFreeCheck(candidate: unknown): ((value: object) => boolean) | null {
  if (typeof candidate !== "function") return null;
  let trapped = false;
  const handler = ObjectCreate(null) as Record<string, () => never>;
  for (let i = 0; i < PROXY_TRAPS.length; i++) {
    handler[PROXY_TRAPS[i]!] = () => {
      trapped = true;
      throw new TypeError("the proxy check ran a trap");
    };
  }
  let answers: unknown[];
  try {
    answers = [
      ReflectApply(candidate, undefined, [new ProxyCtor(ObjectCreate(null) as object, handler as ProxyHandler<object>)]),
      ReflectApply(candidate, undefined, [new ProxyCtor([] as unknown[], handler as ProxyHandler<unknown[]>)]),
      ReflectApply(candidate, undefined, [ObjectCreate(null) as object]),
      ReflectApply(candidate, undefined, [[] as unknown[]]),
    ];
  } catch {
    return null;
  }
  if (trapped || answers[0] !== true || answers[1] !== true || answers[2] !== false || answers[3] !== false) return null;
  const check = candidate as (value: unknown) => unknown;
  return (value: object) => check(value) === true;
}

/**
 * A proxy check that runs no trap: Node's `util.types.isProxy`, loaded when
 * the module loads without a static `node:util` import, so browser bundles of
 * @pcc/spec still build (the dashboard bundles this module and never calls
 * it; vite has no `node:util`).
 *
 * It is found through own properties only: the global's `process`, its
 * `getBuiltinModule`, the module's `types` and their `isProxy`. Nothing
 * written on a prototype is consulted, so a `getBuiltinModule` inherited from
 * Object.prototype (Node before 20.16, or a browser's process shim) is never
 * used. It is accepted only after it passes the probe in `trapFreeCheck`.
 *
 * Otherwise, and wherever no such check exists (a browser, or Node before
 * 20.16), `isProxy` is null, and plainDataCopy refuses every object: a proxy
 * cannot be told apart from plain data there without running its traps.
 * A check replaced before this module loaded, by one that passes the probe,
 * is a realm compromised before load (astra pack 162).
 */
export const isProxy: ((value: object) => boolean) | null = trapFreeProxyCheckOf(globalThis);

/** The loader behind `isProxy`, given the global object: exported so each of its refusals can be tested. */
export function trapFreeProxyCheckOf(global: object): ((value: object) => boolean) | null {
  const runtime = ownValue(global, "process");
  const load = ownDataValue(runtime, "getBuiltinModule");
  if (typeof load !== "function") return null;
  let util: unknown;
  try {
    util = ReflectApply(load, runtime, ["node:util"]);
  } catch {
    return null;
  }
  return trapFreeCheck(ownDataValue(ownDataValue(util, "types"), "isProxy"));
}

class NotPlainData extends Error {}
const NOT_PLAIN_DATA = NotPlainData.prototype;

export type PlainDataCopy = { ok: true; value: unknown } | { ok: false; reason: string };

export function plainDataCopy(value: unknown): PlainDataCopy {
  // The objects on the path from the root: a cycle check without a Set, whose methods could be replaced.
  const ancestors: object[] = new ArrayCtor<object>(0);
  const walk = (v: unknown, path: string): unknown => {
    const at = path || "<root>";
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!NumberIsFinite(v)) throw new NotPlainData(`${at}: a non-finite number`);
      return ObjectIs(v, -0) ? 0 : v;
    }
    if (typeof v !== "object") throw new NotPlainData(`${at}: a ${typeof v} is not JSON data`);
    if (isProxy === null) throw new NotPlainData(`${at}: this runtime has no trap-free proxy check, so no object is copied as plain data`);
    if (isProxy(v)) throw new NotPlainData(`${at}: a proxy`);
    for (let i = 0; i < ancestors.length; i++) if (ancestors[i] === v) throw new NotPlainData(`${at}: a cycle`);
    ObjectDefineProperty(ancestors, ancestors.length, dataDescriptor(v));
    try {
      if (ArrayIsArray(v)) {
        if (ObjectGetPrototypeOf(v) !== ArrayPrototype) throw new NotPlainData(`${at}: an array with a nonstandard prototype`);
        const length = v.length;
        const out: unknown[] = new ArrayCtor<unknown>(length);
        for (let i = 0; i < length; i++) {
          const element = ObjectGetOwnPropertyDescriptor(v, i);
          if (element === undefined) throw new NotPlainData(`${at}[${i}]: a hole in a sparse array`);
          // The descriptor's OWN value: `"value" in element` would also find one written on
          // Object.prototype, and pass an accessor off as data (astra pack 162).
          if (!hasOwn(element, "value")) throw new NotPlainData(`${at}[${i}]: an accessor (a getter or setter)`);
          const item: unknown = element.value;
          if (item === undefined) throw new NotPlainData(`${at}[${i}]: undefined in an array`);
          // Installed as the copy's own data property, with a null-prototype descriptor. An
          // assignment would run a setter that Array.prototype serves for this index (astra pack 158).
          ObjectDefineProperty(out, i, dataDescriptor(walk(item, `${path}[${i}]`)));
        }
        return out;
      }
      const proto: unknown = ObjectGetPrototypeOf(v);
      if (proto !== ObjectPrototype && proto !== null) throw new NotPlainData(`${at}: not a plain object`);
      const out = ObjectCreate(null) as Record<string, unknown>;
      // By index, not for...of: the iterator protocol runs Array.prototype[Symbol.iterator] (astra pack 162).
      const keys = ObjectKeys(v);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k]!;
        // `out["__proto__"] = x` would set the copy's PROTOTYPE, not a property: the
        // value would be read through inheritance but never hashed. JSON.parse makes
        // it an ordinary own key, so it reaches here; no PCC document uses it.
        if (key === "__proto__") throw new NotPlainData(`${at}: a key named __proto__ is refused`);
        const member = ObjectGetOwnPropertyDescriptor(v, key);
        if (member === undefined) continue;
        if (!hasOwn(member, "value")) throw new NotPlainData(`${path ? `${path}.${key}` : key}: an accessor (a getter or setter)`);
        const item: unknown = member.value;
        if (item === undefined) continue;
        out[key] = walk(item, path ? `${path}.${key}` : key);
      }
      return out;
    } finally {
      ancestors.length = ancestors.length - 1;
    }
  };
  try {
    return { ok: true, value: walk(value, "") };
  } catch (err) {
    // Only this module's own refusal is formatted. Nothing supplied with the data runs, so what
    // else can arrive here is an engine error (a stack overflow); it gets the generic reason.
    let reason = "not JSON data (reading it threw)";
    try {
      if (typeof err === "object" && err !== null && ObjectGetPrototypeOf(err) === NOT_PLAIN_DATA) {
        const message = ObjectGetOwnPropertyDescriptor(err, "message");
        if (message !== undefined && hasOwn(message, "value") && typeof message.value === "string") reason = message.value;
      }
    } catch {
      // keep the generic reason
    }
    return { ok: false, reason };
  }
}
