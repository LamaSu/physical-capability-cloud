import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initStore, closeStore } from "../db.js";
import { pizzaDemoRoutes, _clearPizzaDemoForTests } from "../routes/pizza-demo.js";
import { composeRoutes, _clearComposeForTests } from "../routes/compose.js";
import {
  graphSearchRoutes,
  _clearGraphSearchForTests,
  _seedGraphSearchForTests,
} from "../routes/graph-search.js";

const registeredRoutes = new Set<string>();

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      registeredRoutes.add(`${String(m).toUpperCase()} ${route.url}`);
    }
  });
  await app.register(pizzaDemoRoutes);
  await app.register(graphSearchRoutes);
  await app.register(composeRoutes);
  await app.ready();
  return app;
}

function seed(shopCapabilityId: string, shopKernelId: string, driverCapabilityId: string, driverKernelId: string) {
  _seedGraphSearchForTests({
    nodes: [
      {
        capabilityId: shopCapabilityId,
        capabilityType: "pizza",
        kernelId: shopKernelId,
        estimatedPriceUSD: 12,
        estimatedDurationMs: 900000,
        assuranceTier: 1,
        available: true,
        location: { lat: 37.77, lng: -122.42 },
        inputTypes: [],
        outputTypes: ["pizza"],
      },
      {
        capabilityId: driverCapabilityId,
        capabilityType: "pizza-delivery",
        kernelId: driverKernelId,
        estimatedPriceUSD: 4,
        estimatedDurationMs: 1800000,
        assuranceTier: 1,
        available: true,
        location: { lat: 37.77, lng: -122.42 },
        inputTypes: ["pizza"],
        outputTypes: ["delivered-pizza"],
      },
    ],
    edges: [{
      fromCapabilityId: shopCapabilityId,
      toCapabilityId: driverCapabilityId,
      capabilityTypeFlow: "pizza",
      estimatedHandoffPriceUSD: 0,
      estimatedHandoffDurationMs: 0,
    }],
  });
}

describe("pizza demo job routing", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });
  beforeEach(() => {
    _clearPizzaDemoForTests();
    _clearComposeForTests();
    _clearGraphSearchForTests();
  });
  afterAll(async () => {
    _clearPizzaDemoForTests();
    _clearComposeForTests();
    _clearGraphSearchForTests();
    await app.close();
    closeStore();
  });

  async function confirmOrder() {
    const placed = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "kernel_t1_ab12",
        description: "pizza",
        deliveryAddress: "dana-ab12",
        deliveryLocation: { lat: 37.77, lng: -122.42 },
      },
    });
    expect(placed.statusCode).toBe(201);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/demo/orders/${placed.json().order.orderId}/confirm`,
    });
    expect(confirmed.statusCode).toBe(200);
    return confirmed.json().job;
  }

  async function queue(slug: string) {
    const response = await app.inject({ method: "GET", url: `/api/demo/jobs/${slug}/queue` });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function complete(jobId: string) {
    const accepted = await app.inject({ method: "POST", url: `/api/demo/jobs/${jobId}/accept` });
    expect(accepted.statusCode).toBe(200);
    const completed = await app.inject({ method: "POST", url: `/api/demo/jobs/${jobId}/complete` });
    expect(completed.statusCode).toBe(200);
  }

  it("a new shop's and a new driver's jobs land on the slugs their wizards link to", async () => {
    seed("cap-kernel_t1_ab12-pizza", "kernel_t1_ab12", "skill_00000000-0000-4000-8000-000000000001", "dana-ab12");
    const job = await confirmOrder();
    expect.soft((await queue("kernel_t1_ab12")).active).toEqual([
      expect.objectContaining({ jobId: job.jobId, type: "make-pizza", assigneeSlug: "kernel_t1_ab12" }),
    ]);
    expect.soft((await queue("cap-kernel_t1_ab12-pizza")).active).toEqual([]);
    await complete(job.jobId);
    expect.soft((await queue("dana-ab12")).active).toEqual([
      expect.objectContaining({ orderId: job.orderId, type: "deliver-pizza", assigneeSlug: "dana-ab12" }),
    ]);
  });

  it("seeded kernels keep their slugs", async () => {
    seed("cap_shop-roma", "k_shop-roma", "cap_driver-alex", "k_driver-alex");
    const job = await confirmOrder();
    expect.soft((await queue("shop-roma")).active).toEqual([
      expect.objectContaining({ jobId: job.jobId, type: "make-pizza", assigneeSlug: "shop-roma" }),
    ]);
    await complete(job.jobId);
    expect.soft((await queue("driver-alex")).active).toEqual([
      expect.objectContaining({ orderId: job.orderId, type: "deliver-pizza", assigneeSlug: "driver-alex" }),
    ]);
  });

  it("assigns a kernel id with an inner k_ to its own queue", async () => {
    seed("cap-kernel_t1_ab12-pizza", "kernel_t1k_ab12", "skill_00000000-0000-4000-8000-000000000001", "dana-ab12");
    const job = await confirmOrder();
    expect((await queue("kernel_t1k_ab12")).active).toEqual([
      expect.objectContaining({ jobId: job.jobId, type: "make-pizza", assigneeSlug: "kernel_t1k_ab12" }),
    ]);
  });

  it("a seeded shop gets its jobs on its seeded slug", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { method: "POST"; headers: Record<string, string>; body?: string }) => {
      const response = await app.inject({
        method: init.method,
        url: new URL(url).pathname,
        headers: init.headers,
        payload: init.body,
      });
      return new Response(response.body, { status: response.statusCode });
    }));
    try {
      await import(resolve(__dirname, "../../../../scripts/seed-pizza-demo.ts"));
      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledWith("✓ seeded 3/3 shops, 4/4 drivers, 12 graph edges");
      });
      expect(exit).not.toHaveBeenCalled();
      const job = await confirmOrder();
      expect((await queue("shop-slice-heaven")).active).toEqual([
        expect.objectContaining({ jobId: job.jobId, type: "make-pizza", assigneeSlug: "shop-slice-heaven" }),
      ]);
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      exit.mockRestore();
    }
  });

  it("every path the seed script posts to is a registered route", () => {
    const source = readFileSync(resolve(__dirname, "../../../../scripts/seed-pizza-demo.ts"), "utf8");
    const paths = [...source.matchAll(/api\("POST",\s*(["'`])([^"'`]+)\1/g)].map((match) => match[2]);
    expect(paths).toHaveLength(3);
    expect(paths).toHaveLength([...source.matchAll(/api\("POST",/g)].length);
    for (const path of paths) expect.soft(registeredRoutes.has(`POST ${path}`)).toBe(true);
  });
});
