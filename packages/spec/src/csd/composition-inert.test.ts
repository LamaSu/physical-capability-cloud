import { describe, expect, it } from "vitest";
import { isInertJsonValue } from "./composition.js";

/**
 * The inert-JSON boundary reads property DESCRIPTORS only. A descriptor is an ordinary object, so
 * any check on it must be an OWN-property check: an inherited `value`, `get` or `set` (from a
 * polluted Object.prototype) must never decide whether a property is data (#5147, found by sensors
 * #5136).
 */
function withPrototypeKey(key: "value" | "get" | "set", v: unknown, run: () => void): void {
  const proto = Object.prototype as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(proto, key);
  Object.defineProperty(proto, key, { value: v, configurable: true, writable: true, enumerable: false });
  try {
    run();
  } finally {
    if (!had) delete proto[key];
  }
}

function objectWithEmptyAccessor(): object {
  const o = {};
  Object.defineProperty(o, "k", { get: undefined, set: undefined, enumerable: true, configurable: true });
  return o;
}

function arrayWithEmptyAccessor(): unknown[] {
  const a: unknown[] = [1];
  Object.defineProperty(a, "0", { get: undefined, set: undefined, enumerable: true, configurable: true });
  return a;
}

describe("isInertJsonValue checks descriptors by OWN properties only", () => {
  it("a clean realm: an accessor without get/set is refused, plain data is accepted", () => {
    expect(isInertJsonValue(objectWithEmptyAccessor())).toBe(false);
    expect(isInertJsonValue(arrayWithEmptyAccessor())).toBe(false);
    expect(isInertJsonValue({ k: 1, a: [1, "x", null, { b: true }] })).toBe(true);
  });

  // The accessors are built BEFORE the prototype is polluted: with `value` inherited, defineProperty
  // would read it from the descriptor literal itself and refuse an accessor-plus-value descriptor.
  it("an inherited `value` never makes an accessor look like data (object)", () => {
    const o = objectWithEmptyAccessor();
    withPrototypeKey("value", 1, () => {
      expect(isInertJsonValue(o)).toBe(false);
    });
  });

  it("an inherited `value` never makes an accessor look like data (array element)", () => {
    const a = arrayWithEmptyAccessor();
    withPrototypeKey("value", 1, () => {
      expect(isInertJsonValue(a)).toBe(false);
    });
  });

  it("an inherited `get` or `set` never makes plain data look like an accessor", () => {
    for (const key of ["get", "set"] as const) {
      withPrototypeKey(key, () => 1, () => {
        expect(isInertJsonValue({ k: 1 })).toBe(true);
        expect(isInertJsonValue([1, 2])).toBe(true);
      });
    }
  });
});
