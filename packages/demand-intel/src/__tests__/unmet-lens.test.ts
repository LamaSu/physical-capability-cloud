/**
 * UnmetDemandLens (R44, D3). SYNTHETIC rows only. The last block is the seam
 * test: lens output fed straight into @pcc/spec's public projection.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createStore, type Store } from "@pcc/store";
import {
  computeCompositionSignature,
  kitDemandSignalDigest,
  toPublicOpportunityAggregate,
  type DemandEnvelope,
  type KitDemandPriorRef,
  type UnmetCapability,
} from "@pcc/spec";
import { UnmetDemandLens, resolveCapabilityKey, VERIFIED_ACTOR_TYPE } from "../unmet-lens.js";

const HPLC = "pcc://capabilities/synthetic-hplc/v1";
const WIDGET = "pcc://capabilities/synthetic-widget/v1";
const WINDOW = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" };
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
      urgencyBand: "standard",
      createdAt: spec.createdAt ?? "2026-09-10T00:00:00.000Z",
      ...(spec.fulfillmentPath === undefined ? { fulfillmentPath: "unfulfilled" } : { fulfillmentPath: spec.fulfillmentPath }),
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

  it("counts a server-captured unmet intent with its class, reason, band and server timestamp", () => {
    persist(store, { timestamp: "2026-09-12T08:00:00.000Z", createdAt: "1999-01-01T00:00:00.000Z", budgetBand: "1k_10k" });
    const { signals } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals).toHaveLength(1);
    const internal = signals[0]!.internal!;
    expect(signals[0]!.capabilityKey).toBe(HPLC);
    expect(internal.unmetCount).toBe(1);
    expect(internal.byEvidenceClass).toEqual({ funded: 0, authenticated_order: 1, query: 0 });
    expect(internal.reasonHistogram).toEqual({ no_kernel_offering: 1 });
    expect(internal.budgetBandHistogram).toEqual({ "1k_10k": 1 });
    // The caller-influenced createdAt (1999) is ignored; the server row timestamp is used.
    expect(internal.firstSeen).toBe("2026-09-12T08:00:00.000Z");
    expect(internal.lastSeen).toBe("2026-09-12T08:00:00.000Z");
  });

  it("gives today's rows zero verified breadth: body-supplied actors never count", () => {
    for (let i = 0; i < 50; i++) persist(store, { actorType: "requestor", actorId: `body-actor-${i}` });
    for (let i = 0; i < 50; i++) persist(store, { eventType: "intent.atomic_session", actorType: "agent", actorId: `agent-${i}` });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals[0]!.internal!.unmetCount).toBe(100);
    expect(signals[0]!.internal!.distinctVerifiedRequesters).toBe(0);
    expect(diagnostics.verifiedRows).toBe(0);
  });

  it("counts one principal once, however many intents it files", () => {
    for (let i = 0; i < 40; i++) verified(store, "operator-a");
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.unmetCount).toBe(40);
    expect(internal.distinctVerifiedRequesters).toBe(1);
  });

  it("classes nl-query intents as query evidence", () => {
    persist(store, { eventType: "intent.synthetic_query" });
    const internal = lens.compute({ ...WINDOW, now: NOW }).signals[0]!.internal!;
    expect(internal.byEvidenceClass).toEqual({ funded: 0, authenticated_order: 0, query: 1 });
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

  it("requires known types as CSD URIs and turns only no_capability_type slugs into proposed keys", () => {
    expect(resolveCapabilityKey(HPLC, "no_kernel_offering")).toBe(HPLC);
    expect(resolveCapabilityKey("synthetic-hplc", "no_kernel_offering")).toBeNull();
    expect(resolveCapabilityKey("Synthetic-Gizmo", "no_capability_type")).toBe("proposed:synthetic-gizmo");
    expect(resolveCapabilityKey("bad slug!", "no_capability_type")).toBeNull();
    persist(store, {
      unmet: [
        { capabilityType: "synthetic-hplc", reason: "no_kernel_offering", supplyCount: 0 },
        { capabilityType: "synthetic-gizmo", reason: "no_capability_type", supplyCount: 0 },
      ],
    });
    const { signals, diagnostics } = lens.compute({ ...WINDOW, now: NOW });
    expect(signals.map((s) => s.capabilityKey)).toEqual(["proposed:synthetic-gizmo"]);
    expect(diagnostics.unresolvedCapability).toBe(1);
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
    persist(store, { timestamp: "2026-08-31T23:59:59.000Z" });
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
      ["op-1", { timestamp: "2026-09-02T00:00:00.000Z" }],
      ["op-2", { timestamp: "2026-09-03T00:00:00.000Z", budgetBand: "1k_10k" }],
      ["op-3", { timestamp: "2026-09-04T00:00:00.000Z", eventType: "intent.atomic_session" }],
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

describe("seam: UnmetDemandLens -> toPublicOpportunityAggregate", () => {
  let store: Store;
  let lens: UnmetDemandLens;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:", seed: false });
    lens = new UnmetDemandLens(store.repos);
  });

  it("keeps a type private with 4 verified principals and publishes it at 5", () => {
    for (let i = 1; i <= 4; i++) verified(store, `operator-${i}`, { timestamp: `2026-09-1${i}T00:00:00.000Z` });
    expect(toPublicOpportunityAggregate(lens.compute({ ...WINDOW, now: NOW }).signals[0]!)).toBeNull();
    verified(store, "operator-5", { timestamp: "2026-09-19T06:00:00.000Z" });
    expect(toPublicOpportunityAggregate(lens.compute({ ...WINDOW, now: NOW }).signals[0]!)).toEqual({
      schema: "pcc.public-opportunity-aggregate.v0",
      capabilityType: HPLC,
      demandBand: "5+",
      asOf: "2026-09-19",
    });
  });

  it("publishes nothing from today's data shape, however large the volume", () => {
    for (let i = 0; i < 500; i++) persist(store, { actorType: "requestor", actorId: `body-${i}` });
    const [signal] = lens.compute({ ...WINDOW, now: NOW }).signals;
    expect(signal!.internal!.unmetCount).toBe(500);
    expect(toPublicOpportunityAggregate(signal!)).toBeNull();
  });

  it("never publishes proposed types or prior-only keys", () => {
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
    const { signals } = lens.compute({ ...WINDOW, now: NOW, priors });
    expect(signals.map((s) => s.capabilityKey)).toEqual([WIDGET, "proposed:synthetic-gizmo"]);
    for (const s of signals) expect(toPublicOpportunityAggregate(s)).toBeNull();
  });
});
