/**
 * WP-A round 5 (sol #2963 items 5-6; shell #3352): the fiat-ramp CDP routes, over the real
 * route plugin with CDP in mock mode.
 *
 * - CDP_API_KEY_ID alone no longer makes the CDP clients "real". Before, the wallet
 *   client went real on the key id alone, so /coinbase/onramp built a real-money checkout
 *   while the wallets it had issued were still mock.
 * - Balance results say mock: true.
 * - Revoking an unknown spend permission is 404 (it answered revoked: true), and a
 *   malformed spend permission is 400 (it was issued anyway).
 *
 * fetch is stubbed, so nothing leaves the box.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const ENV = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "CDP_NETWORK", "COINBASE_APP_ID"] as const;
const saved: Record<string, string | undefined> = {};
let app: FastifyInstance | undefined;

async function buildApp(): Promise<FastifyInstance> {
  vi.resetModules(); // the route module caches its CDP clients
  const { fiatRampRoutes } = await import("../routes/fiat-ramp.js");
  const a = Fastify({ logger: false });
  await a.register(fiatRampRoutes);
  await a.ready();
  return a;
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
});

afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const WALLET = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

describe("CDP credentials: the key id alone is not real mode", () => {
  it("[neg] CDP_API_KEY_ID without its secrets: no real-money onramp is built (503 cdp_wallet_mock)", async () => {
    process.env.CDP_API_KEY_ID = "key-id-only";
    process.env.COINBASE_APP_ID = "app-id";
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/coinbase/onramp", payload: { walletAddress: WALLET } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "cdp_wallet_mock" });
    expect(res.body).not.toContain("pay.coinbase.com");
  });
});

describe("mock CDP answers are marked or refused", () => {
  it("[neg] a mock balance says mock: true", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fiat-ramp/cdp/wallet/${WALLET}/balance` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ usdc: 0, mock: true });
  });

  it("[neg] revoking a spend permission this gateway does not know is 404, not revoked: true", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/fiat-ramp/cdp/spend-permission/0xdeadbeef" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(/"revoked":\s*true/);
  });

  it("[neg] a malformed spend permission is 400 and nothing is issued", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/fiat-ramp/cdp/spend-permission",
      payload: { walletAddress: WALLET, spender: WALLET, allowanceUSDC: -5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("permissionId");
  });

  it("control: a well-formed mock permission is issued, marked, and revocable once", async () => {
    app = await buildApp();
    const issued = await app.inject({
      method: "POST",
      url: "/api/fiat-ramp/cdp/spend-permission",
      payload: { walletAddress: WALLET, spender: WALLET, allowanceUSDC: 5 },
    });
    expect(issued.statusCode).toBe(200);
    const perm = issued.json() as { permissionId: string; mock?: boolean };
    expect(perm.mock).toBe(true);
    const revoked = await app.inject({ method: "DELETE", url: `/api/fiat-ramp/cdp/spend-permission/${perm.permissionId}` });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ revoked: true, mock: true });
  });
});
