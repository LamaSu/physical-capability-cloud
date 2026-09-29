/**
 * WP-A round 5 (sol #2963, the weakest link): a LIVE Wise token without
 * WISE_PROFILE_ID used to enter real mode, and both payout handlers then
 * substituted profile "12345". A live payout was attempted against a placeholder
 * account. Now a live token with a missing or malformed profile is a 503
 * provider_not_configured, and nothing reaches Wise.
 *
 * fetch is stubbed, so an attempted payout is observable and nothing leaves the box.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const WISE_ENV = ["WISE_API_TOKEN", "WISE_PROFILE_ID", "WISE_ENVIRONMENT"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance | undefined;
let fetchCalls: string[];

async function buildApp(): Promise<FastifyInstance> {
  vi.resetModules();
  const { fiatRampRoutes } = await import("../routes/fiat-ramp.js");
  const a = Fastify({ logger: false });
  await a.register(fiatRampRoutes);
  await a.ready();
  return a;
}

beforeEach(() => {
  for (const k of WISE_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  fetchCalls = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: unknown }) => {
    fetchCalls.push(`${String(url)} ${String(init?.body ?? "")}`);
    return new Response(JSON.stringify({ error: "stubbed" }), { status: 500, headers: { "content-type": "application/json" } });
  });
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  vi.unstubAllGlobals();
  for (const k of WISE_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const payout = { sourceAmount: 10, recipient: { name: "R", currency: "EUR", type: "iban", details: { iban: "DE00" } }, reference: "ref-1" };
const batch = { payouts: [payout] };

describe("Wise payouts need a real profile id", () => {
  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["malformed", "not-a-number"],
    ["zero", "0"],
  ])("[neg] a live token with a %s WISE_PROFILE_ID: 503, and nothing is sent to Wise", async (_name, profile) => {
    process.env.WISE_API_TOKEN = "live-looking-wise-token";
    if (profile !== undefined) process.env.WISE_PROFILE_ID = profile;
    app = await buildApp();
    for (const [url, body] of [["/api/fiat-ramp/wise/payout", payout], ["/api/fiat-ramp/wise/batch-payout", batch]] as const) {
      const res = await app.inject({ method: "POST", url, payload: body });
      expect(res.statusCode, url).toBe(503);
      expect(res.json()).toMatchObject({ error: "provider_not_configured", provider: "wise" });
    }
    expect(fetchCalls).toEqual([]);
    expect(fetchCalls.join(" ")).not.toContain("12345");
  });

  it("[neg] a profile id above 2^53 is refused (503), never rounded to a different account (round 8, astra FC-1)", async () => {
    process.env.WISE_API_TOKEN = "live-looking-wise-token";
    process.env.WISE_PROFILE_ID = "9007199254740993"; // Number() gives ...992
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/wise/payout", payload: payout });
    expect(res.statusCode).toBe(503);
    expect(fetchCalls).toEqual([]);
  });

  it("control: the largest exactly representable id (2^53 - 1) reaches Wise unchanged", async () => {
    process.env.WISE_API_TOKEN = "live-looking-wise-token";
    process.env.WISE_PROFILE_ID = "9007199254740991";
    app = await buildApp();
    await app.inject({ method: "POST", url: "/api/fiat-ramp/wise/payout", payload: payout });
    expect(fetchCalls.join(" ")).toContain("9007199254740991");
  });

  it("control: a live token with a valid profile does reach Wise, with that profile", async () => {
    process.env.WISE_API_TOKEN = "live-looking-wise-token";
    process.env.WISE_PROFILE_ID = "4242";
    app = await buildApp();
    await app.inject({ method: "POST", url: "/api/fiat-ramp/wise/payout", payload: payout });
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.join(" ")).not.toContain("12345");
  });
});
