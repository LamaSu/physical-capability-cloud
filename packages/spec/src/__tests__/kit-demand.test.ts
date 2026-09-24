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
  MIN_PUBLIC_K,
  type KitDemandSignal,
} from "../types/kit-demand.js";

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

function signal(internalOverrides: Record<string, unknown> = {}, top: Partial<KitDemandSignal> = {}): KitDemandSignal {
  return {
    schema: "pcc.kit-demand-signal.v0",
    capabilityKey: TYPE,
    internal: {
      unmetCount: 12,
      distinctVerifiedRequesters: 7,
      byEvidenceClass: { funded: 2, authenticated_order: 6, query: 4 },
      reasonHistogram: { no_kernel_offering: 9, no_capability_type: 3 },
      budgetBandHistogram: { "100_1k": 10, "1k_10k": 2 },
      firstSeen: "2026-09-01T00:00:00.000Z",
      lastSeen: "2026-09-23T18:30:00.000Z",
      ...internalOverrides,
    } as KitDemandSignal["internal"],
    computedAt: "2026-09-24T00:00:00.000Z",
    ...top,
  };
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

  it("rejects more distinct requesters than unmet intents", () => {
    expect(KitDemandSignalSchema.safeParse(signal({ distinctVerifiedRequesters: 13 })).success).toBe(false);
  });

  it("rejects histograms that do not account for every unmet intent", () => {
    expect(KitDemandSignalSchema.safeParse(signal({ byEvidenceClass: { funded: 0, authenticated_order: 0, query: 1 } })).success).toBe(false);
    expect(KitDemandSignalSchema.safeParse(signal({ reasonHistogram: { no_capacity: 1 } })).success).toBe(false);
    expect(KitDemandSignalSchema.safeParse(signal({ budgetBandHistogram: { under_100: 1 } })).success).toBe(false);
  });

  it("rejects an unknown reason key and an unknown budget band key", () => {
    expect(KitDemandSignalSchema.safeParse(signal({ reasonHistogram: { because: 12 } })).success).toBe(false);
    expect(KitDemandSignalSchema.safeParse(signal({ budgetBandHistogram: { lots: 12 } })).success).toBe(false);
  });

  it("rejects firstSeen after lastSeen", () => {
    expect(KitDemandSignalSchema.safeParse(signal({ firstSeen: "2026-09-30T00:00:00.000Z" })).success).toBe(false);
  });

  it("rejects malformed capability keys", () => {
    for (const key of ["hplc", "pcc://capabilities/HPLC/v1", "proposed:", "proposed:Has Space", "https://x/y"]) {
      expect(KitDemandSignalSchema.safeParse(signal({}, { capabilityKey: key })).success).toBe(false);
    }
  });

  it("rejects unknown keys (strict), including smuggled intent fields", () => {
    expect(KitDemandSignalSchema.safeParse({ ...signal(), requesterIdHash: "x" }).success).toBe(false);
    expect(KitDemandSignalSchema.safeParse(signal({ summary: "raw user text" })).success).toBe(false);
  });
});

describe("kitDemandSignalDigest", () => {
  it("is a 0x-prefixed sha256 and independent of key order", () => {
    const a = signal();
    const reordered: KitDemandSignal = {
      computedAt: a.computedAt,
      internal: a.internal,
      capabilityKey: a.capabilityKey,
      schema: a.schema,
    };
    expect(kitDemandSignalDigest(a)).toMatch(/^0x[a-f0-9]{64}$/);
    expect(kitDemandSignalDigest(reordered)).toBe(kitDemandSignalDigest(a));
  });

  it("changes when any count changes", () => {
    const base = kitDemandSignalDigest(signal());
    const changed = kitDemandSignalDigest(
      signal({ unmetCount: 13, byEvidenceClass: { funded: 2, authenticated_order: 7, query: 4 }, reasonHistogram: { no_kernel_offering: 10, no_capability_type: 3 }, budgetBandHistogram: { "100_1k": 11, "1k_10k": 2 } }),
    );
    expect(changed).not.toBe(base);
  });

  it("refuses to digest an invalid signal", () => {
    expect(() => kitDemandSignalDigest(signal({ distinctVerifiedRequesters: 99 }))).toThrow();
  });
});

describe("toPublicOpportunityAggregate", () => {
  it("publishes only the allow-listed, banded shape", () => {
    const out = toPublicOpportunityAggregate(signal());
    expect(out).toEqual({
      schema: "pcc.public-opportunity-aggregate.v0",
      capabilityType: TYPE,
      demandBand: "5+",
      asOf: "2026-09-23",
    });
  });

  it("never leaks exact counts, histograms, prior data or requester identity", () => {
    const withPrior = signal({}, {
      prior: { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 5, buildClass: "build", datasetDigest: `sha256:${"a".repeat(64)}` },
    });
    const out = toPublicOpportunityAggregate(withPrior);
    expect(out).not.toBeNull();
    const text = JSON.stringify(out);
    for (const leak of ["unmetCount", "distinctVerifiedRequesters", "Histogram", "byEvidenceClass", "prior", "kdp-", "demandScore", "firstSeen", "12", "7"]) {
      expect(text).not.toContain(leak);
    }
    expect(Object.values(out as object).every((v) => typeof v === "string")).toBe(true);
  });

  it("keeps prior-only signals private", () => {
    const priorOnly: KitDemandSignal = {
      schema: "pcc.kit-demand-signal.v0",
      capabilityKey: TYPE,
      prior: { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 9, buildClass: "package", datasetDigest: `sha256:${"b".repeat(64)}` },
      computedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(toPublicOpportunityAggregate(priorOnly)).toBeNull();
  });

  it("keeps proposed types private even with broad demand", () => {
    expect(toPublicOpportunityAggregate(signal({}, { capabilityKey: "proposed:synthetic-gizmo" }))).toBeNull();
  });

  it("suppresses types below k distinct verified requesters", () => {
    const four = signal({
      unmetCount: 4,
      distinctVerifiedRequesters: 4,
      byEvidenceClass: { funded: 0, authenticated_order: 4, query: 0 },
      reasonHistogram: { no_kernel_offering: 4 },
      budgetBandHistogram: { "100_1k": 4 },
    });
    expect(toPublicOpportunityAggregate(four)).toBeNull();
  });

  it("does not let one caller inflate volume into a public opportunity", () => {
    const oneActor = signal({
      unmetCount: 10_000,
      distinctVerifiedRequesters: 1,
      byEvidenceClass: { funded: 0, authenticated_order: 0, query: 10_000 },
      reasonHistogram: { no_capability_type: 10_000 },
      budgetBandHistogram: { under_100: 10_000 },
    });
    expect(toPublicOpportunityAggregate(oneActor)).toBeNull();
  });

  it("bands by distinct verified requesters, never exact", () => {
    const at = (n: number) =>
      toPublicOpportunityAggregate(
        signal({
          unmetCount: n,
          distinctVerifiedRequesters: n,
          byEvidenceClass: { funded: 0, authenticated_order: n, query: 0 },
          reasonHistogram: { no_kernel_offering: n },
          budgetBandHistogram: { "100_1k": n },
        }),
      )?.demandBand;
    expect(at(5)).toBe("5+");
    expect(at(9)).toBe("5+");
    expect(at(10)).toBe("10+");
    expect(at(49)).toBe("25+");
    expect(at(50)).toBe("50+");
    expect(at(100)).toBe("100+");
    expect(at(5000)).toBe("100+");
  });

  it("honours a stricter k and refuses a weaker one", () => {
    expect(toPublicOpportunityAggregate(signal(), { k: 8 })).toBeNull();
    expect(toPublicOpportunityAggregate(signal(), { k: 7 })).not.toBeNull();
    expect(() => toPublicOpportunityAggregate(signal(), { k: MIN_PUBLIC_K - 1 })).toThrow();
    expect(() => toPublicOpportunityAggregate(signal(), { k: 5.5 })).toThrow();
  });

  it("reports asOf as the UTC day, whatever offset lastSeen carries", () => {
    const out = toPublicOpportunityAggregate(signal({ lastSeen: "2026-09-23T20:00:00-07:00" }));
    expect(out?.asOf).toBe("2026-09-24");
  });

  it("fails closed on an invalid signal and never mutates its input", () => {
    expect(() => toPublicOpportunityAggregate(signal({ distinctVerifiedRequesters: 99 }))).toThrow();
    const frozen = deepFreeze(signal());
    expect(() => toPublicOpportunityAggregate(frozen)).not.toThrow();
  });
});
