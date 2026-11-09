import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { closeStore } from "../db.js";
import {
  graphSearchRoutes,
  _clearGraphSearchForTests,
} from "../routes/graph-search.js";
import { composeRoutes, _clearComposeForTests } from "../routes/compose.js";

let app: FastifyInstance | undefined;

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  _clearGraphSearchForTests();
  _clearComposeForTests();
});

afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = undefined;
    vi.unstubAllEnvs();
  }
});

afterAll(() => closeStore());

function setEnvironment(nodeEnv: string | undefined, demos: string | undefined) {
  vi.stubEnv("NODE_ENV", nodeEnv ?? "");
  vi.stubEnv("PCC_DEMOS_ENABLED", demos ?? "");
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  if (demos === undefined) delete process.env.PCC_DEMOS_ENABLED;
  expect(process.env.NODE_ENV).toBe(nodeEnv);
  expect(process.env.PCC_DEMOS_ENABLED).toBe(demos);
}

const node = {
  capabilityId: "node",
  capabilityType: "generic",
  kernelId: "kernel",
  estimatedPriceUSD: 1,
  estimatedDurationMs: 100,
  assuranceTier: 0,
};

const edge = {
  fromCapabilityId: "node",
  toCapabilityId: "other",
  capabilityTypeFlow: "part",
};

async function makeGraphApp() {
  app = Fastify({ logger: false });
  await app.register(graphSearchRoutes);
  await app.ready();
  return app;
}

async function expectGraphRegistrations(graphApp: FastifyInstance, status: number) {
  const nodeResponse = await graphApp.inject({
    method: "POST",
    url: "/api/capabilities/graph/_dev/register-node",
    payload: node,
  });
  const edgeResponse = await graphApp.inject({
    method: "POST",
    url: "/api/capabilities/graph/_dev/register-edge",
    payload: edge,
  });
  expect.soft(nodeResponse.statusCode).toBe(status);
  expect.soft(edgeResponse.statusCode).toBe(status);
}

describe("graph dev registration routes", () => {
  it("G1: production with PCC_DEMOS_ENABLED unset", async () => {
    setEnvironment("production", undefined);
    const graphApp = await makeGraphApp();
    await expectGraphRegistrations(graphApp, 404);

    const search = await graphApp.inject({
      method: "POST",
      url: "/api/capabilities/graph-search",
      payload: { outcomeType: "part", budgetUSD: 10, minAssuranceTier: 0 },
    });
    const stats = await graphApp.inject({
      method: "GET",
      url: "/api/capabilities/graph-stats",
    });
    expect.soft(search.statusCode).toBe(201);
    expect.soft(stats.statusCode).toBe(200);
  });

  it("G2: production with PCC_DEMOS_ENABLED=true", async () => {
    setEnvironment("production", "true");
    await expectGraphRegistrations(await makeGraphApp(), 201);
  });

  it.each(["1", "TRUE"])("G3: production with PCC_DEMOS_ENABLED=%s", async (flag) => {
    setEnvironment("production", flag);
    await expectGraphRegistrations(await makeGraphApp(), 404);
  });

  it.each(["test", "development", undefined])("G4: NODE_ENV=%s", async (nodeEnv) => {
    setEnvironment(nodeEnv, undefined);
    await expectGraphRegistrations(await makeGraphApp(), 201);
  });
});

async function makeComposeApp() {
  app = Fastify({ logger: false });
  await app.register(composeRoutes);
  await app.ready();
  return app;
}

async function expectComposeRegistration(composeApp: FastifyInstance, status: number) {
  const response = await composeApp.inject({
    method: "POST",
    url: "/api/compose/_dev/register-candidate",
    payload: { ...node, operatorAddress: "operator" },
  });
  expect(response.statusCode).toBe(status);
}

describe("compose dev registration route", () => {
  it("C1: production with PCC_DEMOS_ENABLED unset", async () => {
    setEnvironment("production", undefined);
    const composeApp = await makeComposeApp();
    expect.soft(composeApp.hasRoute({ method: "POST", url: "/api/compose" })).toBe(true);
    await expectComposeRegistration(composeApp, 404);
  });

  it("C2: production with PCC_DEMOS_ENABLED=true", async () => {
    setEnvironment("production", "true");
    await expectComposeRegistration(await makeComposeApp(), 201);
  });

  it.each(["1", "TRUE"])("C3: production with PCC_DEMOS_ENABLED=%s", async (flag) => {
    setEnvironment("production", flag);
    await expectComposeRegistration(await makeComposeApp(), 404);
  });

  it.each(["test", "development", undefined])("C4: NODE_ENV=%s", async (nodeEnv) => {
    setEnvironment(nodeEnv, undefined);
    await expectComposeRegistration(await makeComposeApp(), 201);
  });
});
