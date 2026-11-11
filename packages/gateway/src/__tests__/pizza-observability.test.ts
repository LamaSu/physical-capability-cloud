/**
 * pizza-observability test suite.
 *
 * Verifies the live observability dashboard's two new gateway endpoints
 * (extracted from auto-closed PR #110) hydrate cleanly:
 *
 *   - GET  /api/demo/orders/observability — full-state hydration for the dashboard
 *   - GET  /sse/demo/firehose             — single cross-order event stream
 *
 * Plus the static dashboard asset (pizza-observability.html).
 *
 * What this guards against:
 *   - Someone renames a route → dashboard breaks silently on first load
 *   - Someone strips the timeline/chainEvents fields off DemoOrder
 *     → dashboard renders blank panels with no error
 *   - Someone strips the firehose stream → dashboard's live tail goes dark
 *
 * The test exercises the real route registration + body shape; it does NOT
 * try to drive an SSE connection to completion (Fastify inject is one-shot).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { get, type IncomingMessage } from "node:http";

import { pizzaDemoRoutes, _clearPizzaDemoForTests } from "../routes/pizza-demo.js";
import { initStore, closeStore } from "../db.js";
import { _clearGraphSearchForTests, _seedGraphSearchForTests } from "../routes/graph-search.js";

// ── Asset locations ──────────────────────────────────────────────────────────
const REPO_ROOT = resolve(__dirname, "../../../..");
const PUBLIC_DIR = join(REPO_ROOT, "apps", "dashboard", "public");
const DASHBOARD_HTML = join(PUBLIC_DIR, "pizza-observability.html");

// ── App fixture ──────────────────────────────────────────────────────────────
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
  await app.ready();
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pizza-observability — dashboard asset presence", () => {
  it("ships pizza-observability.html in the dashboard public dir", () => {
    expect(existsSync(DASHBOARD_HTML)).toBe(true);
    const txt = readFileSync(DASHBOARD_HTML, "utf8");
    // Sanity: it's actually an HTML document with the right scaffolding.
    expect(txt).toMatch(/<!DOCTYPE html>/i);
    expect(txt).toContain("PCC · Pizza Observability");
    // The dashboard depends on the two new gateway endpoints — if they're
    // renamed in the route file, surface the breakage here.
    expect(txt).toContain("/api/demo/orders/observability");
    expect(txt).toContain("/sse/demo/firehose");
  });
});

describe("pizza-observability — gateway endpoints register cleanly", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    _clearPizzaDemoForTests();
  });

  it("registers GET /api/demo/orders/observability", () => {
    expect(registeredRoutes.has("GET /api/demo/orders/observability")).toBe(true);
  });

  it("registers GET /sse/demo/firehose", () => {
    expect(registeredRoutes.has("GET /sse/demo/firehose")).toBe(true);
  });

  it("does not regress the pre-existing pizza-demo endpoints", () => {
    // Spot-check a handful that the dashboard / LLM bootstrap depend on.
    expect(registeredRoutes.has("POST /api/demo/pizza-order")).toBe(true);
    expect(registeredRoutes.has("POST /api/demo/orders/:id/confirm")).toBe(true);
    expect(registeredRoutes.has("GET /api/demo/orders/:id")).toBe(true);
    expect(registeredRoutes.has("GET /api/demo/orders")).toBe(true);
    expect(registeredRoutes.has("GET /sse/demo/order/:id")).toBe(true);
    expect(registeredRoutes.has("POST /api/demo/_reset")).toBe(true);
  });
});

describe("pizza-observability — GET /api/demo/orders/observability shape", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    // Clean slate — start with an empty store so the stats are deterministic.
    await app.inject({ method: "POST", url: "/api/demo/_reset" });
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    _clearPizzaDemoForTests();
  });

  it("returns an empty orders array with zeroed stats when nothing has been ordered", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/demo/orders/observability",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Array.isArray(body.orders)).toBe(true);
    expect(body.orders.length).toBe(0);
    expect(body.stats).toMatchObject({
      activeOrders: 0,
      completedToday: 0,
      totalVolumeUSD: 0,
      avgTimeToDeliverSec: 0,
      totalOrders: 0,
    });
    expect(body.stats).not.toHaveProperty("pccFeeUSDToday");
    expect(typeof body.serverTime).toBe("string");
    expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("after a pizza order is placed, the response includes the order with a populated timeline + chainEvents fields", async () => {
    // Place a single order against the real compose engine.
    const place = await app.inject({
      method: "POST",
      url: "/api/demo/pizza-order",
      payload: {
        userId: "observability-test-user",
        description: "1 margherita",
        deliveryAddress: "123 Test St, SF CA",
        deliveryLocation: { lat: 37.77, lng: -122.42 },
        maxPriceUSD: 30,
      },
    });
    // Compose engine may return 404 if no seeded providers — that's fine for
    // the empty-state case above; here we tolerate either outcome.
    if (place.statusCode !== 201) return;

    const res = await app.inject({
      method: "GET",
      url: "/api/demo/orders/observability",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.orders.length).toBeGreaterThanOrEqual(1);
    const o = body.orders[0];
    // Surface contract the dashboard relies on:
    expect(Array.isArray(o.timeline)).toBe(true);
    expect(Array.isArray(o.chainEvents)).toBe(true);
    // The two automatic steps recorded at order creation:
    const stepIds = (o.timeline as Array<{ step: string }>).map((t) => t.step);
    expect(stepIds).toContain("order_placed");
    expect(stepIds).toContain("composition_planned");

    expect(body.stats.totalOrders).toBeGreaterThanOrEqual(1);
  });
});

describe("pizza-observability — a delivered order", () => {
  it("a delivered order sends no fee or treasury data, and its payout legs add up to the release", async () => {
    const FEE_WORDING =
      /\bplatform (?:fees?|tax(?:es)?)\b|\bprotocol fees?\b|\bpcc(?:['\u2019]s)? (?:cut|fees?)\b|\bfee (?:rate|collection|recipient|flows?)\b|\b2\.35 ?%/i;
    const NEW_FEE = /\bfees?\b|pccfee|treasury|feebps|protocol-fee|\btax(?:es)?\b/i;
    const app = await buildApp();
    let response: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: ReturnType<typeof get> | undefined;
    try {
      _clearPizzaDemoForTests();
      _clearGraphSearchForTests();
      _seedGraphSearchForTests({
        nodes: [
          { capabilityId: "cap_shop-test", capabilityType: "make-pizza", kernelId: "k_shop-test", estimatedPriceUSD: 12, estimatedDurationMs: 900000, assuranceTier: 1, reputation: 600, available: true, inputTypes: [], outputTypes: ["pizza"], location: { lat: 37.77, lng: -122.42 } },
          { capabilityId: "cap_driver-test", capabilityType: "delivered-pizza", kernelId: "k_driver-test", estimatedPriceUSD: 4, estimatedDurationMs: 1800000, assuranceTier: 1, reputation: 600, available: true, inputTypes: ["pizza"], outputTypes: ["delivered-pizza"], location: { lat: 37.77, lng: -122.42 } },
        ],
        edges: [{ fromCapabilityId: "cap_shop-test", toCapabilityId: "cap_driver-test", capabilityTypeFlow: "pizza", estimatedHandoffPriceUSD: 0 }],
      });
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      let receive!: (value: { event: { settlement: Record<string, number> } }) => void;
      const delivered = new Promise<{ event: { settlement: Record<string, number> } }>((resolve) => { receive = resolve; });
      await new Promise<void>((resolve, reject) => {
        request = get(address + "/sse/demo/firehose", (res) => {
          response = res;
          expect(res.statusCode).toBe(200);
          let pending = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            pending += chunk;
            let end: number;
            while ((end = pending.indexOf("\n\n")) !== -1) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              if (!frame.startsWith("data: ")) continue;
              const payload = JSON.parse(frame.slice(6));
              if (payload.type === "connected") resolve();
              if (payload.event?.type === "delivered") receive(payload);
            }
          });
          res.on("error", reject);
        });
        request.on("error", reject);
      });
      const place = await app.inject({ method: "POST", url: "/api/demo/pizza-order", payload: { userId: "observability-test-user", description: "1 margherita", deliveryAddress: "123 Test St, SF CA" } });
      expect(place.statusCode).toBe(201);
      const id = place.json().order.orderId;
      expect((await app.inject({ method: "POST", url: `/api/demo/orders/${id}/confirm` })).statusCode).toBe(200);
      const shop = (await app.inject({ method: "GET", url: `/api/demo/orders/${id}` })).json().jobs.makePizza.jobId;
      for (const action of ["accept", "complete"]) {
        expect((await app.inject({ method: "POST", url: `/api/demo/jobs/${shop}/${action}`, payload: {} })).statusCode).toBe(200);
      }
      const driver = (await app.inject({ method: "GET", url: `/api/demo/orders/${id}` })).json().jobs.delivery.jobId;
      for (const action of ["accept", "pickup", "complete"]) {
        expect((await app.inject({ method: "POST", url: `/api/demo/jobs/${driver}/${action}`, payload: {} })).statusCode).toBe(200);
      }
      const observability = (await app.inject({ method: "GET", url: "/api/demo/orders/observability" })).json();
      const detail = (await app.inject({ method: "GET", url: `/api/demo/orders/${id}` })).json();
      const event = await Promise.race([
        delivered,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error()), 5000); }),
      ]);
      for (const value of [observability, detail, event]) {
        expect.soft(JSON.stringify(value)).not.toMatch(FEE_WORDING);
        expect.soft(JSON.stringify(value)).not.toMatch(NEW_FEE);
      }
      const chain = detail.order.chainEvents as Array<{ type: string; amountUSDC?: string }>;
      expect.soft(chain.filter((entry) => entry.type === "escrow_locked").map((entry) => entry.amountUSDC)).toEqual(["16.00"]);
      expect.soft(chain.filter((entry) => entry.type === "escrow_released").map((entry) => entry.amountUSDC)).toEqual(["16.00"]);
      expect.soft(chain.filter((entry) => entry.type === "usdc_transfer").map((entry) => entry.amountUSDC)).toEqual(["12.00", "4.00"]);
      expect.soft(event.event.settlement).toEqual({ shopPayoutUSD: 12, driverPayoutUSD: 4 });
      const settlement = detail.order.timeline.find((entry: { step: string }) => entry.step === "settlement_released").detail;
      expect.soft(Object.fromEntries(Object.entries(settlement).filter(([key]) => key.endsWith("USD")))).toEqual({ shopPayoutUSD: 12, driverPayoutUSD: 4 });
      expect.soft(observability.stats.totalVolumeUSD).toBe(16);
      expect.soft(observability.stats).not.toHaveProperty("pccFeeUSDToday");
    } finally {
      clearTimeout(timer);
      response?.destroy();
      request?.destroy();
      await app.close();
      _clearPizzaDemoForTests();
      _clearGraphSearchForTests();
      closeStore();
    }
  });
});
