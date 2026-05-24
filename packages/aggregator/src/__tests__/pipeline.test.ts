/**
 * Tests for the 6-stage pipeline.
 *
 * Uses a mock SourceAdapter that returns a fixed IndexedTool[] so the
 * test exercises every stage independent of network IO.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";
import { IndexedToolRegistry } from "../registry.js";
import { computeJsonHash, computeToolCid, runPipeline } from "../pipeline.js";
import type { SourceAdapter } from "../types.js";

const SHA = "sha256:" + "0".repeat(64);

function makeDraft(id: string, overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id,
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.directory/x",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://example.com/api",
    skills: ["data.fetch"],
    domains: [],
    features: [],
    inputSchema: { type: "object" },
    description: "fetch data",
    actionClass: "read",
    assuranceCeiling: undefined as unknown as DigitalCaptureClass,
    trustTier: undefined as unknown as TrustTier,
    knownVulns: [],
    lastFetchedAt: "",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [],
    hostingPeers: [],
    ...overrides,
  };
}

function makeMockAdapter(out: IndexedTool[]): SourceAdapter {
  return {
    id: "mock",
    sourceType: "mcp-directory",
    fetch: async () => out,
  };
}

describe("runPipeline — happy path", () => {
  let reg: IndexedToolRegistry;
  beforeEach(() => {
    reg = new IndexedToolRegistry();
  });

  it("runs all 6 stages and publishes to the registry", async () => {
    const adapter = makeMockAdapter([makeDraft("t-1"), makeDraft("t-2")]);
    const res = await runPipeline(
      adapter,
      { url: "https://test/" },
      reg,
    );
    expect(res.stages.map((s) => s.stage)).toEqual([
      "discover",
      "fetch",
      "transform",
      "enrich",
      "verify",
      "publish",
    ]);
    expect(res.published).toHaveLength(2);
    expect(reg.count()).toBe(2);
  });

  it("transform fills ingestedAt + lastFetchedAt + defaults", async () => {
    const adapter = makeMockAdapter([makeDraft("t-1")]);
    const res = await runPipeline(adapter, { url: "u" }, reg);
    const tool = res.published[0]!;
    expect(tool.ingestedAt).toBeTruthy();
    expect(tool.lastFetchedAt).toBeTruthy();
    expect(tool.knownVulns).toEqual([]);
    expect(tool.driftAlerts).toEqual([]);
    expect(tool.schemaHashHistory).toHaveLength(1);
  });

  it("enrich populates trustTier + assuranceCeiling from source.type", async () => {
    const adapter = makeMockAdapter([
      makeDraft("t-1", {
        source: {
          type: "common-crawl",
          url: "https://cc",
          fetchedAt: "2026-05-23T00:00:00.000Z",
        },
      }),
    ]);
    const res = await runPipeline(adapter, { url: "u" }, reg);
    const tool = res.published[0]!;
    expect(tool.trustTier).toBe(TrustTier.UNTRUSTED);
    expect(tool.assuranceCeiling).toBe(DigitalCaptureClass.DCC1);
  });

  it("enrich computes a real cid (not the placeholder)", async () => {
    const adapter = makeMockAdapter([makeDraft("t-1")]);
    const res = await runPipeline(adapter, { url: "u" }, reg);
    const tool = res.published[0]!;
    expect(tool.cid).not.toBe(SHA);
    expect(tool.cid).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("publishToRegistry:false skips writing to registry", async () => {
    const adapter = makeMockAdapter([makeDraft("t-1")]);
    const res = await runPipeline(adapter, { url: "u" }, reg, {
      publishToRegistry: false,
    });
    expect(res.published).toHaveLength(1);
    expect(reg.count()).toBe(0);
  });

  it("runVerify:true adds a default PASS vetReport", async () => {
    const adapter = makeMockAdapter([makeDraft("t-1")]);
    const res = await runPipeline(adapter, { url: "u" }, reg, {
      runVerify: true,
    });
    expect(res.published[0]?.vetReport?.verdict).toBe("PASS");
  });
});

describe("runPipeline — failure handling", () => {
  it("adapter throw lands as top-level error + zero published", async () => {
    const adapter: SourceAdapter = {
      id: "broken",
      sourceType: "mcp-directory",
      fetch: async () => {
        throw new Error("upstream down");
      },
    };
    const reg = new IndexedToolRegistry();
    const res = await runPipeline(adapter, { url: "u" }, reg);
    expect(res.published).toHaveLength(0);
    expect(res.errors[0]).toContain("upstream down");
    expect(reg.count()).toBe(0);
  });
});

describe("computeToolCid + computeJsonHash", () => {
  it("computeJsonHash is stable for the same input", () => {
    const a = computeJsonHash({ a: 1, b: [1, 2] });
    const b = computeJsonHash({ a: 1, b: [1, 2] });
    expect(a).toBe(b);
  });

  it("computeToolCid changes when stable fields change", () => {
    const tool = makeDraft("t-1", { skills: ["a"] });
    const tool2 = { ...tool, skills: ["b"] };
    expect(computeToolCid(tool)).not.toBe(computeToolCid(tool2));
  });
});
