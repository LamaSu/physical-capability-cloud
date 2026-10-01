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
