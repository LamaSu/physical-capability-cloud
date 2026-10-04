/**
 * The evidence profile's D5 (#359): `canonicalize` refuses a value with no JSON form, so hashing a body that
 * holds one throws. Economics refuses such bodies itself, and guards each hash it computes on input it was
 * handed, so the compiler and the adapters return refusals and never throw, with or without D5.
 *
 * The guard tests make the hash throw the way D5's does, so they hold in either merge order.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../types/rate-schedule.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../types/rate-schedule.js")>();
  return { ...mod, computeScheduleHash: vi.fn(mod.computeScheduleHash) };
});
vi.mock("../types/composition-manifest.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../types/composition-manifest.js")>();
  return { ...mod, computeManifestHash: vi.fn(mod.computeManifestHash) };
});
vi.mock("../types/training-manifest.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../types/training-manifest.js")>();
  return { ...mod, computeTrainingManifestHash: vi.fn(mod.computeTrainingManifestHash) };
});

import { clausesFromCompositionManifest, splitsFromTrainingManifest, type LineageInput, type ManifestAdapterInput } from "../economics/adapters.js";
import { compileEconomics } from "../economics/compile.js";
import { exampleSparePrinter, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import { numberWithoutCanonicalForm } from "../economics/input.js";
import { computeManifestHash, type CompositionManifest } from "../types/composition-manifest.js";
import { computeScheduleHash } from "../types/rate-schedule.js";
import { computeTrainingManifestHash, type TrainingManifest } from "../types/training-manifest.js";
import { a } from "./economics-helpers.js";

/** What D5's canonicalize throws, without depending on its class: these tests run before #359 lands too. */
const d5Refuses = () => {
  throw new TypeError("canonicalize: the integer 9007199254740992, outside the safe range (send it as a decimal string) at $.x has no JSON form; refusing to hash it");
};
const STAND_IN = `0x${"5d".repeat(32)}`;
/** The real hash when the canonical form can write the body, else a stand-in: refusal must not depend on it. */
const sealedHash = (hash: () => string) => {
  try {
    return hash();
  } catch {
    return STAND_IN;
  }
};

describe("D5: the compiler refuses a schedule with no canonical form, never throws", () => {
  it("a schedule whose hash throws (as D5's canonicalize does) is a SCHEMA_INVALID options refusal", () => {
    const ag = exampleSparePrinter();
    expect(compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] }).ok).toBe(true);
    vi.mocked(computeScheduleHash).mockImplementationOnce(d5Refuses);
    const r = compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => [x.code, x.path])).toEqual([["SCHEMA_INVALID", ["options"]]]);
    expect(r.refusals[0]!.message).toMatch(/has no canonical form: canonicalize: the integer 9007199254740992/);
  });
});

describe("D5: the manifest adapters refuse a manifest with no canonical form, never throw", () => {
  const SCHED = PRINTER_KIT_SCHEDULE.scheduleHash;
  const rateSource = { scheduleHash: SCHED, evaluatedAt: 1_790_000_000, context: { jobValueCents: 10000, jobsPerDay: 1, captureClass: null } };
  const entry = (extra: Record<string, unknown> = {}) => ({ ipId: "ip:adapter", role: "integrator" as const, contributorAddress: a(0x11), rateScheduleHash: SCHED, ...extra });
  const composition = (entries: unknown[]): CompositionManifest => {
    const body = { capabilityIpId: "cap:print", entries, builtAt: "2026-09-24T00:00:00Z" } as unknown as CompositionManifest;
    return { ...body, manifestHash: sealedHash(() => computeManifestHash(body)) } as CompositionManifest;
  };
  const fromComposition = (manifest: CompositionManifest) =>
    clausesFromCompositionManifest({ manifest, pinnedRates: [{ bps: 100, rateSource }], partyByAddress: { [a(0x11)]: "alice" }, appliesTo: { allUnits: true }, idPrefix: "m" } as ManifestAdapterInput);
  const training = (datasets: unknown[]): TrainingManifest => {
    const body = { modelIpId: "model:fine", datasets, trainedAt: "2026-09-01T00:00:00Z" } as unknown as TrainingManifest;
    return { ...body, manifestHash: sealedHash(() => computeTrainingManifestHash(body)) } as TrainingManifest;
  };
  const fromTraining = (manifest: TrainingManifest) =>
    splitsFromTrainingManifest({ manifest, modelAuthorParty: "author", passThroughBps: 4000, datasetParty: { "ds:1": "d1" } } as LineageInput, "lin");
  const codes = (r: { ok: boolean; refusals?: Array<{ code: string }> }) => (r.ok ? [] : r.refusals!.map((x) => x.code));

  it("a number the canonical form cannot write is MANIFEST_INVALID before any hash, with or without D5", () => {
    expect(fromComposition(composition([entry()])).ok).toBe(true);
    // Before this, groupBps 2^53 was GROUP_WEIGHTS_INVALID and an unknown 1e21 passed; under D5 both threw.
    for (const bad of [{ groupBps: 2 ** 53 }, { note: 1e21 }, { note: -(2 ** 53) }, { note: Number.NaN }, { note: Infinity }]) {
      const r = fromComposition(composition([entry(bad)]));
      expect(codes(r)).toEqual(["MANIFEST_INVALID"]);
      expect(r.ok ? "" : r.refusals[0]!.message).toMatch(/no canonical JSON form: \$\.entries\[0\]\.(groupBps|note) is /);
    }

    expect(fromTraining(training([{ datasetIpId: "ds:1", weightBps: 10000 }])).ok).toBe(true);
    expect(fromTraining(training([{ datasetIpId: "ds:1", weightBps: 10000, dataPointCount: 2 ** 53 - 1 }])).ok).toBe(true);
    // The schema leaves dataPointCount unbounded: before this it passed, and under D5 the hash threw.
    const r = fromTraining(training([{ datasetIpId: "ds:1", weightBps: 10000, dataPointCount: 2 ** 53 }]));
    expect(codes(r)).toEqual(["MANIFEST_INVALID"]);
    expect(r.ok ? "" : r.refusals[0]!.message).toMatch(/\$\.datasets\[0\]\.dataPointCount is 9007199254740992/);
  });

  it("a hash that throws for any other reason (as D5's does) is MANIFEST_INVALID, never an exception", () => {
    const comp = composition([entry()]);
    vi.mocked(computeManifestHash).mockImplementationOnce(d5Refuses);
    expect(codes(fromComposition(comp))).toEqual(["MANIFEST_INVALID"]);

    const tm = training([{ datasetIpId: "ds:1", weightBps: 10000 }]);
    vi.mocked(computeTrainingManifestHash).mockImplementationOnce(d5Refuses);
    expect(codes(fromTraining(tm))).toEqual(["MANIFEST_INVALID"]);

    // The same manifests, hashed normally, still convert.
    expect(fromComposition(comp).ok).toBe(true);
    expect(fromTraining(tm).ok).toBe(true);
  });
});

describe("numberWithoutCanonicalForm", () => {
  it("names the first number the canonical form cannot write, and passes every other value", () => {
    expect(numberWithoutCanonicalForm({ a: [0, -0, 1.5, 1e-9, 2 ** 53 - 1, -(2 ** 53 - 1)], b: "1e400", c: null, d: true, e: undefined })).toBeNull();
    expect(numberWithoutCanonicalForm({ a: { b: [1, 2 ** 53] } })).toBe("$.a.b[1] is 9007199254740992");
    expect(numberWithoutCanonicalForm([Number.NaN])).toBe("$[0] is NaN");
    expect(numberWithoutCanonicalForm(-Infinity)).toBe("$ is -Infinity");
    expect(numberWithoutCanonicalForm(1e21)).toBe("$ is 1e+21");
  });

  it("reads no accessor, and leaves a cycle or a throwing Proxy to the caller's guarded hash", () => {
    let reads = 0;
    const withGetter = Object.defineProperty({}, "n", {
      enumerable: true,
      get() {
        reads += 1;
        return 2 ** 53;
      },
    });
    expect(numberWithoutCanonicalForm(withGetter)).toBeNull();
    expect(reads).toBe(0);

    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    expect(numberWithoutCanonicalForm(cyclic)).toBeNull();
    cyclic.bad = 2 ** 53;
    expect(numberWithoutCanonicalForm(cyclic)).toBe("$.bad is 9007199254740992");

    const trap = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    expect(numberWithoutCanonicalForm(trap)).toBeNull();
  });
});
