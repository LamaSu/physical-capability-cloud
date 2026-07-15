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
 * PCC_LEGACY_FIAT_WEBHOOKS=true is a dev-only escape hatch (still unsigned — never prod).
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

  // ── the retire is a reversible flag, not a hardcoded break ──
  it("escape hatch: PCC_LEGACY_FIAT_WEBHOOKS=true makes the credits route live again (404, not 410)", async () => {
    process.env.PCC_LEGACY_FIAT_WEBHOOKS = "true";
    const r = await app.inject({ method: "GET", url: "/api/fiat-ramp/stripe/credits/nobody", headers: bearer() });
    expect(r.statusCode).toBe(404); // live handler → "no balance", not the 410-retired guard
    delete process.env.PCC_LEGACY_FIAT_WEBHOOKS;
  });

  // ── the escape hatch is enforced, not just documented: prod boot fails if it's set ──
  it("FAILS STARTUP under NODE_ENV=production when the legacy flag is set", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.PCC_LEGACY_FIAT_WEBHOOKS = "true";
    const bad = Fastify();
    bad.register(fiatRampRoutes);
    await expect(bad.ready()).rejects.toThrow(/forbidden in production/);
    await bad.close().catch(() => {});
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    delete process.env.PCC_LEGACY_FIAT_WEBHOOKS;
  });
});
