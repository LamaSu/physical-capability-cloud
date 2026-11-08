import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { pizzaDemoRoutes, _clearPizzaDemoForTests } from "../routes/pizza-demo.js";
import { closeStore, initStore } from "../db.js";
import { initAgentBridge, shutdownAgentBridge, isAgentBridgeReady, getKernelAgent, getAgentCards } from "../agent-bridge.js";

function environment(nodeEnv: string | undefined, flag?: string) {
  vi.stubEnv("NODE_ENV", nodeEnv ?? "");
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  vi.stubEnv("PCC_DEMOS_ENABLED", flag ?? "");
  if (flag === undefined) delete process.env.PCC_DEMOS_ENABLED;
}

const routes = [
  "POST /api/demo/pizza-order", "POST /api/demo/orders/:id/confirm", "POST /api/demo/orders/:id/cancel",
  "GET /api/demo/orders/:id", "GET /api/demo/jobs/:assignee/queue",
  ...["accept", "pickup", "complete", "reject"].map((action) => `POST /api/demo/jobs/:jobId/${action}`),
  "GET /sse/demo/order/:id", "GET /sse/demo/operator/:slug", "GET /sse/demo/driver/:slug", "GET /sse/demo/firehose",
  "GET /api/demo/orders", "GET /api/demo/orders/observability", "POST /api/demo/_reset",
].sort();

describe("N291 demo routes", () => {
  let app: FastifyInstance | undefined;
  const registered = new Set<string>();
  beforeEach(() => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: true });
    registered.clear();
  });
  afterEach(async () => {
    _clearPizzaDemoForTests();
    await app?.close();
    app = undefined;
    closeStore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  async function register() {
    app = Fastify({ logger: false });
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== "HEAD") registered.add(`${method} ${route.url}`);
      }
    });
    await app.register(pizzaDemoRoutes);
    await app.ready();
    return app;
  }
  function demoRoutes() {
    return [...registered].filter((route) => / \/(?:api\/demo|sse\/demo)/.test(route)).sort();
  }

  it("D1: production default registers no demo routes", async () => {
    environment("production");
    const server = await register();
    expect(demoRoutes()).toEqual([]);
    expect((await server.inject({ method: "POST", url: "/api/demo/pizza-order" })).statusCode).toBe(404);
  });
  it("D2: exact true registers all 16 demo routes in production", async () => {
    environment("production", "true");
    await register();
    expect(demoRoutes()).toEqual(routes);
  });
  it.each(["test", "development"])("D3: %s keeps all demo routes", async (nodeEnv) => {
    environment(nodeEnv, "false");
    await register();
    expect(demoRoutes()).toEqual(routes);
  });
  it.each(["TRUE", "1", "yes", "", "false"])("D4: production flag %s leaves demo routes off", async (flag) => {
    environment("production", flag);
    await register();
    expect(demoRoutes()).toEqual([]);
  });
});

describe("N291 bridge agents", () => {
  beforeEach(async () => {
    await shutdownAgentBridge();
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: false });
  });
  afterEach(async () => {
    await shutdownAgentBridge();
    closeStore();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it("D5: production default starts user and broker", async () => {
    environment("production");
    await initAgentBridge();
    expect(isAgentBridgeReady()).toBe(true);
    expect(getKernelAgent() === null).toBe(true);
    expect(getAgentCards().map((card) => card.role)).toEqual(["user", "scheduler"]);
  });
  it("D6: exact true starts all agents in production", async () => {
    environment("production", "true");
    await initAgentBridge();
    expect(isAgentBridgeReady()).toBe(true);
    expect(getKernelAgent() === null).toBe(false);
    expect(getAgentCards().map((card) => card.role)).toEqual(["user", "scheduler", "kernel"]);
  });
  it("D7: test keeps all agents", async () => {
    environment("test");
    await initAgentBridge();
    expect(isAgentBridgeReady()).toBe(true);
    expect(getKernelAgent() === null).toBe(false);
    expect(getAgentCards().map((card) => card.role)).toEqual(["user", "scheduler", "kernel"]);
  });
});

describe("N291 demo flag", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("D8: reads the exact flag and environment on every call", async () => {
    const { demoSurfacesEnabled } = await import("../config/demo-surfaces.js");
    for (const [nodeEnv, flag, expected] of [
      ["production", undefined, false], ["production", "TRUE", false], ["production", "1", false],
      ["production", "", false], ["production", "false", false], ["production", "true", true],
      ["test", undefined, true], ["development", "false", true], [undefined, undefined, true],
    ] as const) {
      environment(nodeEnv, flag);
      expect(demoSurfacesEnabled(), `${nodeEnv}/${flag}`).toBe(expected);
    }
  });
});
