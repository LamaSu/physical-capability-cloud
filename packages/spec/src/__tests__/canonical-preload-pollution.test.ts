import { describe, it, expect, vi, afterEach } from "vitest";
import { canonicalize } from "../util/canonical.js";

/**
 * N15 round 4 (cross-family review A05b, finding 2): round 3 captured
 * Object.prototype.hasOwnProperty when the module loaded and then trusted it to
 * judge descriptors. Pollution installed BEFORE the module loads therefore got
 * captured as the trusted function, and a hasOwnProperty that answers true only
 * for "value" turned an accessor into "data": canonicalize returned the
 * inherited Object.prototype.value instead of refusing.
 *
 * The verdict installs Object.prototype.value before the import too. That order
 * cannot be reproduced here: with an inherited `value`, every getter descriptor
 * the module loader defines (the SSR export getters, and Node's own lazy
 * loaders in a plain process) is rejected as "accessors and a value", so the
 * import itself fails. hasOwnProperty is what the old code captured at load, so
 * it is installed before a FRESH import; `value` is installed after it, before
 * the call. Nothing but the import and the canonicalize calls runs in the
 * window, and every assertion runs after it closes.
 */

type Canonical = typeof import("../util/canonical.js");
type HasOwnProperty = (this: object, key: PropertyKey) => boolean;
type Polluted = { value?: unknown; get?: unknown; set?: unknown; enumerable?: unknown };

interface Result {
  threw: boolean;
  text?: string;
  failure?: unknown;
}

const onlyValue: HasOwnProperty = function (key) {
  return key === "value";
};
const always: HasOwnProperty = () => true;
const never: HasOwnProperty = () => false;

/** A fresh copy of the module, loaded while `Object.prototype.hasOwnProperty` is already replaced. */
async function underPreloadPollution(hasOwnProperty: HasOwnProperty, inputs: unknown[]): Promise<{ fresh: Canonical; results: Result[] }> {
  const results: Result[] = [];
  const original = Object.prototype.hasOwnProperty;
  vi.resetModules();
  Object.prototype.hasOwnProperty = hasOwnProperty;
  let fresh: Canonical | undefined;
  try {
    fresh = await import("../util/canonical.js");
    (Object.prototype as Polluted).value = "job-A";
    for (let i = 0; i < inputs.length; i++) {
      try {
        results[i] = { threw: false, text: fresh.canonicalize(inputs[i]) };
      } catch (failure) {
        results[i] = { threw: true, failure };
      }
    }
  } finally {
    delete (Object.prototype as Polluted).value;
    Object.prototype.hasOwnProperty = original;
  }
  return { fresh: fresh as Canonical, results };
}

describe("canonicalize — pollution that exists BEFORE the module loads (N15 round 4, A05b #2)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  const accessors = () => {
    const ran = { count: 0 };
    const object = Object.defineProperty({}, "jobId", { enumerable: true, get: () => (ran.count++, "job-B") });
    const element = Object.defineProperty([], 0, { enumerable: true, get: () => (ran.count++, "job-B") });
    return { ran, object, element };
  };

  it("refuses an accessor when hasOwnProperty answers true only for 'value' (the verdict's repro); no getter runs", async () => {
    const { ran, object, element } = accessors();
    const { fresh, results } = await underPreloadPollution(onlyValue, [object, element]);
    expect(results[0].text).toBeUndefined(); // round 3 returned {"jobId":"job-A"}
    expect(results[0].threw).toBe(true);
    expect(results[0].failure).toBeInstanceOf(fresh.NonCanonicalValueError);
    expect((results[0].failure as { path: string }).path).toBe("$.jobId");
    expect(results[1].threw).toBe(true);
    expect(results[1].failure).toBeInstanceOf(fresh.NonCanonicalValueError);
    expect((results[1].failure as { path: string }).path).toBe("$[0]");
    expect(ran.count).toBe(0);
  });

  for (const [name, replacement] of [
    ["'value' only", onlyValue],
    ["always true", always],
    ["always false", never],
  ] as const) {
    it(`plain data is still accepted, byte-identical, when hasOwnProperty is replaced before load: ${name}`, async () => {
      const data = { b: [1, "x", null, { d: -0 }], a: true, skip: undefined };
      const { results } = await underPreloadPollution(replacement, [data, [1, 2], "s", null]);
      expect(results.map((r) => r.threw)).toEqual([false, false, false, false]);
      expect(results.map((r) => r.text)).toEqual(['{"a":true,"b":[1,"x",null,{"d":0}]}', "[1,2]", '"s"', "null"]);
    });

    it(`an accessor is refused, and no getter runs, when hasOwnProperty is replaced before load: ${name}`, async () => {
      const { ran, object, element } = accessors();
      const { fresh, results } = await underPreloadPollution(replacement, [object, element]);
      expect(results.map((r) => r.threw)).toEqual([true, true]);
      expect(results[0].failure).toBeInstanceOf(fresh.NonCanonicalValueError);
      expect(results[1].failure).toBeInstanceOf(fresh.NonCanonicalValueError);
      expect(ran.count).toBe(0);
    });
  }

  it("polluting the descriptor field names (get, set, enumerable, value) cannot flip data into an accessor or hide it", () => {
    const { ran, object, element } = accessors();
    const data = { a: 1, b: [2, { c: "x" }] };
    const polluted = Object.prototype as Polluted;
    const outcomes: Result[] = [];
    polluted.get = () => "POISON";
    polluted.set = () => "POISON";
    polluted.enumerable = false;
    polluted.value = "job-A";
    try {
      for (const input of [data, object, element]) {
        try {
          outcomes.push({ threw: false, text: canonicalize(input) });
        } catch (failure) {
          outcomes.push({ threw: true, failure });
        }
      }
    } finally {
      delete polluted.get;
      delete polluted.set;
      delete polluted.enumerable;
      delete polluted.value;
    }
    expect(outcomes[0]).toEqual({ threw: false, text: '{"a":1,"b":[2,{"c":"x"}]}' });
    expect(outcomes[1].threw).toBe(true);
    expect(outcomes[2].threw).toBe(true);
    expect(ran.count).toBe(0);
  });

  it("replacing hasOwnProperty after load changes nothing either", () => {
    const { ran, object } = accessors();
    const outcomes: Result[] = [];
    const original = Object.prototype.hasOwnProperty;
    try {
      for (const replacement of [onlyValue, always, never]) {
        Object.prototype.hasOwnProperty = replacement;
        (Object.prototype as Polluted).value = "job-A";
        try {
          outcomes.push({ threw: false, text: canonicalize({ a: [1] }) });
        } catch (failure) {
          outcomes.push({ threw: true, failure });
        }
        try {
          outcomes.push({ threw: false, text: canonicalize(object) });
        } catch (failure) {
          outcomes.push({ threw: true, failure });
        }
        delete (Object.prototype as Polluted).value;
      }
    } finally {
      delete (Object.prototype as Polluted).value;
      Object.prototype.hasOwnProperty = original;
    }
    expect(outcomes.map((o) => o.threw)).toEqual([false, true, false, true, false, true]);
    expect(outcomes.filter((o) => !o.threw).map((o) => o.text)).toEqual(['{"a":[1]}', '{"a":[1]}', '{"a":[1]}']);
    expect(ran.count).toBe(0);
  });
});
