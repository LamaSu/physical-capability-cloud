/**
 * N188: in-process caller values may be hostile even though transported JSON cannot be.
 * Refusing them never invokes their coercion methods, re-reads their agreement, or trusts
 * WeakSet prototype methods replaced after this module loaded.
 */

import { describe, expect, it } from "vitest";
import { compileEconomics, type CompileOptions } from "../economics/compile.js";
import { exampleGuildRepair } from "../economics/examples.js";
import { snapshotJson } from "../economics/input.js";
import { kitRoyaltyRequirement } from "../economics/kits.js";
import { simulateEconomics } from "../economics/simulate.js";

/** All 13 Proxy traps count once and forward to Reflect, including on callable targets. */
function countingProxy<T extends object>(target: T): { value: T; trapCount: () => number } {
  let count = 0;
  const handler: ProxyHandler<T> = {
    getPrototypeOf(target) {
      count++;
      return Reflect.getPrototypeOf(target);
    },
    setPrototypeOf(target, prototype) {
      count++;
      return Reflect.setPrototypeOf(target, prototype);
    },
    isExtensible(target) {
      count++;
      return Reflect.isExtensible(target);
    },
    preventExtensions(target) {
      count++;
      return Reflect.preventExtensions(target);
    },
    getOwnPropertyDescriptor(target, property) {
      count++;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    defineProperty(target, property, descriptor) {
      count++;
      return Reflect.defineProperty(target, property, descriptor);
    },
    has(target, property) {
      count++;
      return Reflect.has(target, property);
    },
    get(target, property, receiver) {
      count++;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      count++;
      return Reflect.set(target, property, value, receiver);
    },
    deleteProperty(target, property) {
      count++;
      return Reflect.deleteProperty(target, property);
    },
    ownKeys(target) {
      count++;
      return Reflect.ownKeys(target);
    },
    apply(target, thisArg, args) {
      count++;
      return Reflect.apply(target as Function, thisArg, args);
    },
    construct(target, args, newTarget) {
      count++;
      return Reflect.construct(target as Function, args, newTarget);
    },
  };
  return { value: new Proxy(target, handler), trapCount: () => count };
}

function expectBpsRefusal(input: unknown, suffix: string): void {
  let thrown: unknown;
  try {
    kitRoyaltyRequirement(input as Parameters<typeof kitRoyaltyRequirement>[0]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof RangeError).toBe(true);
  expect((thrown as RangeError).message).toBe(`a royalty is 0..10000 bps, not ${suffix}`);
}

function S(id: string) {
  return { scenarioId: id, label: id, grossOverrides: [], usesOverrides: [], outcomes: [] };
}

function cycle(): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  object.self = object;
  return object;
}

describe("N188 K: kitRoyaltyRequirement cannot coerce refused caller values", () => {
  it("K1: hostile objects, arrays, functions and Proxies throw RangeError without running caller code", () => {
    let toStringRan = false;
    const throwingToString = {
      toString() {
        toStringRan = true;
        throw new TypeError("caller toString ran");
      },
    };
    expectBpsRefusal({ bps: throwingToString, lineage: ["ann"] }, "an object");
    expect(toStringRan).toBe(false);

    let primitiveRan = false;
    const throwingPrimitive = {
      [Symbol.toPrimitive]() {
        primitiveRan = true;
        throw new Error("caller Symbol.toPrimitive ran");
      },
    };
    expectBpsRefusal({ bps: throwingPrimitive, lineage: ["ann"] }, "an object");
    expect(primitiveRan).toBe(false);

    let valueOfRan = false;
    let ordinaryToStringRan = false;
    const coercible = {
      valueOf() {
        valueOfRan = true;
        return 5;
      },
      toString() {
        ordinaryToStringRan = true;
        return 5;
      },
    };
    expectBpsRefusal({ bps: coercible, lineage: ["ann"] }, "an object");
    expect(valueOfRan).toBe(false);
    expect(ordinaryToStringRan).toBe(false);

    const objectProxy = countingProxy({});
    expectBpsRefusal({ bps: objectProxy.value, lineage: ["ann"] }, "an object");
    expect(objectProxy.trapCount()).toBe(0);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expectBpsRefusal({ bps: revoked.proxy, lineage: ["ann"] }, "an object");
    expectBpsRefusal({ bps: [50], lineage: ["ann"] }, "an object");

    let functionToStringRan = false;
    const callable = () => 50;
    Object.defineProperty(callable, "toString", {
      value() {
        functionToStringRan = true;
        return "50";
      },
    });
    expectBpsRefusal({ bps: callable, lineage: ["ann"] }, "a function");
    expect(functionToStringRan).toBe(false);

    const functionProxy = countingProxy(function () {});
    expectBpsRefusal({ bps: functionProxy.value, lineage: ["ann"] }, "a function");
    expect(functionProxy.trapCount()).toBe(0);
  });

  it("K2: each refused primitive retains the exact base message", () => {
    const cases: Array<[unknown, string]> = [
      [10_001, "10001"],
      [-1, "-1"],
      [1.5, "1.5"],
      [NaN, "NaN"],
      ["50", "50"],
      [null, "null"],
      [true, "true"],
      [50n, "50"],
      [Symbol("s"), "Symbol(s)"],
      [undefined, "undefined"],
    ];
    for (const [bps, suffix] of cases) expectBpsRefusal({ bps, lineage: ["ann"] }, suffix);
  });

  it("K3: missing and accessor bps are unreadable; the getter is never called", () => {
    expectBpsRefusal({ lineage: ["ann"] }, "unreadable");
    const inherited = Object.create({ bps: 50 }) as { bps: number; lineage: string[] };
    inherited.lineage = ["ann"];
    expectBpsRefusal(inherited, "unreadable");
    let getterRan = false;
    const withGetter = { lineage: ["ann"] };
    Object.defineProperty(withGetter, "bps", {
      enumerable: true,
      get() {
        getterRan = true;
        return 50;
      },
    });
    expectBpsRefusal(withGetter, "unreadable");
    expect(getterRan).toBe(false);
  });
});

describe("N188 R: simulateEconomics does not re-read refused agreements", () => {
  it("R1: a failed first snapshot cannot become an empty refusal after a later successful read", () => {
    let ownKeysCalls = 0;
    const agreement = new Proxy(exampleGuildRepair(), {
      ownKeys(target) {
        ownKeysCalls++;
        if (ownKeysCalls === 1) throw new Error("first copy cannot read keys");
        return Reflect.ownKeys(target);
      },
    });
    expect(simulateEconomics(agreement, [S("s1"), S("s2")])).toEqual([
      { scenarioId: "s1", label: "s1", ok: false, refusals: [{ code: "SCHEMA_INVALID", message: "the input could not be read as JSON data", path: [] }] },
      { scenarioId: "s2", label: "s2", ok: false, refusals: [{ code: "SCHEMA_INVALID", message: "the input could not be read as JSON data", path: [] }] },
    ]);
    expect(ownKeysCalls).toBe(1);
  });

  it("R2: three valid scenarios cause only the traps of the initial snapshot", () => {
    const single = countingProxy({ f: () => 1 });
    snapshotJson(single.value);
    const simulated = countingProxy({ f: () => 1 });
    simulateEconomics(simulated.value, [S("a"), S("b"), S("c")]);
    expect(single.trapCount()).toBe(3);
    expect(simulated.trapCount()).toBe(single.trapCount());
  });

  it("R3: six invalid agreements times four options reproduce compile refusals, including both failures", () => {
    const agreements: Array<{ name: string; make: () => unknown }> = [
      { name: "cyclic", make: cycle },
      { name: "function member", make: () => ({ f: () => 1 }) },
      { name: "date", make: () => new Date(0) },
      { name: "empty", make: () => ({}) },
      { name: "invalid version", make: () => ({ ...exampleGuildRepair(), version: -1 }) },
      { name: "bigint", make: () => 5n },
    ];
    const optionCases: Array<{ name: string; make: () => CompileOptions }> = [
      { name: "valid", make: () => ({}) },
      { name: "null", make: () => null as unknown as CompileOptions },
      { name: "cyclic", make: () => cycle() as unknown as CompileOptions },
      { name: "bad fee", make: () => ({ feeBps: "x" }) as unknown as CompileOptions },
    ];

    for (const agreementCase of agreements) {
      for (const optionCase of optionCases) {
        const agreement = agreementCase.make();
        const options = optionCase.make();
        const compiled = compileEconomics(agreement, options);
        expect(compiled.ok, `${agreementCase.name}, ${optionCase.name}`).toBe(false);
        if (compiled.ok) throw new Error("invalid fixture compiled");

        const result = simulateEconomics(agreement, [S("a"), S("b")], options);
        expect(result, `${agreementCase.name}, ${optionCase.name}`).toEqual([
          { scenarioId: "a", label: "a", ok: false, refusals: compiled.refusals },
          { scenarioId: "b", label: "b", ok: false, refusals: compiled.refusals },
        ]);
        if (agreementCase.name === "cyclic" && optionCase.name === "cyclic") {
          expect(compiled.refusals).toEqual([
            { code: "SCHEMA_INVALID", message: "input.self contains itself", path: [] },
            { code: "SCHEMA_INVALID", message: "options: input.self contains itself", path: ["options"] },
          ]);
        }
      }
    }
  });

  it("R4: a malformed scenario keeps its own schema-invalid result and synthetic id", () => {
    const result = simulateEconomics(cycle(), [S("a"), { scenarioId: "b" }]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      scenarioId: "a",
      label: "a",
      ok: false,
      refusals: [{ code: "SCHEMA_INVALID", message: "input.self contains itself", path: [] }],
    });
    expect(result[1]).toMatchObject({
      scenarioId: "scenario-1",
      label: "invalid scenario",
      ok: false,
      refusals: [{ code: "SCHEMA_INVALID", path: ["scenario"] }],
    });
  });

  it("R5: each scenario owns its refusal array and refusal objects", () => {
    const [first, second] = simulateEconomics(cycle(), [S("a"), S("b")], {});
    if (!first || !second || first.ok || second.ok) throw new Error("fixture must refuse both scenarios");
    expect(first.refusals).not.toBe(second.refusals);
    expect(first.refusals[0]).not.toBe(second.refusals[0]);
    expect(first.refusals).toEqual(second.refusals);
  });
});

describe("N188 W: snapshotJson uses WeakSet methods bound at load", () => {
  it("W1: replaced WeakSet.add/has cannot escape the refusal boundary", () => {
    const originalAdd = WeakSet.prototype.add;
    const originalHas = WeakSet.prototype.has;
    let cycleResult: unknown;
    let proxyResult: unknown;
    let thrown: unknown;
    try {
      WeakSet.prototype.add = (() => { throw new Error("replaced add ran"); }) as typeof WeakSet.prototype.add;
      WeakSet.prototype.has = (() => { throw new Error("replaced has ran"); }) as typeof WeakSet.prototype.has;
      try {
        cycleResult = snapshotJson(cycle());
        proxyResult = snapshotJson(new Proxy({}, {
          ownKeys() {
            throw new Error("caller ownKeys ran");
          },
        }));
      } catch (error) {
        thrown = error;
      }
    } finally {
      WeakSet.prototype.add = originalAdd;
      WeakSet.prototype.has = originalHas;
    }
    // All assertions run only after the original methods have been restored.
    expect(thrown).toBeUndefined();
    expect(cycleResult).toEqual({ ok: false, reason: "input.self contains itself" });
    expect(proxyResult).toEqual({ ok: false, reason: "the input could not be read as JSON data" });
  });
});
