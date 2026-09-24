/**
 * Kit demand (R44): server-only envelope fields, the private KitDemandSignal,
 * and the public projection. All fixtures are SYNTHETIC; no real demand or
 * prior data belongs in this public package.
 */
import { describe, it, expect } from "vitest";
import {
  DemandEnvelopeSchema,
  ServerCapturedDemandEnvelopeSchema,
  UnmetCapabilitySchema,
  stripServerOnlyDemandFields,
  computeCompositionSignature,
  type DemandEnvelope,
} from "../types/demand.js";
import {
  KitDemandSignalSchema,
  kitDemandSignalDigest,
  toPublicOpportunityAggregate,
  evidenceClassRank,
  MIN_PUBLIC_K,
  MIN_WINDOW_DAYS,
  DEFAULT_OPPORTUNITY_POLICY,
  type KitDemandSignal,
  type KitDemandInternal,
} from "../types/kit-demand.js";
import { canonicalize, sha256 } from "../util/canonical.js";

const TYPE = "pcc://capabilities/synthetic-widget/v1";

function envelope(extra: Partial<DemandEnvelope> = {}): DemandEnvelope {
  return {
    id: "intent-test-1",
    source: "requests_api",
    compositionSignature: computeCompositionSignature(["synthetic-widget"], []),
    capabilityTypes: ["synthetic-widget"],
    summary: "synthetic intent",
    budgetBand: "100_1k",
    urgencyBand: "standard",
    createdAt: "2026-09-24T00:00:00.000Z",
    ...extra,
  };
}

/** A consistent internal block: 12 intents, 7 verified requesters, 6 at or above orders. */
function internal(overrides: Partial<KitDemandInternal> = {}): KitDemandInternal {
  return {
    windowFrom: "2026-08-24T00:00:00.000Z",
    windowTo: "2026-09-23T23:59:59.999Z",
    unmetCount: 12,
    byEvidenceClass: { query: 4, authenticated_order: 6, funded: 2 },
    distinctVerifiedRequestersByClass: { query: 3, authenticated_order: 5, funded: 2 },
    distinctVerifiedRequestersAtOrAbove: { query: 7, authenticated_order: 6, funded: 2 },
    distinctVerifiedRequesters: 7,
    reasonHistogram: { no_kernel_offering: 9, no_capability_type: 3 },
    budgetBandHistogram: { "100_1k": 10, "1k_10k": 2 },
    urgencyHistogram: { standard: 10, rush: 2 },
    assuranceTierHistogram: { "2": 5 },
    countryHistogram: { US: 8, DE: 3, unknown: 1 },
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-09-23T18:30:00.000Z",
    ...overrides,
  };
}

function signal(overrides: Partial<KitDemandInternal> = {}, top: Partial<KitDemandSignal> = {}): KitDemandSignal {
  return {
    schema: "pcc.kit-demand-signal.v0",
    capabilityKey: TYPE,
    internal: internal(overrides),
    computedAt: "2026-09-24T00:00:00.000Z",
    ...top,
  };
}

/** n verified requesters, all at exactly one class, with every histogram consistent. */
function uniform(n: number, cls: "query" | "authenticated_order" | "funded"): KitDemandInternal {
  const per = { query: 0, authenticated_order: 0, funded: 0, [cls]: n };
  const up = {
    query: n,
    authenticated_order: cls === "query" ? 0 : n,
    funded: cls === "funded" ? n : 0,
  };
  return internal({
    unmetCount: n,
    byEvidenceClass: per,
    distinctVerifiedRequestersByClass: per,
    distinctVerifiedRequestersAtOrAbove: up,
    distinctVerifiedRequesters: n,
    reasonHistogram: { no_kernel_offering: n },
    budgetBandHistogram: { "100_1k": n },
    urgencyHistogram: { standard: n },
    assuranceTierHistogram: {},
    countryHistogram: { US: n },
  });
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.values(o as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

describe("DemandEnvelope.unmet (server-owned)", () => {
  const unmet = [{ capabilityType: "synthetic-widget", reason: "no_kernel_offering" as const, supplyCount: 0 }];

  it("stays backward compatible: an envelope without unmet still parses", () => {
    expect(DemandEnvelopeSchema.safeParse(envelope()).success).toBe(true);
    expect(ServerCapturedDemandEnvelopeSchema.safeParse(envelope()).success).toBe(true);
  });

  it("the caller-input schema (used by /api/intent/ingest) strips a caller-supplied unmet list", () => {
    const parsed = DemandEnvelopeSchema.parse(envelope({ unmet }));
    expect("unmet" in parsed).toBe(false);
  });

  it("the server-captured schema keeps a well-formed unmet list", () => {
    const parsed = ServerCapturedDemandEnvelopeSchema.parse(envelope({ fulfillmentPath: "unfulfilled", unmet }));
    expect(parsed.unmet?.[0]?.reason).toBe("no_kernel_offering");
  });

  it("the server-captured schema rejects a malformed unmet list", () => {
    const bad = envelope({ unmet: [{ capabilityType: "", reason: "no_capacity", supplyCount: 0 }] });
    expect(ServerCapturedDemandEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown reason and a negative supply count", () => {
    expect(UnmetCapabilitySchema.safeParse({ capabilityType: "x", reason: "because", supplyCount: 0 }).success).toBe(false);
    expect(UnmetCapabilitySchema.safeParse({ capabilityType: "x", reason: "no_capacity", supplyCount: -1 }).success).toBe(false);
  });
});

describe("stripServerOnlyDemandFields", () => {
  it("removes caller-asserted fulfillmentPath and unmet, keeps everything else", () => {
    const forged = envelope({
      fulfillmentPath: "unfulfilled",
      unmet: [{ capabilityType: "synthetic-widget", reason: "no_capability_type", supplyCount: 0 }],
    });
    const out = stripServerOnlyDemandFields(forged);
    expect("fulfillmentPath" in out).toBe(false);
    expect("unmet" in out).toBe(false);
    expect(out.id).toBe(forged.id);
    expect(out.capabilityTypes).toEqual(forged.capabilityTypes);
  });

  it("does not mutate its input", () => {
    const forged = deepFreeze(envelope({ fulfillmentPath: "unfulfilled" }));
    expect(() => stripServerOnlyDemandFields(forged)).not.toThrow();
    expect(forged.fulfillmentPath).toBe("unfulfilled");
  });
});

describe("KitDemandSignalSchema", () => {
  it("accepts a consistent signal", () => {
    expect(KitDemandSignalSchema.safeParse(signal()).success).toBe(true);
  });

  it("accepts a prior-only signal and a proposed key", () => {
    const priorOnly: KitDemandSignal = {
      schema: "pcc.kit-demand-signal.v0",
      capabilityKey: "proposed:synthetic-gizmo",
      prior: {
        priorId: "kdp-synthetic-gizmo",
        source: "desk_research",
        demandScore: 3.5,
        buildClass: "build",
        datasetDigest: `sha256:${"0".repeat(64)}`,
      },
      computedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(KitDemandSignalSchema.safeParse(priorOnly).success).toBe(true);
  });

  it("rejects a signal with neither internal demand nor a prior", () => {
    const empty = { schema: "pcc.kit-demand-signal.v0", capabilityKey: TYPE, computedAt: "2026-09-24T00:00:00.000Z" };
    expect(KitDemandSignalSchema.safeParse(empty).success).toBe(false);
  });

  const rejects: Array<[string, Partial<KitDemandInternal>]> = [
    ["more distinct requesters than intents", { distinctVerifiedRequesters: 13, distinctVerifiedRequestersAtOrAbove: { query: 13, authenticated_order: 6, funded: 2 } }],
    ["class counts that miss intents", { byEvidenceClass: { query: 0, authenticated_order: 0, funded: 1 } }],
    ["a reason histogram that misses intents", { reasonHistogram: { no_capacity: 1 } }],
    ["a budget histogram that misses intents", { budgetBandHistogram: { under_100: 1 } }],
    ["an urgency histogram that misses intents", { urgencyHistogram: { rush: 1 } }],
    ["a country histogram that misses intents", { countryHistogram: { US: 1 } }],
    ["a tier histogram above unmetCount", { assuranceTierHistogram: { "3": 13 } }],
    ["a sub-country region key", { countryHistogram: { "US-CA": 12 } }],
    ["a lowercase country key", { countryHistogram: { us: 12 } }],
    ["more distinct requesters in a class than intents in it", { distinctVerifiedRequestersByClass: { query: 5, authenticated_order: 5, funded: 2 } }],
    ["an increasing at-or-above series", { distinctVerifiedRequestersAtOrAbove: { query: 7, authenticated_order: 8, funded: 2 } }],
    ["at-or-above funded different from by-class funded", { distinctVerifiedRequestersAtOrAbove: { query: 7, authenticated_order: 6, funded: 1 } }],
    ["an at-or-above count above its union bound", { distinctVerifiedRequestersByClass: { query: 0, authenticated_order: 3, funded: 2 }, distinctVerifiedRequestersAtOrAbove: { query: 6, authenticated_order: 6, funded: 2 }, distinctVerifiedRequesters: 6 }],
    ["a total that is not the at-or-above query count", { distinctVerifiedRequesters: 6 }],
    ["firstSeen after lastSeen", { firstSeen: "2026-09-23T19:00:00.000Z" }],
    ["activity outside the window", { windowFrom: "2026-09-05T00:00:00.000Z" }],
    ["an unknown reason key", { reasonHistogram: { because: 12 } as never }],
    ["a smuggled free-text field", { summary: "raw user text" } as never],
  ];
  for (const [name, bad] of rejects) {
    it(`rejects ${name}`, () => {
      expect(KitDemandSignalSchema.safeParse(signal(bad)).success).toBe(false);
    });
  }

  it("rejects malformed capability keys", () => {
    for (const key of ["hplc", "pcc://capabilities/HPLC/v1", "proposed:", "proposed:Has Space", "https://x/y"]) {
      expect(KitDemandSignalSchema.safeParse(signal({}, { capabilityKey: key })).success).toBe(false);
    }
  });

  it("rejects unknown top-level keys (strict), including smuggled intent fields", () => {
    expect(KitDemandSignalSchema.safeParse({ ...signal(), requesterIdHash: "x" }).success).toBe(false);
  });
});

describe("kitDemandSignalDigest", () => {
  it("is sha256:<hex>, byte-identical to the canonical async helper, and independent of key order", async () => {
    const a = signal();
    const reordered: KitDemandSignal = {
      computedAt: a.computedAt,
      internal: a.internal,
      capabilityKey: a.capabilityKey,
      schema: a.schema,
    };
    const d = kitDemandSignalDigest(a);
    expect(d).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await sha256(canonicalize(KitDemandSignalSchema.parse(a)))).toBe(d);
    expect(kitDemandSignalDigest(reordered)).toBe(d);
  });

  it("changes when any count changes", () => {
    expect(kitDemandSignalDigest(signal({ assuranceTierHistogram: { "2": 4 } }))).not.toBe(kitDemandSignalDigest(signal()));
  });

  it("refuses to digest an invalid signal", () => {
    expect(() => kitDemandSignalDigest(signal({ distinctVerifiedRequesters: 99 }))).toThrow();
  });
});

describe("toPublicOpportunityAggregate", () => {
  it("publishes only the allow-listed, banded shape under the default policy", () => {
    expect(toPublicOpportunityAggregate(signal())).toEqual({
      schema: "pcc.public-opportunity-aggregate.v0",
      capabilityType: TYPE,
      demandBand: "5-9",
      countedEvidence: "authenticated_order",
      asOf: "2026-09-23",
    });
  });

  it("defaults to k=5, an order-or-funded floor and a 30-day window", () => {
    expect(DEFAULT_OPPORTUNITY_POLICY).toEqual({ k: MIN_PUBLIC_K, minEvidenceClass: "authenticated_order", minWindowDays: MIN_WINDOW_DAYS });
    expect(evidenceClassRank("query")).toBeLessThan(evidenceClassRank("authenticated_order"));
    expect(evidenceClassRank("authenticated_order")).toBeLessThan(evidenceClassRank("funded"));
  });

  it("never leaks counts, histograms, prior data or requester identity", () => {
    const withPrior = signal({}, {
      prior: { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 5, buildClass: "build", datasetDigest: `sha256:${"a".repeat(64)}` },
    });
    const out = toPublicOpportunityAggregate(withPrior);
    expect(out).not.toBeNull();
    const text = JSON.stringify(out);
    for (const leak of ["unmetCount", "distinct", "Histogram", "byEvidenceClass", "prior", "kdp-", "demandScore", "firstSeen", "window", "US", "DE", "12"]) {
      expect(text).not.toContain(leak);
    }
    expect(Object.values(out as object).every((v) => typeof v === "string")).toBe(true);
  });

  it("keeps query-only demand private, however many verified requesters it has", () => {
    expect(toPublicOpportunityAggregate(signal(uniform(9, "query")))).toBeNull();
    expect(toPublicOpportunityAggregate(signal(uniform(500, "query")))).toBeNull();
  });

  it("counts order-backed and funded requesters, and a funded floor counts only funded ones", () => {
    expect(toPublicOpportunityAggregate(signal(uniform(5, "authenticated_order")))?.demandBand).toBe("5-9");
    expect(toPublicOpportunityAggregate(signal(uniform(5, "funded")))?.demandBand).toBe("5-9");
    const fundedOnly = { ...DEFAULT_OPPORTUNITY_POLICY, minEvidenceClass: "funded" as const };
    expect(toPublicOpportunityAggregate(signal(), fundedOnly)).toBeNull();
    expect(toPublicOpportunityAggregate(signal(uniform(6, "funded")), fundedOnly)?.countedEvidence).toBe("funded");
  });

  it("keeps prior-only signals and proposed types private", () => {
    const priorOnly: KitDemandSignal = {
      schema: "pcc.kit-demand-signal.v0",
      capabilityKey: TYPE,
      prior: { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 9, buildClass: "package", datasetDigest: `sha256:${"b".repeat(64)}` },
      computedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(toPublicOpportunityAggregate(priorOnly)).toBeNull();
    expect(toPublicOpportunityAggregate(signal(uniform(50, "funded"), { capabilityKey: "proposed:synthetic-gizmo" }))).toBeNull();
  });

  it("suppresses below k, and one caller's volume never publishes", () => {
    expect(toPublicOpportunityAggregate(signal(uniform(4, "funded")))).toBeNull();
    const oneActor = internal({
      unmetCount: 10_000,
      byEvidenceClass: { query: 0, authenticated_order: 10_000, funded: 0 },
      distinctVerifiedRequestersByClass: { query: 0, authenticated_order: 1, funded: 0 },
      distinctVerifiedRequestersAtOrAbove: { query: 1, authenticated_order: 1, funded: 0 },
      distinctVerifiedRequesters: 1,
      reasonHistogram: { no_capability_type: 10_000 },
      budgetBandHistogram: { under_100: 10_000 },
      urgencyHistogram: { standard: 10_000 },
      assuranceTierHistogram: {},
      countryHistogram: { unknown: 10_000 },
    });
    expect(toPublicOpportunityAggregate(signal(oneActor))).toBeNull();
  });

  it("keeps windows shorter than 30 days private", () => {
    const short = signal(uniform(20, "funded"), {});
    short.internal = { ...short.internal!, windowFrom: "2026-09-01T00:00:00.000Z", windowTo: "2026-09-23T23:59:59.999Z" };
    expect(toPublicOpportunityAggregate(short)).toBeNull();
  });

  it("bands by distinct verified requesters, never exact", () => {
    const at = (n: number) => toPublicOpportunityAggregate(signal(uniform(n, "authenticated_order")))?.demandBand;
    expect([at(5), at(9), at(10), at(24), at(25), at(99), at(100), at(5000)]).toEqual([
      "5-9", "5-9", "10-24", "10-24", "25-99", "25-99", "100+", "100+",
    ]);
  });

  it("honours stricter policies and refuses any policy weaker than the floors", () => {
    expect(toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, k: 7 })).toBeNull();
    expect(toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, k: 6 })).not.toBeNull();
    expect(() => toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, k: MIN_PUBLIC_K - 1 })).toThrow();
    expect(() => toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, k: 5.5 })).toThrow();
    expect(() => toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, minEvidenceClass: "query" })).toThrow();
    expect(() => toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, minWindowDays: 7 })).toThrow();
    expect(() => toPublicOpportunityAggregate(signal(), { ...DEFAULT_OPPORTUNITY_POLICY, minEvidenceClass: "bogus" as never })).toThrow();
  });

  it("reports asOf as the UTC day, whatever offset lastSeen carries", () => {
    const s = signal({ lastSeen: "2026-09-23T16:00:00-07:00", windowTo: "2026-09-24T23:59:59.999Z" });
    expect(toPublicOpportunityAggregate(s)?.asOf).toBe("2026-09-23");
    const t = signal({ lastSeen: "2026-09-23T20:00:00-07:00", windowTo: "2026-09-24T23:59:59.999Z" });
    expect(toPublicOpportunityAggregate(t)?.asOf).toBe("2026-09-24");
  });

  it("fails closed on an invalid signal and never mutates its input", () => {
    expect(() => toPublicOpportunityAggregate(signal({ distinctVerifiedRequesters: 99 }))).toThrow();
    const frozen = deepFreeze(signal());
    expect(() => toPublicOpportunityAggregate(frozen)).not.toThrow();
  });
});
