/**
 * The intrinsics the safety envelope (ADK R8) uses, captured when this module
 * loads: the "primordials" pattern Node itself uses internally.
 *
 * Why: astra pack 164. Compile called `Array.prototype.map` after the
 * registration was verified, so a `map` replaced after load changed an
 * emitted limit from the signed 40 to 400. The R8 code therefore calls only
 * the functions below, plain loops and operators. It never calls a method
 * looked up on a mutable prototype or global at the time of the call:
 *   - every function a check, a hash or a projection calls is captured here;
 *   - arrays are built by defining own data properties (no [[Set]], so no
 *     setter a prototype serves runs), and iterated by index (no iterator
 *     protocol);
 *   - property-descriptor objects passed to defineProperty have a null
 *     prototype, so an inherited `get` or `set` cannot be mistaken for theirs.
 * `safety-envelope-intrinsics.test.ts` scans both R8 modules for any other
 * call and fails if it finds one.
 *
 * The boundary, named honestly: a realm whose intrinsics were replaced BEFORE
 * this module loaded hands it the replaced ones, and no in-process check can
 * tell. Load @pcc/spec before any untrusted code, or run under a frozen realm.
 *
 * Internal to the onboarding module; not exported from the package index.
 */

import { createHash } from "node:crypto";

const FunctionPrototype = Function.prototype;
/** uncurryThis(fn)(self, ...args) calls the ORIGINAL fn with `this` = self, through the original `call`. */
const uncurryThis = FunctionPrototype.bind.bind(FunctionPrototype.call) as <T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
) => (self: T, ...args: A) => R;

export const ArrayCtor = Array;
export const ArrayIsArray = Array.isArray;
export const ArrayPrototype = Array.prototype;
export const ObjectPrototype = Object.prototype;
export const ObjectAssign = Object.assign;
export const ObjectCreate = Object.create;
export const ObjectDefineProperty = Object.defineProperty;
export const ObjectFreeze = Object.freeze;
export const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
export const ObjectGetPrototypeOf = Object.getPrototypeOf;
export const ObjectIs = Object.is;
export const ObjectIsFrozen = Object.isFrozen;
export const ObjectKeys = Object.keys;
export const NumberIsFinite = Number.isFinite;
export const NumberIsInteger = Number.isInteger;
export const NumberIsSafeInteger = Number.isSafeInteger;
export const DateParse = Date.parse;
export const JSONParse = JSON.parse;
export const JSONStringify = JSON.stringify;
const TypeErrorAtLoad = TypeError;
export const Uint8ArrayCtor = Uint8Array;
const ObjectPrototypeHasOwnProperty = uncurryThis(Object.prototype.hasOwnProperty);
const StringPrototypeTrim = uncurryThis(String.prototype.trim);
const StringPrototypeToLowerCase = uncurryThis(String.prototype.toLowerCase);
const StringPrototypeCharCodeAt = uncurryThis(String.prototype.charCodeAt);

/** The SHA-256 the digests use: node:crypto's Hash, its methods captured at load. */
const createHashAtLoad = createHash;
const HashPrototype = ObjectGetPrototypeOf(createHash("sha256")) as { update: (data: string) => unknown; digest: (encoding: "hex") => string };
const HashPrototypeUpdate = uncurryThis(HashPrototype.update);
const HashPrototypeDigest = uncurryThis(HashPrototype.digest);

/**
 * A proxy check that runs no trap: Node's `util.types.isProxy`, captured at
 * load without a static `node:util` import, so browser bundles of @pcc/spec
 * still build (the dashboard has no `node:util`). Where there is none (a
 * browser, or Node before 20.16) it is null, and every object is refused: a
 * proxy cannot be told apart from plain data there without running its traps.
 */
export const isProxy: ((value: object) => boolean) | null = (() => {
  const runtime = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const util = runtime?.getBuiltinModule?.("node:util") as { types?: { isProxy?: (value: unknown) => boolean } } | undefined;
  const check = util?.types?.isProxy;
  return typeof check === "function" ? (value: object) => check(value) : null;
})();

/** An own property check that consults no prototype. */
export function hasOwn(o: object, key: PropertyKey): boolean {
  return ObjectPrototypeHasOwnProperty(o, key);
}

/** A data-property descriptor with a null prototype, so no inherited `get` or `set` is read as its own. */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = ObjectCreate(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  return descriptor;
}

/** Install `value` as `list`'s own data property at `index`; no setter a prototype serves runs. */
export function defineIndex<T>(list: T[], index: number, value: T): void {
  ObjectDefineProperty(list, index, dataDescriptor(value));
}

/** Install `value` after `list`'s last element (push, without [[Set]]). */
export function append<T>(list: T[], value: T): void {
  ObjectDefineProperty(list, list.length, dataDescriptor(value));
}

/** A new array of `length` elements, built by index. */
export function newList<T>(length: number): T[] {
  return new ArrayCtor<T>(length);
}

export function includesValue(list: readonly unknown[], x: unknown): boolean {
  for (let i = 0; i < list.length; i++) if (list[i] === x) return true;
  return false;
}

export function mapList<T, U>(list: readonly T[], f: (x: T, i: number) => U): U[] {
  const out = newList<U>(list.length);
  for (let i = 0; i < list.length; i++) defineIndex(out, i, f(list[i]!, i));
  return out;
}

export function filterList<T>(list: readonly T[], keep: (x: T, i: number) => boolean): T[] {
  const out: T[] = newList<T>(0);
  for (let i = 0; i < list.length; i++) if (keep(list[i]!, i)) append(out, list[i]!);
  return out;
}

export function concatLists<T>(a: readonly T[], b: readonly T[]): T[] {
  const out = newList<T>(0);
  for (let i = 0; i < a.length; i++) append(out, a[i]!);
  for (let i = 0; i < b.length; i++) append(out, b[i]!);
  return out;
}

export function joinStrings(list: readonly string[], separator: string): string {
  let out = "";
  for (let i = 0; i < list.length; i++) out = i === 0 ? list[i]! : out + separator + list[i]!;
  return out;
}

/** Strings in UTF-16 code-unit order, as Array.prototype.sort with no comparator orders them. */
export function sortedStrings(list: readonly string[]): string[] {
  const out = mapList(list, (s) => s);
  for (let i = 1; i < out.length; i++) {
    const s = out[i]!;
    let j = i - 1;
    while (j >= 0 && out[j]! > s) {
      defineIndex(out, j + 1, out[j]!);
      j--;
    }
    defineIndex(out, j + 1, s);
  }
  return out;
}

export function trim(s: string): string {
  return StringPrototypeTrim(s);
}

export function toLowerCase(s: string): string {
  return StringPrototypeToLowerCase(s);
}

/**
 * `prefix` and then exactly `hexLength` lowercase hex digits, checked code unit
 * by code unit. There is no RegExp: RegExp.prototype.compile replaces a RegExp
 * object's matcher in place after load, and it does so even when the object is
 * frozen (astra pack 167).
 */
function isPrefixedLowerHex(value: unknown, prefix: string, hexLength: number): value is string {
  if (typeof value !== "string" || value.length !== prefix.length + hexLength) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (StringPrototypeCharCodeAt(value, i) !== StringPrototypeCharCodeAt(prefix, i)) return false;
  }
  for (let i = prefix.length; i < value.length; i++) {
    const unit = StringPrototypeCharCodeAt(value, i);
    if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x66))) return false;
  }
  return true;
}

/** `sha256:` + 64 lowercase hex: LO-EV-1's tagged digest form, also an adapter's manifest digest. */
export function isTaggedSha256(value: unknown): value is string {
  return isPrefixedLowerHex(value, "sha256:", 64);
}

/** `0x` + 64 lowercase hex: the commitment family's digest form. */
export function isHex256Digest(value: unknown): value is string {
  return isPrefixedLowerHex(value, "0x", 64);
}

/** A value as text for a message, never calling a method on it. */
export function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return `${v}`;
  return typeof v === "object" ? "[object]" : `[${typeof v}]`;
}

/** `JSON.stringify(String(v))`, for quoting a value in a message, without calling a method on it. */
export function quoted(v: unknown): string {
  return JSONStringify(text(v));
}

/**
 * canonicalize (util/canonical.ts) for JSON data, byte for byte, built only
 * from the captured intrinsics: keys sorted by UTF-16 code units at every
 * depth, no whitespace, strings as JSON.stringify writes them, numbers as
 * JavaScript writes them, null and undefined as "null", and an object member
 * whose value is undefined omitted.
 *
 * A number canonical JSON has no form for is refused, as D5's canonicalize
 * refuses it (evidence profile v1 sec 1, #359): a non-finite number, or an
 * integer outside the safe range (every number of magnitude 2^53 or more is
 * one). So an envelope digest is always one the oracle can recompute.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSONStringify(value);
  if (typeof value === "boolean") return `${value}`;
  if (typeof value === "number") {
    if (!NumberIsFinite(value) || (NumberIsInteger(value) && !NumberIsSafeInteger(value))) {
      throw new TypeErrorAtLoad(`canonical JSON has no form for the number ${text(value)}`);
    }
    return `${value}`;
  }
  if (ArrayIsArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) out += (i === 0 ? "" : ",") + canonicalJson(value[i]);
    return `${out}]`;
  }
  if (typeof value === "object") {
    const keys = sortedStrings(ObjectKeys(value));
    let out = "{";
    let first = true;
    for (let i = 0; i < keys.length; i++) {
      const member = (value as Record<string, unknown>)[keys[i]!];
      if (member === undefined) continue;
      out += `${first ? "" : ","}${JSONStringify(keys[i]!)}:${canonicalJson(member)}`;
      first = false;
    }
    return `${out}}`;
  }
  return text(value);
}

/** Lowercase hex of the SHA-256 of `input`'s UTF-8. */
export function sha256Hex(input: string): string {
  const hash = createHashAtLoad("sha256");
  HashPrototypeUpdate(hash, input);
  return HashPrototypeDigest(hash, "hex");
}

/** The UTF-8 of an ASCII string (every code unit below 0x80), or null when it is not ASCII. */
export function asciiBytes(s: string): Uint8Array | null {
  const out = new Uint8ArrayCtor(s.length);
  for (let i = 0; i < s.length; i++) {
    const unit = StringPrototypeCharCodeAt(s, i);
    if (unit >= 0x80) return null;
    out[i] = unit;
  }
  return out;
}

function hexDigit(unit: number): number {
  if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
  if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10;
  if (unit >= 0x41 && unit <= 0x46) return unit - 0x41 + 10;
  return -1;
}

/**
 * Exactly `byteLength` bytes from hex (either case), with an optional `0x`
 * prefix, as LO-EV-1's parseEd25519SignatureHex accepts them; null otherwise.
 */
export function fixedHexBytes(value: unknown, byteLength: number): Uint8Array | null {
  if (typeof value !== "string") return null;
  const start = value.length >= 2 && StringPrototypeCharCodeAt(value, 0) === 0x30 && (StringPrototypeCharCodeAt(value, 1) === 0x78 || StringPrototypeCharCodeAt(value, 1) === 0x58) ? 2 : 0;
  if (value.length - start !== byteLength * 2) return null;
  const out = new Uint8ArrayCtor(byteLength);
  for (let i = 0; i < byteLength; i++) {
    const high = hexDigit(StringPrototypeCharCodeAt(value, start + 2 * i));
    const low = hexDigit(StringPrototypeCharCodeAt(value, start + 2 * i + 1));
    if (high < 0 || low < 0) return null;
    out[i] = high * 16 + low;
  }
  return out;
}

/** Freeze `value` and everything inside it, reading only own properties. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !ObjectIsFrozen(value)) {
    ObjectFreeze(value);
    const keys = ObjectKeys(value);
    for (let i = 0; i < keys.length; i++) deepFreeze((value as Record<string, unknown>)[keys[i]!]);
  }
  return value;
}

/** A string set with no prototype, built at load: membership never consults one. */
export function stringSet(values: readonly string[]): Readonly<Record<string, true>> {
  const set = ObjectCreate(null) as Record<string, true>;
  for (let i = 0; i < values.length; i++) set[values[i]!] = true;
  return ObjectFreeze(set);
}

export function inSet(set: Readonly<Record<string, true>>, key: unknown): boolean {
  return typeof key === "string" && hasOwn(set, key);
}
