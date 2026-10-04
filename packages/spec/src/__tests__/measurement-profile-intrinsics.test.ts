/**
 * astra pack 170 (gpt-5.6-sol, #336 @fd12d897), HIGH: after the protected
 * one-pass copy, the measurement-profile path still called mutable ambient
 * methods. Replacing `Array.prototype.map` after load collapsed distinct
 * valid profiles to one digest, and replacing `Object.isFrozen` let
 * `profileGoverns` return a mutable "frozen" profile. Canonicalization (the
 * PRODUCTION `canonicalize`), validation, digesting and freezing now call
 * only intrinsics captured at load. Each intrinsic below is replaced after
 * load, and every result must be byte-identical, or a refusal.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as profileModule from "../evidence/measurement-profile.js";
import {
  computeMeasurementProfileDigest,
  profileGoverns,
  validateMeasurementProfile,
  type MeasurementProfileV1,
} from "../evidence/measurement-profile.js";
import { canonicalize } from "../util/canonical.js";

function profile(target = 0.5): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/mass/load-cell/v1",
    outcome: { capabilityType: "weighing", statement: "The sample was weighed.", objectIdentity: { kind: "sampleId", value: "s-1" } },
    device: {
      deviceId: "dev-scale-1",
      kind: "scale",
      adapterType: "serial",
      permittedAdapterVersions: ["ScaleAdapter-1.0.0", "ScaleAdapter-1.0.1"],
      permittedFirmwareVersions: ["fw-2.3"],
    },
    measurement: { method: "load-cell", quantity: "mass", unit: "kg", sampling: { minSamples: 3, maxIntervalMs: 500 }, tolerance: { comparator: "<=", target, band: 0.01 } },
    capture: { startCondition: "job_started", endCondition: "job_completed", coverage: { policy: "continuous", minFraction: 0.9 } },
    calibration: { required: true, procedureId: "cal-scale-v2", validityWindowSeconds: 86400 },
    interpretation: { evidenceTypeIds: ["measure.io_test_pair", "receipt.kernel_signed"], acceptanceLevel: "device_reported", onDeviceFailure: "hold" },
    simulationProhibited: true,
    witnesses: { requiredRoles: ["qa"], independentOfClaimant: true },
    onMissingData: "reject",
    onContradiction: "hold",
  };
}

/** Profiles that must each be refused, built before any patch is applied. */
const INVALID: Array<[string, MeasurementProfileV1]> = (() => {
  const make = (edit: (p: Record<string, any>) => void): MeasurementProfileV1 => {
    const p = profile() as unknown as Record<string, any>;
    edit(p);
    return p as unknown as MeasurementProfileV1;
  };
  return [
    ["unknown field", make((p) => (p.extraTerm = 1))],
    ["blank profileId", make((p) => (p.profileId = "   "))],
    ["onDeviceFailure not a decision", make((p) => (p.interpretation.onDeviceFailure = "maybe"))],
    ["minSamples 0", make((p) => (p.measurement.sampling.minSamples = 0))],
    ["tolerance comparator", make((p) => (p.measurement.tolerance.comparator = "~"))],
    ["acceptance level", make((p) => (p.interpretation.acceptanceLevel = "vibes"))],
    ["empty adapter list", make((p) => (p.device.permittedAdapterVersions = []))],
    ["witness roles without independence", make((p) => (p.witnesses.independentOfClaimant = false))],
  ];
})();

const SAMPLE = { b: [3, -0, { d: "x", c: [true, null] }], a: "\u00e9", "": 1.5e-7, z: { y: [] } };

function results() {
  const out: Record<string, unknown> = {};
  out.canonical = canonicalize(SAMPLE);
  const digestA = computeMeasurementProfileDigest(profile(0.5));
  const digestB = computeMeasurementProfileDigest(profile(0.75));
  out.digests = [digestA, digestB];
  const governed = profileGoverns(digestA, profile(0.5));
  out.governs = [governed.governs, governed.code, governed.presentedDigest];
  out.governedProfile = governed.profile;
  out.mismatch = profileGoverns(digestA, profile(0.75)).code;
  out.wrongFamily = profileGoverns(`sha256:${"ab".repeat(32)}`, profile(0.5)).code;
  // Index loops, no destructuring: the test's own code must not run a replaced intrinsic either.
  const invalid: unknown[] = [];
  for (let i = 0; i < INVALID.length; i++) {
    const violations = validateMeasurementProfile(INVALID[i]![1]);
    const paths: string[] = [];
    for (let j = 0; j < violations.length; j++) paths[j] = violations[j]!.path;
    invalid[i] = [INVALID[i]![0], paths];
  }
  out.invalid = invalid;
  return out;
}

/** node:crypto's Hash prototype, whose methods the digest must have captured at load. */
const HashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;

type Patch = [label: string, target: object, key: PropertyKey, make: (original: any) => unknown];
const PATCHES: Patch[] = [
  ["Array.prototype.map (astra's recipe)", Array.prototype, "map", () => () => []],
  ["Array.prototype.join", Array.prototype, "join", () => () => ""],
  ["Array.prototype.filter", Array.prototype, "filter", () => () => []],
  ["Array.prototype.sort", Array.prototype, "sort", (o) => function (this: unknown[]) { return o.call(this).reverse(); }],
  ["Array.prototype.includes", Array.prototype, "includes", () => () => true],
  ["Array.prototype.every", Array.prototype, "every", () => () => true],
  ["Array.prototype.reduce", Array.prototype, "reduce", () => () => undefined],
  ["Array.prototype.push", Array.prototype, "push", () => () => 0],
  ["Array.prototype[Symbol.iterator]", Array.prototype, Symbol.iterator, () => function* () {}],
  ["Array.isArray", Array, "isArray", () => () => false],
  ["Object.keys", Object, "keys", () => () => []],
  ["Object.entries", Object, "entries", () => () => []],
  ["Object.values", Object, "values", () => () => []],
  ["Object.isFrozen (astra's recipe)", Object, "isFrozen", () => () => true],
  ["Object.freeze", Object, "freeze", () => (v: unknown) => v],
  ["JSON.stringify", JSON, "stringify", () => () => '"x"'],
  ["String", globalThis, "String", () => () => "x"],
  ["String.prototype.trim", String.prototype, "trim", () => () => "x"],
  ["String.prototype.split", String.prototype, "split", () => () => []],
  ["Number.isFinite", Number, "isFinite", () => () => true],
  ["Number.isInteger", Number, "isInteger", () => () => true],
  ["Set.prototype.has", Set.prototype, "has", () => () => true],
  ["RegExp.prototype.test", RegExp.prototype, "test", () => () => true],
  ["RegExp.prototype.exec", RegExp.prototype, "exec", () => () => null],
  ["Hash.prototype.digest", HashPrototype, "digest", () => () => "0".repeat(64)],
  ["Hash.prototype.update", HashPrototype, "update", (o) => function (this: unknown) { return o.call(this, "tampered"); }],
];

function withPatch<T>(target: object, key: PropertyKey, replacement: unknown, run: () => T): T {
  const original = Reflect.getOwnPropertyDescriptor(target, key)!;
  Reflect.defineProperty(target, key, { ...original, value: replacement });
  try {
    return run();
  } finally {
    Reflect.defineProperty(target, key, original);
  }
}

/** Every object inside `v` is frozen (checked with the real Object.isFrozen, after any patch is undone). */
function deeplyFrozen(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (!Object.isFrozen(v)) return false;
  return Object.values(v).every(deeplyFrozen);
}

const CLEAN = JSON.stringify(results());

describe("astra 170 HIGH: nothing replaced after load changes the profile's digest, validation or freezing", () => {
  it("astra's recipe: with Array.prototype.map replaced, two profiles differing in a committed term keep distinct, unchanged digests", () => {
    const clean = [computeMeasurementProfileDigest(profile(0.5)), computeMeasurementProfileDigest(profile(0.75))];
    expect(clean[0]).not.toBe(clean[1]);
    let patched: string[] = [];
    try {
      patched = withPatch(Array.prototype, "map", () => [], () => [computeMeasurementProfileDigest(profile(0.5)), computeMeasurementProfileDigest(profile(0.75))]);
    } catch {
      patched = ["refused"];
    }
    expect(patched).toEqual(clean);
  });

  it("astra's recipe: with Object.isFrozen replaced, profileGoverns still returns a deeply frozen profile", () => {
    const digest = computeMeasurementProfileDigest(profile());
    const governed = withPatch(Object, "isFrozen", () => true, () => profileGoverns(digest, profile()));
    expect(governed.governs).toBe(true);
    expect(deeplyFrozen(governed.profile)).toBe(true);
  });

  for (const [label, target, key, make] of PATCHES) {
    it(`with ${label} replaced after load, every digest, verdict and refusal is unchanged`, () => {
      const original = (target as Record<PropertyKey, unknown>)[key];
      let produced: string;
      try {
        produced = withPatch(target, key, make(original), () => {
          const r = results();
          // Serialized after the patch is undone (below), so only the module's behavior is compared.
          return r as unknown as string;
        }) as unknown as string;
        produced = JSON.stringify(produced);
      } catch (err) {
        produced = `threw: ${(err as Error)?.message}`;
      }
      expect(produced).toBe(CLEAN);
    });
  }

  it("a governed profile is deeply frozen, and its digest is the one committed", () => {
    const digest = computeMeasurementProfileDigest(profile());
    const governed = profileGoverns(digest, profile());
    expect(governed.presentedDigest).toBe(digest);
    expect(deeplyFrozen(governed.profile)).toBe(true);
  });
});

describe("no RegExp is exported for a format check (astra pack 167's class)", () => {
  it("measurement-profile exports no RegExp, so none can be recompiled to widen the family check", () => {
    const regexps = Object.keys(profileModule).filter((k) => (profileModule as Record<string, unknown>)[k] instanceof RegExp);
    expect(regexps).toEqual([]);
  });

  it("the committed-digest family check refuses a sha256:-tagged value, with its own code", () => {
    expect(profileGoverns(`sha256:${"ab".repeat(32)}`, profile()).code).toBe("digest-wrong-family");
    expect(profileGoverns(`0x${"AB".repeat(32)}`, profile()).code).toBe("digest-wrong-family");
    expect(profileGoverns(`0x${"ab".repeat(31)}`, profile()).code).toBe("digest-wrong-family");
    expect(profileGoverns(`0x${"ab".repeat(32)}0`, profile()).code).toBe("digest-wrong-family");
    expect(profileGoverns(`0x${"ab".repeat(32)}\n`, profile()).code).toBe("digest-wrong-family");
  });

  it("isMeasurementProfileDigest accepts exactly 0x + 64 lowercase hex, checked at every position", () => {
    const hex = "0123456789abcdef".repeat(4);
    expect(profileModule.isMeasurementProfileDigest(`0x${hex}`)).toBe(true);
    for (let i = 0; i < 64; i++) expect(profileModule.isMeasurementProfileDigest(`0x${hex.slice(0, i)}g${hex.slice(i + 1)}`), `position ${i}`).toBe(false);
    for (const bad of [`0X${hex}`, `1x${hex}`, `0x${hex}0`, `0x${hex.slice(1)}`, `0x${hex.slice(0, 63)}F`, "", undefined, 7, [`0x${hex}`]]) {
      expect(profileModule.isMeasurementProfileDigest(bad), String(bad)).toBe(false);
    }
  });
});

describe("validation reads only own indices of a list", () => {
  it("an index Array.prototype serves cannot fill a hole in a permitted-version list", () => {
    const p = profile() as unknown as { device: { permittedAdapterVersions: unknown[] } };
    p.device.permittedAdapterVersions = new Array(1);
    Object.defineProperty(Array.prototype, "0", { configurable: true, writable: true, value: "ScaleAdapter-9.9.9" });
    let paths: string[];
    try {
      paths = validateMeasurementProfile(p as unknown as MeasurementProfileV1).map((v) => v.path);
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["0"];
    }
    expect(paths).toContain("device.permittedAdapterVersions");
  });
});
