/**
 * Carrier config gate: FAIL AT THE REQUEST, NOT AT BOOT.
 *
 * Regression for the defect that reddened master CI on 2026-09-02. server.ts registers
 * carrierRoutes UNCONDITIONALLY, and carrierRoutes used to `throw` during registration when
 * production config was incomplete. Composed, that meant a missing shipping-vendor credential
 * took down the ENTIRE gateway — including deployments that will never mail anything
 * (printing-only, CNC-only) — and staging, which boots in production mode without EasyPost
 * credentials, served 502 on every route until the deploy-staging smoke test gave up.
 *
 * The safety property is NOT relaxed by the fix and is asserted here: it must remain
 * impossible to buy a label or admit a carrier scan without real credentials. What changed is
 * only the blast radius — the mail capability goes unavailable and SAYS SO, instead of the
 * process refusing to start.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { carrierRoutes } from "../routes/carrier.js";
import { _resetCarrierShipmentStoreForTests, initCarrierShipmentStore } from "../services/carrier-shipment-store.js";
import { initStore, closeStore } from "../db.js";

const CARRIER_ENV = ["EASYPOST_API_KEY", "EASYPOST_WEBHOOK_SECRET"] as const;

let savedNodeEnv: string | undefined;
const savedCarrierEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
});
afterAll(() => closeStore());

beforeEach(() => {
  savedNodeEnv = process.env.NODE_ENV;
  for (const k of CARRIER_ENV) {
    savedCarrierEnv[k] = process.env[k];
    delete process.env[k];
  }
  _resetCarrierShipmentStoreForTests();
  initCarrierShipmentStore({});
});

afterEach(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  for (const k of CARRIER_ENV) {
    if (savedCarrierEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedCarrierEnv[k] as string;
  }
  _resetCarrierShipmentStoreForTests();
});

/** NODE_ENV is read at REGISTRATION time, so it must be set before register(). */
async function buildApp(nodeEnv: string): Promise<FastifyInstance> {
  process.env.NODE_ENV = nodeEnv;
  const app = Fastify({ logger: false });
  await app.register(carrierRoutes);
  await app.ready();
  return app;
}

describe("carrier config gate — production, nothing configured", () => {
  it("REGISTERS without throwing (the regression: this used to kill the whole gateway)", async () => {
    // The assertion is that this line does not reject. A throw here is the 502.
    const app = await buildApp("production");
    expect(app).toBeTruthy();
    await app.close();
  });

  it("keeps /api/carrier/healthz serving, so ops can see WHAT is unconfigured", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // healthz already reported these; the fix must not take that visibility away.
      expect(body).toHaveProperty("webhookConfigured");
      expect(body).toHaveProperty("commitmentSigningConfigured");
      expect(body).toHaveProperty("durable");
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED on the webhook — evidence cannot be admitted without real config", async () => {
    const app = await buildApp("production");
    try {
      const body = JSON.stringify({ id: "e", description: "tracker.updated", result: { tracking_code: "EZ_X", status: "in_transit" } });
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/webhook/easypost",
        payload: body,
        headers: { "content-type": "application/json", "x-hmac-signature": "hmac-sha256-hex=deadbeef" },
      });
      expect(res.statusCode).toBe(503);
      const json = res.json();
      expect(json.error).toBe("carrier_not_configured");
      // The response must name what is missing — a 503 with no actionable detail is a dead end.
      expect(Array.isArray(json.missing)).toBe(true);
      expect(json.missing.join(" ")).toContain("EASYPOST_API_KEY");
      expect(json.missing.join(" ")).toContain("EASYPOST_WEBHOOK_SECRET");
    } finally {
      await app.close();
    }
  });

  it("FAILS CLOSED on the money route rather than reaching label purchase", async () => {
    const app = await buildApp("production");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/carrier/shipments",
        payload: { jobId: "job-1", kernelId: "k-1", documentHash: "a".repeat(64) },
        headers: { "content-type": "application/json" },
      });
      // Unauthenticated, so 401 is correct and is still fail-closed — the point is that it is
      // NEVER 2xx, i.e. no label can be bought on this deployment.
      expect([401, 503]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("carrier config gate — non-production is untouched", () => {
  it("does not gate outside production, so every existing suite behaves exactly as before", async () => {
    const app = await buildApp("test");
    try {
      const res = await app.inject({ method: "GET", url: "/api/carrier/healthz" });
      expect(res.statusCode).toBe(200);
      // No carrier_not_configured anywhere in dev/test: the gate is production-only, which is
      // why this change cannot alter the behaviour the other carrier suites assert.
      const evidence = await app.inject({ method: "GET", url: "/api/carrier/shipments/job-1/evidence" });
      expect(evidence.statusCode).not.toBe(503);
    } finally {
      await app.close();
    }
  });
});
