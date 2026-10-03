/**
 * Payment statistics belong to the app that counted them (astra, pack 58 verdict,
 * residual). Round 8 keyed the payment gate's descriptor per app (FC-3), but the
 * counters and recent payments behind /api/x402/stats stayed module-global, so
 * one app's traffic showed in every other app's stats. Reproduced at 9a44e8f2
 * before any code changed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const ENV_KEYS = ["PCC_PAYMENT_ENABLED", "MPP_SECRET_KEY", "TEMPO_RECIPIENT", "PCC_TREASURY_ADDRESS", "PCC_X402_LEGACY"] as const;
const saved: Record<string, string | undefined> = {};
const apps: FastifyInstance[] = [];

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PCC_PAYMENT_ENABLED = "true";
  process.env.MPP_SECRET_KEY = "test-only-mpp-secret-key-0123456789abcdef";
  // No recipient: the gate is "unconfigured" and counts every request it sees.
  delete process.env.TEMPO_RECIPIENT;
  delete process.env.PCC_TREASURY_ADDRESS;
  delete process.env.PCC_X402_LEGACY;
});

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function gatedApp(): Promise<FastifyInstance> {
  const { paymentGate } = await import("../middleware/x402-gate.js");
  const a = Fastify({ logger: false });
  await paymentGate(a);
  a.get("/ping", async () => ({ ok: true }));
  await a.ready();
  apps.push(a);
  return a;
}

describe("x402 payment stats are per app", () => {
  it("[neg] traffic on app A does not appear in app B's /api/x402/stats", async () => {
    const a = await gatedApp();
    const b = await gatedApp();
    for (let i = 0; i < 5; i += 1) await a.inject({ method: "GET", url: "/ping" });
    const statsB = (await b.inject({ method: "GET", url: "/api/x402/stats" })).json() as { totalRequests: number };
    // B has seen only its own stats request.
    expect(statsB.totalRequests).toBeLessThanOrEqual(1);
  });

  it("control: an app's own traffic is counted", async () => {
    const a = await gatedApp();
    for (let i = 0; i < 5; i += 1) await a.inject({ method: "GET", url: "/ping" });
    const statsA = (await a.inject({ method: "GET", url: "/api/x402/stats" })).json() as { totalRequests: number };
    expect(statsA.totalRequests).toBeGreaterThanOrEqual(5);
  });
});
