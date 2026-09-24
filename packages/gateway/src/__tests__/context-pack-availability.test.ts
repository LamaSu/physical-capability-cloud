/**
 * Board N34 (reviewer-n34-a, reviewer-n34-c): the agent context pack listed the routes that now
 * answer 501 not_available as live endpoints, so an agent following it walked into refusals.
 * The pack lists them apart ("Not available on this gateway (demo only)" and
 * `demoOnlyEndpoints`). This test asks the N34 route families themselves which routes refuse
 * (PCC_DEMO_ROUTES unset), so neither list can drift from the routes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const norm = (method: string, path: string) => `${method} ${path.replace(/:[A-Za-z_]+/g, ":_").replace(/\/$/, "")}`;

let refused: Set<string>;
let markdown: string;
let pack: any;
const saved = { demo: process.env.PCC_DEMO_ROUTES, db: process.env.PCC_DB_PATH };

beforeAll(async () => {
  delete process.env.PCC_DEMO_ROUTES;
  process.env.PCC_DB_PATH = ":memory:";
  const db = await import("../db.js");
  db.initStore({ seed: true });
  const families: Array<(app: FastifyInstance) => Promise<void>> = [
    (await import("../routes/agents.js")).agentRoutes,
    (await import("../routes/discover.js")).discoverRoutes,
    (await import("../routes/logistics.js")).logisticsRoutes,
    (await import("../routes/marketplace.js")).marketplaceRoutes,
    (await import("../routes/registry.js")).registryRoutes,
    (await import("../routes/rewards.js")).rewardRoutes,
    (await import("../routes/spaces.js")).spaceRoutes,
    (await import("../routes/orchestrator.js")).orchestratorRoutes,
    (await import("../routes/protocols.js")).protocolRoutes,
    (await import("../routes/swf.js")).swfRoutes,
  ];
  refused = new Set();
  for (const family of families) {
    const routes: Array<{ method: string; url: string }> = [];
    const app = Fastify({ logger: false });
    app.addHook("onRoute", (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD" && m !== "OPTIONS") routes.push({ method: m, url: r.url });
    });
    await app.register(family);
    await app.ready();
    for (const r of routes) {
      const write = r.method === "POST" || r.method === "PUT" || r.method === "PATCH";
      const res = await app.inject({ method: r.method as any, url: r.url.replace(/:[A-Za-z_]+/g, "probe-x"), ...(write ? { payload: {} } : {}) });
      if (res.statusCode === 501 && res.json().error === "not_available") refused.add(norm(r.method, r.url));
    }
    await app.close();
  }

  const { contextPackRoutes } = await import("../routes/context-pack.js");
  const app = Fastify({ logger: false });
  await app.register(contextPackRoutes);
  await app.ready();
  markdown = (await app.inject({ method: "GET", url: "/agent-context-pack" })).body;
  pack = (await app.inject({ method: "GET", url: "/agent-context-pack.json" })).json();
  await app.close();
}, 60_000);

afterAll(async () => {
  (await import("../db.js")).closeStore();
  if (saved.demo === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = saved.demo;
  if (saved.db === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = saved.db;
});

const ROW = /^\| (GET|POST|PUT|PATCH|DELETE) \| (\/[^ |]*) \|/gm;
const rowsOf = (text: string) => [...text.matchAll(ROW)].map((m) => norm(m[1]!, m[2]!));
const DEMO_HEADING = "### Not available on this gateway (demo only)";

describe("agent context pack: routes that refuse are never listed as available", () => {
  it("the N34 families refuse routes with demo off (the probe works)", () => {
    expect(refused.size).toBeGreaterThan(50);
    expect(refused.has("GET /api/logistics/shipments")).toBe(true);
    expect(refused.has("GET /api/swf/summary")).toBe(false);
  });

  it("NEGATIVE: no markdown row above the demo-only list refuses", () => {
    const [available] = markdown.split(DEMO_HEADING);
    const listed = rowsOf(available!);
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.filter((r) => refused.has(r))).toEqual([]);
  });

  it("every row in the markdown demo-only list does refuse, and the JSON pack lists the same rows", () => {
    const demoPart = markdown.split(DEMO_HEADING)[1]!.split("## Data Types")[0]!;
    const demoRows = rowsOf(demoPart);
    expect(demoRows.length).toBeGreaterThan(0);
    expect(demoRows.filter((r) => !refused.has(r))).toEqual([]);
    expect(pack.demoOnlyEndpoints.endpoints.map((e: any) => norm(e.method, e.path))).toEqual(demoRows);
    expect(pack.demoOnlyEndpoints.note).toMatch(/501 not_available/);
  });

  it("NEGATIVE: no JSON endpointGroups entry refuses", () => {
    const listed = pack.endpointGroups.flatMap((g: any) => g.endpoints.map((e: any) => norm(e.method, e.path)));
    expect(listed.length).toBeGreaterThan(20);
    expect(listed.filter((r: string) => refused.has(r))).toEqual([]);
  });
});
