/**
 * Adapters: existing PCC primitives in, the same IR out, one compiler for everything (docs §8).
 *
 * Required lane test: "optional contribution graph compiles into existing payout config, not a second
 * settlement engine" — proven below by compiling a graph and a hand-written agreement with the same
 * splits and getting byte-identical V-next payouts.
 */

import { describe, expect, it } from "vitest";
import {
  clausesFromCompositionManifest,
  splitsFromContributionGraph,
  splitsFromTrainingManifest,
  type ContributionGraph,
  type LineageInput,
} from "../economics/adapters.js";
import { compileEconomics, type CompiledEconomics } from "../economics/compile.js";
import type { Clause, EconomicAgreement } from "../economics/types.js";
import { computeManifestHash, type CompositionManifest } from "../types/composition-manifest.js";
import { computeTrainingManifestHash, type TrainingManifest } from "../types/training-manifest.js";
import { a, baseAgreement } from "./economics-helpers.js";

const SCHED = `0x${"ab".repeat(32)}`;
const rateSource = { scheduleHash: SCHED, evaluatedAt: 1_790_000_000, context: { jobValueCents: 10000, jobsPerDay: 1, captureClass: null } };

function ok(r: ReturnType<typeof compileEconomics>): CompiledEconomics {
  if (!r.ok) throw new Error(JSON.stringify(r.refusals, null, 1));
  return r;
}

/** An explicit open license for each component a test unit runs: unknown rights would (rightly) refuse. */
function openLicenses(components: EconomicAgreement["units"][number]["components"]): EconomicAgreement["licenses"] {
  return components.map((c) => ({
    licenseId: `open-${c.ref.replace(/[^A-Za-z0-9]/g, "-")}`,
    version: 1,
    label: `Open license for ${c.ref}`,
    licensor: "op",
    subject: c.ref,
    class: "open" as const,
    shareAlikeTag: null,
    grants: { commercialUse: true, compose: true, resell: true, modify: true, fieldsOfUse: ["*"], regions: ["*"] },
    requires: { attribution: false, payments: [] },
    validFrom: null,
    validUntil: null,
    authority: "counterparty-accepted" as const,
  }));
}

function agreementWith(parties: EconomicAgreement["parties"], clauses: Clause[], splits: EconomicAgreement["splits"], gross = "1000000", components: EconomicAgreement["units"][number]["components"] = []): EconomicAgreement {
  return baseAgreement({
    licenses: openLicenses(components),
    parties: [{ partyId: "buyer", label: "Buyer", kind: "person", payTo: a(1) }, { partyId: "op", label: "Operator", kind: "person", payTo: a(2) }, ...parties],
    units: [{ unitRef: "u1", label: "Job", gross, components, measures: [] }],
    clauses: [...clauses, { clauseId: "zz-rest", label: "Operator keeps the rest", role: "operator", to: { party: "op" }, subject: null, appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "residual" } }],
    splits,
    fee: { feeBps: 0, feeRecipient: null },
  });
}

// ── CompositionManifest ──────────────────────────────────────────────────────

describe("CompositionManifest adapter", () => {
  const manifest = (entries: CompositionManifest["entries"]): CompositionManifest => {
    const body = { capabilityIpId: "cap:print", entries, builtAt: "2026-09-24T00:00:00Z" };
    return { ...body, manifestHash: computeManifestHash(body) };
  };
  const coAuthors = [
    { ipId: "ip:adapter", role: "integrator" as const, contributorAddress: a(0x11), rateScheduleHash: SCHED },
    { ipId: "ip:adapter", role: "integrator" as const, contributorAddress: a(0x12), rateScheduleHash: SCHED },
  ];
  const parties = [
    { partyId: "alice", label: "Alice", kind: "person" as const, payTo: a(0x11) },
    { partyId: "bob", label: "Bob", kind: "person" as const, payTo: a(0x12) },
  ];
  const partyByAddress = { [a(0x11)]: "alice", [a(0x12)]: "bob" };

  it("two co-authors of one role SHARE one allocation (buildPayoutMap paid each the full rate)", () => {
    const r = clausesFromCompositionManifest({ manifest: manifest(coAuthors), pinnedRates: [{ bps: 100, rateSource }], partyByAddress, appliesTo: { allUnits: true }, idPrefix: "m" });
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    expect(r.clauses).toHaveLength(1);
    const c = ok(compileEconomics(agreementWith(parties, r.clauses, r.splits)));
    const byParty = Object.fromEntries(c.totals.byParty.map((p) => [p.partyId, p.amount]));
    // 1% of 1,000,000 = 10,000 for the ROLE, split equally: 5,000 each. The old walker paid 10,000 each.
    expect(byParty["alice"]).toBe("5000");
    expect(byParty["bob"]).toBe("5000");
    expect(byParty["op"]).toBe("990000");
  });

  it("groupBps weights the co-authors when every entry has one and they total 10000", () => {
    const weighted = coAuthors.map((e, i) => ({ ...e, groupBps: i === 0 ? 7500 : 2500 }));
    const r = clausesFromCompositionManifest({ manifest: manifest(weighted), pinnedRates: [{ bps: 100, rateSource }], partyByAddress, appliesTo: { allUnits: true }, idPrefix: "m" });
    if (!r.ok) throw new Error(JSON.stringify(r.refusals));
    const byParty = Object.fromEntries(ok(compileEconomics(agreementWith(parties, r.clauses, r.splits))).totals.byParty.map((p) => [p.partyId, p.amount]));
    expect([byParty["alice"], byParty["bob"]]).toEqual(["7500", "2500"]);
  });

  it("refuses ambiguous or unverifiable manifests instead of guessing", () => {
    const run = (m: CompositionManifest, pinned = [{ bps: 100, rateSource }], map: Record<string, string> = partyByAddress) =>
      clausesFromCompositionManifest({ manifest: m, pinnedRates: pinned, partyByAddress: map, appliesTo: { allUnits: true }, idPrefix: "m" });
    const code = (r: ReturnType<typeof run>) => (r.ok ? "ok" : r.refusals.map((x) => x.code).join(","));
    expect(code(run(manifest(coAuthors.map((e, i) => (i === 0 ? { ...e, groupBps: 10000 } : e)))))).toBe("MIXED_GROUP_WEIGHTS");
    expect(code(run(manifest(coAuthors.map((e) => ({ ...e, groupBps: 4000 })))))).toBe("GROUP_WEIGHTS_INVALID");
    expect(code(run({ ...manifest(coAuthors), manifestHash: `0x${"00".repeat(32)}` }))).toBe("MANIFEST_HASH_MISMATCH");
    expect(code(run(manifest(coAuthors), []))).toBe("RATE_NOT_PINNED");
    expect(code(run(manifest(coAuthors), undefined, { [a(0x11)]: "alice" }))).toBe("UNKNOWN_CONTRIBUTOR");
  });
});

// ── TrainingManifest ─────────────────────────────────────────────────────────

describe("TrainingManifest adapter", () => {
  const tm = (modelIpId: string, datasets: TrainingManifest["datasets"], baseModelIpId?: string): TrainingManifest => {
    const body = { modelIpId, datasets, trainedAt: "2026-09-01T00:00:00Z", ...(baseModelIpId ? { baseModelIpId } : {}) };
    return { ...body, manifestHash: computeTrainingManifestHash(body) };
  };
  const parties = [
    { partyId: "author", label: "Model author", kind: "person" as const, payTo: a(0x21) },
    { partyId: "base-author", label: "Base model author", kind: "person" as const, payTo: a(0x22) },
    { partyId: "d1", label: "Dataset 1", kind: "organization" as const, payTo: a(0x23) },
    { partyId: "d2", label: "Dataset 2", kind: "organization" as const, payTo: a(0x24) },
    { partyId: "d3", label: "Base dataset", kind: "organization" as const, payTo: a(0x25) },
  ];
  const lineage = (): LineageInput => ({
    manifest: tm("model:fine", [{ datasetIpId: "ds:1", weightBps: 6000 }, { datasetIpId: "ds:2", weightBps: 4000 }], "model:base"),
    modelAuthorParty: "author",
    passThroughBps: 4000,
    datasetParty: { "ds:1": "d1", "ds:2": "d2" },
    baseModel: {
      weightBps: 2500,
      lineage: { manifest: tm("model:base", [{ datasetIpId: "ds:3", weightBps: 10000 }]), modelAuthorParty: "base-author", passThroughBps: 5000, datasetParty: { "ds:3": "d3" } },
    },
  });

  it("a 3-level lineage subdivides the model allocation and sums to it exactly (the old walker paid it twice)", () => {
    const s = splitsFromTrainingManifest(lineage(), "lin");
    if (!s.ok) throw new Error(JSON.stringify(s.refusals));
    const royalty: Clause = { clauseId: "model", label: "Model royalty", role: "model-author", to: { split: s.rootSplitId }, subject: "model:fine", appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "fixed", amount: "1000003" } };
    const c = ok(compileEconomics(agreementWith(parties, [royalty], s.splits, "2000000")));
    const byParty = Object.fromEntries(c.totals.byParty.map((p) => [p.partyId, BigInt(p.amount)]));
    const lineageTotal = ["author", "base-author", "d1", "d2", "d3"].reduce((sum, p) => sum + (byParty[p] ?? 0n), 0n);
    expect(lineageTotal).toBe(1000003n); // exactly the model allocation: subdivided, never inflated
    // author 60% → 600001.8 → 600002 (largest remainder); inputs 400001 → datasets 75% = 300000.75 → 300001,
    // base model 25% = 100000; datasets 300001 by 60/40 → 180000.6 / 120000.4 → 180001 / 120000; base 50/50.
    expect(byParty["author"]).toBe(600002n);
    expect(byParty["d1"]).toBe(180001n);
    expect(byParty["d2"]).toBe(120000n);
    expect(byParty["base-author"]).toBe(50000n);
    expect(byParty["d3"]).toBe(50000n);
    const datasetLeg = c.units[0]!.legs.find((l) => l.partyIds.includes("d1"))!;
    expect(datasetLeg.roles).toEqual(["dataset-contributor"]);
    expect(datasetLeg.subjects).toEqual(["ds:1"]);
  });

  it("refuses an undeclared expansion share, a missing base-model weight, and a lineage cycle", () => {
    const code = (li: LineageInput) => {
      const r = splitsFromTrainingManifest(li, "lin");
      return r.ok ? "ok" : r.refusals.map((x) => x.code).join(",");
    };
    expect(code({ ...lineage(), passThroughBps: 10001 })).toBe("EXPANSION_SHARE_UNDECLARED");
    const noBase = lineage();
    delete noBase.baseModel;
    expect(code(noBase)).toBe("EXPANSION_SHARE_UNDECLARED");
    const cyc = lineage();
    cyc.baseModel!.lineage.manifest = tm("model:fine", [{ datasetIpId: "ds:3", weightBps: 10000 }]);
    expect(code(cyc)).toBe("LINEAGE_CYCLE");
    const unknownDataset = lineage();
    unknownDataset.datasetParty = { "ds:1": "d1" };
    expect(code(unknownDataset)).toBe("UNKNOWN_CONTRIBUTOR");
  });
});

// ── ContributionGraphV1 (optional) ───────────────────────────────────────────

describe("ContributionGraph template", () => {
  // An open hardware module: the module's maintainer passes shares to a firmware author and to a
  // sensor-board designer; the board designer passes a share to the author of a driver it builds on.
  // One upstream relationship was declared but never accepted; one contributor's component is optional.
  const graph = (): ContributionGraph => ({
    schema: "pcc.contribution-graph.v1",
    graphId: "g",
    root: "module",
    nodes: [
      { nodeId: "module", label: "Module maintainer", party: "maint", role: "integrator", subject: "hw:module", componentRef: null, participationRequired: false, retainWeight: 50 },
      { nodeId: "firmware", label: "Firmware author", party: "fw", role: "integrator", subject: "fw:core", componentRef: "fw:core", participationRequired: true, retainWeight: 1 },
      { nodeId: "board", label: "Sensor board designer", party: "board", role: "integrator", subject: "hw:board", componentRef: null, participationRequired: false, retainWeight: 70 },
      { nodeId: "driver", label: "Driver author", party: "drv", role: "integrator", subject: "sw:driver", componentRef: null, participationRequired: false, retainWeight: 1 },
      { nodeId: "claimant", label: "Declared, never accepted", party: "claim", role: "integrator", subject: "x", componentRef: null, participationRequired: false, retainWeight: 1 },
    ],
    edges: [
      { from: "module", to: "firmware", weight: 20, accepted: true },
      { from: "module", to: "board", weight: 30, accepted: true },
      { from: "board", to: "driver", weight: 30, accepted: true },
      { from: "module", to: "claimant", weight: 25, accepted: false },
    ],
  });
  const parties = ["maint", "fw", "board", "drv", "claim"].map((p, i) => ({ partyId: p, label: p, kind: "person" as const, payTo: a(0x40 + i) }));
  const pool = (to: Clause["to"]): Clause => ({ clauseId: "contributors", label: "Contributor pool: 10% of the job", role: "integrator", to, subject: "hw:module", appliesTo: { allUnits: true }, underLicense: null, rule: { kind: "percent", bps: 1000, of: "gross", min: null, max: null, rateSource: null } });

  it("compiles into the SAME payout config as hand-written splits: one engine, not two", () => {
    const g = splitsFromContributionGraph(graph(), new Set(["fw:core"]), "g");
    if (!g.ok) throw new Error(JSON.stringify(g.refusals));
    const fromGraph = ok(compileEconomics(agreementWith(parties, [pool(g.rootPayee)], g.splits, "1000000", [{ ref: "fw:core", uses: "1" }])));
    // The same economics written by hand: module keeps 50 (+25 from the unaccepted edge), 20 firmware, 30 board; board keeps 70, 30 driver.
    const byHand = ok(
      compileEconomics(
        agreementWith(
          parties,
          [pool({ split: "g/module" })],
          [
            { splitId: "g/module", label: "Module maintainer", members: [{ to: { party: "maint" }, weight: 75, role: "integrator", subject: "hw:module" }, { to: { split: "g/board" }, weight: 30, role: null, subject: null }, { to: { split: "g/firmware" }, weight: 20, role: null, subject: null }] },
            { splitId: "g/firmware", label: "Firmware author", members: [{ to: { party: "fw" }, weight: 1, role: "integrator", subject: "fw:core" }] },
            { splitId: "g/board", label: "Sensor board designer", members: [{ to: { party: "board" }, weight: 70, role: "integrator", subject: "hw:board" }, { to: { split: "g/driver" }, weight: 30, role: null, subject: null }] },
            { splitId: "g/driver", label: "Driver author", members: [{ to: { party: "drv" }, weight: 1, role: "integrator", subject: "sw:driver" }] },
          ],
          "1000000",
          [{ ref: "fw:core", uses: "1" }],
        ),
      ),
    );
    expect(fromGraph.units).toEqual(byHand.units);
    // The unaccepted claimant is paid nothing; the pool is conserved exactly.
    const byParty = Object.fromEntries(fromGraph.totals.byParty.map((p) => [p.partyId, BigInt(p.amount)]));
    expect(byParty["claim"]).toBeUndefined();
    expect(byParty["maint"]! + byParty["fw"]! + byParty["board"]! + byParty["drv"]!).toBe(100000n);
  });

  it("a contributor whose component does not run in this job is dropped, and its share stays upstream", () => {
    const g = splitsFromContributionGraph(graph(), new Set(), "g");
    if (!g.ok) throw new Error(JSON.stringify(g.refusals));
    const c = ok(compileEconomics(agreementWith(parties, [pool(g.rootPayee)], g.splits)));
    const byParty = Object.fromEntries(c.totals.byParty.map((p) => [p.partyId, BigInt(p.amount)]));
    expect(byParty["fw"]).toBeUndefined();
    // module now keeps 50 + 25 + 20 = 95 of 125 → 76,000 of the 100,000 pool.
    expect(byParty["maint"]).toBe(76000n);
  });

  it("a shared upstream (diamond) is paid once per path and never inflates the pool", () => {
    const d = graph();
    d.edges.push({ from: "firmware", to: "driver", weight: 1, accepted: true });
    const g = splitsFromContributionGraph(d, new Set(["fw:core"]), "g");
    if (!g.ok) throw new Error(JSON.stringify(g.refusals));
    const c = ok(compileEconomics(agreementWith(parties, [pool(g.rootPayee)], g.splits, "1000000", [{ ref: "fw:core", uses: "1" }])));
    const drv = c.units[0]!.legs.find((l) => l.partyIds.includes("drv"))!;
    expect(drv.attribution.length).toBe(2); // two paths, one leg
    expect(c.totals.byParty.reduce((s, p) => s + (p.partyId === "op" ? 0n : BigInt(p.amount)), 0n)).toBe(100000n);
  });

  it("refuses cycles, graphs that are too deep, empty graphs and malformed graphs", () => {
    const code = (g: unknown, used = new Set<string>(["fw:core"])) => {
      const r = splitsFromContributionGraph(g, used, "g");
      return r.ok ? "ok" : r.refusals.map((x) => x.code).join(",");
    };
    const cyc = graph();
    cyc.edges.push({ from: "driver", to: "module", weight: 1, accepted: true });
    expect(code(cyc)).toBe("GRAPH_CYCLE");
    const deep: ContributionGraph = {
      ...graph(),
      nodes: Array.from({ length: 10 }, (_, i) => ({ nodeId: `n${i}`, label: `N${i}`, party: "maint", role: "integrator" as const, subject: null, componentRef: null, participationRequired: false, retainWeight: 1 })),
      edges: Array.from({ length: 9 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, weight: 1, accepted: true })),
      root: "n0",
    };
    expect(code(deep)).toBe("GRAPH_TOO_DEEP");
    const empty: ContributionGraph = { ...graph(), nodes: [{ nodeId: "only", label: "Only", party: null, role: "integrator", subject: null, componentRef: null, participationRequired: false, retainWeight: 0 }], edges: [], root: "only" };
    expect(code(empty)).toBe("GRAPH_EMPTY");
    expect(code({ ...graph(), extra: 1 })).toBe("GRAPH_INVALID");
    expect(code({ ...graph(), root: "ghost" })).toBe("GRAPH_INVALID");
  });
});
