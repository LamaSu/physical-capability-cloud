/**
 * Intrinsics captured when this module loads (Node's own "primordials"
 * pattern), for the code whose results must not depend on anything changed
 * afterwards: canonicalization (`canonical.ts`) and the measurement profile's
 * validation, digest and freezing (`evidence/measurement-profile.ts`).
 *
 * Why: astra pack 170. After the one-pass plain copy, `canonicalize` called
 * `value.map` and `join`, so `Array.prototype.map` replaced after load
 * collapsed two different profiles to one digest. Code built on this module
 * calls only the functions below, plain loops and operators: never a method
 * looked up on a prototype or a global at the time of the call. Arrays are
 * built by defining own data properties (no [[Set]], so no setter a prototype
 * serves runs) and are iterated by index (no iterator protocol).
 *
 * The boundary, named honestly: a realm whose intrinsics were replaced BEFORE
 * this module loaded hands it the replaced ones, and no in-process check can
 * tell. Load @pcc/spec before untrusted code.
 *
 * Browser-safe: no `node:` import, because the dashboard bundles canonical.ts.
 * Internal to @pcc/spec; not exported from the package index.
 */

const FunctionPrototype = Function.prototype;
/** uncurryThis(fn)(self, ...args) calls the ORIGINAL fn with `this` = self, through the original `call`. */
export const uncurryThis = FunctionPrototype.bind.bind(FunctionPrototype.call) as <T, A extends unknown[], R>(
  fn: (this: T, ...args: A) => R,
) => (self: T, ...args: A) => R;

export const ArrayCtor = Array;
export const ArrayIsArray = Array.isArray;
export const ArrayPrototype = Array.prototype;
export const ObjectPrototype = Object.prototype;
export const ObjectCreate = Object.create;
export const ObjectDefineProperty = Object.defineProperty;
export const ObjectFreeze = Object.freeze;
export const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
export const ObjectGetPrototypeOf = Object.getPrototypeOf;
export const ObjectIsFrozen = Object.isFrozen;
export const ObjectKeys = Object.keys;
export const NumberIsFinite = Number.isFinite;
export const NumberIsInteger = Number.isInteger;
export const JSONStringify = JSON.stringify;
export const StringCtor = String;
const ObjectPrototypeHasOwnProperty = uncurryThis(Object.prototype.hasOwnProperty);
const StringPrototypeTrim = uncurryThis(String.prototype.trim);
const StringPrototypeCharCodeAt = uncurryThis(String.prototype.charCodeAt);

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

/** Freeze `value` and everything inside it, reading only own properties. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !ObjectIsFrozen(value)) {
    ObjectFreeze(value);
    const keys = ObjectKeys(value);
    for (let i = 0; i < keys.length; i++) deepFreeze((value as Record<string, unknown>)[keys[i]!]);
  }
  return value;
}

/** A string set with no prototype, frozen when built: membership never consults one. */
export function stringSet(values: readonly string[]): Readonly<Record<string, true>> {
  const set = ObjectCreate(null) as Record<string, true>;
  for (let i = 0; i < values.length; i++) set[values[i]!] = true;
  return ObjectFreeze(set);
}

export function inSet(set: Readonly<Record<string, true>>, key: unknown): boolean {
  return typeof key === "string" && hasOwn(set, key);
}

/**
 * `0x` followed by exactly 64 lowercase hex digits, checked code unit by code
 * unit. There is no RegExp: RegExp.prototype.compile replaces a RegExp
 * object's matcher in place after load, even when the object is frozen
 * (astra pack 167).
 */
export function isHex256Digest(value: unknown): value is `0x${string}` {
  if (typeof value !== "string" || value.length !== 66) return false;
  if (StringPrototypeCharCodeAt(value, 0) !== 0x30 || StringPrototypeCharCodeAt(value, 1) !== 0x78) return false;
  for (let i = 2; i < 66; i++) {
    const unit = StringPrototypeCharCodeAt(value, i);
    if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x66))) return false;
  }
  return true;
}
