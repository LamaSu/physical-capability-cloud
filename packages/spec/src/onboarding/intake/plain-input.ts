/**
 * Device intake — the input boundary (steward #5225, astra pack 120f). Every
 * intake entry point reads ONE owned, plain-data copy of what it was given, so
 * what is validated, redacted or normalized is exactly what a producer stores,
 * and no accessor, proxy or other non-JSON shape is read twice.
 *
 * plainIntakeCopy = util/plain-data.ts's plainDataCopy (ported verbatim from
 * sensors' #336) plus one rule: the copy must be EXACT. plainDataCopy refuses a
 * proxy, an accessor on an enumerable key, a cycle, a non-plain object, a key
 * named __proto__, a hole and a non-JSON value. But it silently drops a symbol
 * key, a non-enumerable property (astra pack 120g), a named property on an
 * array (120f) and a property whose value is undefined. What a copy drops
 * would also drop out of the token reservation (120e), and an undefined value
 * would be validated as absent though the original holds it. So the original
 * is walked once more, and any of those refuses the input: plain JSON data,
 * exactly as an HTTP body carries it, is what the intake accepts. That walk is
 * trap-free: plainDataCopy already refused proxies, and this walk reads only
 * descriptors, never a getter. The returned `keys` are every object key of the
 * input (all of them are in the copy too).
 *
 * Like plain-data.ts, the walk calls only intrinsics captured when this module
 * loads, keeps its stack in a null-prototype object (an assignment can't reach
 * a setter on Array.prototype) and iterates by index (no iterator protocol). A
 * realm whose intrinsics were replaced before this module loaded was
 * compromised before load. Internal to the intake module.
 */

import { plainDataCopy } from "../../util/plain-data.js";

const ArrayIsArray = Array.isArray;
const NumberCtor = Number;
const ObjectCreate = Object.create;
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const FunctionCall = Function.prototype.call;
const ObjectHasOwn = Object.prototype.hasOwnProperty;
const RegExpTest = RegExp.prototype.test;
const hasOwn = (o: object, key: PropertyKey): boolean => FunctionCall.call(ObjectHasOwn, o, key) as boolean;
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** The exact plain-data copy of an intake input, and every object key of the original. */
export interface PlainIntakeCopy {
  value: unknown;
  keys: ReadonlySet<string>;
}

/** An index of an array this long: a canonical decimal below the length. */
function isIndex(name: string, length: number): boolean {
  return (FunctionCall.call(RegExpTest, CANONICAL_DECIMAL, name) as boolean) && NumberCtor(name) < length;
}

/** The exact copy, or null when the input is not plain JSON data. Never throws. */
export function plainIntakeCopy(input: unknown): PlainIntakeCopy | null {
  const copy = plainDataCopy(input);
  if (!copy.ok) return null;
  const found = ObjectCreate(null) as Record<string, true>;
  try {
    const stack = ObjectCreate(null) as Record<number, unknown>;
    let top = 0;
    stack[top++] = input;
    while (top > 0) {
      const node = stack[--top];
      if (node === null || typeof node !== "object") continue;
      if (ObjectGetOwnPropertySymbols(node).length > 0) return null;
      const isArray = ArrayIsArray(node);
      const length = isArray ? (node as unknown[]).length : 0;
      const names = ObjectGetOwnPropertyNames(node);
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        if (isArray) {
          if (name === "length") continue;
          if (!isIndex(name, length)) return null; // a named property on an array
        } else {
          found[name] = true;
        }
        const d = ObjectGetOwnPropertyDescriptor(node, name);
        // Non-enumerable, an accessor or undefined: none copies exactly, so none may hide data the copy drops.
        if (d === undefined || !d.enumerable || !hasOwn(d, "value") || d.value === undefined) return null;
        stack[top++] = d.value;
      }
    }
  } catch {
    return null;
  }
  const keys = new Set<string>();
  const names = ObjectGetOwnPropertyNames(found);
  for (let i = 0; i < names.length; i++) keys.add(names[i]!);
  return { value: copy.value, keys };
}
