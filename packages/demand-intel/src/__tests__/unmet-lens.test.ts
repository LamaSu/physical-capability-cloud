/**
 * UnmetDemandLens (R44, D3). SYNTHETIC rows only. The last block is the seam
 * test: lens output fed straight into @pcc/spec's public release, with the
 * adversarial cases from the PX-13 round-1 review (pack 10).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStore, type Store } from "@pcc/store";
import {
  buildPublicRelease,
  computeCompositionSignature,
  kitDemandSignalDigest,
  releasePeriodWindow,
  toPublicOpportunityAggregate,
  type DemandEnvelope,
  type KitDemandPriorRef,
  type UnmetCapability,
} from "@pcc/spec";
import { UnmetDemandLens, resolveCapabilityKey, normalizeCountry, VERIFIED_ACTOR_TYPE } from "../unmet-lens.js";

const HPLC = "pcc://capabilities/synthetic-hplc/v1";
const WIDGET = "pcc://capabilities/synthetic-widget/v1";
/** The verdict's F3 counterexample: a CSD-shaped key carrying a proposed type, a place and a time. */
const CSD_SHAPED_SECRET = "pcc://capabilities/proposed-secret-us-ca-sf-20260910-123456/v1";
/** 37 days: comfortably above the 30-day public window floor. */
const WINDOW = { from: "2026-08-25T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" };
const NOW = () => "2026-09-24T12:00:00.000Z";

let seq = 0;

interface RowSpec {
  eventType?: string;
  actorType?: string;
  actorId?: string;
  timestamp?: string;
  unmet?: UnmetCapability[];
  fulfillmentPath?: DemandEnvelope["fulfillmentPath"];
  budgetBand?: DemandEnvelope["budgetBand"];
  urgencyBand?: DemandEnvelope["urgencyBand"];
  assuranceTier?: DemandEnvelope["assuranceTier"];
  geographicRegion?: string;
  createdAt?: string;
  payloadOverride?: unknown;
}

function persist(store: Store, spec: RowSpec = {}): void {
  seq++;
  const id = `intent-syn-${seq}`;
  const payload =
    spec.payloadOverride ??
    ({
      id,
      source: "requests_api",
      compositionSignature: computeCompositionSignature(["synthetic-hplc"], []),
      capabilityTypes: ["synthetic-hplc"],
      summary: "synthetic",
      budgetBand: spec.budgetBand ?? "100_1k",
      urgencyBand: spec.urgencyBand ?? "standard",
      ...(spec.assuranceTier === undefined ? {} : { assuranceTier: spec.assuranceTier }),
      ...(spec.geographicRegion === undefined ? {} : { geographicRegion: spec.geographicRegion }),
      createdAt: spec.createdAt ?? "2026-09-10T00:00:00.000Z",
      fulfillmentPath: spec.fulfillmentPath ?? "unfulfilled",
      unmet: spec.unmet ?? [{ capabilityType: HPLC, reason: "no_kernel_offering", supplyCount: 0 }],
    } satisfies Record<string, unknown>);
  store.repos.analytics.insertEvent({
    id,
    eventType: spec.eventType ?? "intent.composite_request",
    category: "intent",
    timestamp: spec.timestamp ?? "2026-09-10T00:00:00.000Z",
    actorId: spec.actorId ?? "someone@example.invalid",
    actorType: spec.actorType ?? "requestor",
    resourceType: "intent",
    resourceId: id,
    payload: payload as Record<string, unknown>,
    hash: `sha256:${id}`,
    previousHash: null,
  } as Parameters<typeof store.repos.analytics.insertEvent>[0]);
}

function verified(store: Store, principal: string, extra: RowSpec = {}): void {
  persist(store, { actorType: VERIFIED_ACTOR_TYPE, actorId: principal, ...extra });
}

describe("normalizeCountry", () => {
  it("keeps only ISO alpha-2 countries and drops sub-country detail", () => {
    expect(normalizeCountry("US")).toBe("US");
    expect(normalizeCountry("us-ca")).toBe("US");
    expect(normalizeCountry("DE-BY")).toBe("DE");
    expect(normalizeCountry("Europe")).toBe("unknown");
    expect(normalizeCountry("unknown")).toBe("unknown");
    expect(normalizeCountry(undefined)).toBe("unknown");
    expect(normalizeCountry("US-CA-SF-94103")).toBe("unknown");
  });
});

describe("UnmetDemandLens", () => {
  let store: Store;
  let lens: UnmetDemandLens;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:", seed: false });
    lens = new UnmetDemandLens(store.repos);
  });

  it("never reads intent.external_ingest, even with forged unmet data and a verified-looking actor", () => {
    for (let i = 0; i < 20; i++) {
      persist(store, { eventType: "intent.external_ingest", actorType: VERIFIED_ACTOR_TYPE, actorId: `forger-${i}` });
    }
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals).toEqual([]);
    expect(diagnostics.rowsRead).toBe(0);
  });

  it("counts a server-captured unmet intent with its class, histograms, window and server timestamp", () => {
    persist(store, {
      timestamp: "2026-09-12T08:00:00.000Z",
      createdAt: "1999-01-01T00:00:00.000Z",
      budgetBand: "1k_10k",
      urgencyBand: "rush",
      assuranceTier: 2,
      geographicRegion: "us-ca",
    });
    const { signals } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals).toHaveLength(1);
    const internal = signals[0]!.internal!;
    expect(signals[0]!.capabilityKey).toBe(HPLC);
    expect(internal.unmetCount).toBe(1);
    expect(internal.byEvidenceClass).toEqual({ query: 0, authenticated_order: 1, funded: 0 });
    expect(internal.reasonHistogram).toEqual({ no_kernel_offering: 1 });
    expect(internal.budgetBandHistogram).toEqual({ "1k_10k": 1 });
    expect(internal.urgencyHistogram).toEqual({ rush: 1 });
    expect(internal.assuranceTierHistogram).toEqual({ "2": 1 });
    expect(internal.countryHistogram).toEqual({ US: 1 });
    expect(internal.windowFrom).toBe(WINDOW.from);
    expect(internal.windowTo).toBe(WINDOW.to);
    // The caller-influenced createdAt (1999) is ignored; the server row timestamp is used.
    expect(internal.firstSeen).toBe("2026-09-12T08:00:00.000Z");
    expect(internal.lastSeen).toBe("2026-09-12T08:00:00.000Z");
  });

  it("counts an intent without a tier toward every histogram except the tier one", () => {
    persist(store);
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.assuranceTierHistogram).toEqual({});
    expect(internal.countryHistogram).toEqual({ unknown: 1 });
  });

  it("gives today's rows zero verified breadth: body-supplied actors never count", () => {
    for (let i = 0; i < 50; i++) persist(store, { actorType: "requestor", actorId: `body-actor-${i}` });
    for (let i = 0; i < 50; i++) persist(store, { eventType: "intent.atomic_session", actorType: "agent", actorId: `agent-${i}` });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    const internal = signals[0]!.internal!;
    expect(internal.unmetCount).toBe(100);
    expect(internal.distinctVerifiedRequesters).toBe(0);
    expect(internal.distinctVerifiedRequestersAtOrAbove).toEqual({ query: 0, authenticated_order: 0, funded: 0 });
    expect(diagnostics.verifiedRows).toBe(0);
  });

  it("counts one principal once, however many intents it files", () => {
    for (let i = 0; i < 40; i++) verified(store, "operator-a");
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.unmetCount).toBe(40);
    expect(internal.distinctVerifiedRequesters).toBe(1);
  });

  it("tracks verified requesters per class and cumulatively by strongest class", () => {
    verified(store, "a", { eventType: "intent.synthetic_query" });
    verified(store, "a", { eventType: "intent.composite_request" });
    verified(store, "c", { eventType: "intent.synthetic_query" });
    verified(store, "d", { eventType: "intent.atomic_session" });
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.byEvidenceClass).toEqual({ query: 2, authenticated_order: 2, funded: 0 });
    expect(internal.distinctVerifiedRequestersByClass).toEqual({ query: 2, authenticated_order: 2, funded: 0 });
    expect(internal.distinctVerifiedRequestersAtOrAbove).toEqual({ query: 3, authenticated_order: 2, funded: 0 });
    expect(internal.distinctVerifiedRequesters).toBe(3);
  });

  it("classes nl-query intents as query evidence", () => {
    persist(store, { eventType: "intent.synthetic_query" });
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.byEvidenceClass).toEqual({ query: 1, authenticated_order: 0, funded: 0 });
  });

  it("skips intents the server did not mark unmet, and malformed payloads", () => {
    persist(store, { fulfillmentPath: "auto" });
    persist(store, { unmet: [] });
    persist(store, { payloadOverride: { id: "broken" } });
    persist(store, { payloadOverride: "not even an object" });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals).toEqual([]);
    expect(diagnostics.notUnmet).toBe(2);
    expect(diagnostics.invalidPayload).toBe(2);
  });

  it("checks the reason first: known types only as CSD URIs, no_capability_type only as an exact slug", () => {
    expect(resolveCapabilityKey(HPLC, "no_kernel_offering")).toBe(HPLC);
    expect(resolveCapabilityKey("synthetic-hplc", "no_kernel_offering")).toBeNull();
    expect(resolveCapabilityKey("synthetic-gizmo", "no_capability_type")).toBe("proposed:synthetic-gizmo");
    // The capture point slugifies; the lens takes only an exact slug, never a respelling.
    expect(resolveCapabilityKey("Synthetic-Gizmo", "no_capability_type")).toBeNull();
    expect(resolveCapabilityKey("bad slug!", "no_capability_type")).toBeNull();
  });

  it("F3: never turns a CSD-shaped no_capability_type key into a signal key", () => {
    expect(resolveCapabilityKey(CSD_SHAPED_SECRET, "no_capability_type")).toBeNull();
    expect(resolveCapabilityKey(HPLC, "no_capability_type")).toBeNull();
    for (let i = 1; i <= 9; i++) {
      verified(store, `operator-${i}`, {
        unmet: [{ capabilityType: CSD_SHAPED_SECRET, reason: "no_capability_type", supplyCount: 0 }],
      });
    }
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals).toEqual([]);
    expect(diagnostics.invalidPayload).toBe(9);
  });

  it("drops a whole intent whose unmet list has any key that does not match its reason", () => {
    persist(store, {
      unmet: [
        { capabilityType: "synthetic-hplc", reason: "no_kernel_offering", supplyCount: 0 },
        { capabilityType: "synthetic-gizmo", reason: "no_capability_type", supplyCount: 0 },
      ],
    });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals).toEqual([]);
    expect(diagnostics.invalidPayload).toBe(1);
  });

  it("drops CSD URIs outside a given registered set, and leaves proposed slugs alone", () => {
    expect(resolveCapabilityKey(HPLC, "no_kernel_offering", new Set([WIDGET]))).toBeNull();
    expect(resolveCapabilityKey(HPLC, "no_kernel_offering", new Set([HPLC]))).toBe(HPLC);
    expect(resolveCapabilityKey("synthetic-gizmo", "no_capability_type", new Set())).toBe("proposed:synthetic-gizmo");
    persist(store, { unmet: [{ capabilityType: HPLC, reason: "no_kernel_offering", supplyCount: 0 }] });
    persist(store, { unmet: [{ capabilityType: WIDGET, reason: "no_capacity", supplyCount: 1 }] });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW, registeredCsdUris: new Set([HPLC]) });
    expect(signals.map((s) => s.capabilityKey)).toEqual([HPLC]);
    expect(diagnostics.unresolvedCapability).toBe(1);
  });

  it("F5: an API-key holder (authenticated_key) adds volume, never verified breadth", () => {
    for (let i = 0; i < 9; i++) persist(store, { actorType: "authenticated_key", actorId: `key-holder-${i}` });
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.unmetCount).toBe(9);
    expect(internal.distinctVerifiedRequesters).toBe(0);
  });

  it("computeForPeriod covers exactly one UTC calendar month", () => {
    persist(store, { timestamp: "2026-08-31T23:59:59.999Z" });
    persist(store, { timestamp: "2026-09-01T00:00:00.000Z" });
    persist(store, { timestamp: "2026-09-30T23:59:59.999Z" });
    persist(store, { timestamp: "2026-10-01T00:00:00.000Z" });
    const { signals, diagnostics } = lens.computeForPeriod("2026-09", { now: NOW });
    expect(signals[0]!.internal!.unmetCount).toBe(2);
    expect(diagnostics.outsideWindow).toBe(2);
    expect(signals[0]!.internal!.windowFrom).toBe(releasePeriodWindow("2026-09").from);
    expect(signals[0]!.internal!.windowTo).toBe(releasePeriodWindow("2026-09").to);
    expect(() => lens.computeForPeriod("2026-9")).toThrow();
  });

  it("counts a type listed twice in one intent once", () => {
    persist(store, {
      unmet: [
        { capabilityType: HPLC, reason: "no_kernel_offering", supplyCount: 0 },
        { capabilityType: HPLC, reason: "no_capacity", supplyCount: 2 },
      ],
    });
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.unmetCount).toBe(1);
    expect(internal.reasonHistogram).toEqual({ no_kernel_offering: 1 });
  });

  it("filters by the server timestamp window and rejects an inverted window", () => {
    persist(store, { timestamp: "2026-08-24T23:59:59.000Z" });
    persist(store, { timestamp: "2026-10-01T00:00:00.000Z" });
    persist(store, { timestamp: "2026-09-15T00:00:00.000Z" });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals[0]!.internal!.unmetCount).toBe(1);
    expect(diagnostics.outsideWindow).toBe(2);
    expect(() => lens.compute({ from: WINDOW.to, to: WINDOW.from })).toThrow();
  });

  it("merges private priors: prior-only keys, combined keys, and fails closed on a bad prior key", () => {
    persist(store);
    const prior: KitDemandPriorRef = {
      priorId: "kdp-synthetic-hplc",
      source: "desk_research",
      demandScore: 5,
      buildClass: "build",
      datasetDigest: `sha256:${"c".repeat(64)}`,
    };
    const priors = new Map<string, KitDemandPriorRef>([
      [HPLC, prior],
      [WIDGET, { ...prior, priorId: "kdp-synthetic-widget", buildClass: "package" }],
    ]);
    const { signals } = lens.compute({ ...WINDOW, now: NOW, priors });
    expect(signals.map((s) => s.capabilityKey)).toEqual([HPLC, WIDGET]);
    expect(signals[0]!.internal).toBeDefined();
    expect(signals[0]!.prior?.priorId).toBe("kdp-synthetic-hplc");
    expect(signals[1]!.internal).toBeUndefined();
    expect(signals[1]!.prior?.buildClass).toBe("package");
    const bad = new Map<string, KitDemandPriorRef>([["hplc", prior]]);
    expect(() => lens.compute({ ...WINDOW, now: NOW, priors: bad })).toThrow();
  });

  it("is deterministic: the same rows in any order give identical signals and digests", () => {
    const specs: Array<[string, RowSpec]> = [
      ["op-1", { timestamp: "2026-09-02T00:00:00.000Z", geographicRegion: "DE" }],
      ["op-2", { timestamp: "2026-09-03T00:00:00.000Z", budgetBand: "1k_10k", assuranceTier: 3 }],
      ["op-3", { timestamp: "2026-09-04T00:00:00.000Z", eventType: "intent.atomic_session", urgencyBand: "emergency" }],
    ];
    for (const [p, s] of specs) verified(store, p, s);
    const a = lens.compute({ ...WINDOW, now: NOW }).signals;
    const other = createStore({ dbPath: ":memory:", seed: false });
    for (const [p, s] of [...specs].reverse()) verified(other, p, s);
    const b = new UnmetDemandLens(other.repos).compute({ ...WINDOW, now: NOW }).signals;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(kitDemandSignalDigest(b[0]!)).toBe(kitDemandSignalDigest(a[0]!));
  });
});

describe("seam: UnmetDemandLens -> public release (PX-13 round-1 findings)", () => {
  const PERIOD = "2026-09";
  /** After September closed and its 24-hour grace passed. */
  const AFTER_CLOSE = "2026-10-05T00:00:00.000Z";
  const RELEASE_NOW = () => AFTER_CLOSE;
  const APPROVED: ReadonlySet<string> = new Set([HPLC, WIDGET]);
  let store: Store;
  let lens: UnmetDemandLens;
  const release = () => lens.computeForPeriod(PERIOD, { now: RELEASE_NOW }).signals;
  const project = (s: Parameters<typeof toPublicOpportunityAggregate>[0]) => toPublicOpportunityAggregate(s, PERIOD, APPROVED);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(AFTER_CLOSE));
    store = createStore({ dbPath: ":memory:", seed: false });
    lens = new UnmetDemandLens(store.repos);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a type private with 4 order-backed principals and publishes it at 5, labelled by period", () => {
    for (let i = 1; i <= 4; i++) verified(store, `operator-${i}`, { timestamp: `2026-09-1${i}T00:00:00.000Z` });
    expect(project(release()[0]!)).toBeNull();
    verified(store, "operator-5", { timestamp: "2026-09-19T06:00:00.000Z" });
    expect(project(release()[0]!)).toEqual({
      schema: "pcc.public-opportunity-aggregate.v1",
      capabilityType: HPLC,
      demandBand: "5-9",
      countedEvidence: "authenticated_order",
      period: PERIOD,
    });
  });

  it("F2: the verdict's sliding-window attack gets one canonical answer, and every other window is refused", () => {
    // One qualifying requester at 10 Sep 12:34:56.789, four on 11 Sep.
    verified(store, "operator-1", { timestamp: "2026-09-10T12:34:56.789Z" });
    for (let i = 2; i <= 5; i++) verified(store, `operator-${i}`, { timestamp: "2026-09-11T00:00:00.000Z" });
    const to = releasePeriodWindow(PERIOD).to;
    for (const from of ["2026-09-10T12:34:56.789Z", "2026-09-10T12:34:56.790Z", "2026-08-31T00:00:00.000Z"]) {
      const [slid] = lens.compute({ from, to, now: RELEASE_NOW }).signals;
      expect(() => project(slid!)).toThrow(/not release period/);
    }
    expect(project(release()[0]!)?.demandBand).toBe("5-9");
  });

  it("F2: refuses to release the month still in progress", () => {
    for (let i = 1; i <= 6; i++) verified(store, `operator-${i}`, { timestamp: "2026-09-10T00:00:00.000Z" });
    vi.setSystemTime(new Date("2026-09-20T00:00:00.000Z"));
    const early = lens.computeForPeriod(PERIOD, { now: () => "2026-09-20T00:00:00.000Z" }).signals;
    expect(() => project(early[0]!)).toThrow(/has not closed/);
  });

  it("F4, one unverified late intent: the private signal moves, the public release does not", () => {
    for (let i = 1; i <= 5; i++) verified(store, `operator-${i}`, { timestamp: `2026-09-1${i}T00:00:00.000Z` });
    const before = release();
    const releaseBefore = buildPublicRelease(before, PERIOD, APPROVED);
    persist(store, { actorType: "requestor", actorId: "late-unverified", timestamp: "2026-09-30T23:59:59.999Z" });
    verified(store, "late-querier", { eventType: "intent.synthetic_query", timestamp: "2026-09-30T23:00:00.000Z" });
    const after = release();
    expect(after[0]!.internal!.lastSeen).toBe("2026-09-30T23:59:59.999Z");
    expect(after[0]!.internal!.lastSeen).not.toBe(before[0]!.internal!.lastSeen);
    expect(buildPublicRelease(after, PERIOD, APPROVED)).toEqual(releaseBefore);
  });

  it("F3: a CSD-shaped no_capability_type key from 9 verified principals publishes nothing", () => {
    for (let i = 1; i <= 9; i++) {
      verified(store, `operator-${i}`, {
        unmet: [{ capabilityType: CSD_SHAPED_SECRET, reason: "no_capability_type", supplyCount: 0 }],
      });
    }
    const out = buildPublicRelease(release(), PERIOD, new Set([...APPROVED, CSD_SHAPED_SECRET]));
    expect(out.aggregates).toEqual([]);
  });

  it("F3: a registered type with enough demand still waits for the publisher's approval", () => {
    for (let i = 1; i <= 6; i++) verified(store, `operator-${i}`);
    const [signal] = release();
    expect(toPublicOpportunityAggregate(signal!, PERIOD, new Set([WIDGET]))).toBeNull();
    expect(toPublicOpportunityAggregate(signal!, PERIOD, new Set([HPLC]))?.capabilityType).toBe(HPLC);
  });

  it("keeps query-only demand private, even from many verified principals", () => {
    for (let i = 1; i <= 9; i++) verified(store, `querier-${i}`, { eventType: "intent.synthetic_query" });
    const [signal] = release();
    expect(signal!.internal!.distinctVerifiedRequesters).toBe(9);
    expect(project(signal!)).toBeNull();
  });

  it("publishes nothing from today's data shape, however large the volume", () => {
    for (let i = 0; i < 500; i++) persist(store, { actorType: "requestor", actorId: `body-${i}` });
    for (let i = 0; i < 50; i++) persist(store, { actorType: "authenticated_key", actorId: `key-${i}` });
    const [signal] = release();
    expect(signal!.internal!.unmetCount).toBe(550);
    expect(project(signal!)).toBeNull();
  });

  it("never publishes proposed types or prior-only keys, even when the approved set names them", () => {
    for (let i = 1; i <= 9; i++) {
      verified(store, `operator-${i}`, {
        unmet: [{ capabilityType: "synthetic-gizmo", reason: "no_capability_type", supplyCount: 0 }],
      });
    }
    const priors = new Map<string, KitDemandPriorRef>([
      [
        WIDGET,
        { priorId: "kdp-synthetic-widget", source: "desk_research", demandScore: 9, buildClass: "package", datasetDigest: `sha256:${"d".repeat(64)}` },
      ],
    ]);
    const { signals } = lens.computeForPeriod(PERIOD, { now: RELEASE_NOW, priors });
    expect(signals.map((s) => s.capabilityKey)).toEqual([WIDGET, "proposed:synthetic-gizmo"]);
    const out = buildPublicRelease(signals, PERIOD, new Set([WIDGET, "proposed:synthetic-gizmo"]));
    expect(out.aggregates).toEqual([]);
  });
});
