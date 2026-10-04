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

import { clausesFromCompositionManifest, splitsFromContributionGraph, splitsFromTrainingManifest, type LineageInput, type ManifestAdapterInput } from "../economics/adapters.js";
import { compileEconomics } from "../economics/compile.js";
import { exampleSparePrinter, PRINTER_KIT_SCHEDULE } from "../economics/examples.js";
import { snapshotJson } from "../economics/input.js";
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

  it("a number the canonical form cannot write is INPUT_INVALID: the input copy refuses it before any hash, with or without D5", () => {
    expect(fromComposition(composition([entry()])).ok).toBe(true);
    // Before this, groupBps 2^53 was GROUP_WEIGHTS_INVALID and an unknown 1e21 passed; under D5 both threw.
    for (const bad of [{ groupBps: 2 ** 53 }, { note: 1e21 }, { note: -(2 ** 53) }, { note: Number.NaN }, { note: Infinity }]) {
      const r = fromComposition(composition([entry(bad)]));
      expect(codes(r)).toEqual(["INPUT_INVALID"]);
      expect(r.ok ? "" : r.refusals[0]!.message).toMatch(/^input\.manifest\.entries\[0\]\.(groupBps|note) is .*, a number the canonical form cannot write/);
    }

    expect(fromTraining(training([{ datasetIpId: "ds:1", weightBps: 10000 }])).ok).toBe(true);
    expect(fromTraining(training([{ datasetIpId: "ds:1", weightBps: 10000, dataPointCount: 2 ** 53 - 1 }])).ok).toBe(true);
    // The schema leaves dataPointCount unbounded: before this it passed, and under D5 the hash threw.
    const r = fromTraining(training([{ datasetIpId: "ds:1", weightBps: 10000, dataPointCount: 2 ** 53 }]));
    expect(codes(r)).toEqual(["INPUT_INVALID"]);
    expect(r.ok ? "" : r.refusals[0]!.message).toMatch(/^input\.manifest\.datasets\[0\]\.dataPointCount is 9007199254740992, a number the canonical form cannot write/);
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

describe("snapshotJson({ canonical: true }): the one copy each adapter reads", () => {
  it("copies plain data, drops an undefined member as canonicalize does, and refuses a number it cannot write", () => {
    const value = { a: [0, -0, 1.5, 1e-9, 2 ** 53 - 1, -(2 ** 53 - 1)], b: "1e400", c: null, d: true, e: undefined };
    const copied = snapshotJson(value, { canonical: true });
    expect(copied).toEqual({ ok: true, value: { a: [0, -0, 1.5, 1e-9, 2 ** 53 - 1, -(2 ** 53 - 1)], b: "1e400", c: null, d: true } });
    expect(Object.keys((copied as { value: object }).value)).not.toContain("e");
    const reason = (v: unknown) => {
      const r = snapshotJson(v, { canonical: true });
      return r.ok ? null : r.reason;
    };
    expect(reason({ a: { b: [1, 2 ** 53] } })).toBe("input.a.b[1] is 9007199254740992, a number the canonical form cannot write (send it as a decimal string)");
    expect(reason([Number.NaN])).toMatch(/^input\[0\] is NaN, /);
    expect(reason(-Infinity)).toMatch(/^input is -Infinity, /);
    expect(reason(1e21)).toMatch(/^input is 1e\+21, /);
    expect(reason([undefined])).toMatch(/^input\[0\] is a undefined/);
  });

  it("leaves the compiler's default unchanged: an undefined member and a large number are its schema's to judge", () => {
    expect(snapshotJson({ e: undefined }).ok).toBe(false);
    expect(snapshotJson({ n: 2 ** 53 })).toEqual({ ok: true, value: { n: 2 ** 53 } });
  });

  it("reads no accessor, and refuses a cycle, a throwing Proxy and nesting past the bound, never throwing", () => {
    let reads = 0;
    const withGetter = Object.defineProperty({}, "n", {
      enumerable: true,
      get() {
        reads += 1;
        return 1;
      },
    });
    expect(snapshotJson(withGetter, { canonical: true })).toEqual({ ok: false, reason: "input.n is an accessor" });
    expect(reads).toBe(0);
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    expect(snapshotJson(cyclic, { canonical: true })).toEqual({ ok: false, reason: "input.self contains itself" });
    const trap = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    expect(snapshotJson(trap, { canonical: true })).toEqual({ ok: false, reason: "the input could not be read as JSON data" });
    // 64 nested objects are within the bound; a 65th is refused explicitly, never truncated (astra EC5 M2).
    let deep: unknown = 1;
    for (let i = 0; i < 64; i++) deep = { n: deep };
    expect(snapshotJson(deep, { canonical: true }).ok).toBe(true);
    expect(snapshotJson({ n: deep }, { canonical: true })).toMatchObject({ ok: false, reason: expect.stringMatching(/nests deeper than 64$/) });
  });
});

describe("astra EC5: each adapter reads its input once, then validates, hashes and pays only that copy", () => {
  const SCHED = PRINTER_KIT_SCHEDULE.scheduleHash;
  const rateSource = { scheduleHash: SCHED, evaluatedAt: 1_790_000_000, context: { jobValueCents: 10000, jobsPerDay: 1, captureClass: null } };
  const entry = (extra: Record<string, unknown> = {}) => ({ ipId: "ip:adapter", role: "integrator" as const, contributorAddress: a(0x11), rateScheduleHash: SCHED, ...extra });
  const composition = (entries: unknown[]): Record<string, unknown> => {
    const body = { capabilityIpId: "cap:print", entries, builtAt: "2026-09-24T00:00:00Z" } as unknown as CompositionManifest;
    return { ...body, manifestHash: sealedHash(() => computeManifestHash(body)) };
  };
  const both = { [a(0x11)]: "alice", [a(0x12)]: "bob" };
  const fromComposition = (manifest: unknown, partyByAddress: Record<string, string> = both) =>
    clausesFromCompositionManifest({ manifest, pinnedRates: [{ bps: 100, rateSource }], partyByAddress, appliesTo: { allUnits: true }, idPrefix: "m" } as unknown as ManifestAdapterInput);
  const training = (datasets: unknown[]): Record<string, unknown> => {
    const body = { modelIpId: "model:fine", datasets, trainedAt: "2026-09-01T00:00:00Z" } as unknown as TrainingManifest;
    return { ...body, manifestHash: sealedHash(() => computeTrainingManifestHash(body)) };
  };
  const fromTraining = (manifest: unknown) =>
    splitsFromTrainingManifest({ manifest, modelAuthorParty: "author", passThroughBps: 4000, datasetParty: { "ds:1": "d1", "ds:2": "d2" } } as unknown as LineageInput, "lin");
  const codes = (r: { ok: boolean; refusals?: Array<{ code: string }> }) => (r.ok ? [] : r.refusals!.map((x) => x.code));
  const run = <T,>(f: () => T): { threw: unknown; result: T | undefined } => {
    try {
      return { threw: null, result: f() };
    } catch (e) {
      return { threw: e, result: undefined };
    }
  };

  it("H1: an entries getter cannot pay Bob under the hash of Alice's entries (composition)", () => {
    const alice = [entry({ contributorAddress: a(0x11) })];
    const bob = [entry({ contributorAddress: a(0x12) })];
    const manifest = composition(alice);
    let reads = 0;
    Object.defineProperty(manifest, "entries", { enumerable: true, configurable: true, get: () => (++reads === 1 ? alice : bob) });
    const { threw, result } = run(() => fromComposition(manifest));
    expect(threw).toBeNull();
    expect(codes(result!)).toEqual(["INPUT_INVALID"]);
    expect(JSON.stringify(result)).not.toContain('"bob"');
    expect(reads).toBe(0);
  });

  it("H1: a datasets getter cannot change who is paid after the hash (training)", () => {
    const ds1 = [{ datasetIpId: "ds:1", weightBps: 10000 }];
    const ds2 = [{ datasetIpId: "ds:2", weightBps: 10000 }];
    const manifest = training(ds1);
    let reads = 0;
    Object.defineProperty(manifest, "datasets", { enumerable: true, configurable: true, get: () => (++reads <= 2 ? ds1 : ds2) });
    const { threw, result } = run(() => fromTraining(manifest));
    expect(threw).toBeNull();
    expect(codes(result!)).toEqual(["INPUT_INVALID"]);
    expect(JSON.stringify(result)).not.toContain('"d2"');
    expect(reads).toBe(0);
  });

  it("M1: manifestHash null is a refusal, not a TypeError (composition)", () => {
    const manifest = { ...composition([entry()]), manifestHash: null };
    const { threw, result } = run(() => fromComposition(manifest));
    expect(threw).toBeNull();
    expect(codes(result!)).toEqual(["MANIFEST_INVALID"]);
  });

  it("M1: a throwing datasets getter is a refusal, not an exception (training)", () => {
    const manifest = training([{ datasetIpId: "ds:1", weightBps: 10000 }]);
    Object.defineProperty(manifest, "datasets", {
      enumerable: true,
      configurable: true,
      get: () => {
        throw new Error("getter");
      },
    });
    const { threw, result } = run(() => fromTraining(manifest));
    expect(threw).toBeNull();
    expect(codes(result!)).toEqual(["INPUT_INVALID"]);
  });

  it("the contribution graph adapter reads its graph and its component set once, and never throws", () => {
    const graph = {
      schema: "pcc.contribution-graph.v1",
      graphId: "g",
      root: "module",
      nodes: [
        { nodeId: "module", label: "Module maintainer", party: "maint", role: "integrator", subject: "hw:module", componentRef: null, participationRequired: false, retainWeight: 50 },
        { nodeId: "firmware", label: "Firmware author", party: "fw", role: "integrator", subject: "fw:core", componentRef: "fw:core", participationRequired: true, retainWeight: 1 },
      ],
      edges: [{ from: "module", to: "firmware", weight: 20, accepted: true }],
    };
    // Controls: the plain graph converts, and the firmware share follows the component set.
    const plain = splitsFromContributionGraph(graph, new Set(["fw:core"]), "g");
    expect(plain.ok).toBe(true);
    expect(JSON.stringify(plain)).toContain('"fw"');
    expect(JSON.stringify(splitsFromContributionGraph(graph, new Set<string>(), "g"))).not.toContain('"fw"');
    let reads = 0;
    const hostile = Object.defineProperty({ ...graph }, "nodes", {
      enumerable: true,
      get: () => {
        reads += 1;
        return graph.nodes;
      },
    });
    const g1 = run(() => splitsFromContributionGraph(hostile, new Set(["fw:core"]), "g"));
    expect(g1.threw).toBeNull();
    expect(codes(g1.result!)).toEqual(["GRAPH_INVALID"]);
    expect(reads).toBe(0);
    for (const notASet of [undefined, null, ["fw:core"], { has: () => true }]) {
      const g2 = run(() => splitsFromContributionGraph(graph, notASet as unknown as Set<string>, "g"));
      expect(g2.threw).toBeNull();
      expect(codes(g2.result!)).toEqual(["INPUT_INVALID"]);
    }
    const g3 = run(() => splitsFromContributionGraph(graph, new Set<string>(), 7 as unknown as string));
    expect(g3.threw).toBeNull();
    expect(codes(g3.result!)).toEqual(["INPUT_INVALID"]);
  });

  it("M2: nesting past the input bound is refused explicitly, the same with or without D5", () => {
    let deep: unknown = 2 ** 53;
    for (let i = 0; i < 65; i++) deep = { n: deep };
    const { threw, result } = run(() => fromComposition(composition([entry({ note: deep })])));
    expect(threw).toBeNull();
    expect(codes(result!)).toEqual(["INPUT_INVALID"]);
    // A shallow unknown field with safe numbers still converts.
    let shallow: unknown = 2 ** 53 - 1;
    for (let i = 0; i < 10; i++) shallow = { n: shallow };
    expect(fromComposition(composition([entry({ note: shallow })])).ok).toBe(true);
  });
});
