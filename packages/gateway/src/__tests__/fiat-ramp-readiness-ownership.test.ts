/**
 * Fiat ramp (board N48), the fixes for the cross-family review of #373 at d5be8805
 * (A06-n48-373-r2), each with its negative case:
 *  A. CDP runs on ONE snapshot, taken at the first read of its configuration: the gate, the
 *     clients and the response label read the same network and onramp app id. A CDP_NETWORK
 *     change after that moves neither what runs nor its label; an unknown network is not live.
 *  B. Principals: a wallet address matches case-insensitively, any other id exactly.
 *  C. GET /status reports what each operation will do: Coinbase's checkout needs a live CDP,
 *     and a live /cdp/provision needs the base network and an onramp app id. Every case below
 *     calls the route and checks it agrees with the status.
 *  D. The legacy credits and unsigned webhooks answer 410 in every environment, whatever
 *     PCC_LEGACY_FIAT_WEBHOOKS says.
 *  E. Every listed session carries the mode its client recorded.
 *  F. /cdp/provision never builds a checkout it cannot stand behind, and a refusal creates
 *     nothing.
 *  G. A spend permission is money authority over a wallet: only the wallet's creator, or an
 *     X-Admin-Key holder, may issue one.
 *  H. A demo answer carries no payment instruction: no deposit address, no bank account, and
 *     no 0 USDC balance read.
 *
 * The real @pcc/payments clients run; only the CDP SDK handle inside CdpWalletClient is
 * faked, so a live CDP configuration never reaches a network and the test can see which
 * network each SDK call carried.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const K = vi.hoisted(() => ({
  SMART: "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
  calls: [] as Array<{ method: string; network?: string }>,
}));

vi.mock("@pcc/payments", async (orig) => {
  const real = (await orig()) as typeof import("@pcc/payments");
  const sdk = {
    evm: {
      createAccount: async () => {
        K.calls.push({ method: "createAccount" });
        return { address: "0x1111111111111111111111111111111111111111" };
      },
      createSmartAccount: async () => {
        K.calls.push({ method: "createSmartAccount" });
        return { address: K.SMART };
      },
      listTokenBalances: async (a: { network: string }) => {
        K.calls.push({ method: "listTokenBalances", network: a.network });
        return { balances: [] };
      },
    },
  };
  class CdpWalletClient extends real.CdpWalletClient {}
  // The client's own code runs; only its lazy SDK handle is replaced.
  (CdpWalletClient.prototype as unknown as { cdp: () => Promise<unknown> }).cdp = async () => sdk;
  return { ...real, CdpWalletClient };
});

const WALLET_A = "0xaaaa00000000000000000000000000000000000a";
const WALLET_B = "0xbbbb00000000000000000000000000000000000b";
const ADMIN = "fiat-r3-admin-key";
const CDP = { CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret", CDP_WALLET_SECRET: "wallet-secret" };
const ENV = [
  "COINBASE_APP_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "YELLOWCARD_API_KEY",
  "YELLOWCARD_SECRET_KEY",
  "YELLOWCARD_ENVIRONMENT",
  "WISE_API_TOKEN",
  "WISE_PROFILE_ID",
  "WISE_ENVIRONMENT",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "CDP_WALLET_SECRET",
  "CDP_NETWORK",
  "CDP_ONRAMP_APP_ID",
  "PCC_DEMO_ROUTES",
  "PCC_ADMIN_KEY",
  "PCC_LEGACY_FIAT_WEBHOOKS",
];
const saved: Record<string, string | undefined> = {};
const savedNodeEnv = process.env.NODE_ENV;
let app: FastifyInstance | undefined;

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.env.NODE_ENV = savedNodeEnv;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  K.calls.length = 0;
  process.env.NODE_ENV = savedNodeEnv;
});

/** A fresh routes module (its configuration snapshot is per module) under `env`. */
async function buildApp(env: Record<string, string> = {}): Promise<FastifyInstance> {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { fiatRampRoutes } = await import("../routes/fiat-ramp.js");
  const a = Fastify({ logger: false });
  // Stand-in for the API gate: it sets req.operatorId from the API key.
  a.addHook("onRequest", async (req) => {
    const p = req.headers["x-test-principal"];
    if (typeof p === "string") (req as any).operatorId = p;
  });
  await a.register(fiatRampRoutes);
  await a.ready();
  app = a;
  return a;
}

const call = (
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: unknown,
  principal: string | null = WALLET_A,
  headers: Record<string, string> = {},
) => app!.inject({ method, url, payload: payload as any, headers: { ...(principal ? { "x-test-principal": principal } : {}), ...headers } });

const status = async () => (await call("GET", "/api/fiat-ramp/status")).json().providers;

const YC_WITHDRAW = {
  walletAddress: WALLET_A,
  amountUsd: "10",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch-1",
  destination: { type: "bank_transfer", accountName: "A", accountNumber: "1", country: "NG" },
  sender: { name: "A", country: "NG", address: "x", dob: "1990-01-01", email: "a@example.invalid", idNumber: "1", idType: "passport" },
};
const WISE = { sourceAmount: 10, recipient: { name: "A", currency: "EUR", type: "iban", details: {} }, reference: "r" };
const YC_DEPOSIT = {
  fiatAmount: "1000",
  fiatCurrency: "NGN",
  country: "NG",
  channelId: "ch-1",
  recipient: { name: "A", country: "NG", phone: "1", address: "x", dob: "1990-01-01", idNumber: "1", idType: "passport" },
  walletAddress: WALLET_A,
};

// ── A ─────────────────────────────────────────────────────────────────────────

describe("A. CDP: one snapshot for the gate, the clients and the label", () => {
  it("snapshotted on base, then CDP_NETWORK changes to base-sepolia: runs on base AND says production", async () => {
    await buildApp({ ...CDP, CDP_NETWORK: "base" });
    expect((await status()).cdp).toMatchObject({ configured: true, environment: "production", network: "base" });
    process.env.CDP_NETWORK = "base-sepolia";
    const res = await call("GET", `/api/fiat-ramp/cdp/wallet/${K.SMART}/balance`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ network: "base", environment: "production" });
    expect(res.json().sandbox).toBeUndefined();
    expect(K.calls).toEqual([{ method: "listTokenBalances", network: "base" }]);
  });

  it("the reverse: snapshotted on the default (base-sepolia), then CDP_NETWORK=base: runs on base-sepolia AND says sandbox", async () => {
    await buildApp({ ...CDP });
    expect((await status()).cdp).toMatchObject({ environment: "sandbox", network: "base-sepolia" }); // first read: the snapshot
    process.env.CDP_NETWORK = "base";
    const res = await call("GET", `/api/fiat-ramp/cdp/wallet/${K.SMART}/balance`);
    expect(res.json()).toMatchObject({ network: "base-sepolia", environment: "sandbox", sandbox: true });
    expect(K.calls).toEqual([{ method: "listTokenBalances", network: "base-sepolia" }]);
    expect((await status()).cdp).toMatchObject({ environment: "sandbox", network: "base-sepolia" });
  });

  it("the onramp app id is part of the snapshot: set after startup, provision still refuses and creates nothing", async () => {
    await buildApp({ ...CDP, CDP_NETWORK: "base" });
    expect((await status()).cdp.operations.provision).toBe(false); // first read: the snapshot
    process.env.CDP_ONRAMP_APP_ID = "late-app";
    const res = await call("POST", "/api/fiat-ramp/cdp/provision", {});
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "not_configured", provider: "cdp", missing: "CDP_ONRAMP_APP_ID" });
    expect(K.calls).toEqual([]);
  });

  it("and the checkout uses the snapshot's app id, not one set later", async () => {
    await buildApp({ ...CDP, CDP_NETWORK: "base", CDP_ONRAMP_APP_ID: "app-1" });
    expect((await status()).cdp.operations.provision).toBe(true); // first read: the snapshot
    process.env.CDP_ONRAMP_APP_ID = "app-2";
    const res = await call("POST", "/api/fiat-ramp/cdp/provision", {});
    expect(res.statusCode).toBe(200);
    expect(res.json().onrampUrl).toContain("appId=app-1&");
    expect(res.json().onrampUrl).not.toContain("app-2");
  });

  it("NEGATIVE: an unknown CDP_NETWORK is not live: 503, status not configured, no SDK call", async () => {
    await buildApp({ ...CDP, CDP_NETWORK: "base-mainnet" });
    const res = await call("POST", "/api/fiat-ramp/cdp/wallet");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "not_configured", provider: "cdp" });
    expect((await status()).cdp).toMatchObject({ configured: false, mock: true, environment: null, network: null });
    expect(K.calls).toEqual([]);
  });
});

// ── B ─────────────────────────────────────────────────────────────────────────

describe("B. principals: a wallet case-insensitively, any other id exactly", () => {
  it("NEGATIVE: 'OperatorA' and 'operatora' are different principals and never see each other's sessions", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    expect((await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_B }, "OperatorA")).statusCode).toBe(200);
    const mine = (await call("GET", "/api/fiat-ramp/sessions", undefined, "OperatorA")).json();
    expect(mine.sessions).toHaveLength(1);
    expect(mine.sessions[0]).toMatchObject({ createdBy: "OperatorA" });
    for (const other of ["operatora", "OPERATORA", "OperatorA "]) {
      expect((await call("GET", "/api/fiat-ramp/sessions", undefined, other)).json().sessions, JSON.stringify(other)).toEqual([]);
    }
  });

  it("a wallet principal finds the sessions it created in any letter case", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const mixed = WALLET_A.toUpperCase().replace("0X", "0x");
    // Created by WALLET_A (upper case) into WALLET_B's wallet: WALLET_A finds it by creator.
    expect((await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_B }, mixed)).statusCode).toBe(200);
    const mine = (await call("GET", "/api/fiat-ramp/sessions", undefined, WALLET_A)).json();
    expect(mine.sessions).toHaveLength(1);
    expect(mine.sessions[0].walletAddress).toBe(WALLET_B);
  });
});

// ── C ─────────────────────────────────────────────────────────────────────────

describe("C. /status reports operation readiness, and each route agrees with it", () => {
  const coinbase: Array<[string, Record<string, string>, { configured: boolean; available: boolean; mock: boolean }]> = [
    ["the app id without CDP", { COINBASE_APP_ID: "app" }, { configured: true, available: false, mock: true }],
    ["the app id with CDP", { COINBASE_APP_ID: "app", ...CDP }, { configured: true, available: true, mock: false }],
    ["demos on, CDP, no app id", { PCC_DEMO_ROUTES: "true", ...CDP }, { configured: false, available: true, mock: true }],
    ["demos on, no CDP", { PCC_DEMO_ROUTES: "true" }, { configured: false, available: false, mock: true }],
    ["nothing configured", {}, { configured: false, available: false, mock: true }],
  ];
  for (const [name, env, want] of coinbase) {
    it(`coinbase, ${name}: ${JSON.stringify(want)}, and the checkout ${want.available ? "answers" : "refuses"}`, async () => {
      await buildApp(env);
      const s = (await status()).coinbase;
      expect(s).toMatchObject({ ...want, requires: ["cdp"] });
      expect(s.environment).toBe(want.mock ? null : "production");
      for (const [method, url, body] of [
        ["POST", "/api/fiat-ramp/coinbase/onramp", { walletAddress: WALLET_A }],
        ["GET", `/api/fiat-ramp/coinbase/onramp-url?wallet=${WALLET_A}`, undefined],
      ] as const) {
        const res = await call(method, url, body);
        expect(res.statusCode === 200, `${url} -> ${res.statusCode}`).toBe(want.available);
        expect(res.body.includes("pay.coinbase.com"), url).toBe(!want.mock);
      }
    });
  }

  const provision: Array<[string, Record<string, string>, boolean]> = [
    ["live, sandbox network, with an app id", { ...CDP, CDP_ONRAMP_APP_ID: "app" }, false],
    ["live, base, no app id", { ...CDP, CDP_NETWORK: "base" }, false],
    ["live, base, with an app id", { ...CDP, CDP_NETWORK: "base", CDP_ONRAMP_APP_ID: "app" }, true],
    ["demos on", { PCC_DEMO_ROUTES: "true" }, true],
    ["nothing configured", {}, false],
  ];
  for (const [name, env, ready] of provision) {
    it(`cdp provision, ${name}: operations.provision is ${ready}, and the route agrees`, async () => {
      await buildApp(env);
      expect((await status()).cdp.operations.provision).toBe(ready);
      expect((await call("POST", "/api/fiat-ramp/cdp/provision", {})).statusCode === 200).toBe(ready);
    });
  }
});

// ── D ─────────────────────────────────────────────────────────────────────────

describe("D. NEGATIVE: the legacy credits and unsigned webhooks are 410 in every environment", () => {
  const LEGACY = [
    ["POST", "/api/fiat-ramp/stripe/credits/deposit", { amountUsd: 5 }],
    ["GET", "/api/fiat-ramp/stripe/credits/user-1", undefined],
    [
      "POST",
      "/api/fiat-ramp/webhook/stripe",
      { type: "checkout.session.completed", data: { object: { metadata: { user_id: "user-1", credits: "1000000" }, amount_total: 100 } } },
    ],
    ["POST", "/api/fiat-ramp/webhook/yellowcard", { event: "COLLECTION.COMPLETE", data: { id: "x", status: "completed" } }],
  ] as const;

  it("with PCC_LEGACY_FIAT_WEBHOOKS=true and demos on: every legacy route is 410, for the caller and the admin", async () => {
    await buildApp({ PCC_LEGACY_FIAT_WEBHOOKS: "true", PCC_DEMO_ROUTES: "true", PCC_ADMIN_KEY: ADMIN });
    for (const [method, url, body] of LEGACY) {
      for (const headers of [{}, { "x-admin-key": ADMIN }]) {
        const res = await call(method, url, body, "user-1", headers);
        expect(res.statusCode, url).toBe(410);
        expect(res.json().error).toBe("gone");
      }
    }
  });

  it("production with the flag set boots (the flag is ignored) and answers 410", async () => {
    process.env.NODE_ENV = "production";
    await buildApp({ PCC_LEGACY_FIAT_WEBHOOKS: "true" });
    for (const [method, url, body] of LEGACY) {
      expect((await call(method, url, body, "user-1")).statusCode, url).toBe(410);
    }
  });

  it("status no longer lists Stripe credits as a capability", async () => {
    await buildApp({ PCC_LEGACY_FIAT_WEBHOOKS: "true" });
    expect((await status()).stripe.capabilities).toEqual(["onramp"]);
  });
});

// ── E ─────────────────────────────────────────────────────────────────────────

describe("E. every listed session carries the mode its client recorded", () => {
  const stripeLive = (id: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id, client_secret: "cs", status: "initialized" }), { status: 200 })),
    );

  it("in one listing: a live sandbox Stripe session is sandbox, demo Yellowcard and Wise sessions are simulated", async () => {
    stripeLive("cos_live_1");
    await buildApp({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", PCC_DEMO_ROUTES: "true", PCC_ADMIN_KEY: ADMIN });
    expect((await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A })).statusCode).toBe(200);
    expect((await call("POST", "/api/fiat-ramp/yellowcard/withdraw", YC_WITHDRAW)).statusCode).toBe(200);
    expect((await call("POST", "/api/fiat-ramp/wise/payout", WISE)).statusCode).toBe(200);
    for (const headers of [{ "x-admin-key": ADMIN }, {}]) {
      const sessions = (await call("GET", "/api/fiat-ramp/sessions", undefined, WALLET_A, headers)).json().sessions as Array<{
        provider: string;
        mode: string;
      }>;
      expect(Object.fromEntries(sessions.map((s) => [s.provider, s.mode]))).toEqual({
        stripe: "sandbox",
        yellowcard: "simulated",
        wise: "simulated",
      });
    }
  });

  it("a live production Stripe key records production", async () => {
    stripeLive("cos_live_2");
    await buildApp({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x" });
    expect((await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A })).statusCode).toBe(200);
    const [s] = (await call("GET", "/api/fiat-ramp/sessions")).json().sessions;
    expect(s).toMatchObject({ provider: "stripe", mode: "production" });
  });
});

// ── F ─────────────────────────────────────────────────────────────────────────

describe("F. /cdp/provision never builds a checkout it cannot stand behind", () => {
  it("NEGATIVE: a live sandbox refuses before creating a wallet (no real-money URL under a sandbox label)", async () => {
    await buildApp({ ...CDP, CDP_ONRAMP_APP_ID: "app" });
    const res = await call("POST", "/api/fiat-ramp/cdp/provision", {});
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "onramp_not_on_sandbox", provider: "cdp", environment: "sandbox" });
    expect(res.body).not.toContain("pay.coinbase.com");
    expect(K.calls).toEqual([]);
  });

  it("live on base with an app id: the real checkout for the new wallet, labelled production", async () => {
    await buildApp({ ...CDP, CDP_NETWORK: "base", CDP_ONRAMP_APP_ID: "app-1" });
    const res = await call("POST", "/api/fiat-ramp/cdp/provision", { presetAmountUSD: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ walletAddress: K.SMART, network: "base", environment: "production", mock: false });
    expect(res.json().onrampUrl).toMatch(/^https:\/\/pay\.coinbase\.com\/buy\/select-asset\?appId=app-1&/);
    expect(decodeURIComponent(res.json().onrampUrl)).toContain(K.SMART);
    expect(K.calls.map((c) => c.method)).toEqual(["createAccount", "createSmartAccount"]);
  });

  it("demo: a mock wallet and no checkout at all", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const res = await call("POST", "/api/fiat-ramp/cdp/provision", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ onrampUrl: null, sessionId: null, mock: true, demo: true, usableNow: false });
    expect(res.body).not.toContain("pay.coinbase.com");
  });
});

// ── G ─────────────────────────────────────────────────────────────────────────

describe("G. NEGATIVE: spend authority over a wallet belongs to its creator", () => {
  const issue = (wallet: string, principal: string | null, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    call("POST", "/api/fiat-ramp/cdp/spend-permission", { walletAddress: wallet, spender: WALLET_B, allowanceUSDC: 5, ...extra }, principal, headers);
  const createWallet = async (principal: string) => (await call("POST", "/api/fiat-ramp/cdp/wallet", undefined, principal)).json().walletAddress as string;

  it("the creator issues; anyone else, or an unknown wallet, gets 404 and nothing; X-Admin-Key issues", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true", PCC_ADMIN_KEY: ADMIN });
    const w = await createWallet("OperatorA");
    const own = await issue(w, "OperatorA");
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ account: w, spender: WALLET_B, mock: true, demo: true });
    for (const other of ["operatora", "OperatorB", WALLET_A, null]) {
      const res = await issue(w, other);
      expect(res.statusCode, String(other)).toBe(404);
      expect(res.json().error).toBe("wallet_not_found");
    }
    expect((await issue(WALLET_A, "OperatorA")).statusCode).toBe(404);
    expect((await issue(w, "OperatorB", { "x-admin-key": ADMIN })).statusCode).toBe(200);
    expect((await issue(w, "OperatorB", { "x-admin-key": ADMIN + "x" })).statusCode).toBe(404);
  });

  it("a wallet principal owns the wallets it created, in any letter case", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const w = await createWallet(WALLET_A.toUpperCase().replace("0X", "0x"));
    expect((await issue(w, WALLET_A)).statusCode).toBe(200);
  });

  it("NEGATIVE: malformed amounts, periods and addresses are 400 before anything is issued", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const w = await createWallet("OperatorA");
    const bad: Array<Record<string, unknown>> = [
      { allowanceUSDC: -5 },
      { allowanceUSDC: 0 },
      { allowanceUSDC: "5" },
      { spender: "not-an-address" },
      { walletAddress: "0x123" },
      { periodSec: 1.5 },
      { periodSec: 0 },
    ];
    for (const extra of bad) {
      expect((await issue(w, "OperatorA", {}, extra)).statusCode, JSON.stringify(extra)).toBe(400);
    }
  });
});

// ── H ─────────────────────────────────────────────────────────────────────────

describe("H. NEGATIVE: a demo answer carries no payment instruction", () => {
  it("demo withdraw: no deposit address (the mock's TRC20 literal never reaches a caller)", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const res = await call("POST", "/api/fiat-ramp/yellowcard/withdraw", YC_WITHDRAW);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ depositAddress: null, mock: true, demo: true });
    expect(res.json().note).toMatch(/nothing to pay into or send to/);
    expect(res.json().session.mode).toBe("simulated");
    expect(res.body).not.toContain("TCM1FNSZ");
  });

  it("demo deposit: no bank account", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const res = await call("POST", "/api/fiat-ramp/yellowcard/deposit", YC_DEPOSIT);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ bankInfo: null, mock: true, demo: true });
    expect(res.json().session.mode).toBe("simulated");
    expect(res.body).not.toMatch(/4550440202|PAGA|PCC Escrow/);
  });

  it("demo balance: null, not a 0 USDC read", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const res = await call("GET", `/api/fiat-ramp/cdp/wallet/${WALLET_A}/balance`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ address: WALLET_A, usdc: null, network: null, mock: true, demo: true });
  });
});
