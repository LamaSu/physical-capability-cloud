import { describe, it, expect } from "vitest";
import { PhaseOneReplicator } from "../replicator-stub.js";
import type { ServerContext } from "../server.js";
import {
  gCounterValue,
  taggedFractionValue,
} from "../crdts/index.js";
import type { IndexedTool } from "@pcc/spec";
import { DigitalCaptureClass, TrustTier } from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);
const ctx: ServerContext = {
  regionId: "us-east-1",
  meshId: "us-east-1-mesh-a",
  serverId: "test",
  defaultNamespaceId: "pcc-public",
  role: "leader",
};

function makeTool(over: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-x",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.directory/x",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com",
    skills: [],
    domains: [],
    features: [],
    inputSchema: {},
    description: "test",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...over,
  };
}

describe("PhaseOneReplicator", () => {
  it("onUpsert increments tools-tracked + upsert-events", () => {
    const r = new PhaseOneReplicator(ctx);
    r.onUpsert(makeTool({ id: "a" }));
    r.onUpsert(makeTool({ id: "b" }));
    r.onUpsert(makeTool({ id: "a" })); // re-upsert
    const stats = r.getStats();
    expect(stats.toolsTracked).toBe(2);
    expect(stats.upsertEvents).toBe(3);
  });

  it("seeds the G-Counter from the tool's scalar invocationCount on first sight", () => {
    const r = new PhaseOneReplicator(ctx);
    r.onUpsert(makeTool({ id: "a", invocationCount: 100 }));
    const slot = r.getSlot("a")!;
    expect(gCounterValue(slot.invocationCount)).toBe(100);
  });

  it("does NOT re-seed the G-Counter on subsequent upserts", () => {
    const r = new PhaseOneReplicator(ctx);
    r.onUpsert(makeTool({ id: "a", invocationCount: 100 }));
    r.onUpsert(makeTool({ id: "a", invocationCount: 99999 }));
    expect(gCounterValue(r.getSlot("a")!.invocationCount)).toBe(100);
  });

  it("onRemove drops the slot + increments remove-events", () => {
    const r = new PhaseOneReplicator(ctx);
    r.onUpsert(makeTool({ id: "a" }));
    r.onRemove("a");
    expect(r.getSlot("a")).toBeUndefined();
    expect(r.getStats().removeEvents).toBe(1);
  });

  it("recordInvocation updates all four CRDT slots", () => {
    const r = new PhaseOneReplicator(ctx);
    r.recordInvocation("a", {
      success: true,
      latencyMs: 120,
      invokedAt: "2026-05-25T00:00:00.000Z",
    });
    r.recordInvocation("a", {
      success: false,
      latencyMs: 80,
      invokedAt: "2026-05-25T00:01:00.000Z",
    });
    const slot = r.getSlot("a")!;
    expect(gCounterValue(slot.invocationCount)).toBe(2);
    const succ = taggedFractionValue(slot.successCounts);
    expect(succ.numerator).toBe(1);
    expect(succ.denominator).toBe(2);
    const lat = taggedFractionValue(slot.latencySums);
    expect(lat.numerator).toBe(200);
    expect(lat.denominator).toBe(2);
    expect(slot.lastInvokedAt.value).toBe("2026-05-25T00:01:00.000Z");
  });

  it("pending-deltas counter advances on every state-changing op", () => {
    const r = new PhaseOneReplicator(ctx);
    r.onUpsert(makeTool({ id: "a" }));
    r.recordInvocation("a", { success: true, latencyMs: 10 });
    r.onRemove("a");
    expect(r.getStats().pendingDeltas).toBe(3);
  });

  it("start + stop resolve without error (Phase 1 no-ops)", async () => {
    const r = new PhaseOneReplicator(ctx);
    await expect(r.start()).resolves.toBeUndefined();
    await expect(r.stop()).resolves.toBeUndefined();
  });

  it("tools tracked under different regions use the configured replicaId", () => {
    const usReplicator = new PhaseOneReplicator(ctx);
    const euReplicator = new PhaseOneReplicator({
      ...ctx,
      regionId: "eu-west-1",
      meshId: "eu-west-1-mesh-a",
    });
    usReplicator.recordInvocation("t", { success: true, latencyMs: 50 });
    euReplicator.recordInvocation("t", { success: true, latencyMs: 200 });
    expect(
      Object.keys(usReplicator.getSlot("t")!.invocationCount.slots),
    ).toEqual(["us-east-1:us-east-1-mesh-a"]);
    expect(
      Object.keys(euReplicator.getSlot("t")!.invocationCount.slots),
    ).toEqual(["eu-west-1:eu-west-1-mesh-a"]);
  });
});
