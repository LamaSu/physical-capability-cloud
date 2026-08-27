/**
 * Carrier routes BEHIND the real apiGate — the negative control the first
 * revision of this PR lacked. sol #297 finding 15: the webhook route sat
 * behind PCC's API-key gate, so EasyPost's deliveries would have 401'd before
 * the HMAC check ever ran, and a test suite that mounted the routes on a bare
 * Fastify could never notice. This suite mounts apiGate first.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { apiGate } from "../middleware/api-gate.js";
import { carrierRoutes } from "../routes/carrier.js";
import { EasyPostClient, _setEasyPostClientForTests } from "../services/easypost-client.js";
import { _resetCarrierShipmentStoreForTests, initCarrierShipmentStore } from "../services/carrier-shipment-store.js";
import { initStore, closeStore } from "../db.js";

const SECRET = "whsec_gate_suite";
const sign = (body: string) => "hmac-sha256-hex=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

async function buildGatedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(carrierRoutes);
  await app.ready();
  return app;
}

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
});
afterAll(() => closeStore());
beforeEach(() => {
  _resetCarrierShipmentStoreForTests();
  initCarrierShipmentStore({});
  _setEasyPostClientForTests(new EasyPostClient({ webhookSecret: SECRET }));
});
afterEach(() => {
  _resetCarrierShipmentStoreForTests();
  _setEasyPostClientForTests(undefined);
});

describe("carrier routes behind apiGate (finding 15)", () => {
  it("the webhook POST passes the API-key gate unauthenticated and reaches HMAC verification", async () => {
    const app = await buildGatedApp();
    try {
      const body = JSON.stringify({ id: "e", description: "tracker.updated", result: { tracking_code: "EZ_NONE", status: "in_transit", updated_at: "2026-08-27T14:22:00Z" } });
      // No Bearer, no session — only EasyPost's HMAC. Must NOT be the gate's 401.
      const good = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: body, headers: { "content-type": "application/json", "x-hmac-signature": sign(body) } });
      expect(good.statusCode).toBe(200);
      expect(good.json()).toMatchObject({ received: true, matched: false, reason: "unknown_tracking_code" });

      // And a bad signature is rejected BY THE ROUTE (its own 401 body), not by the gate.
      const bad = await app.inject({ method: "POST", url: "/api/carrier/webhook/easypost", payload: body, headers: { "content-type": "application/json", "x-hmac-signature": "hmac-sha256-hex=00" } });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error).toBe("invalid_signature");
    } finally {
      await app.close();
    }
  });

  it("everything else under /api/carrier/ stays gated (401 api_key_required without credentials)", async () => {
    const app = await buildGatedApp();
    try {
      for (const [method, url] of [
        ["POST", "/api/carrier/shipments"],
        ["GET", "/api/carrier/shipments/job-x"],
        ["GET", "/api/carrier/healthz"],
        ["GET", "/api/carrier/webhook/easypost"], // only POST is exempt
      ] as const) {
        const res = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
        expect(res.json().error, `${method} ${url}`).toBe("api_key_required");
      }
    } finally {
      await app.close();
    }
  });
});
