/**
 * Tests for /api/aggregator/* routes.
 *
 * Strategy: spin up a minimal Fastify instance, initialise an in-memory
 * @pcc/store, register only aggregatorRoutes. Auth-gated ingest routes
 * are skipped (covered by spec §) — public search + receipts are tested
 * end-to-end.
 *
 * Invoke route is partially tested: we mock fetch globally to avoid
 * network IO.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import {
  aggregatorRoutes,
  getAggregatorRegistry,
  _resetAggregatorRegistryForTests,
} from "../routes/aggregator/index.js";
import { initStore, closeStore } from "../db.js";
import {
  type IndexedTool,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";

const SHA = "sha256:" + "a".repeat(64);

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "test-tool-1",
    cid: SHA,
    version: "1.0.0",
    source: {
      type: "mcp-directory",
      url: "https://mcp.example.com",
      fetchedAt: "2026-05-23T00:00:00.000Z",
    },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://api.example.com/echo",
    skills: ["data.echo"],
    domains: ["test"],
    features: [],
    inputSchema: { type: "object" },
    description: "echo back the input",
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

describe("aggregator routes", () => {
  beforeEach(() => {
    _resetAggregatorRegistryForTests();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterEach(() => {
    closeStore();
    vi.restoreAllMocks();
  });

  it("GET /tools/search returns empty when registry is empty", async () => {
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/api/aggregator/tools/search",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tools).toEqual([]);
    expect(body.total).toBe(0);
    await app.close();
  });

  it("GET /tools/search returns matching tools with filters", async () => {
    const reg = getAggregatorRegistry();
    reg.upsert(makeTool({ id: "a", description: "summarize text" }));
    reg.upsert(
      makeTool({
        id: "b",
        description: "translate text",
        skills: ["nlp.translate"],
      }),
    );

    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/api/aggregator/tools/search?q=translate",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].id).toBe("b");
    await app.close();
  });

  it("POST /invoke/:toolId returns 404 for unknown tool", async () => {
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/aggregator/invoke/missing-tool",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "tool_not_found" });
    await app.close();
  });

  it("POST /invoke/:toolId is blocked for quarantined tools", async () => {
    const reg = getAggregatorRegistry();
    reg.upsert(makeTool({ id: "bad", trustTier: TrustTier.QUARANTINED }));
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/aggregator/invoke/bad",
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("tool_quarantined");
    await app.close();
  });

  it("POST /invoke/:toolId proxies and signs a receipt", async () => {
    const reg = getAggregatorRegistry();
    reg.upsert(makeTool({ id: "echo-1" }));
    // Mock the upstream fetch.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ echoed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/aggregator/invoke/echo-1",
      payload: { args: { msg: "hi" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receiptCID).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.effectiveDccClass).toBe("DCC1");
    expect(body.result).toEqual({ echoed: true });
    expect(body.evaluation.verdict).toBe("valid");
    expect(fetchSpy).toHaveBeenCalledOnce();
    await app.close();
  });

  it("POST /invoke/:toolId auto-downgrades DCC3 without artifacts to DCC1", async () => {
    const reg = getAggregatorRegistry();
    reg.upsert(makeTool({ id: "t1" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/aggregator/invoke/t1",
      payload: { requestedDccClass: "DCC3" },
    });
    const body = res.json();
    expect(body.requestedDccClass).toBe("DCC3");
    expect(body.effectiveDccClass).toBe("DCC1");
    expect(body.downgraded).toBe(true);
    expect(body.downgradeReason).toBeTruthy();
    await app.close();
  });

  it("GET /receipts/:cid returns 404 for missing CID", async () => {
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/api/aggregator/receipts/sha256:doesnotexist",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("POST /invoke -> GET /receipts/:cid round-trip", async () => {
    const reg = getAggregatorRegistry();
    reg.upsert(makeTool({ id: "round-trip" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const invoke = await app.inject({
      method: "POST",
      url: "/api/aggregator/invoke/round-trip",
      payload: { args: {} },
    });
    const cid = invoke.json().receiptCID;
    const lookup = await app.inject({
      method: "GET",
      url: `/api/aggregator/receipts/${encodeURIComponent(cid)}`,
    });
    expect(lookup.statusCode).toBe(200);
    const body = lookup.json();
    expect(body.receipt.receiptCID).toBe(cid);
    expect(body.evaluation.verdict).toBe("valid");
    await app.close();
  });

  it("POST /ingest/mcp without auth returns 401", async () => {
    const app = Fastify();
    await app.register(aggregatorRoutes);
    const res = await app.inject({
      method: "POST",
      url: "/api/aggregator/ingest/mcp",
      payload: { url: "https://x" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
