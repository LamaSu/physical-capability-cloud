import { describe, it, expect } from "vitest";
import { NonCanonicalValueError, canonicalize } from "../util/canonical.js";

/**
 * N15 round 4 (cross-family review A05b, finding 5): the boundary caught errors
 * with `instanceof NonCanonicalValueError`. `instanceof` on a hostile Proxy runs
 * its getPrototypeOf trap, so a trap that threw a Proxy whose own
 * getPrototypeOf trap throws escaped as a plain Error. Errors are now recognised
 * by membership in a module-private registry, never by inspecting the value.
 */

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

/** What canonicalize threw, or its text if it did not throw. */
function attempt(input: unknown): { threw: true; error: unknown } | { threw: false; text: string } {
  try {
    return { threw: false, text: canonicalize(input) };
  } catch (error) {
    return { threw: true, error };
  }
}

describe("canonicalize — round 4 (cross-family A05b #5): errors are classified by identity, never by inspecting them", () => {
  const allTrapsThrow = (message: string): ProxyHandler<object> => {
    const handler: Record<string, unknown> = {};
    for (const trap of ALL_TRAPS) {
      handler[trap] = () => {
        throw new Error(message);
      };
    }
    return handler as ProxyHandler<object>;
  };

  const expectRefusal = (out: ReturnType<typeof attempt>, leaked?: string) => {
    expect(out.threw).toBe(true);
    if (!out.threw) return;
    expect(out.error).toBeInstanceOf(NonCanonicalValueError);
    expect((out.error as NonCanonicalValueError).path).toBe("$");
    if (leaked) expect((out.error as Error).message).not.toContain(leaked);
  };

  it("a thrown Proxy whose getPrototypeOf trap throws is a typed refusal (the verdict's repro)", () => {
    const hostileError = new Proxy({}, {
      getPrototypeOf() {
        throw new Error("escaped");
      },
    });
    const input = new Proxy({}, {
      ownKeys() {
        throw hostileError;
      },
    });
    expectRefusal(attempt(input), "escaped"); // round 3 let the plain Error("escaped") out
  });

  it("whatever a trap throws becomes a typed refusal: primitives, and objects that fight back", () => {
    const thrown: Array<[string, unknown]> = [
      ["a string", "boom"],
      ["a number", 42],
      ["undefined", undefined],
      ["null", null],
      ["a symbol", Symbol("boom")],
      ["a bigint", BigInt(1)],
      ["a boolean", false],
      ["a Proxy whose every trap throws", new Proxy({}, allTrapsThrow("every trap"))],
      ["an object with throwing accessors", Object.defineProperties({}, {
        message: { get() { throw new Error("message"); } },
        name: { get() { throw new Error("name"); } },
        constructor: { get() { throw new Error("constructor"); } },
      })],
      ["a revoked Proxy", (() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()],
    ];
    for (const [name, value] of thrown) {
      const input = new Proxy({}, {
        ownKeys() {
          throw value;
        },
      });
      const out = attempt(input);
      expect(out.threw, name).toBe(true);
      if (out.threw) {
        expect(out.error, name).toBeInstanceOf(NonCanonicalValueError);
        expect((out.error as NonCanonicalValueError).path, name).toBe("$");
      }
    }
  });

  it("an object that merely inherits from NonCanonicalValueError.prototype is not one of ours: it is wrapped", () => {
    const forged = Object.create(NonCanonicalValueError.prototype) as object;
    expect(forged instanceof NonCanonicalValueError).toBe(true); // `instanceof` would have waved it through
    const out = attempt(new Proxy({}, { ownKeys() { throw forged; } }));
    expect(out.threw).toBe(true);
    if (out.threw) {
      expect(out.error).not.toBe(forged);
      expect((out.error as NonCanonicalValueError).path).toBe("$");
    }
  });

  it("a Proxy around a genuine refusal is not that refusal: it is wrapped too", () => {
    const real = (() => {
      try {
        canonicalize({ n: Number.NaN });
      } catch (e) {
        return e as NonCanonicalValueError;
      }
      throw new Error("expected a refusal");
    })();
    expect(real.path).toBe("$.n");
    const lookalike = new Proxy(real, {});
    const out = attempt(new Proxy({}, { ownKeys() { throw lookalike; } }));
    expect(out.threw).toBe(true);
    if (out.threw) {
      expect(out.error).not.toBe(lookalike);
      expect(out.error).toBeInstanceOf(NonCanonicalValueError);
      expect((out.error as NonCanonicalValueError).path).toBe("$");
    }
  });

  it("the module's own refusals pass through unchanged, with the path where they arose", () => {
    const out = attempt({ a: [1, { deep: Number.NaN }] });
    expect(out.threw).toBe(true);
    if (out.threw) {
      expect(out.error).toBeInstanceOf(NonCanonicalValueError);
      expect((out.error as NonCanonicalValueError).path).toBe("$.a[1].deep");
    }
  });

  it("a value nested too deeply to walk is still a typed refusal", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expectRefusal(attempt(deep));
  });
});

// ---------------------------------------------------------------------------
// N15 round 5 (cross-family review A05c, finding F3)
// ---------------------------------------------------------------------------

/**
 * NonCanonicalValueError's constructor assigned `this.name` with an ordinary [[Set]].
 * An instance does not own `name`, so the assignment walks the prototype chain, and a
 * setter installed on Error.prototype after the module loaded ran inside the
 * constructor. The constructor then threw a plain Error before the new error could be
 * registered, the boundary's own catch tried to build another one, which threw the
 * same way, and a plain Error escaped canonicalize. Both `name` and `path` are now
 * DEFINED as own data properties with a Reflect.defineProperty captured at load, so no
 * inherited setter is consulted.
 */

/**
 * Install a setter on Error.prototype[key] that throws, with a getter that still answers what
 * the property held, while `fn` runs; always put the original back. Only `fn` runs inside the
 * window; assertions run after it closes.
 */
function withThrowingErrorPrototypeSetter<T>(key: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(Error.prototype, key);
  Object.defineProperty(Error.prototype, key, {
    configurable: true,
    get() {
      return original ? original.value : undefined;
    },
    set() {
      throw new Error("escaped: the Error.prototype." + key + " setter ran");
    },
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(Error.prototype, key, original);
    else delete (Error.prototype as unknown as Record<string, unknown>)[key];
  }
}

describe("canonicalize -- round 5 (cross-family A05c F3): the refusal is built without consulting Error.prototype", () => {
  const refused: Array<[string, () => unknown, string]> = [
    ["a NaN member", () => ({ n: Number.NaN }), "$.n"],
    ["an undefined element", () => [1, undefined], "$[1]"],
    ["a Proxy trap that throws (the boundary builds the error itself)", () => new Proxy({}, { ownKeys() { throw new Error("trap"); } }), "$"],
    ["a value nested too deeply to walk", () => { let deep: unknown = 0; for (let i = 0; i < 100_000; i++) deep = [deep]; return deep; }, "$"],
  ];

  for (const key of ["name", "path"]) {
    for (const [what, make, path] of refused) {
      it(`A05c F3: a throwing Error.prototype.${key} setter installed after load cannot let a plain Error out: ${what}`, () => {
        const input = make();
        const out = withThrowingErrorPrototypeSetter(key, () => attempt(input));
        expect(out.threw).toBe(true);
        if (out.threw) {
          expect(out.error).toBeInstanceOf(NonCanonicalValueError); // faac0003 let the plain Error("escaped...") out
          expect((out.error as Error).message).not.toContain("escaped");
          expect((out.error as NonCanonicalValueError).path).toBe(path);
          expect((out.error as NonCanonicalValueError).name).toBe("NonCanonicalValueError");
        }
      });
    }
  }

  it("a refusal built under such a setter is still the module's own: it passes through the boundary unchanged", () => {
    const real = withThrowingErrorPrototypeSetter("name", () => attempt({ a: [{ n: Number.NaN }] }));
    expect(real.threw).toBe(true);
    if (real.threw) {
      expect(real.error).toBeInstanceOf(NonCanonicalValueError);
      expect((real.error as NonCanonicalValueError).path).toBe("$.a[0].n");
    }
  });

  it("name and path are own data properties, as they were when they were assigned (writable, enumerable, configurable)", () => {
    const out = attempt({ n: Number.NaN });
    expect(out.threw).toBe(true);
    if (out.threw) {
      const error = out.error as object;
      expect(Object.getOwnPropertyDescriptor(error, "name")).toEqual({
        value: "NonCanonicalValueError",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(Object.getOwnPropertyDescriptor(error, "path")).toEqual({
        value: "$.n",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      expect(Object.getPrototypeOf(error)).toBe(NonCanonicalValueError.prototype);
      expect((error as Error).message).toBe("canonicalize: NaN at $.n has no JSON form; refusing to hash it");
    }
  });

  it("leaves Error.prototype exactly as it found it (no test above leaks a setter)", () => {
    expect(Object.getOwnPropertyDescriptor(Error.prototype, "name")).toEqual({
      value: "Error",
      writable: true,
      enumerable: false,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(Error.prototype, "path")).toBeUndefined();
  });
});
