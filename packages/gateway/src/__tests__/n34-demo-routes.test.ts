import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { spaceRoutes } from "../routes/spaces.js";
import { orchestratorRoutes } from "../routes/orchestrator.js";
import { logisticsRoutes } from "../routes/logistics.js";
import { protocolRoutes } from "../routes/protocols.js";
import * as marketplace from "../routes/marketplace.js";
import { discoverRoutes } from "../routes/discover.js";
import * as registry from "../routes/registry.js";
import { csdRoutes, resetCsdRegistry } from "../routes/csd.js";

// These are the base route templates, independent of the gate and its exports.
const WRITES = ["POST /api/marketplace/listings", "PUT /api/marketplace/listings/:id", "DELETE /api/marketplace/listings/:id", "POST /api/marketplace/orders"];
const families = [
  {
    name: "agents", plugin: agentRoutes, size: 4,
    routes: ["GET /api/agents/conversations", "GET /api/agents/conversations/:convId"],
    body: { error: "not_available", message: "Conversations under /api/agents/conversations are not recorded on this gateway. Only built-in examples exist, and they are not served.", see: [] },
  },
  {
    name: "spaces", plugin: spaceRoutes, size: 5,
    routes: ["GET /api/spaces", "GET /api/spaces/:id", "POST /api/spaces/match"],
    malformed: ["POST /api/spaces/match"],
    body: { error: "not_available", message: "Hosting spaces are not recorded or matched on this gateway. Only built-in examples exist, and they are not served.", see: [] },
  },
  {
    name: "orchestrator", plugin: orchestratorRoutes, size: 15,
    routes: ["GET /api/orchestrator/graphs", "GET /api/orchestrator/graphs/:kernelId", "GET /api/orchestrator/samples", "GET /api/orchestrator/samples/:sampleId", "GET /api/orchestrator/claims", "POST /api/orchestrator/workflows", "GET /api/orchestrator/workflows", "GET /api/orchestrator/workflows/:workflowId"],
    malformed: ["POST /api/orchestrator/workflows"],
    body: { error: "not_available", message: "Transfer graphs, samples, resource claims and instrument workflows under /api/orchestrator are not recorded on this gateway. Only built-in examples exist, and they are not served.", see: [] },
  },
  {
    name: "logistics", plugin: logisticsRoutes, size: 22,
    routes: ["GET /api/logistics/providers", "GET /api/logistics/providers/:id", "GET /api/logistics/shipments", "GET /api/logistics/shipments/:id", "POST /api/logistics/shipments/quote", "GET /api/logistics/bookings", "GET /api/logistics/bookings/:id", "GET /api/logistics/installations", "GET /api/logistics/installations/:id", "PATCH /api/logistics/installations/:id/steps/:stepId", "GET /api/logistics/timeline", "GET /api/logistics/summary"],
    malformed: ["POST /api/logistics/shipments/quote", "PATCH /api/logistics/installations/inst-001/steps/inst-001-s1"],
    body: { error: "not_available", message: "Logistics providers, shipments, quotes, bookings and installations under /api/logistics are not recorded on this gateway. A job's own shipment, when it has one, is at the carrier route.", see: ["/api/carrier/shipments/:jobId"] },
  },
  {
    name: "protocols", plugin: protocolRoutes, size: 30,
    routes: ["GET /api/protocols", "GET /api/protocols/:id", "POST /api/protocols", "PUT /api/protocols/:id", "POST /api/protocols/:id/publish", "POST /api/protocols/:id/fork", "GET /api/protocols/:id/forks", "GET /api/protocols/:id/runs", "GET /api/protocol-runs", "GET /api/protocol-runs/:runId", "POST /api/protocols/:id/runs", "POST /api/protocol-runs/:runId/start", "POST /api/protocol-runs/:runId/pause", "POST /api/protocol-runs/:runId/resume", "POST /api/protocol-runs/:runId/cancel", "GET /api/automation-status", "GET /api/automation-status/:fromNodeId/:toNodeId", "POST /api/automation-status/:fromNodeId/:toNodeId/episode", "POST /api/automation-status/:fromNodeId/:toNodeId/advance", "GET /api/transfer-agents", "POST /api/protocols/:id/validate"],
    malformed: ["POST /api/protocols"],
    body: { error: "not_available", message: "Protocol templates, forks, runs, automation status and transfer agents are not recorded on this gateway, and no run is sent to any kernel. Only built-in examples exist, and they are not served.", see: [] },
  },
  {
    name: "marketplace", plugin: marketplace.marketplaceRoutes, size: 21,
    routes: ["GET /api/marketplace/classes", "GET /api/marketplace/classes/:id", "GET /api/marketplace/demand-supply", "POST /api/marketplace/roi", "GET /api/marketplace/categories", "GET /api/marketplace/listings", "GET /api/marketplace/listings/:id", ...WRITES, "GET /api/marketplace/orders", "GET /api/marketplace/orders/:id"],
    malformed: ["POST /api/marketplace/roi"],
    body: { error: "not_available", message: "Marketplace equipment classes, demand and supply figures and ROI projections are not recorded or computed on this gateway, and supply listings and orders are not served. Registered capabilities are listed by the capability registry.", see: ["/api/capabilities"] },
  },
  {
    name: "discover", plugin: discoverRoutes, size: 3,
    routes: ["POST /api/discover/scan", "POST /api/discover/generate-csd", "POST /api/discover/onboard"],
    malformed: ["POST /api/discover/onboard"],
    body: { error: "not_available", message: "Network device discovery is not run by this gateway. Only built-in example printers exist, and they are not served.", see: [] },
  },
];

const apps: FastifyInstance[] = [];
let savedFlag: string | undefined;
beforeEach(() => { savedFlag = process.env.PCC_DEMO_ROUTES; delete process.env.PCC_DEMO_ROUTES; });
afterEach(() => {
  if (savedFlag === undefined) delete process.env.PCC_DEMO_ROUTES;
  else process.env.PCC_DEMO_ROUTES = savedFlag;
});
afterAll(async () => { await Promise.all(apps.map((app) => app.close())); resetCsdRegistry(); });

async function build(plugin: FastifyPluginAsync) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const routes = new Set<string>();
  const calls = new Map<string, number>();
  app.addHook("onRoute", (options) => {
    for (const method of Array.isArray(options.method) ? options.method : [options.method]) {
      const key = `${method} ${options.url}`;
      routes.add(key);
      calls.set(key, 0);
    }
    const original = options.handler;
    options.handler = function (req, reply) {
      const key = `${req.method} ${req.routeOptions.url}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return original.call(this, req, reply);
    };
  });
  await app.register(plugin);
  await app.ready();
  return { app, routes, calls };
}
function withHeads(routes: string[]) {
  return routes.flatMap((key) => key.startsWith("GET ") ? [key, key.replace(/^GET /, "HEAD ")] : [key]).sort();
}
function parse(key: string) {
  const [method, path] = key.split(" ") as ["GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE", string];
  return { method, url: path.replace(/:[^/]+/g, "n34-probe") };
}

for (const family of families) {
  describe(`N34 ${family.name}`, () => {
    let recorded: Awaited<ReturnType<typeof build>>;
    beforeAll(async () => { recorded = await build(family.plugin); });
    it("B1 registers the pinned routes and HEAD twins with either flag", async () => {
      const off = await build(family.plugin);
      process.env.PCC_DEMO_ROUTES = "1";
      const on = await build(family.plugin);
      expect([...off.routes].sort()).toEqual([...on.routes].sort());
      expect([...off.routes].sort()).toEqual(withHeads(family.routes));
      expect(off.routes.size).toBe(family.size);
    });
    it("B2 every gated route returns its exact 501 body", async () => {
      for (const key of recorded.routes) {
        if (WRITES.includes(key)) continue;
        const opts = parse(key);
        const res = await recorded.app.inject({ ...opts, ...(["POST", "PUT", "PATCH"].includes(opts.method) ? { payload: {} } : {}) });
        expect(res.statusCode, key).toBe(501);
        if (opts.method === "HEAD") expect(res.body, key).toBe("");
        else expect(res.json(), key).toEqual(family.body);
      }
    });
    if (family.malformed) it("B3 rejects malformed JSON before parsing", async () => {
      for (const key of family.malformed) {
        const res = await recorded.app.inject({ ...parse(key), headers: { "content-type": "application/json" }, payload: "{not json" });
        expect(res.statusCode, key).toBe(501);
        expect(res.json(), key).toEqual(family.body);
      }
    });
    it("B4 no gated handler ran during B2 or B3", () => {
      for (const [key, count] of recorded.calls) if (!WRITES.includes(key)) expect(count, key).toBe(0);
    });
  });
}

it("B5 a blocked logistics PATCH cannot mutate installation steps", async () => {
  const { app } = await build(logisticsRoutes);
  process.env.PCC_DEMO_ROUTES = "1";
  const before = (await app.inject({ method: "GET", url: "/api/logistics/installations/inst-001" })).json().installation.steps;
  delete process.env.PCC_DEMO_ROUTES;
  const res = await app.inject({ method: "PATCH", url: "/api/logistics/installations/inst-001/steps/inst-001-s1", payload: { status: "completed", notes: "n34" } });
  expect(res.statusCode).toBe(501);
  process.env.PCC_DEMO_ROUTES = "1";
  const after = (await app.inject({ method: "GET", url: "/api/logistics/installations/inst-001" })).json().installation.steps;
  expect(after).toEqual(before);
});

it("B6 the flag preserves each family's base fixtures", async () => {
  process.env.PCC_DEMO_ROUTES = "1";
  const probes = [
    { plugin: agentRoutes, url: "/api/agents/conversations", field: "conversations", id: "conv-001" },
    { plugin: spaceRoutes, url: "/api/spaces", field: "spaces", id: "space-bk" },
    { plugin: logisticsRoutes, url: "/api/logistics/shipments", field: "shipments", id: "shp-001" },
    { plugin: protocolRoutes, url: "/api/protocols", field: "templates", id: "ptpl_bioassay001" },
    { plugin: marketplace.marketplaceRoutes, url: "/api/marketplace/classes", field: "classes", id: "ec-fdm" },
  ];
  for (const probe of probes) {
    const { app } = await build(probe.plugin);
    const res = await app.inject({ method: "GET", url: probe.url });
    expect(res.statusCode, probe.url).toBe(200);
    expect(res.json()[probe.field], probe.url).toEqual(expect.arrayContaining([expect.objectContaining({ id: probe.id })]));
  }
  const orchestrator = await build(orchestratorRoutes);
  expect((await orchestrator.app.inject({ method: "GET", url: "/api/orchestrator/graphs" })).json().graphs).toEqual(expect.arrayContaining([expect.objectContaining({ kernelId: "kernel-biolab-01" })]));
  const market = await build(marketplace.marketplaceRoutes);
  const roi = await market.app.inject({ method: "POST", url: "/api/marketplace/roi", payload: {} });
  expect(roi.statusCode).toBe(200);
  expect(roi.json().projection).toHaveLength(25);
});

it("B6 discover retains all three flag-on behaviors", async () => {
  process.env.PCC_DEMO_ROUTES = "1";
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(csdRoutes);
  await app.register(discoverRoutes);
  await app.ready();
  try {
    const scan = await app.inject({ method: "POST", url: "/api/discover/scan", payload: {} });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().devices.map((device: { uri: string }) => device.uri)).toEqual(["ipp://192.168.1.50/ipp/print", "ipp://192.168.1.51/ipp/print"]);
    const generated = await app.inject({ method: "POST", url: "/api/discover/generate-csd", payload: { device: scan.json().devices[0] } });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().csd.url).toMatch(/^pcc:\/\/capabilities\/ipp-2d-print\//);
    const onboard = await app.inject({ method: "POST", url: "/api/discover/onboard", payload: { timeoutMs: 100 } });
    expect(onboard.statusCode).toBe(200);
    expect(onboard.json().registered).toBe(true);
  } finally { resetCsdRegistry(); }
});

it("B7 the four N43 writes reach their unchanged handlers", async () => {
  const { app } = await build(marketplace.marketplaceRoutes);
  for (const url of ["/api/marketplace/listings", "/api/marketplace/orders"]) {
    expect((await app.inject({ method: "POST", url, payload: {} })).statusCode).toBe(400);
  }
  for (const method of ["PUT", "DELETE"] as const) {
    const res = await app.inject({ method, url: "/api/marketplace/listings/n34-none", ...(method === "PUT" ? { payload: {} } : {}) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("listing_not_found");
  }
});

it("B8 a real family accepts only the exact flag 1", async () => {
  const { app } = await build(spaceRoutes);
  for (const flag of ["true", "0", "", "1"]) {
    process.env.PCC_DEMO_ROUTES = flag;
    expect((await app.inject({ method: "GET", url: "/api/spaces" })).statusCode, flag).toBe(flag === "1" ? 200 : 501);
  }
});

it("B9 both exported scope lists name registered route templates", async () => {
  for (const [module, name, plugin] of [[marketplace, "MARKETPLACE_N43_WRITES", marketplace.marketplaceRoutes], [registry, "REGISTRY_ATTESTATION_ROUTES", registry.registryRoutes]] as const) {
    const keys: unknown = Reflect.get(module, name);
    expect(Array.isArray(keys), name).toBe(true);
    const { routes } = await build(plugin);
    for (const key of keys as string[]) expect(routes.has(key), key).toBe(true);
  }
});

describe("B10 real gateway registration", () => {
  let app: FastifyInstance;
  const saved = new Map<string, string | undefined>();
  beforeAll(async () => {
    for (const [name, value] of Object.entries({ PCC_DB_PATH: ":memory:", PCC_SEED_DATA: "true", PCC_RELAY_GATE: "open" })) {
      saved.set(name, process.env[name]); process.env[name] = value;
    }
    const { createGateway } = await import("../server.js");
    app = (await createGateway(0)).app as unknown as FastifyInstance;
    await app.ready();
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  it("B10 spaces stays gated through app.register", async () => {
    const provisioned = await app.inject({ method: "POST", url: "/api/auth/provision", payload: { email: "n34-real-gateway@example.invalid", name: "N34" } });
    expect(provisioned.statusCode).toBe(201);
    const key = provisioned.json().api_key;
    const res = await app.inject({ method: "GET", url: "/api/spaces", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject(families.find((family) => family.name === "spaces")!.body);
  });
  it("B10 ungated capabilities retains its base response", async () => {
    const off = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(off.statusCode).toBe(200);
    process.env.PCC_DEMO_ROUTES = "1";
    const on = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(on.statusCode).toBe(200);
    expect(off.json()).toEqual(on.json());
  });
});
