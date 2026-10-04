/**
 * astra pack 309 HIGH (PR #578 @1a56cf2b): checkTierRequirements read the fields of the caller's
 * requirements, events and options through ordinary property access, so a write on Object.prototype
 * after load changed its answer. Reproduced at 1a56cf2b
 * (/mnt/sparkbulk/tmp/sensors/round8/order/r309/repro-309.mts):
 *   - requirements [{}] for tier 2: { met: false, missing: ["No requirements defined for tier 2"] };
 *     with Object.prototype.tier = 2, .requiredEventTypes = [] and .minimumEvents = 0 written after
 *     load, { met: true, missing: [] };
 *   - three Tier-1 events with no own `type`: not met; with an Object.prototype.type getter answering
 *     gcode_hash_verified, execution_completed and power_profile_summary in turn: met, the getter run
 *     3 times.
 * Every field is now read as the caller's OWN data, through descriptors (ownField, ownElements): no
 * getter runs, and nothing a prototype serves is read. A Proxy, an accessor, or a field missing or of
 * the wrong shape fails closed. registerStep's unit is read the same way.
 */

import { describe, it, expect, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource, TierEvidenceRequirements } from "@pcc/spec";

import { EvidenceEmitter } from "../evidence-emitter.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

// Captured at load: the test writes and restores Object.prototype only through these.
const defineAtLoad = Reflect.defineProperty;
const deleteAtLoad = Reflect.deleteProperty;
const ObjectPrototype = Object.prototype;

const KERNEL_ID = "kernel-tier-own-data";
const UNIT = { settlementUnitId: `0x${"ab".repeat(32)}`, challengeNonce: `0x${"cd".repeat(32)}` };

function source(deviceId: string, deviceType: EvidenceSource["deviceType"] = "controller"): EvidenceSource {
  return { deviceId, deviceType, kernelId: KERNEL_ID };
}

/** An event as the emitter stores it, with every field its own. */
function stored(type: string, i: number, deviceType: EvidenceSource["deviceType"] = "controller"): EvidenceEvent {
  return { id: `e${i}`, hash: `sha256:${i}`, type: type as EvidenceEvent["type"], timestamp: new Date(0).toISOString(), source: source(`dev-${i}`, deviceType), payload: {} };
}

const TIER1_TYPES = ["gcode_hash_verified", "execution_completed", "power_profile_summary"];
const tier1 = (): EvidenceEvent[] => TIER1_TYPES.map((type, i) => stored(type, i, type === "power_profile_summary" ? "power_monitor" : "controller"));

/** Runs `body` with `values` written on Object.prototype (as data, or a getter counting its runs), then removes them. */
function withPrototype<T>(values: Record<string, unknown>, body: () => T, getter?: { key: string; answers: readonly unknown[]; runs: { n: number } }): T {
  const keys = Object.keys(values);
  try {
    for (const key of keys) defineAtLoad(ObjectPrototype, key, { value: values[key], configurable: true, writable: true, enumerable: false });
    if (getter !== undefined) {
      defineAtLoad(ObjectPrototype, getter.key, { configurable: true, enumerable: false, get: () => getter.answers[getter.runs.n++ % getter.answers.length] });
    }
    return body();
  } finally {
    for (const key of keys) deleteAtLoad(ObjectPrototype, key);
    if (getter !== undefined) deleteAtLoad(ObjectPrototype, getter.key);
  }
}

/** A Proxy of `target` whose every trap counts its runs into `runs` before doing what the target would. */
function counted<T extends object>(target: T, runs: { n: number }): T {
  const handler: ProxyHandler<T> = {};
  for (const trap of ["get", "set", "has", "ownKeys", "getOwnPropertyDescriptor", "defineProperty", "deleteProperty", "getPrototypeOf", "setPrototypeOf", "isExtensible", "preventExtensions", "apply", "construct"] as const) {
    (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
      runs.n++;
      return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
    };
  }
  return new Proxy(target, handler);
}

/** `target` with `key` turned into an enumerable accessor answering `value`, counting its runs. */
function accessor<T extends object>(target: T, key: PropertyKey, value: unknown, runs: { n: number }): T {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, get: () => (runs.n++, value) });
  return target;
}

describe("checkTierRequirements reads the caller's requirements, events and options as own data (astra pack 309)", () => {
  const emitter = new EvidenceEmitter(KERNEL_ID);

  it("astra's first reproduction: a prototype's tier, requiredEventTypes and minimumEvents do not make an empty requirement tier 2's", () => {
    const requirements = [{}] as unknown as TierEvidenceRequirements[];
    const clean = emitter.checkTierRequirements([], 2, requirements);
    const hostile = withPrototype({ tier: 2, requiredEventTypes: [], minimumEvents: 0 }, () => emitter.checkTierRequirements([], 2, requirements));
    expect(clean).toEqual({ met: false, missing: ["No requirements defined for tier 2"] });
    expect(hostile).toEqual(clean);
  });

  it("astra's second: an Object.prototype.type getter gives typeless events no type, and never runs", () => {
    const events = tier1().map((e) => {
      const { type: _type, ...rest } = e;
      return rest;
    }) as unknown as EvidenceEvent[];
    const clean = emitter.checkTierRequirements(events, 1);
    const runs = { n: 0 };
    const hostile = withPrototype({}, () => emitter.checkTierRequirements(events, 1), { key: "type", answers: TIER1_TYPES, runs });
    expect(clean.met).toBe(false);
    expect(hostile).toEqual(clean);
    expect(runs.n).toBe(0);
  });

  it("a requirement's missing field is not read from a prototype: it fails closed", () => {
    const noMinimum = [{ tier: 2, requiredEventTypes: [["gcode_hash_verified"]] }] as unknown as TierEvidenceRequirements[];
    const noTypes = [{ tier: 2, minimumEvents: 0 }] as unknown as TierEvidenceRequirements[];
    const events = tier1();
    for (const requirements of [noMinimum, noTypes]) {
      const clean = emitter.checkTierRequirements(events, 2, requirements);
      const hostile = withPrototype({ minimumEvents: 0, requiredEventTypes: [] }, () => emitter.checkTierRequirements(events, 2, requirements));
      expect(clean).toEqual({ met: false, missing: ["the requirements for tier 2 are not plain data"] });
      expect(hostile).toEqual(clean);
    }
  });

  it("the default requirements still answer as before for own-data events", () => {
    expect(emitter.checkTierRequirements(tier1(), 1)).toEqual({ met: true, missing: [] });
    expect(emitter.checkTierRequirements(tier1().slice(1), 1).met).toBe(false);
  });

  it("a Proxy or an accessor anywhere in the requirements fails closed, and runs no trap or getter", () => {
    const own = (): TierEvidenceRequirements => ({ tier: 1, requiredEventTypes: [["gcode_hash_verified"]], minimumEvents: 1 }) as TierEvidenceRequirements;
    const cases: Array<[string, (runs: { n: number }) => TierEvidenceRequirements[], string]> = [
      ["the list is a Proxy", (runs) => counted([own()], runs), "the tier requirements are not plain data"],
      ["an element is an accessor", (runs) => accessor([] as TierEvidenceRequirements[], 0, own(), runs), "the tier requirements are not plain data"],
      ["a requirement is a Proxy", (runs) => [counted(own(), runs)], "a tier requirement is not plain data"],
      ["a requirement's tier is an accessor", (runs) => [accessor(own(), "tier", 1, runs)], "a tier requirement is not plain data"],
      ["its requiredEventTypes is an accessor", (runs) => [accessor(own(), "requiredEventTypes", [["gcode_hash_verified"]], runs)], "the requirements for tier 1 are not plain data"],
      ["a group is a Proxy", (runs) => [{ ...own(), requiredEventTypes: [counted(["gcode_hash_verified"], runs)] } as TierEvidenceRequirements], "the requirements for tier 1 are not plain data"],
      ["its minimumEvents is an accessor", (runs) => [accessor(own(), "minimumEvents", 1, runs)], "the requirements for tier 1 are not plain data"],
    ];
    for (const [name, make, reason] of cases) {
      const runs = { n: 0 };
      const answer = emitter.checkTierRequirements(tier1(), 1, make(runs));
      expect(answer, name).toEqual({ met: false, missing: [reason] });
      expect(runs.n, `${name}: traps or getters run`).toBe(0);
    }
  });

  it("a Proxy or an accessor among the events or options fails closed, and runs no trap or getter", () => {
    const notOwn = "an event whose type is not its own string (an accessor, a Proxy, an inherited or a missing field) does not count";
    {
      const runs = { n: 0 };
      expect(emitter.checkTierRequirements(counted(tier1(), runs), 1)).toEqual({ met: false, missing: ["the events are not plain data"] });
      expect(runs.n).toBe(0);
    }
    {
      const runs = { n: 0 };
      const events = tier1();
      events[0] = counted(events[0]!, runs);
      const answer = emitter.checkTierRequirements(events, 1);
      expect(answer.met).toBe(false);
      expect(answer.missing).toContain(notOwn);
      expect(runs.n).toBe(0);
    }
    {
      const runs = { n: 0 };
      const events = tier1();
      accessor(events[0]!, "type", "gcode_hash_verified", runs);
      const answer = emitter.checkTierRequirements(events, 1);
      expect(answer.met).toBe(false);
      expect(answer.missing).toContain(notOwn);
      expect(runs.n).toBe(0);
    }
    {
      const runs = { n: 0 };
      const viaProxy = emitter.checkTierRequirements(tier1(), 1, undefined, counted({ jobId: "job-1" }, runs));
      const viaAccessor = emitter.checkTierRequirements(tier1(), 1, undefined, accessor({} as { jobId?: string }, "jobId", "job-1", runs));
      expect(viaProxy).toEqual(emitter.checkTierRequirements(tier1(), 1, undefined, {}));
      expect(viaAccessor).toEqual(viaProxy);
      expect(runs.n).toBe(0);
    }
  });
});

describe("registerStep reads the caller's unit as own data (astra pack 309)", () => {
  it("an inherited, accessor or Proxy unit field is refused, and no getter or trap runs", () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    expect(() => emitter.registerStep("job", "own", 1, { ...UNIT })).not.toThrow();
    const refused = /settlementUnitId and challengeNonce must be/;
    expect(() => withPrototype(UNIT, () => emitter.registerStep("job", "inherited", 1, {} as typeof UNIT))).toThrow(refused);
    const runs = { n: 0 };
    expect(() => emitter.registerStep("job", "accessor", 1, accessor({ ...UNIT }, "challengeNonce", UNIT.challengeNonce, runs))).toThrow(refused);
    expect(() => emitter.registerStep("job", "proxy", 1, counted({ ...UNIT }, runs))).toThrow(refused);
    expect(runs.n).toBe(0);
  });
});
