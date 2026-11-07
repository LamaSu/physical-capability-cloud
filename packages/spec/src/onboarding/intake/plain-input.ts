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
 * descriptors, never a getter. The returned `reserved` accepts exactly the
 * object keys of the input (all of them are in the copy too).
 *
 * The boundary: hostile data in, hostile in-process code out. The intake
 * defends against any shape of hostile DATA; code that can replace the realm's
 * built-ins after load is outside the contract, because it can already read
 * the raw input, so the display guarantee adds nothing against it (steward
 * ruling #5308). The walk's style (captured intrinsics, a null-prototype stack,
 * char-code index checks) follows util/plain-data.ts for consistency only; it
 * is not a guarantee against such code. Internal to the intake module.
 */

import { plainDataCopy } from "../../util/plain-data.js";
import type { KeyReservation } from "./secret-scan.js";

// Written in util/plain-data.ts's style for consistency; not a guarantee against code that
// rewrites built-ins (out of contract: see the header).
const ReflectApply = Reflect.apply;
const ArrayIsArray = Array.isArray;
const ObjectCreate = Object.create;
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectHasOwn = Object.prototype.hasOwnProperty;
const StringCharCodeAt = String.prototype.charCodeAt;
const hasOwn = (o: object, key: PropertyKey): boolean => ReflectApply(ObjectHasOwn, o, [key]) as boolean;

/** The exact plain-data copy of an intake input, and the reservation of every object key of the original. */
export interface PlainIntakeCopy {
  value: unknown;
  /** Accepts exactly the object keys of the input. */
  reserved: KeyReservation;
}

/** An index of an array this long: a canonical decimal below the length, checked by char codes (no RegExp). */
function isIndex(name: string, length: number): boolean {
  const n = name.length;
  if (n === 0 || n > 10) return false;
  if ((ReflectApply(StringCharCodeAt, name, [0]) as number) === 48) return n === 1 && length > 0;
  let value = 0;
  for (let i = 0; i < n; i++) {
    const c = ReflectApply(StringCharCodeAt, name, [i]) as number;
    if (c < 48 || c > 57) return false;
    value = value * 10 + (c - 48);
  }
  return value < length;
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
  const value = copy.value;
  return { value, reserved: (key) => typeof key === "string" && hasOwn(found, key) };
}
