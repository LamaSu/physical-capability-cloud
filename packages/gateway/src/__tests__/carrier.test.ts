/**
 * Carrier route tests — buy-a-label, idempotent re-buy, and the webhook
 * receiver's full signature-verification + pre-commitment-match + evidence-
 * event path. The webhook signature is computed with real HMAC-SHA256 in
 * this file (not stubbed), so this exercises the exact bytes-on-the-wire
 * path a genuine EasyPost delivery would take.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { verifyEventHash } from "@pcc/spec";
import { carrierRoutes } from "../routes/carrier.js";
import { EasyPostClient, _setEasyPostClientForTests } from "../services/easypost-client.js";
import { _resetCarrierShipmentStoreForTests, getCarrierShipmentStore } from "../services/carrier-shipment-store.js";

const WEBHOOK_SECRET = "whsec_test_carrier_suite";

function sign(body: string): string {
  return "hmac-sha256-hex=" + createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(carrierRoutes);
  await app.ready();
  return app;
}

const validBody = {
  jobId: "job-print-mail-1",
  kernelId: "kernel-hp-printer",
  toAddress: { name: "Court Clerk", street1: "60 Centre St", city: "New York", state: "NY", zip: "10007" },
  fromAddress: { name: "PCC Operator", street1: "1 Shop Way", city: "San Francisco", state: "CA", zip: "94103" },
  parcel: { weightOz: 2 },
};

beforeEach(() => {
  _resetCarrierShipmentStoreForTests();
  _setEasyPostClientForTests(undefined);
});

afterEach(() => {
  _resetCarrierShipmentStoreForTests();
  _setEasyPostClientForTests(undefined);
});

describe("GET /api/carrier/healthz", () => {
  it("reports mock mode and no webhook secret by default", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.mock).toBe(true);
      expect(body.webhookConfigured).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/carrier/shipments", () => {
  it("rejects missing required fields with 400 + details", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_fields");
      expect(res.json().details.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("buys a (mock) label and returns a commitment", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.jobId).toBe("job-print-mail-1");
      expect(body.mock).toBe(true);
      expect(body.status).toBe("label_bought");
      expect(body.commitment.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.commitment.jobId).toBe("job-print-mail-1");
      expect(body.trackingCode).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("is idempotent per jobId — a second call returns the SAME shipment, not a new purchase", async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      const second = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().shipmentId).toBe(first.json().shipmentId);
      expect(second.json().trackingCode).toBe(first.json().trackingCode);
      expect(getCarrierShipmentStore().size()).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/carrier/shipments/:jobId", () => {
  it("404s for an unknown job", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/shipments/does-not-exist" });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns the record after a label is bought", async () => {
    const app = await buildApp();
    try {
      await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      const res = await app.inject({ method: "GET", url: "/api/carrier/shipments/job-print-mail-1" });
      expect(res.statusCode).toBe(200);
      expect(res.json().jobId).toBe("job-print-mail-1");
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/carrier/webhook/easypost", () => {
  it("503s when no webhook secret is configured (default client)", async () => {
    const app = await buildApp();
    try {
      const payload = JSON.stringify({ id: "evt_1", description: "tracker.updated", result: {} });
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/webhook/easypost",
        payload,
        headers: { "content-type": "application/json", "x-hmac-signature": "irrelevant" },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it("401s on an invalid signature once a secret IS configured", async () => {
    _setEasyPostClientForTests(new EasyPostClient({ webhookSecret: WEBHOOK_SECRET }));
    const app = await buildApp();
    try {
      const payload = JSON.stringify({ id: "evt_1", description: "tracker.updated", result: {} });
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/webhook/easypost",
        payload,
        headers: { "content-type": "application/json", "x-hmac-signature": "hmac-sha256-hex=deadbeef" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("accepts a correctly-signed tracker.updated (in_transit) and emits a byte-verifiable EvidenceEvent", async () => {
    const client = new EasyPostClient({ webhookSecret: WEBHOOK_SECRET });
    _setEasyPostClientForTests(client);
    const app = await buildApp();
    try {
      const bought = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      const { trackingCode } = bought.json();

      const webhookBody = JSON.stringify({
        id: "evt_pickup_1",
        description: "tracker.updated",
        result: {
          tracking_code: trackingCode,
          status: "in_transit",
          status_detail: "arrived_at_destination_facility",
          carrier: "USPS",
          updated_at: "2026-08-27T14:22:00Z",
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/webhook/easypost",
        payload: webhookBody,
        headers: { "content-type": "application/json", "x-hmac-signature": sign(webhookBody) },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.matched).toBe(true);
      expect(body.status).toBe("in_transit");

      const record = getCarrierShipmentStore().getByJobId("job-print-mail-1")!;
      expect(record.status).toBe("in_transit");
      expect(record.events).toHaveLength(1);
      const event = record.events[0]!;
      expect(event.type).toBe("courier_pickup_confirmed");
      expect(event.source.deviceType).toBe("courier_api");
      expect(event.source.kernelId).toBe("kernel-hp-printer");
      expect(event.source.simulated).toBe(true); // mock-mode label -> must be flagged non-authentic
      expect(event.timestamp).toBe("2026-08-27T14:22:00Z");

      // The hash is not just present — it is the SAME canonical hash the rest
      // of the evidence pipeline (@pcc/spec) would recompute and check.
      expect(await verifyEventHash(event)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("is idempotent on EasyPost's event id — a retried delivery does not duplicate the EvidenceEvent", async () => {
    const client = new EasyPostClient({ webhookSecret: WEBHOOK_SECRET });
    _setEasyPostClientForTests(client);
    const app = await buildApp();
    try {
      const bought = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      const { trackingCode } = bought.json();
      const webhookBody = JSON.stringify({
        id: "evt_retry_1",
        description: "tracker.updated",
        result: { tracking_code: trackingCode, status: "in_transit", carrier: "USPS", updated_at: "2026-08-27T14:22:00Z" },
      });
      const headers = { "content-type": "application/json", "x-hmac-signature": sign(webhookBody) };

      const first = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: webhookBody, headers });
      const second = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: webhookBody, headers });

      expect(first.json().deduped).toBe(false);
      expect(second.json().deduped).toBe(true);
      expect(getCarrierShipmentStore().getByJobId("job-print-mail-1")!.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("does not treat a scan for an uncommitted tracking code as evidence for any job", async () => {
    const client = new EasyPostClient({ webhookSecret: WEBHOOK_SECRET });
    _setEasyPostClientForTests(client);
    const app = await buildApp();
    try {
      const webhookBody = JSON.stringify({
        id: "evt_stray_1",
        description: "tracker.updated",
        result: { tracking_code: "EZ_NEVER_COMMITTED", status: "in_transit", carrier: "USPS", updated_at: "2026-08-27T14:22:00Z" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/webhook/easypost",
        payload: webhookBody,
        headers: { "content-type": "application/json", "x-hmac-signature": sign(webhookBody) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().matched).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("emits courier_delivery_confirmed on a delivered transition", async () => {
    const client = new EasyPostClient({ webhookSecret: WEBHOOK_SECRET });
    _setEasyPostClientForTests(client);
    const app = await buildApp();
    try {
      const bought = await app.inject({ method: "POST", url: "/api/carrier/shipments", payload: validBody });
      const { trackingCode } = bought.json();
      const body1 = JSON.stringify({
        id: "evt_a",
        description: "tracker.updated",
        result: { tracking_code: trackingCode, status: "in_transit", carrier: "USPS", updated_at: "2026-08-27T14:22:00Z" },
      });
      await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: body1, headers: { "content-type": "application/json", "x-hmac-signature": sign(body1) } });

      const body2 = JSON.stringify({
        id: "evt_b",
        description: "tracker.updated",
        result: { tracking_code: trackingCode, status: "delivered", carrier: "USPS", updated_at: "2026-08-29T09:00:00Z" },
      });
      const res2 = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: body2, headers: { "content-type": "application/json", "x-hmac-signature": sign(body2) } });

      expect(res2.json().status).toBe("delivered");
      const record = getCarrierShipmentStore().getByJobId("job-print-mail-1")!;
      expect(record.events).toHaveLength(2);
      expect(record.events[1]!.type).toBe("courier_delivery_confirmed");
    } finally {
      await app.close();
    }
  });
});
