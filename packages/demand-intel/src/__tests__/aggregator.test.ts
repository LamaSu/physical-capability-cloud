import { describe, it, expect, beforeEach } from "vitest";
import { createStore, type Store } from "@pcc/store";
import { computeCompositionSignature, budgetToBand, type DemandEnvelope } from "@pcc/spec";
import { DemandAggregator } from "../aggregator.js";

/** Build an intent envelope and persist as an analytics_events row */
function persistIntent(store: Store, env: DemandEnvelope, eventType: string): void {
  const event = {
    id: env.id,
    eventType,
    category: "intent",
    timestamp: env.createdAt,
    actorId: env.requesterIdHash ?? env.originAgentId ?? "anonymous",
    actorType: env.originAgentId ? "agent" : "requestor",
    resourceType: "intent",
    resourceId: env.id,
    payload: env as unknown as Record<string, unknown>,
    hash: `sha256:${env.id}`,
    previousHash: null,
  };
  store.repos.analytics.insertEvent(event as Parameters<typeof store.repos.analytics.insertEvent>[0]);
}

describe("DemandAggregator", () => {
  let store: Store;
  let aggregator: DemandAggregator;

  beforeEach(() => {
    store = createStore({ dbPath: ":memory:", seed: false });
    aggregator = new DemandAggregator(store.repos);
  });

  it("round-trips 100 synthetic envelopes into a snapshot", () => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60 * 60_000);
    const windowEnd = now;

    for (let i = 0; i < 100; i++) {
      // Mix of three compositions
      const capabilities = i % 3 === 0 ? ["3d-printing"] : i % 3 === 1 ? ["cnc"] : ["hplc", "synthesis"];
      const sig = computeCompositionSignature(capabilities, []);
      const envelope: DemandEnvelope = {
        id: `e-${i}`,
        source: "requests_api",
        compositionSignature: sig,
        capabilityTypes: capabilities,
        summary: `synthetic-${i}`,
        budgetBand: budgetToBand(100 * (i + 1)),
        urgencyBand: "standard",
        geographicRegion: i % 2 === 0 ? "US" : "EU",
        requesterIdHash: `hash-${i % 20}`, // 20 unique requesters
        createdAt: new Date(windowStart.getTime() + i * 30_000).toISOString(),
      };
      persistIntent(store, envelope, "intent.composite_request");
    }

    const { state, summary } = aggregator.ingestWindow(
      windowStart.toISOString(),
      windowEnd.toISOString(),
    );
    expect(summary.envelopesIngested).toBe(100);
    expect(state.totalIntents).toBe(100);

    const snap = aggregator.snapshotFromState(
      state,
      "hour",
      windowStart.toISOString(),
      windowEnd.toISOString(),
    );

    expect(snap.totalIntents).toBe(100);
    expect(snap.window).toBe("hour");
    expect(snap.topCompositions.length).toBeGreaterThan(0);
    // 20 unique requesterIdHashes — within HLL's small-cardinality bounds
    expect(snap.uniqueRequestersApprox).toBeGreaterThan(15);
    expect(snap.uniqueRequestersApprox).toBeLessThan(30);
    // p50 should be in the middle range of budget mid-points
    expect(snap.budgetPercentiles.p50).toBeGreaterThan(0);
    // geoTopN populated for at least one composition
    const withGeo = snap.topCompositions.find((c) => c.geoTopN.length > 0);
    expect(withGeo).toBeDefined();
  });

  it("respects the window — out-of-window events are skipped", () => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - 60 * 60_000);
    const windowEnd = now;

    const sig = computeCompositionSignature(["3d-printing"], []);

    // In-window
    persistIntent(store, {
      id: "in-1",
      source: "requests_api",
      compositionSignature: sig,
      capabilityTypes: ["3d-printing"],
      summary: "in-window",
      budgetBand: "100_1k",
      urgencyBand: "standard",
      createdAt: new Date(windowStart.getTime() + 30 * 60_000).toISOString(),
    }, "intent.composite_request");

    // Out-of-window (yesterday)
    persistIntent(store, {
      id: "out-1",
      source: "requests_api",
      compositionSignature: sig,
      capabilityTypes: ["3d-printing"],
      summary: "out-window",
      budgetBand: "100_1k",
      urgencyBand: "standard",
      createdAt: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
    }, "intent.composite_request");

    const { state } = aggregator.ingestWindow(
      windowStart.toISOString(),
      windowEnd.toISOString(),
    );
    expect(state.totalIntents).toBe(1);
  });

  it("includes events from all three intent.* event types", () => {
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 60_000);
    const end = now;
    const sig = computeCompositionSignature(["x"], []);
    const baseTs = start.getTime() + 1000;

    persistIntent(store, {
      id: "comp", source: "requests_api", compositionSignature: sig,
      capabilityTypes: ["x"], summary: "comp", budgetBand: "under_100", urgencyBand: "standard",
      createdAt: new Date(baseTs).toISOString(),
    }, "intent.composite_request");

    persistIntent(store, {
      id: "atom", source: "negotiate_api", compositionSignature: sig,
      capabilityTypes: ["x"], summary: "atom", budgetBand: "under_100", urgencyBand: "standard",
      createdAt: new Date(baseTs + 1000).toISOString(),
    }, "intent.atomic_session");

    persistIntent(store, {
      id: "syn", source: "query_api_synthetic", compositionSignature: sig,
      capabilityTypes: ["x"], summary: "syn", budgetBand: "under_100", urgencyBand: "standard",
      createdAt: new Date(baseTs + 2000).toISOString(),
    }, "intent.synthetic_query");

    const { state } = aggregator.ingestWindow(start.toISOString(), end.toISOString());
    expect(state.totalIntents).toBe(3);
  });

  it("snapshot('hour') returns a snapshot with hour boundaries", () => {
    const sig = computeCompositionSignature(["x"], []);
    // Insert one in-window event (last hour)
    const last = new Date();
    last.setMinutes(30, 0, 0);
    const ts = new Date(last.getTime() - 30 * 60_000).toISOString();
    persistIntent(store, {
      id: "h1", source: "requests_api", compositionSignature: sig,
      capabilityTypes: ["x"], summary: "h1", budgetBand: "100_1k", urgencyBand: "standard",
      createdAt: ts,
    }, "intent.composite_request");

    const snap = aggregator.snapshot("hour");
    expect(snap.window).toBe("hour");
    expect(snap.windowStart).toBeTruthy();
    expect(snap.windowEnd).toBeTruthy();
  });
});
