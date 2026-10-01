import { describe, it, expect } from "vitest";
import { NonCanonicalValueError, canonicalize } from "../util/canonical.js";

/**
 * N15 round 4 (cross-family review A05b, finding 4): canonicalize says that the
 * only input code which can run is a Proxy's reflection traps (getPrototypeOf,
 * ownKeys, getOwnPropertyDescriptor). A proxied array's `arr.length` ran its
 * `get` trap, so the claim was false. The length is now read, and validated,
 * through the array's own `length` descriptor.
 */

const REFLECTION_TRAPS = ["getOwnPropertyDescriptor", "getPrototypeOf", "ownKeys"];
const ALL_TRAPS = [
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

/** A Proxy whose every trap records its name and forwards to the target. */
function spy<T extends object>(target: T): { proxy: T; ran: string[] } {
  const ran: string[] = [];
  const handler: Record<string, unknown> = {};
  for (const trap of ALL_TRAPS) {
    handler[trap] = (...args: unknown[]) => {
      ran.push(trap);
      return (Reflect as unknown as Record<string, (...a: unknown[]) => unknown>)[trap](...args);
    };
  }
  return { proxy: new Proxy(target, handler as ProxyHandler<T>), ran };
}

/** What canonicalize threw, or its text if it did not throw. */
function attempt(input: unknown): { threw: true; error: unknown } | { threw: false; text: string } {
  try {
    return { threw: false, text: canonicalize(input) };
  } catch (error) {
    return { threw: true, error };
  }
}

describe("canonicalize — round 4 (cross-family A05b #4): only the reflection traps run", () => {
  it("reads a proxied array's length through its descriptor: the get trap never runs for it (the verdict's repro)", () => {
    let lengthReads = 0;
    const input = new Proxy([1], {
      get(target, key, receiver) {
        if (key === "length") lengthReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(canonicalize(input)).toBe("[1]");
    expect(lengthReads).toBe(0); // round 3 read it once through the get trap
  });

  it("runs no trap but getPrototypeOf, ownKeys and getOwnPropertyDescriptor: arrays", () => {
    const { proxy, ran } = spy([1, "two", null]);
    expect(canonicalize(proxy)).toBe('[1,"two",null]');
    expect(ran.filter((trap) => !REFLECTION_TRAPS.includes(trap))).toEqual([]);
    expect(ran).toContain("getOwnPropertyDescriptor");
    expect(ran).toContain("ownKeys");
    expect(ran).toContain("getPrototypeOf");
  });

  it("runs no trap but getPrototypeOf, ownKeys and getOwnPropertyDescriptor: objects", () => {
    const { proxy, ran } = spy({ b: 1, a: [2] });
    expect(canonicalize(proxy)).toBe('{"a":[2],"b":1}');
    expect(ran.filter((trap) => !REFLECTION_TRAPS.includes(trap))).toEqual([]);
    expect(ran).toContain("getOwnPropertyDescriptor");
  });

  it("a proxy nested in a plain tree obeys the same boundary", () => {
    const { proxy, ran } = spy([1, 2]);
    expect(canonicalize({ list: proxy })).toBe('{"list":[1,2]}');
    expect(ran.filter((trap) => !REFLECTION_TRAPS.includes(trap))).toEqual([]);
  });

  // A trap may report any value for `length` that the target allows to change: the engine only checks
  // that the property stays a compatible non-configurable data property.
  const claims: Array<[string, unknown]> = [
    ["-1", -1],
    ["1.5", 1.5],
    ["a string", "1"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["2 ** 53", 2 ** 53],
    ["1e300", 1e300],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
  ];
  for (const [name, claim] of claims) {
    it(`refuses a proxied array whose reflected length is ${name}`, () => {
      const input = new Proxy([1], {
        getOwnPropertyDescriptor(target, key) {
          const real = Reflect.getOwnPropertyDescriptor(target, key);
          return key === "length" ? { ...real, value: claim } : real;
        },
      });
      const out = attempt({ list: input });
      expect(out.threw).toBe(true);
      if (out.threw) {
        expect(out.error).toBeInstanceOf(NonCanonicalValueError);
        expect((out.error as NonCanonicalValueError).path).toBe("$.list");
        expect((out.error as NonCanonicalValueError).message).toMatch(/length/);
      }
    });
  }

  it("a reflected length that disagrees with the elements is refused, not hashed: shorter", () => {
    const input = new Proxy([1, 2, 3], {
      getOwnPropertyDescriptor(target, key) {
        const real = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "length" ? { ...real, value: 1 } : real;
      },
    });
    const out = attempt(input);
    expect(out.threw).toBe(true);
    if (out.threw) expect((out.error as NonCanonicalValueError).path).toBe("$.1");
  });

  it("a reflected length that disagrees with the elements is refused, not hashed: longer", () => {
    const input = new Proxy([1], {
      getOwnPropertyDescriptor(target, key) {
        const real = Reflect.getOwnPropertyDescriptor(target, key);
        return key === "length" ? { ...real, value: 3 } : real;
      },
    });
    const out = attempt(input);
    expect(out.threw).toBe(true);
    if (out.threw) expect((out.error as NonCanonicalValueError).path).toBe("$[1]");
  });

  it("an honest proxied array, and ordinary arrays, keep their bytes", () => {
    expect(canonicalize(new Proxy([1, [2, 3], "x"], {}))).toBe('[1,[2,3],"x"]');
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize(new Proxy([], {}))).toBe("[]");
  });
});
