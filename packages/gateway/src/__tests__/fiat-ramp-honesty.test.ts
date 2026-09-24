/**
 * Fiat ramp honesty and privacy (board N48; N34 family "fiat-ramp").
 *
 *  - GET /api/fiat-ramp/sessions used to return EVERY account's ramp sessions (wallets,
 *    amounts) to any key. It is now owner-scoped: the caller's own wallet, or all with a
 *    valid X-Admin-Key.
 *  - Provider routes used to answer like the real provider when it was not configured.
 *    Now: 503 not_configured, unless PCC_DEMO_ROUTES=true, and then every response is
 *    marked mock/demo.
 *  - The faucet used to report a FAILED mint (and a skipped one) as success with a
 *    made-up transaction hash, and GET ?wallet= reported a drip without minting.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The faucet's on-chain mint must never reach a network from tests: make the wallet
// client throw like an unreachable RPC.
vi.mock("viem", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    createWalletClient: () => ({
      sendTransaction: async () => {
        throw new Error("rpc unreachable (test)");
      },
    }),
  };
});

const { fiatRampRoutes } = await import("../routes/fiat-ramp.js");

const WALLET_A = "0xaaaa00000000000000000000000000000000000a";
const WALLET_B = "0xbbbb00000000000000000000000000000000000b";
const ADMIN = "fiat-test-admin-key";
const PROVIDER_ENV = [
  "COINBASE_APP_ID",
  "STRIPE_SECRET_KEY",
  "YELLOWCARD_API_KEY",
  "WISE_API_TOKEN",
  "WISE_PROFILE_ID",
  "CDP_API_KEY_ID",
  "DEPLOYER_PRIVATE_KEY",
  "PCC_GATEWAY_PRIVATE_KEY",
  "PCC_DEMO_ROUTES",
  "PCC_ADMIN_KEY",
];

let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of PROVIDER_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  app = Fastify({ logger: false });
  // Stand-in for the API gate: it sets req.operatorId from the API key.
  app.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    if (typeof p === "string") (req as any).operatorId = p;
  });
  await app.register(fiatRampRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const k of PROVIDER_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

beforeEach(() => {
  delete process.env.PCC_DEMO_ROUTES;
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.DEPLOYER_PRIVATE_KEY;
});

const req = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers: { "x-test-principal": WALLET_A, ...headers } });

const YC_WITHDRAW = {
  walletAddress: WALLET_A,
  amountUsd: "10",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch-1",
  destination: { type: "bank_transfer", accountName: "A", accountNumber: "1", country: "NG" },
  sender: { name: "A", country: "NG", address: "x", dob: "1990-01-01", email: "a@example.invalid", idNumber: "1", idType: "passport" },
};
const YC_DEPOSIT = {
  fiatAmount: "1000",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch-1",
  recipient: { name: "A", country: "NG", phone: "1", address: "x", dob: "1990-01-01", idNumber: "1", idType: "passport" },
  walletAddress: WALLET_A,
};
const WISE = { sourceAmount: 10, recipient: { name: "A", currency: "EUR", type: "iban", details: {} }, reference: "r" };

const PROVIDER_ROUTES: Array<[string, "GET" | "POST" | "DELETE", string, unknown]> = [
  ["coinbase", "POST", "/api/fiat-ramp/coinbase/onramp", { walletAddress: WALLET_A, amount: 20 }],
  ["coinbase", "GET", `/api/fiat-ramp/coinbase/onramp-url?wallet=${WALLET_A}`, undefined],
  ["stripe", "POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A }],
  ["yellowcard", "GET", "/api/fiat-ramp/yellowcard/channels", undefined],
  ["yellowcard", "GET", "/api/fiat-ramp/yellowcard/rates", undefined],
  ["yellowcard", "POST", "/api/fiat-ramp/yellowcard/withdraw", YC_WITHDRAW],
  ["yellowcard", "POST", "/api/fiat-ramp/yellowcard/deposit", YC_DEPOSIT],
  ["wise", "POST", "/api/fiat-ramp/wise/payout", WISE],
  ["wise", "POST", "/api/fiat-ramp/wise/batch-payout", { payouts: [WISE] }],
  ["cdp", "POST", "/api/fiat-ramp/cdp/wallet", undefined],
  ["cdp", "POST", "/api/fiat-ramp/cdp/provision", {}],
  ["cdp", "GET", `/api/fiat-ramp/cdp/wallet/${WALLET_A}/balance`, undefined],
  ["cdp", "POST", "/api/fiat-ramp/cdp/spend-permission", { walletAddress: WALLET_A, spender: WALLET_B, allowanceUSDC: 5 }],
];

describe("NEGATIVE: an unconfigured provider fails closed (no provider-shaped data)", () => {
  for (const [provider, method, url, body] of PROVIDER_ROUTES) {
    it(`${method} ${url.split("?")[0]} -> 503 not_configured`, async () => {
      const res = await req(method, url, body);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "not_configured", provider });
      // Nothing provider-shaped leaks into the refusal.
      expect(res.body).not.toMatch(/PAGA|TRC20|cos_mock|COMPLETED|onrampUrl|pay\.coinbase\.com/);
    });
  }

  it("Wise needs the profile too: a token without WISE_PROFILE_ID is not configured", async () => {
    process.env.WISE_API_TOKEN = "t";
    try {
      const res = await req("POST", "/api/fiat-ramp/wise/payout", WISE);
      expect(res.statusCode).toBe(503);
    } finally {
      delete process.env.WISE_API_TOKEN;
    }
  });

  it("status says demo routes are off", async () => {
    const res = await req("GET", "/api/fiat-ramp/status");
    expect(res.json().demoRoutes).toBe(false);
  });
});

describe("PCC_DEMO_ROUTES=true: simulated responses, each marked mock/demo", () => {
  beforeEach(() => {
    process.env.PCC_DEMO_ROUTES = "true";
  });

  for (const [, method, url, body] of PROVIDER_ROUTES) {
    it(`${method} ${url.split("?")[0]} -> 200 with mock:true, demo:true`, async () => {
      const res = await req(method, url, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ mock: true, demo: true });
    });
  }

  it("a simulated CDP wallet is not usable", async () => {
    const res = await req("POST", "/api/fiat-ramp/cdp/wallet");
    expect(res.json().usableNow).toBe(false);
  });
});

describe("NEGATIVE: GET /api/fiat-ramp/sessions is owner-scoped", () => {
  beforeAll(async () => {
    // Two accounts each open a (demo) ramp session into their own wallet.
    process.env.PCC_DEMO_ROUTES = "true";
    expect((await req("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A }, { "x-test-principal": WALLET_A })).statusCode).toBe(200);
    expect((await req("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_B }, { "x-test-principal": WALLET_B })).statusCode).toBe(200);
    delete process.env.PCC_DEMO_ROUTES;
  });

  const wallets = (res: { json(): any }) => (res.json().sessions as Array<{ walletAddress: string }>).map((s) => s.walletAddress.toLowerCase());

  it("a caller sees only the sessions for its own wallet", async () => {
    const a = await req("GET", "/api/fiat-ramp/sessions", undefined, { "x-test-principal": WALLET_A });
    expect(a.statusCode).toBe(200);
    expect(wallets(a).length).toBeGreaterThan(0);
    expect(new Set(wallets(a))).toEqual(new Set([WALLET_A]));
    expect(a.json().scope).toBe("caller_wallet");
    const b = await req("GET", "/api/fiat-ramp/sessions", undefined, { "x-test-principal": WALLET_B.toUpperCase().replace("0X", "0x") });
    expect(new Set(wallets(b))).toEqual(new Set([WALLET_B]));
  });

  it("a caller identified by email (not a wallet) sees none, and is told why", async () => {
    const res = await req("GET", "/api/fiat-ramp/sessions", undefined, { "x-test-principal": "someone@example.invalid" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessions: [], attributable: false });
  });

  it("anonymous is 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/fiat-ramp/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("a valid admin key sees every session; a wrong one does not", async () => {
    process.env.PCC_ADMIN_KEY = ADMIN;
    const admin = await req("GET", "/api/fiat-ramp/sessions", undefined, { "x-admin-key": ADMIN, "x-test-principal": "ops@example.invalid" });
    // Every account's sessions (earlier demo tests opened some too), not one caller's.
    expect(wallets(admin)).toEqual(expect.arrayContaining([WALLET_A, WALLET_B]));
    expect(admin.json().scope).toBe("all");
    const wrong = await req("GET", "/api/fiat-ramp/sessions", undefined, { "x-admin-key": ADMIN + "x", "x-test-principal": WALLET_A });
    expect(new Set(wallets(wrong))).toEqual(new Set([WALLET_A]));
  });

  it("an unset admin key grants nothing (no development bypass)", async () => {
    const res = await req("GET", "/api/fiat-ramp/sessions", undefined, { "x-admin-key": "", "x-test-principal": "ops@example.invalid" });
    expect(res.json().sessions).toEqual([]);
  });
});

describe("NEGATIVE: the faucet never reports a mint that did not happen", () => {
  it("no minting key and no demo flag: 503, success false", async () => {
    const res = await req("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, error: "not_configured" });
  });

  it("a mint that throws is 502 success:false, never a mock success with a made-up hash", async () => {
    process.env.DEPLOYER_PRIVATE_KEY = "0x" + "11".repeat(32);
    const res = await req("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, error: "mint_failed" });
    expect(res.body).not.toContain("f".repeat(64));
  });

  it("demo: says nothing was minted and carries no transaction hash", async () => {
    process.env.PCC_DEMO_ROUTES = "true";
    const res = await req("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ minted: false, txHash: null, mock: true, demo: true });
  });

  it("GET ?wallet= never reports a drip", async () => {
    const res = await req("GET", `/api/faucet/usdc?wallet=${WALLET_A}&amount=100`);
    expect(res.statusCode).toBe(405);
    expect(res.json()).toMatchObject({ success: false, error: "use_post" });
  });
});
