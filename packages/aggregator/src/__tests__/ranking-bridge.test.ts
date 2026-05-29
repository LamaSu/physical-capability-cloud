import { describe, it, expect, beforeEach } from "vitest";
import { IndexedToolRegistry } from "../registry.js";
import { RegistryRankerBridge, createRegistryRanker } from "../ranking-bridge.js";
import {
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "pcc-native",
      url: "https://example.com/x",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/api",
    skills: ["nlp.summarization"],
    domains: ["nlp"],
    features: [],
    inputSchema: {},
    description: "summarize documents",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...overrides,
  };
}

describe("RegistryRankerBridge", () => {
  let registry: IndexedToolRegistry;
  let bridge: RegistryRankerBridge;

  beforeEach(() => {
    registry = new IndexedToolRegistry();
    registry.upsert(
      makeTool({ id: "a", description: "summarize documents into abstracts" }),
    );
    registry.upsert(
      makeTool({ id: "b", description: "perform CNC milling operations" }),
    );
    bridge = createRegistryRanker(registry);
  });

  it("ranks tools against a query and returns top-K hits", async () => {
    const hits = await bridge.rank({ q: "summarize document", topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.tool.id)).toContain("a");
  });

  it("upsert mirrors into the ranker", async () => {
    await bridge.upsert(
      makeTool({ id: "c", description: "summarize summarize summarize" }),
    );
    expect(registry.count()).toBe(3);
    const hits = await bridge.rank({ q: "summarize" });
    expect(hits.map((h) => h.tool.id)).toContain("c");
  });

  it("remove mirrors into the ranker", async () => {
    expect(await bridge.remove("a")).toBe(true);
    const hits = await bridge.rank({ q: "summarize" });
    expect(hits.map((h) => h.tool.id)).not.toContain("a");
  });

  it("rankerInstance exposes underlying HybridRanker", () => {
    expect(bridge.rankerInstance.size()).toBe(2);
  });

  it("createRegistryRanker reseeds from registry state", async () => {
    // Seed registry first, then create the bridge — proves reseeding works.
    const reg = new IndexedToolRegistry();
    reg.upsert(makeTool({ id: "x", description: "alpha bravo charlie" }));
    reg.upsert(makeTool({ id: "y", description: "delta echo foxtrot" }));
    const br = createRegistryRanker(reg);
    expect(br.rankerInstance.size()).toBe(2);
    const hits = await br.rank({ q: "alpha" });
    expect(hits.length).toBeGreaterThan(0);
  });
});
