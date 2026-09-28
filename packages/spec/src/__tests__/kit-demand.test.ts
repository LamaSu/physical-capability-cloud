/**
 * Kit demand (R44): server-only envelope fields, the private KitDemandSignal,
 * and the public release. The release tests carry the adversarial cases from
 * the PX-13 round-1 review (pack 10, findings F1-F5). All fixtures are
 * SYNTHETIC; no real demand or prior data belongs in this public package.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CallerDemandEnvelopeSchema,
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
  buildPublicRelease,
  releasePeriodWindow,
  isReleasePeriodClosed,
  isPublishableCapabilityId,
  evidenceClassRank,
  PUBLIC_RELEASE_POLICY,
  type KitDemandSignal,
  type KitDemandInternal,
} from "../types/kit-demand.js";
import { canonicalize, sha256 } from "../util/canonical.js";

const TYPE = "pcc://capabilities/synthetic-widget/v1";
const OTHER = "pcc://capabilities/synthetic-gauge/v1";
/** The verdict's F3 counterexample: a CSD-shaped key carrying a proposed type, a place and a time. */
const CSD_SHAPED_SECRET = "pcc://capabilities/proposed-secret-us-ca-sf-20260910-123456/v1";
/** The fixtures' release period, and a server clock safely after it closed. */
const PERIOD = "2026-08";
const AFTER_CLOSE = "2026-09-15T00:00:00.000Z";

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

/** A consistent internal block over PERIOD: 12 intents, 7 verified requesters, 6 at or above orders. */
function internal(overrides: Partial<KitDemandInternal> = {}): KitDemandInternal {
  return {
    windowFrom: "2026-08-01T00:00:00.000Z",
    windowTo: "2026-08-31T23:59:59.999Z",
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
    firstSeen: "2026-08-03T00:00:00.000Z",
    lastSeen: "2026-08-30T18:30:00.000Z",
    ...overrides,
  };
}

function signal(overrides: Partial<KitDemandInternal> = {}, top: Partial<KitDemandSignal> = {}): KitDemandSignal {
  return {
    schema: "pcc.kit-demand-signal.v0",
    capabilityKey: TYPE,
    internal: internal(overrides),
    computedAt: "2026-09-02T00:00:00.000Z",
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
  const unmet = [{ capabilityType: TYPE, reason: "no_kernel_offering" as const, supplyCount: 0 }];

  it("stays backward compatible: an envelope without unmet still parses", () => {
    expect(DemandEnvelopeSchema.safeParse(envelope()).success).toBe(true);
    expect(ServerCapturedDemandEnvelopeSchema.safeParse(envelope()).success).toBe(true);
  });

  it("DemandEnvelopeSchema has no unmet field, so parsing strips a supplied one", () => {
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
    expect(UnmetCapabilitySchema.safeParse({ capabilityType: TYPE, reason: "no_capacity", supplyCount: 0 }).success).toBe(true);
    expect(UnmetCapabilitySchema.safeParse({ capabilityType: TYPE, reason: "because", supplyCount: 0 }).success).toBe(false);
    expect(UnmetCapabilitySchema.safeParse({ capabilityType: TYPE, reason: "no_capacity", supplyCount: -1 }).success).toBe(false);
  });
});

describe("UnmetCapability key form must match its reason (F3)", () => {
  const ok = (capabilityType: string, reason: string) =>
    UnmetCapabilitySchema.safeParse({ capabilityType, reason, supplyCount: 0 }).success;

  it("names a type with no CSD only by a kebab slug", () => {
    expect(ok("synthetic-gizmo", "no_capability_type")).toBe(true);
    expect(ok("3d-printing", "no_capability_type")).toBe(true);
  });

  it("rejects the verdict's counterexample: a CSD-shaped key with no_capability_type", () => {
    expect(ok(CSD_SHAPED_SECRET, "no_capability_type")).toBe(false);
    expect(ok(TYPE, "no_capability_type")).toBe(false);
  });

  it("names every registered-type reason only by its CSD URI", () => {
    for (const reason of ["no_kernel_offering", "no_capacity", "tier_too_high", "region_unavailable"]) {
      expect(ok(TYPE, reason)).toBe(true);
      expect(ok("synthetic-widget", reason)).toBe(false);
    }
  });

  it("rejects labels that are neither form", () => {
    for (const bad of ["Synthetic Gizmo", "-leading-hyphen", "UPPER", "a".repeat(101), "pcc://capabilities/Widget/v1", "https://x/y"]) {
      expect(ok(bad, "no_capability_type")).toBe(false);
      expect(ok(bad, "no_kernel_offering")).toBe(false);
    }
  });

  it("makes the server-captured schema reject an envelope with one inconsistent entry", () => {
    const mixed = envelope({
      fulfillmentPath: "unfulfilled",
      unmet: [
        { capabilityType: TYPE, reason: "no_kernel_offering", supplyCount: 0 },
        { capabilityType: CSD_SHAPED_SECRET, reason: "no_capability_type", supplyCount: 0 },
      ],
    });
    expect(ServerCapturedDemandEnvelopeSchema.safeParse(mixed).success).toBe(false);
  });
});

describe("CallerDemandEnvelopeSchema (F5: caller input carries no server-only field)", () => {
  it("drops fulfillmentPath, unmet and unmetTruncated, and keeps everything else", () => {
    const forged = {
      ...envelope(),
      fulfillmentPath: "unfulfilled",
      unmet: [{ capabilityType: TYPE, reason: "no_kernel_offering", supplyCount: 0 }],
      unmetTruncated: true,
    };
    const parsed = CallerDemandEnvelopeSchema.parse(forged);
    expect("fulfillmentPath" in parsed).toBe(false);
    expect("unmet" in parsed).toBe(false);
    expect("unmetTruncated" in parsed).toBe(false);
    expect(parsed).toEqual(envelope());
  });

  it("has no fulfillmentPath field at all, unlike the server-side DemandEnvelopeSchema", () => {
    expect(Object.keys(CallerDemandEnvelopeSchema.shape)).not.toContain("fulfillmentPath");
    expect(Object.keys(CallerDemandEnvelopeSchema.shape)).not.toContain("unmet");
    expect(Object.keys(DemandEnvelopeSchema.shape)).toContain("fulfillmentPath");
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
    ["firstSeen after lastSeen", { firstSeen: "2026-08-30T19:00:00.000Z" }],
    ["activity outside the window", { windowFrom: "2026-08-05T00:00:00.000Z" }],
    ["an unknown reason key", { reasonHistogram: { because: 12 } as never }],
    ["a smuggled free-text field", { summary: "raw user text" } as never],
  ];
  for (const [name, bad] of rejects) {
    it(`rejects ${name}`, () => {
      expect(KitDemandSignalSchema.safeParse(signal(bad)).success).toBe(false);
    });
  }

  it("rejects malformed capability keys", () => {
    for (const key of ["hplc", "pcc://capabilities/HPLC/v1", "proposed:", "proposed:Has Space", "proposed:-x", "https://x/y"]) {
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

/** `base` plus one unverified, query-only intent at `at`: volume and dates move, breadth does not. */
function withLateUnverifiedIntent(base: KitDemandInternal, at: string): KitDemandInternal {
  const plus = (m: Record<string, number | undefined>, k: string) => ({ ...m, [k]: (m[k] ?? 0) + 1 });
  return {
    ...base,
    unmetCount: base.unmetCount + 1,
    byEvidenceClass: { ...base.byEvidenceClass, query: base.byEvidenceClass.query + 1 },
    reasonHistogram: plus(base.reasonHistogram, "no_kernel_offering"),
    budgetBandHistogram: plus(base.budgetBandHistogram, "100_1k"),
    urgencyHistogram: plus(base.urgencyHistogram, "standard"),
    countryHistogram: plus(base.countryHistogram, "unknown"),
    lastSeen: at,
  };
}

describe("public release (PX-13 round-1 findings)", () => {
  const APPROVED: ReadonlySet<string> = new Set([TYPE, OTHER]);
  const project = (s: KitDemandSignal, approved: ReadonlySet<string> = APPROVED) =>
    toPublicOpportunityAggregate(s, PERIOD, approved);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AFTER_CLOSE));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("shape and fixed policy (F1)", () => {
    it("publishes only the allow-listed, banded shape, labelled by its period", () => {
      const out = project(signal());
      expect(out).toEqual({
        schema: "pcc.public-opportunity-aggregate.v1",
        capabilityType: TYPE,
        demandBand: "5-9",
        countedEvidence: "authenticated_order",
        period: PERIOD,
      });
      expect(Object.keys(out!).sort()).toEqual(["capabilityType", "countedEvidence", "demandBand", "period", "schema"]);
    });

    it("fixes one server-owned policy: k = 5, an order-or-funded floor, a 24-hour grace, frozen", () => {
      expect(PUBLIC_RELEASE_POLICY).toEqual({ k: 5, evidenceFloor: "authenticated_order", graceMs: 86_400_000 });
      expect(Object.isFrozen(PUBLIC_RELEASE_POLICY)).toBe(true);
      expect(() => {
        (PUBLIC_RELEASE_POLICY as { k: number }).k = 7;
      }).toThrow(TypeError);
      expect(PUBLIC_RELEASE_POLICY.k).toBe(5);
      expect(evidenceClassRank("query")).toBeLessThan(evidenceClassRank("authenticated_order"));
      expect(evidenceClassRank("authenticated_order")).toBeLessThan(evidenceClassRank("funded"));
    });

    it("F1, two k values: no caller-chosen k exists, so k: 6 and k: 7 give the same answer", () => {
      // Round 1: six qualifying requesters published under k: 6 and were suppressed under k: 7.
      const s = signal();
      expect(s.internal!.distinctVerifiedRequestersAtOrAbove.authenticated_order).toBe(6);
      const untyped = toPublicOpportunityAggregate as unknown as (...args: unknown[]) => unknown;
      const base = untyped(s, PERIOD, APPROVED);
      expect(base).not.toBeNull();
      expect(untyped(s, PERIOD, APPROVED, { k: 6 })).toEqual(base);
      expect(untyped(s, PERIOD, APPROVED, { k: 7 })).toEqual(base);
      expect(untyped(s, PERIOD, APPROVED, { k: 7, minEvidenceClass: "funded", minWindowDays: 1 })).toEqual(base);
      expect(toPublicOpportunityAggregate.length).toBe(3);
      expect(buildPublicRelease.length).toBe(3);
    });

    it("F1: a reader learns the band, never the count: 5 to 9 requesters publish identically", () => {
      const outs = [5, 6, 7, 8, 9].map((n) => project(signal(uniform(n, "authenticated_order"))));
      for (const o of outs) expect(o).toEqual(outs[0]);
      expect(outs[0]?.demandBand).toBe("5-9");
      expect(project(signal(uniform(4, "authenticated_order")))).toBeNull();
    });

    it("bands by distinct verified requesters, never exact", () => {
      const at = (n: number) => project(signal(uniform(n, "authenticated_order")))?.demandBand;
      expect([at(5), at(9), at(10), at(24), at(25), at(99), at(100), at(5000)]).toEqual([
        "5-9", "5-9", "10-24", "10-24", "25-99", "25-99", "100+", "100+",
      ]);
    });

    it("counts funded requesters toward the order floor and always reports that floor", () => {
      expect(project(signal(uniform(5, "funded")))).toMatchObject({ demandBand: "5-9", countedEvidence: "authenticated_order" });
    });

    it("keeps query-only demand private, however many verified requesters it has", () => {
      expect(project(signal(uniform(9, "query")))).toBeNull();
      expect(project(signal(uniform(500, "query")))).toBeNull();
    });

    it("suppresses below k, and one caller's volume never publishes", () => {
      expect(project(signal(uniform(4, "funded")))).toBeNull();
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
      expect(project(signal(oneActor))).toBeNull();
    });

    it("never leaks counts, histograms, prior data, requester identity or an activity date", () => {
      const withPrior = signal({}, {
        prior: { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 5, buildClass: "build", datasetDigest: `sha256:${"a".repeat(64)}` },
      });
      const out = project(withPrior);
      expect(out).not.toBeNull();
      const text = JSON.stringify(out);
      for (const leak of ["unmetCount", "distinct", "Histogram", "byEvidenceClass", "prior", "kdp-", "demandScore", "firstSeen", "lastSeen", "window", "asOf", "US", "DE", "12"]) {
        expect(text).not.toContain(leak);
      }
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(Object.values(out as object).every((v) => typeof v === "string")).toBe(true);
    });
  });

  describe("fixed, closed release periods (F2)", () => {
    it("maps a period to its exact UTC calendar month, including leap February", () => {
      expect(releasePeriodWindow("2026-08")).toEqual({ from: "2026-08-01T00:00:00.000Z", to: "2026-08-31T23:59:59.999Z" });
      expect(releasePeriodWindow("2026-02").to).toBe("2026-02-28T23:59:59.999Z");
      expect(releasePeriodWindow("2028-02").to).toBe("2028-02-29T23:59:59.999Z");
      expect(releasePeriodWindow("2026-12")).toEqual({ from: "2026-12-01T00:00:00.000Z", to: "2026-12-31T23:59:59.999Z" });
    });

    it("refuses malformed periods", () => {
      for (const bad of ["2026-8", "2026-13", "2026-00", "1999-12", "2026-08-01", " 2026-08", "2026-08 ", "", "2026/08"]) {
        expect(() => releasePeriodWindow(bad)).toThrow();
        expect(() => toPublicOpportunityAggregate(signal(), bad, APPROVED)).toThrow();
        expect(() => buildPublicRelease([], bad, APPROVED)).toThrow();
      }
    });

    it("F2, sliding windows at millisecond precision: any window but the exact period is refused", () => {
      // Round 1: holding the end fixed and sliding the start across one
      // requester's intent flipped the output between "5-9" and null.
      const { from, to } = releasePeriodWindow(PERIOD);
      const shift = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
      const windows: Array<[string, string]> = [
        [shift(from, 1), to],
        [shift(from, -1), to],
        [from, shift(to, -1)],
        [from, shift(to, 1)],
        ["2026-08-02T12:34:56.789Z", to],
        ["2026-08-02T12:34:56.790Z", to],
        ["2026-08-01T00:00:00.000Z", "2026-08-30T23:59:59.999Z"],
      ];
      for (const [windowFrom, windowTo] of windows) {
        const s = signal({ windowFrom, windowTo, firstSeen: "2026-08-03T00:00:00.000Z", lastSeen: "2026-08-29T00:00:00.000Z" });
        expect(KitDemandSignalSchema.safeParse(s).success).toBe(true);
        expect(() => project(s)).toThrow(/not release period/);
        expect(() => buildPublicRelease([s], PERIOD, APPROVED)).toThrow(/not release period/);
      }
    });

    it("compares windows by instant, so an offset spelling of the exact period is the same period", () => {
      const s = signal({ windowFrom: "2026-08-01T02:00:00.000+02:00", windowTo: "2026-09-01T01:59:59.999+02:00" });
      expect(project(s)?.period).toBe(PERIOD);
    });

    it("F2, closed periods only: the current month and a month inside its grace are refused", () => {
      vi.setSystemTime(new Date("2026-08-20T00:00:00.000Z"));
      expect(isReleasePeriodClosed(PERIOD)).toBe(false);
      expect(() => project(signal())).toThrow(/has not closed/);
      vi.setSystemTime(new Date("2026-09-01T23:59:59.999Z"));
      expect(isReleasePeriodClosed(PERIOD)).toBe(false);
      expect(() => project(signal())).toThrow(/has not closed/);
      expect(() => buildPublicRelease([], PERIOD, APPROVED)).toThrow(/has not closed/);
      vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
      expect(isReleasePeriodClosed(PERIOD)).toBe(true);
      expect(project(signal())).not.toBeNull();
    });

    it("refuses a signal computed before its period closed, because its data is incomplete", () => {
      expect(() => project(signal({}, { computedAt: "2026-08-31T23:59:59.999Z" }))).toThrow(/before period/);
      expect(() => project(signal({}, { computedAt: "2026-09-01T12:00:00.000Z" }))).toThrow(/before period/);
      expect(project(signal({}, { computedAt: "2026-09-02T00:00:00.000Z" }))).not.toBeNull();
    });
  });

  describe("approved IDs only (F3)", () => {
    it("F3: the verdict's CSD-shaped key is well-formed but never published unless approved", () => {
      const secret = signal(uniform(50, "funded"), { capabilityKey: CSD_SHAPED_SECRET });
      expect(KitDemandSignalSchema.safeParse(secret).success).toBe(true);
      expect(project(secret)).toBeNull();
    });

    it("publishes only exact members of the publisher's approved set", () => {
      expect(project(signal(), new Set())).toBeNull();
      expect(project(signal(), new Set(["pcc://capabilities/synthetic-widget/v2"]))).toBeNull();
      expect(project(signal(), new Set([TYPE]))).not.toBeNull();
    });

    it("F3 defense in depth: an ID whose slug could carry a date, place code or counter never publishes", () => {
      const builtIns = ["2d-print/v1", "cnc-3axis/v2", "courier-route/v1", "fdm/v2", "hot-food-prep/v1", "laser-cut/v2", "make-pizza/v1", "sla/v2"];
      for (const b of builtIns) expect(isPublishableCapabilityId(`pcc://capabilities/${b}`)).toBe(true);
      for (const bad of [
        CSD_SHAPED_SECRET,
        "pcc://capabilities/lab-2026/v1",
        "pcc://capabilities/a-b-c-d-e/v1",
        `pcc://capabilities/${"a".repeat(41)}/v1`,
        "proposed:synthetic-gizmo",
        "pcc://capabilities/Widget/v1",
      ]) {
        expect(isPublishableCapabilityId(bad)).toBe(false);
      }
      const dated = "pcc://capabilities/widget-20260910/v1";
      const s = signal(uniform(50, "funded"), { capabilityKey: dated });
      expect(project(s, new Set([dated]))).toBeNull();
    });

    it("never publishes a proposed key, even if the approved set lists it", () => {
      const proposed = signal(uniform(50, "funded"), { capabilityKey: "proposed:synthetic-gizmo" });
      expect(project(proposed, new Set(["proposed:synthetic-gizmo"]))).toBeNull();
    });

    it("keeps prior-only signals private", () => {
      const priorOnly: KitDemandSignal = {
        schema: "pcc.kit-demand-signal.v0",
        capabilityKey: TYPE,
        prior: { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 9, buildClass: "package", datasetDigest: `sha256:${"b".repeat(64)}` },
        computedAt: "2026-09-02T00:00:00.000Z",
      };
      expect(project(priorOnly)).toBeNull();
    });
  });

  describe("period label, not an activity date (F4)", () => {
    it("F4, one unverified late intent: the private signal moves, the public output does not", () => {
      const base = uniform(6, "authenticated_order");
      const later = withLateUnverifiedIntent(base, "2026-08-31T23:59:59.999Z");
      expect(KitDemandSignalSchema.safeParse(signal(later)).success).toBe(true);
      expect(signal(later).internal!.lastSeen).not.toBe(signal(base).internal!.lastSeen);
      expect(project(signal(later))).toEqual(project(signal(base)));
      expect(buildPublicRelease([signal(later)], PERIOD, APPROVED).digest).toBe(
        buildPublicRelease([signal(base)], PERIOD, APPROVED).digest,
      );
    });
  });

  describe("buildPublicRelease", () => {
    it("builds one deterministic, sorted release with a digest over its canonical JSON", async () => {
      const a = signal(uniform(12, "authenticated_order"));
      const b = signal(uniform(5, "funded"), { capabilityKey: OTHER });
      const release = buildPublicRelease([a, b], PERIOD, APPROVED);
      expect(release.schema).toBe("pcc.public-opportunity-release.v1");
      expect(release.period).toBe(PERIOD);
      expect(release.policy).toEqual({ k: 5, evidenceFloor: "authenticated_order" });
      expect(release.aggregates.map((x) => [x.capabilityType, x.demandBand])).toEqual([
        [OTHER, "5-9"],
        [TYPE, "10-24"],
      ]);
      const { digest, ...body } = release;
      expect(digest).toBe(await sha256(canonicalize(body)));
      expect(buildPublicRelease([b, a], PERIOD, APPROVED)).toEqual(release);
    });

    it("records the approved set it was given by digest, whatever the set's insertion order", async () => {
      const release = buildPublicRelease([signal()], PERIOD, APPROVED);
      expect(release.approvedSetDigest).toBe(await sha256(canonicalize([OTHER, TYPE])));
      expect(buildPublicRelease([signal()], PERIOD, new Set([OTHER, TYPE])).approvedSetDigest).toBe(release.approvedSetDigest);
      const narrower = buildPublicRelease([signal()], PERIOD, new Set([TYPE]));
      expect(narrower.aggregates).toEqual(release.aggregates);
      expect(narrower.approvedSetDigest).not.toBe(release.approvedSetDigest);
      expect(narrower.digest).not.toBe(release.digest);
    });

    it("leaves out whatever does not qualify, and an empty release is still a release", () => {
      const release = buildPublicRelease(
        [
          signal(uniform(4, "funded")),
          signal(uniform(50, "query"), { capabilityKey: OTHER }),
          signal(uniform(50, "funded"), { capabilityKey: CSD_SHAPED_SECRET }),
          signal(uniform(50, "funded"), { capabilityKey: "proposed:synthetic-gizmo" }),
        ],
        PERIOD,
        APPROVED,
      );
      expect(release.aggregates).toEqual([]);
      expect(release.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(JSON.stringify(release)).not.toContain("secret");
      expect(JSON.stringify(release)).not.toContain("proposed");
    });

    it("changes its digest when a band changes, and only then", () => {
      const at = (n: number) => buildPublicRelease([signal(uniform(n, "authenticated_order"))], PERIOD, APPROVED).digest;
      expect(at(6)).toBe(at(9));
      expect(at(9)).not.toBe(at(10));
    });

    it("refuses duplicate keys, a mismatched window and an open period", () => {
      expect(() => buildPublicRelease([signal(), signal()], PERIOD, APPROVED)).toThrow(/more than one signal/);
      expect(() => buildPublicRelease([signal({ windowFrom: "2026-08-02T00:00:00.000Z" })], PERIOD, APPROVED)).toThrow(/not release period/);
      expect(() => buildPublicRelease([], "2026-09", APPROVED)).toThrow(/has not closed/);
    });

    it("contains no date finer than the period", () => {
      expect(JSON.stringify(buildPublicRelease([signal()], PERIOD, APPROVED))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it("fails closed on an invalid signal and never mutates its input", () => {
      expect(() => project(signal({ distinctVerifiedRequesters: 99 }))).toThrow();
      const frozen = deepFreeze(signal());
      expect(() => project(frozen)).not.toThrow();
      expect(() => buildPublicRelease([frozen], PERIOD, APPROVED)).not.toThrow();
    });
  });
});
