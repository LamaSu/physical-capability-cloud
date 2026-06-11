/**
 * Capability Graph Search — gateway route tests.
 *
 * Covers:
 *   POST /api/capabilities/graph-search            — search, filters, optimisation, caps
 *   GET  /api/capabilities/graph-search/:searchId  — retrieve / 404
 *   GET  /api/capabilities/graph-stats             — counts + freshness
 *   POST /api/capabilities/graph/_dev/register-node — scaffold injection
 *   POST /api/capabilities/graph/_dev/register-edge — scaffold injection
 *
 * Strategy: bare Fastify with only graphSearchRoutes registered (mirrors
 * a2a-tasks.test.ts). Graph setup goes through the real _dev HTTP endpoints;
 * `_clearGraphSearchForTests` resets the in-memory stores in beforeEach.
 *
 * NOTE: POST graph-search returns 201 — it creates a retrievable search
 * proposal (consistent with the register-node/edge endpoints).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  graphSearchRoutes,
  _clearGraphSearchForTests,
  _seedGraphSearchForTests,
} from "../routes/graph-search.js";

// -----------------------------------------------------------------------------
// App bootstrap
// -----------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(graphSearchRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearGraphSearchForTests();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface NodeInput {
  capabilityId: string;
  capabilityType?: string;
  kernelId?: string;
  estimatedPriceUSD?: number;
  estimatedDurationMs?: number;
  assuranceTier?: 0 | 1 | 2 | 3;
  reputation?: number;
  location?: { lat: number; lng: number };
  available?: boolean;
  inputTypes?: string[];
  outputTypes?: string[];
}

function mkNode(over: NodeInput): Record<string, unknown> {
  return {
    capabilityType: "generic",
    kernelId: "k1",
    estimatedPriceUSD: 10,
    estimatedDurationMs: 100,
    assuranceTier: 1,
    reputation: 500,
    ...over,
  };
}

async function regNode(over: NodeInput) {
  const res = await app.inject({
    method: "POST",
    url: "/api/capabilities/graph/_dev/register-node",
    payload: mkNode(over),
  });
  expect(res.statusCode).toBe(201);
  return res;
}

async function regEdge(edge: {
  fromCapabilityId: string;
  toCapabilityId: string;
  capabilityTypeFlow: string;
  estimatedHandoffPriceUSD?: number;
  estimatedHandoffDurationMs?: number;
}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/capabilities/graph/_dev/register-edge",
    payload: edge,
  });
  expect(res.statusCode).toBe(201);
  return res;
}

async function doSearch(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/capabilities/graph-search",
    payload: body,
  });
}

const ids = (steps: Array<{ capabilityId: string }>) => steps.map((s) => s.capabilityId);

// -----------------------------------------------------------------------------
// 1. Empty graph
// -----------------------------------------------------------------------------

describe("POST /api/capabilities/graph-search — empty + validation", () => {
  it("returns 201 with empty options when no nodes are registered", async () => {
    const res = await doSearch({
      outcomeType: "widgets",
      budgetUSD: 1000,
      minAssuranceTier: 0,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toEqual([]);
    expect(body.outcomeType).toBe("widgets");
    expect(body.optimizedFor).toBe("price");
    expect(body.searchId).toBeTruthy();
  });

  // 2.
  it("rejects an invalid request body with 400", async () => {
    const res = await doSearch({ budgetUSD: "lots" }); // missing outcomeType, wrong type
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});

// -----------------------------------------------------------------------------
// 3-4. Single + multi-hop paths
// -----------------------------------------------------------------------------

describe("POST /api/capabilities/graph-search — path discovery", () => {
  // 3.
  it("finds a single-node path to a producer of the outcome type", async () => {
    await regNode({ capabilityId: "n1", capabilityType: "printer", outputTypes: ["widgets"] });
    const res = await doSearch({ outcomeType: "widgets", budgetUSD: 1000, minAssuranceTier: 0 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toHaveLength(1);
    expect(body.options[0].steps).toHaveLength(1);
    expect(body.options[0].steps[0].capabilityId).toBe("n1");
  });

  // 4.
  it("finds a 3-hop path A→B→C through registered edges", async () => {
    await regNode({ capabilityId: "A", outputTypes: ["t_ab"] }); // source
    await regNode({ capabilityId: "B", inputTypes: ["t_ab"], outputTypes: ["t_bc"] });
    await regNode({ capabilityId: "C", inputTypes: ["t_bc"], outputTypes: ["final"] });
    await regEdge({ fromCapabilityId: "A", toCapabilityId: "B", capabilityTypeFlow: "t_ab" });
    await regEdge({ fromCapabilityId: "B", toCapabilityId: "C", capabilityTypeFlow: "t_bc" });

    const res = await doSearch({ outcomeType: "final", budgetUSD: 1000, minAssuranceTier: 0 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toHaveLength(1);
    expect(ids(body.options[0].steps)).toEqual(["A", "B", "C"]);
  });

  // 5.
  it("excludes a path whose running total exceeds the budget", async () => {
    await regNode({ capabilityId: "A", estimatedPriceUSD: 10, outputTypes: ["t_ab"] });
    await regNode({ capabilityId: "B", estimatedPriceUSD: 20, inputTypes: ["t_ab"], outputTypes: ["t_bc"] });
    await regNode({ capabilityId: "C", estimatedPriceUSD: 30, inputTypes: ["t_bc"], outputTypes: ["final"] });
    await regEdge({ fromCapabilityId: "A", toCapabilityId: "B", capabilityTypeFlow: "t_ab" });
    await regEdge({ fromCapabilityId: "B", toCapabilityId: "C", capabilityTypeFlow: "t_bc" });

    // chain total = 60; budget 50 → no valid path
    const res = await doSearch({ outcomeType: "final", budgetUSD: 50, minAssuranceTier: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json().options).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 6-7. Tier + reputation filters
// -----------------------------------------------------------------------------

describe("POST /api/capabilities/graph-search — filters", () => {
  // 6.
  it("skips nodes below minAssuranceTier", async () => {
    await regNode({ capabilityId: "low", assuranceTier: 1, outputTypes: ["thing"] });
    await regNode({ capabilityId: "high", assuranceTier: 3, outputTypes: ["thing"] });
    const res = await doSearch({ outcomeType: "thing", budgetUSD: 1000, minAssuranceTier: 2 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toHaveLength(1);
    expect(body.options[0].steps[0].capabilityId).toBe("high");
    expect(body.options[0].minAssuranceTier).toBe(3);
  });

  // 7.
  it("skips nodes below minReputation", async () => {
    await regNode({ capabilityId: "rep-low", reputation: 300, outputTypes: ["thing"] });
    await regNode({ capabilityId: "rep-high", reputation: 800, outputTypes: ["thing"] });
    const res = await doSearch({
      outcomeType: "thing",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      minReputation: 500,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toHaveLength(1);
    expect(body.options[0].steps[0].capabilityId).toBe("rep-high");
  });
});

// -----------------------------------------------------------------------------
// 8-11. The four optimisation modes
// -----------------------------------------------------------------------------

describe("POST /api/capabilities/graph-search — optimizeFor", () => {
  // 8.
  it("optimizeFor='price' ranks cheaper paths first", async () => {
    await regNode({ capabilityId: "cheap", estimatedPriceUSD: 10, outputTypes: ["final"] });
    await regNode({ capabilityId: "pricey", estimatedPriceUSD: 50, outputTypes: ["final"] });
    const res = await doSearch({
      outcomeType: "final",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      optimizeFor: "price",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.optimizedFor).toBe("price");
    expect(body.options).toHaveLength(2);
    expect(body.options[0].steps[0].capabilityId).toBe("cheap");
    expect(body.options[0].totalPriceUSD).toBe(10);
    expect(body.options[0].totalPriceUSD).toBeLessThan(body.options[1].totalPriceUSD);
  });

  // 9.
  it("optimizeFor='speed' ranks faster paths first", async () => {
    await regNode({ capabilityId: "fast", estimatedDurationMs: 100, outputTypes: ["final"] });
    await regNode({ capabilityId: "slow", estimatedDurationMs: 500, outputTypes: ["final"] });
    const res = await doSearch({
      outcomeType: "final",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      optimizeFor: "speed",
    });
    const body = res.json();
    expect(body.optimizedFor).toBe("speed");
    expect(body.options[0].steps[0].capabilityId).toBe("fast");
    expect(body.options[0].totalDurationMs).toBe(100);
    expect(body.options[0].totalDurationMs).toBeLessThan(body.options[1].totalDurationMs);
  });

  // 10.
  it("optimizeFor='quality' ranks higher-assurance paths first", async () => {
    await regNode({ capabilityId: "tier1", assuranceTier: 1, reputation: 500, outputTypes: ["final"] });
    await regNode({ capabilityId: "tier3", assuranceTier: 3, reputation: 500, outputTypes: ["final"] });
    const res = await doSearch({
      outcomeType: "final",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      optimizeFor: "quality",
    });
    const body = res.json();
    expect(body.optimizedFor).toBe("quality");
    expect(body.options[0].steps[0].capabilityId).toBe("tier3");
    expect(body.options[0].minAssuranceTier).toBe(3);
  });

  // 11.
  it("optimizeFor='reputation' ranks higher-reputation paths first", async () => {
    await regNode({ capabilityId: "rep600", reputation: 600, outputTypes: ["final"] });
    await regNode({ capabilityId: "rep900", reputation: 900, outputTypes: ["final"] });
    const res = await doSearch({
      outcomeType: "final",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      optimizeFor: "reputation",
    });
    const body = res.json();
    expect(body.optimizedFor).toBe("reputation");
    expect(body.options[0].steps[0].capabilityId).toBe("rep900");
    expect(body.options[0].avgReputation).toBe(900);
  });
});

// -----------------------------------------------------------------------------
// 12-15. Caps + availability + location
// -----------------------------------------------------------------------------

describe("POST /api/capabilities/graph-search — caps + location + availability", () => {
  // 12.
  it("respects the maxDepth cap (no path longer than maxDepth)", async () => {
    await regNode({ capabilityId: "A", outputTypes: ["t_ab"] });
    await regNode({ capabilityId: "B", inputTypes: ["t_ab"], outputTypes: ["t_bc"] });
    await regNode({ capabilityId: "C", inputTypes: ["t_bc"], outputTypes: ["final"] });
    await regEdge({ fromCapabilityId: "A", toCapabilityId: "B", capabilityTypeFlow: "t_ab" });
    await regEdge({ fromCapabilityId: "B", toCapabilityId: "C", capabilityTypeFlow: "t_bc" });

    // path length is 3; maxDepth 2 → excluded
    const capped = await doSearch({ outcomeType: "final", budgetUSD: 1000, minAssuranceTier: 0, maxDepth: 2 });
    expect(capped.statusCode).toBe(201);
    expect(capped.json().options).toHaveLength(0);
    expect(capped.json().searchStats.cappedAtMaxDepth).toBe(true);

    // maxDepth 3 → the 3-node chain is allowed
    const ok = await doSearch({ outcomeType: "final", budgetUSD: 1000, minAssuranceTier: 0, maxDepth: 3 });
    expect(ok.json().options).toHaveLength(1);
  });

  // 13.
  it("respects the location radius (haversine)", async () => {
    await regNode({ capabilityId: "near", location: { lat: 0, lng: 0 }, outputTypes: ["thing"] });
    await regNode({ capabilityId: "far", location: { lat: 10, lng: 10 }, outputTypes: ["thing"] });
    const res = await doSearch({
      outcomeType: "thing",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      location: { lat: 0, lng: 0, radiusKm: 50 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toHaveLength(1);
    expect(body.options[0].steps[0].capabilityId).toBe("near");
  });

  // 14.
  it("returns at most topN paths", async () => {
    _seedGraphSearchForTests({
      nodes: [
        mkNode({ capabilityId: "p10", estimatedPriceUSD: 10, outputTypes: ["final"] }) as never,
        mkNode({ capabilityId: "p20", estimatedPriceUSD: 20, outputTypes: ["final"] }) as never,
        mkNode({ capabilityId: "p30", estimatedPriceUSD: 30, outputTypes: ["final"] }) as never,
        mkNode({ capabilityId: "p40", estimatedPriceUSD: 40, outputTypes: ["final"] }) as never,
      ],
    });
    const res = await doSearch({
      outcomeType: "final",
      budgetUSD: 1000,
      minAssuranceTier: 0,
      optimizeFor: "price",
      topN: 2,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.options).toHaveLength(2);
    expect(body.options[0].totalPriceUSD).toBe(10);
    expect(body.options[1].totalPriceUSD).toBe(20);
  });

  // 15.
  it("skips unavailable nodes", async () => {
    await regNode({ capabilityId: "off", available: false, outputTypes: ["gadgets"] });
    const res = await doSearch({ outcomeType: "gadgets", budgetUSD: 1000, minAssuranceTier: 0 });
    expect(res.statusCode).toBe(201);
    expect(res.json().options).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 16-17. GET retrieval
// -----------------------------------------------------------------------------

describe("GET /api/capabilities/graph-search/:searchId", () => {
  // 16.
  it("retrieves a previously-run search", async () => {
    const created = await doSearch({ outcomeType: "x", budgetUSD: 1000, minAssuranceTier: 0 });
    const searchId = created.json().searchId;
    const res = await app.inject({
      method: "GET",
      url: `/api/capabilities/graph-search/${searchId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().searchId).toBe(searchId);
    expect(res.json().outcomeType).toBe("x");
  });

  // 17.
  it("returns 404 for an unknown searchId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/graph-search/does-not-exist",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("search_not_found");
  });
});

// -----------------------------------------------------------------------------
// 18-20. Stats + scaffold registration
// -----------------------------------------------------------------------------

describe("graph-stats + _dev registration", () => {
  // 18.
  it("graph-stats reports counts after node + edge registrations", async () => {
    await regNode({ capabilityId: "n1", capabilityType: "alpha", outputTypes: ["mid"] });
    await regNode({ capabilityId: "n2", capabilityType: "beta", inputTypes: ["mid"], outputTypes: ["final"] });
    await regEdge({ fromCapabilityId: "n1", toCapabilityId: "n2", capabilityTypeFlow: "mid" });

    const res = await app.inject({ method: "GET", url: "/api/capabilities/graph-stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodeCount).toBe(2);
    expect(body.edgeCount).toBe(1);
    expect(body.capabilityTypeCount).toBe(2);
    expect(body.capabilityTypes).toEqual(["alpha", "beta"]);
    expect(body.lastRebuiltAt).not.toBeNull();
  });

  // 19.
  it("_dev/register-node persists a node visible in stats and findable by search", async () => {
    await regNode({ capabilityId: "solo", capabilityType: "gizmo", outputTypes: ["gizmos"] });

    const stats = await app.inject({ method: "GET", url: "/api/capabilities/graph-stats" });
    expect(stats.json().nodeCount).toBe(1);
    expect(stats.json().capabilityTypes).toContain("gizmo");

    const res = await doSearch({ outcomeType: "gizmos", budgetUSD: 1000, minAssuranceTier: 0 });
    expect(res.json().options).toHaveLength(1);
    expect(res.json().options[0].steps[0].capabilityId).toBe("solo");
  });

  // 20.
  it("_dev/register-edge persists an edge that enables a multi-hop path", async () => {
    await regNode({ capabilityId: "A", outputTypes: ["mid"] }); // source
    await regNode({ capabilityId: "B", inputTypes: ["mid"], outputTypes: ["final"] }); // not a source

    // No edge yet → B is unreachable, no path produces "final"
    const before = await doSearch({ outcomeType: "final", budgetUSD: 1000, minAssuranceTier: 0 });
    expect(before.json().options).toHaveLength(0);

    await regEdge({ fromCapabilityId: "A", toCapabilityId: "B", capabilityTypeFlow: "mid" });

    const after = await doSearch({ outcomeType: "final", budgetUSD: 1000, minAssuranceTier: 0 });
    expect(after.json().options).toHaveLength(1);
    expect(ids(after.json().options[0].steps)).toEqual(["A", "B"]);
  });
});
