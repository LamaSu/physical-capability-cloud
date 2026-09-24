/**
 * WP-A fold F6 (shell #2499): fiat-ramp never presents a MOCK wallet as usable
 * and never builds a real-money onramp for an address no key controls.
 *
 * With no CDP credentials, CdpWalletClient is in mock mode and createWallet()
 * returns an address nobody controls. Before this change:
 *   - POST /api/fiat-ramp/cdp/wallet returned it with `usableNow: true` and
 *     "Usable on PCC now";
 *   - POST /api/fiat-ramp/coinbase/onramp (and GET .../onramp-url) built a REAL
 *     https://pay.coinbase.com checkout URL for ANY walletAddress, mock or not —
 *     so a user could buy USDC into an unrecoverable address.
 * Now: the mock wallet says so (mock:true, usableNow:false, honest note); the
 * onramp refuses 503 while the wallet client is mock, 409 wallet_not_custodial
 * for an address minted in mock mode (recognizable by construction — see
 * @pcc/payments isCdpMockAddress), and 400 for a malformed address.
 *
 * The routes' CDP client is a module singleton that reads env on first use, so
 * each mode re-imports the route module (vi.resetModules).
 *
 * With N48 (#373) merged on top: an unconfigured CDP answers 503 not_configured unless
 * PCC_DEMO_ROUTES is on, so the mock-wallet body is a DEMO answer (marked mock/demo), and
 * "configured" means all three CDP credentials. F6's refusals still apply after that gate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const CDP_ENV = ["CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "COINBASE_APP_ID", "CDP_NETWORK", "PCC_DEMO_ROUTES"] as const;
const saved: Record<string, string | undefined> = {};
const REAL_LOOKING = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const MOCK_MINTED = "0x000000000000000000000000a1b2c3d4e5f60718";

let app: FastifyInstance | undefined;

async function buildApp(): Promise<FastifyInstance> {
  vi.resetModules();
  const { fiatRampRoutes } = await import("../routes/fiat-ramp.js");
  const a = Fastify({ logger: false });
  await a.register(fiatRampRoutes);
  await a.ready();
  return a;
}

beforeEach(() => {
  for (const k of CDP_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
  for (const k of CDP_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("F6 — CDP wallet client in MOCK mode (no CDP credentials)", () => {
  it("POST /cdp/wallet without demo mode creates nothing (503 not_configured)", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/wallet" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "not_configured", provider: "cdp" });
    expect(res.json().walletAddress).toBeUndefined();
  });

  it("POST /cdp/wallet in demo mode never calls a mock wallet usable", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/wallet" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.demo).toBe(true);
    expect(body.mock).toBe(true);
    expect(body.usableNow).toBe(false);
    expect(body.note).toMatch(/MOCK/);
    expect(body.note).toMatch(/unrecoverable/);
    expect(body.note).not.toMatch(/Usable on PCC now/);
    const { isCdpMockAddress } = await import("@pcc/payments");
    expect(isCdpMockAddress(body.walletAddress)).toBe(true);
  });

  it("POST /coinbase/onramp REFUSES outright (503) — for any address, including its own mock wallet", async () => {
    process.env.COINBASE_APP_ID = "live-app-id"; // the shell's scenario: onramp configured, CDP not
    app = await buildApp();
    for (const walletAddress of [REAL_LOOKING, MOCK_MINTED]) {
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/coinbase/onramp", payload: { walletAddress } });
      expect(res.statusCode, walletAddress).toBe(503);
      expect(res.json().error).toBe("cdp_wallet_mock");
      expect(res.json().onrampUrl).toBeUndefined();
      expect(res.body).not.toContain("pay.coinbase.com");
    }
  });

  it("GET /coinbase/onramp-url (same real-money URL) refuses too", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/fiat-ramp/coinbase/onramp-url?wallet=${REAL_LOOKING}` });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("pay.coinbase.com");
  });

  it("POST /cdp/provision (demo mode) is honest that the wallet and URL are mock", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/provision", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().demo).toBe(true);
    expect(res.json().mock).toBe(true);
    expect(res.json().instructions).toMatch(/MOCK/);
    expect(res.json().instructions).not.toMatch(/pay once by card/);
  });
});

describe("F6 — CDP wallet client REAL (credentials present)", () => {
  beforeEach(() => {
    // All three CDP credentials make it live (a key id alone is a partial configuration,
    // which stays mock). No network is touched: the onramp route only reads isMock and
    // builds a URL.
    process.env.CDP_API_KEY_ID = "test-cdp-key-id";
    process.env.CDP_API_KEY_SECRET = "test-cdp-key-secret";
    process.env.CDP_WALLET_SECRET = "test-cdp-wallet-secret";
    process.env.COINBASE_APP_ID = "live-app-id";
  });

  it("an address minted in mock mode is refused 409 wallet_not_custodial (POST and GET)", async () => {
    app = await buildApp();
    const post = await app.inject({ method: "POST", url: "/api/fiat-ramp/coinbase/onramp", payload: { walletAddress: MOCK_MINTED } });
    expect(post.statusCode).toBe(409);
    expect(post.json().error).toBe("wallet_not_custodial");
    expect(post.body).not.toContain("pay.coinbase.com");
    const get = await app.inject({ method: "GET", url: `/api/fiat-ramp/coinbase/onramp-url?wallet=${MOCK_MINTED}` });
    expect(get.statusCode).toBe(409);
  });

  it("a malformed walletAddress is refused 400 (never embedded in a checkout URL)", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/coinbase/onramp", payload: { walletAddress: "not-an-address" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_wallet_address");
  });

  it("control: a real address still gets its Coinbase onramp URL", async () => {
    app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/coinbase/onramp", payload: { walletAddress: REAL_LOOKING, amount: 25 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().onrampUrl).toContain("https://pay.coinbase.com/buy/select-asset");
    expect(decodeURIComponent(res.json().onrampUrl)).toContain(REAL_LOOKING);
  });
});
