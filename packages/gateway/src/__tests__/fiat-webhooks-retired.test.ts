import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { fiatRampRoutes } from "../routes/fiat-ramp.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore } from "../db.js";

/**
 * PR 2 — the legacy Stripe prepaid-credits path and the unsigned provider webhooks are
 * RETIRED (410 by default). The webhooks verified NO provider signature, so an
 * AUTHENTICATED PCC principal could POST a forged `checkout.session.completed` and mint
 * credits — being behind an API key is NOT provider authentication. Nothing consumes the
 * credits (deductCredits is never called in real code; the rail is x402 / on-chain USDC),
 * so the path is removed rather than hardened; funding moves to direct USDC.
 * PCC_LEGACY_FIAT_WEBHOOKS used to re-enable it outside production; it re-enables nothing
 * now, in any environment (board N48, cross-family review of #373 at d5be8805, finding D).
 */
describe("legacy fiat webhooks + credits are RETIRED (audit PR2)", () => {
  let app: FastifyInstance;
  const prevFlag = process.env.PCC_LEGACY_FIAT_WEBHOOKS;
  const prevDb = process.env.PCC_DB_PATH;
  let n = 0;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    delete process.env.PCC_LEGACY_FIAT_WEBHOOKS; // default → retired
    initStore({ seed: false });
    app = Fastify();
    await app.register(apiGate);
    await app.register(fiatRampRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (prevFlag === undefined) delete process.env.PCC_LEGACY_FIAT_WEBHOOKS;
    else process.env.PCC_LEGACY_FIAT_WEBHOOKS = prevFlag;
    if (prevDb === undefined) delete process.env.PCC_DB_PATH;
    else process.env.PCC_DB_PATH = prevDb;
  });

  const bearer = () => ({
    authorization: `Bearer ${provisionApiKey({ operatorId: `wh-${++n}@x.com`, scopes: [] }).rawKey}`,
  });
  const forgedCredit = {
    type: "checkout.session.completed",
    data: { object: { metadata: { user_id: "victim", credits: "1000000" }, amount_total: 100 } },
  };

  // ── the vuln is closed: an authenticated principal cannot forge a credit ──
  it("410s an AUTHENTICATED caller forging a Stripe credit webhook — no credits minted", async () => {
    delete process.env.PCC_LEGACY_FIAT_WEBHOOKS;
    const r = await app.inject({
      method: "POST",
      url: "/api/fiat-ramp/webhook/stripe",
      headers: bearer(),
      payload: forgedCredit,
    });
    expect(r.statusCode).toBe(410);
  });

  it("401s an anonymous caller on the Stripe webhook (api-gate — the route is not public)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/fiat-ramp/webhook/stripe", payload: forgedCredit });
    expect(r.statusCode).toBe(401);
  });

  it("410s the Yellow Card webhook (authenticated)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/fiat-ramp/webhook/yellowcard",
      headers: bearer(),
      payload: { event: "COLLECTION.COMPLETE", data: { id: "x" } },
    });
    expect(r.statusCode).toBe(410);
  });

  it("410s the credits deposit + balance endpoints (authenticated)", async () => {
    expect(
      (await app.inject({
        method: "POST",
        url: "/api/fiat-ramp/stripe/credits/deposit",
        headers: bearer(),
        payload: { amountUsd: 50 },
      })).statusCode,
    ).toBe(410);
    expect(
      (await app.inject({ method: "GET", url: "/api/fiat-ramp/stripe/credits/anyuser", headers: bearer() })).statusCode,
    ).toBe(410);
  });

  // ── the legacy flag re-enables nothing, in any environment ──
  it("PCC_LEGACY_FIAT_WEBHOOKS=true re-enables nothing: the credits and webhooks stay 410", async () => {
    process.env.PCC_LEGACY_FIAT_WEBHOOKS = "true";
    for (const [method, url, payload] of [
      ["GET", "/api/fiat-ramp/stripe/credits/nobody", undefined],
      ["POST", "/api/fiat-ramp/stripe/credits/deposit", { amountUsd: 50 }],
      ["POST", "/api/fiat-ramp/webhook/stripe", forgedCredit],
      ["POST", "/api/fiat-ramp/webhook/yellowcard", { event: "COLLECTION.COMPLETE", data: { id: "x" } }],
    ] as const) {
      const r = await app.inject({ method, url, headers: bearer(), payload: payload as any });
      expect(r.statusCode, url).toBe(410);
    }
    delete process.env.PCC_LEGACY_FIAT_WEBHOOKS;
  });

  it("production boots with the legacy flag set (it is ignored) and still answers 410", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.PCC_LEGACY_FIAT_WEBHOOKS = "true";
    const prod = Fastify();
    await prod.register(apiGate);
    await prod.register(fiatRampRoutes);
    await expect(prod.ready()).resolves.toBeDefined();
    const r = await prod.inject({ method: "POST", url: "/api/fiat-ramp/webhook/stripe", headers: bearer(), payload: forgedCredit });
    expect(r.statusCode).toBe(410);
    await prod.close();
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    delete process.env.PCC_LEGACY_FIAT_WEBHOOKS;
  });
});
