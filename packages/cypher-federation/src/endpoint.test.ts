import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { createPeerEndpoint, mountStandalone } from "./endpoint.js";
import { FederationPeer } from "./peer.js";
import { OrderTranslator } from "./translator.js";
import type { CypherFederationService, PccA2aIntent } from "./types.js";

const NOOP_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const sampleService: CypherFederationService = {
  _id: "pcc-pcc-cap-fdm-1",
  name: "FDM 3D Printing",
  pricing: { basePrice: 0, currency: "USD", pricingModel: "quote" },
  provider: { name: "PCC", slug: "pcc" },
  sourceInstance: { instanceId: "pcc", name: "PCC", baseUrl: "https://capability.network/cypher/federation" },
  sourceServiceId: "cap-fdm-1",
};

function makeFixtures() {
  // Stub peer with an injected fetch so .status() can be controlled.
  const peerFetch = vi.fn();
  const peer = new FederationPeer({
    apiKey: "test-key",
    fetchImpl: peerFetch as unknown as typeof fetch,
  });
  const translator = new OrderTranslator({ pccGatewayUrl: "https://capability.network" });
  const submitJob = vi.fn().mockResolvedValue({ jobId: "job-uuid-1", status: "queued" });
  const gatewayClient = { submitJob };
  return { peer, peerFetch, translator, gatewayClient, submitJob };
}

describe("POST /orders", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  beforeEach(() => {
    fixtures = makeFixtures();
  });

  it("translates the order, calls submitJob, and returns 200 with order metadata", async () => {
    const { app } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });

    const res = await request(app)
      .post("/cypher/federation/orders")
      .send({
        _id: "ord_xyz",
        orderNumber: "FED-20260506-0001",
        federatedServiceId: "cap-fdm-1",
        orderData: { quantity: 2, material: "PLA" },
        priority: "rush",
      })
      .expect(200);

    expect(res.body).toMatchObject({
      orderNumber: "FED-20260506-0001",
      orderId: "ord_xyz",
      status: "accepted",
      pccJobId: "job-uuid-1",
    });

    expect(fixtures.submitJob).toHaveBeenCalledTimes(1);
    const intent = fixtures.submitJob.mock.calls[0][0] as PccA2aIntent;
    expect(intent.type).toBe("submit_workflow");
    expect(intent.capabilityId).toBe("cap-fdm-1");
    expect(intent.assuranceTier).toBe(2); // rush
    expect(intent.params).toEqual({ quantity: 2, material: "PLA" });
    expect(intent.callbackUrl).toContain("/cypher/federation/orders/ord_xyz/status");
  });

  it("rejects malformed order with 400 invalid_order", async () => {
    const { app } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    const res = await request(app)
      .post("/cypher/federation/orders")
      .send({ orderNumber: "FED-1" }) // missing _id and federatedServiceId
      .expect(400);
    expect(res.body.error).toBe("invalid_order");
  });

  it("returns 502 when the gateway client rejects", async () => {
    fixtures.submitJob.mockRejectedValueOnce(new Error("downstream timeout"));
    const { app } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    const res = await request(app)
      .post("/cypher/federation/orders")
      .send({
        _id: "ord_xyz",
        orderNumber: "FED-20260506-0001",
        federatedServiceId: "cap-fdm-1",
        orderData: {},
      })
      .expect(502);
    expect(res.body.error).toBe("submit_failed");
    expect(res.body.message).toContain("downstream timeout");
  });

  it("increments open-orders count after a successful submit", async () => {
    const { app, endpoint } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    expect(endpoint.getOpenOrderCount()).toBe(0);
    await request(app)
      .post("/cypher/federation/orders")
      .send({
        _id: "ord_a",
        orderNumber: "FED-1",
        federatedServiceId: "cap-fdm-1",
        orderData: {},
      })
      .expect(200);
    expect(endpoint.getOpenOrderCount()).toBe(1);
  });
});

describe("GET /services", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  beforeEach(() => {
    fixtures = makeFixtures();
  });

  it("returns the cached service list when no live listing function is provided", async () => {
    const { app } = mountStandalone({
      ...fixtures,
      initialPublishedServices: [sampleService],
      logger: NOOP_LOGGER,
    });
    const res = await request(app).get("/cypher/federation/services").expect(200);
    expect(res.body.services).toHaveLength(1);
    expect(res.body.services[0]._id).toBe("pcc-pcc-cap-fdm-1");
  });

  it("uses the live gateway listing when supplied", async () => {
    const listPublishedServices = vi.fn().mockResolvedValue([sampleService, sampleService]);
    const { app } = mountStandalone({
      ...fixtures,
      gatewayClient: { ...fixtures.gatewayClient, listPublishedServices },
      logger: NOOP_LOGGER,
    });
    const res = await request(app).get("/cypher/federation/services").expect(200);
    expect(res.body.services).toHaveLength(2);
    expect(listPublishedServices).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the live listing throws", async () => {
    const listPublishedServices = vi.fn().mockRejectedValue(new Error("db down"));
    const { app } = mountStandalone({
      ...fixtures,
      gatewayClient: { ...fixtures.gatewayClient, listPublishedServices },
      logger: NOOP_LOGGER,
    });
    const res = await request(app).get("/cypher/federation/services").expect(500);
    expect(res.body.error).toBe("services_list_failed");
  });
});

describe("GET /status", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  beforeEach(() => {
    fixtures = makeFixtures();
  });

  it("returns local stats merged with upstream peer status", async () => {
    fixtures.peerFetch.mockResolvedValue(
      jsonResponse({ registered: true, lastSyncAt: "2026-05-06T18:00:00Z", openOrders: 0 }),
    );
    const { app, endpoint } = mountStandalone({
      ...fixtures,
      initialPublishedServices: [sampleService],
      logger: NOOP_LOGGER,
    });
    expect(endpoint.getOpenOrderCount()).toBe(0);
    const res = await request(app).get("/cypher/federation/status").expect(200);
    expect(res.body.registered).toBe(true);
    expect(res.body.publishedServices).toBe(1);
    expect(res.body.openOrders).toBe(0);
  });

  it("falls back to local-only data when upstream peer.status throws", async () => {
    fixtures.peerFetch.mockRejectedValue(new TypeError("unreachable"));
    const { app } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    const res = await request(app).get("/cypher/federation/status").expect(200);
    expect(res.body.registered).toBe(false);
  });
});

describe("POST /orders/:id/status", () => {
  let fixtures: ReturnType<typeof makeFixtures>;
  beforeEach(() => {
    fixtures = makeFixtures();
  });

  it("acks valid status updates", async () => {
    const { app } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    const res = await request(app)
      .post("/cypher/federation/orders/ord_xyz/status")
      .send({ status: "in_progress", message: "device started" })
      .expect(200);
    expect(res.body).toEqual({ ok: true, orderId: "ord_xyz", status: "in_progress" });
  });

  it("rejects invalid status values with 400", async () => {
    const { app } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    const res = await request(app)
      .post("/cypher/federation/orders/ord_xyz/status")
      .send({ status: "exploded" })
      .expect(400);
    expect(res.body.error).toBe("invalid_status_update");
  });
});

describe("createPeerEndpoint cache management", () => {
  it("setPublishedServices updates the cache used by GET /services", async () => {
    const fixtures = makeFixtures();
    const { app, endpoint } = mountStandalone({ ...fixtures, logger: NOOP_LOGGER });
    endpoint.setPublishedServices([sampleService]);
    const res = await request(app).get("/cypher/federation/services").expect(200);
    expect(res.body.services).toHaveLength(1);
  });
});

describe("createPeerEndpoint deferred work", () => {
  // These tests describe future integration milestones — they are
  // intentionally pending. Removing the `it.todo` lines should be
  // paired with adding live infrastructure (real Cypher peer +
  // running PCC gateway).
  it.todo("live integration: register with a real Cypher staging instance");
  it.todo("live integration: receive an order from Cypher and submit a real PCC job");
  it.todo("live integration: emit settlement back to Cypher after escrow release");
});
