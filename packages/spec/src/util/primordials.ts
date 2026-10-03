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
 *
 * #363 round 9 adds what profile admission and the evidence levels need: the
 * tagged-digest check, own-data reads, Set methods for the evidence levels'
 * exported Set API, the structured clone, and promises whose delivery reads
 * nothing that code running after load can replace: `ownPromise` for a promise
 * handed to a caller (its species is pinned too, so every promise derived from
 * it is: astra pack 187), `awaitedHere` for one this package only awaits, and
 * `fulfillsWithTrue`.
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

// -- #363 round 9: profile admission and the evidence levels (steward #5186) --

export const ReflectOwnKeys = Reflect.ownKeys;
export const DateParse = Date.parse;
export const ErrorCtor = Error;
export const PromiseCtor = Promise;
export const SetCtor = Set;
export const SetPrototypeAdd = uncurryThis(Set.prototype.add) as (set: Set<unknown>, value: unknown) => Set<unknown>;
export const SetPrototypeHas = uncurryThis(Set.prototype.has) as (set: ReadonlySet<unknown>, value: unknown) => boolean;
export const SetPrototypeSize = uncurryThis(ObjectGetOwnPropertyDescriptor(Set.prototype, "size")!.get!) as (set: ReadonlySet<unknown>) => number;
/** The runtime's structured clone (HTML, and Node since 17), captured at load. */
export const StructuredClone = (globalThis as { structuredClone?: <T>(value: T) => T }).structuredClone;
const PromisePrototypeThenOriginal = Promise.prototype.then;
const PromisePrototypeThen = uncurryThis(Promise.prototype.then) as (
  promise: Promise<unknown>,
  onFulfilled: (value: unknown) => unknown,
  onRejected: (reason: unknown) => unknown,
) => Promise<unknown>;

/** `s.charCodeAt(i)`, through String.prototype.charCodeAt as it was at load. */
export function charCodeAt(s: string, i: number): number {
  return StringPrototypeCharCodeAt(s, i);
}

const TAGGED_SHA256_PREFIX = "sha256:";

/**
 * `sha256:` followed by exactly 64 lowercase hex digits: the evidence family's
 * tagged digest (signing-preimage.ts TAGGED_DIGEST_PATTERN), checked code unit
 * by code unit, with no RegExp (astra pack 167).
 */
export function isTaggedSha256(value: unknown): value is `sha256:${string}` {
  if (typeof value !== "string" || value.length !== 71) return false;
  for (let i = 0; i < 7; i++) {
    if (StringPrototypeCharCodeAt(value, i) !== StringPrototypeCharCodeAt(TAGGED_SHA256_PREFIX, i)) return false;
  }
  for (let i = 7; i < 71; i++) {
    const unit = StringPrototypeCharCodeAt(value, i);
    if (!((unit >= 0x30 && unit <= 0x39) || (unit >= 0x61 && unit <= 0x66))) return false;
  }
  return true;
}

/**
 * An own data property's value: undefined when `o` is not an object, or the
 * property is absent, inherited, or an accessor (which never runs). Nothing
 * written on a prototype after load can supply it.
 */
export function ownDataValue(o: unknown, key: PropertyKey): unknown {
  if (o === null || (typeof o !== "object" && typeof o !== "function")) return undefined;
  const descriptor = ObjectGetOwnPropertyDescriptor(o, key);
  return descriptor !== undefined && hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

/** A data descriptor that is not writable, enumerable or configurable, with a null prototype. */
function fixedDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = ObjectCreate(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = false;
  descriptor.enumerable = false;
  descriptor.configurable = false;
  return descriptor;
}

const SymbolSpecies = Symbol.species;

/**
 * The species of every promise `ownPromise` returns (astra pack 187). Native
 * `then`, `catch` and `finally` build the promise they return by constructing
 * this with their executor: it makes a native promise with the Promise
 * captured at load and passes it through `ownPromise`, so the derived promise
 * is pinned like its parent, and so on down any chain. A function declaration,
 * because a species must be a constructor. Frozen.
 */
function PinnedSpecies(executor: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => void): Promise<unknown> {
  return ownPromise(new PromiseCtor<unknown>(executor));
}
ObjectFreeze(PinnedSpecies);

/**
 * What `ownPromise` installs as a promise's own `constructor`: a frozen record
 * with no prototype whose one property, `[Symbol.species]`, is PinnedSpecies,
 * fixed. SpeciesConstructor reads that property of `constructor` and nothing
 * else. Every returned promise shares this record, and any caller can reach it
 * (`promise.constructor`), so it must be frozen: otherwise one caller could
 * re-point the species every other caller's `.then` uses.
 */
const PINNED_CONSTRUCTOR: object = ObjectCreate(null);
ObjectDefineProperty(PINNED_CONSTRUCTOR, SymbolSpecies, fixedDescriptor(PinnedSpecies));
ObjectFreeze(PINNED_CONSTRUCTOR);

/**
 * `promise`, ready to hand to a caller: whatever code running after load
 * replaces on Promise, Promise.prototype or Promise[Symbol.species], the
 * caller receives the value the promise settles with, through
 * `await promise`, through `promise.then`, and through every promise `then`
 * returns, at any depth.
 *
 * It gets own properties, which are read before anything on Promise.prototype,
 * each fixed (not writable, enumerable or configurable):
 *   - `then`: Promise.prototype.then as it was at load;
 *   - `constructor`: PINNED_CONSTRUCTOR, whose `[Symbol.species]` is
 *     PinnedSpecies. Native `then` builds the promise it returns with
 *     SpeciesConstructor(promise), that is
 *     `promise.constructor[Symbol.species]`. A `constructor` pinned to the
 *     global Promise (#363 round 9) was not enough: its species is a
 *     configurable accessor, which code running after load can point at a
 *     constructor whose "promise" is a forged thenable (astra pack 187).
 *
 * `await promise` takes the engine's thenable path, since `constructor` is not
 * %Promise%: it calls the own `then`, which reads only the frozen species, and
 * the value is then resolved as any resolution is, looking `then` up on it if
 * it is an object. So hand out only promises that settle with a primitive or
 * an object with no prototype (admission's result, the set digest, a
 * boolean). A promise this package awaits itself, and never hands out, takes
 * `awaitedHere`, on whose value `await` looks nothing up.
 *
 * The boundary: the promise returned, its own methods, and the promises they
 * return. A static that a caller calls after the change, such as
 * `Promise.all`, `Promise.race` or `Promise.resolve`, reads the global Promise
 * and its statics as they are then (`Promise.all` looks up `resolve` on its
 * receiver, and `then` on each promise it makes) and is outside it.
 * `promise.constructor` is not the global Promise; `instanceof Promise` still
 * holds.
 */
export function ownPromise<T>(promise: Promise<T>): Promise<T> {
  ObjectDefineProperty(promise, "constructor", fixedDescriptor(PINNED_CONSTRUCTOR));
  ObjectDefineProperty(promise, "then", fixedDescriptor(PromisePrototypeThenOriginal));
  return promise;
}

/**
 * `promise`, to be awaited by this package and never handed out. Its own,
 * fixed `constructor` is the Promise captured at load, which is %Promise%
 * itself, so `await` takes the engine's internal path: it reads that one own
 * property and attaches its reactions directly, with no `then` call and no
 * species, and the value arrives without `then` being looked up on it. (An
 * `ownPromise` resolves `await` through its `then`, and a resolution looks
 * `then` up on an object value; binding's answer is an ordinary object.) Its
 * own `then` is Promise.prototype.then as it was at load. Never return it: a
 * `.then` call on it builds its result with the global Promise's species,
 * which code running after load can replace.
 */
export function awaitedHere<T>(promise: Promise<T>): Promise<T> {
  ObjectDefineProperty(promise, "constructor", fixedDescriptor(PromiseCtor));
  ObjectDefineProperty(promise, "then", fixedDescriptor(PromisePrototypeThenOriginal));
  return promise;
}

/**
 * Whether a trusted callback answered exactly true, or with a native promise
 * that fulfills with exactly true. A promise is followed through
 * Promise.prototype.then as it was at load: its handlers receive the value
 * that promise settled with, whatever species that call constructs for the
 * promise it returns (that promise is discarded; a species that throws, or
 * never hands over its resolving functions, makes the answer false). The
 * answer is a boolean, or an `ownPromise` of one, so nothing replaced after
 * load changes it, whether it is awaited or followed with `.then` (the
 * boundary is `ownPromise`'s). Anything else answers false: a value that is
 * not exactly true, a rejection, and an object that is not a native promise
 * (a thenable is never followed).
 */
export function fulfillsWithTrue(answer: unknown): boolean | Promise<boolean> {
  if (typeof answer !== "object" || answer === null) return answer === true;
  return ownPromise(
    new PromiseCtor<boolean>((resolve) => {
      try {
        PromisePrototypeThen(answer as Promise<unknown>, (value) => resolve(value === true), () => resolve(false));
      } catch {
        resolve(false);
      }
    }),
  );
}
