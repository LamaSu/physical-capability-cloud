/**
 * Fiat ramp honesty and privacy (board N48; N34 family "fiat-ramp"), revised for
 * coord-watch's review (#2934) and the gateway's (#2831).
 *
 *  - GET /api/fiat-ramp/sessions used to return EVERY account's ramp sessions (wallets,
 *    amounts) to any key. It is owner-scoped: sessions the caller created, or that pay
 *    into or out of the caller's wallet; all with a valid X-Admin-Key.
 *  - Provider routes used to answer like the real provider when it was not configured.
 *    Now: 503 not_configured, unless PCC_DEMO_ROUTES is on (never in production), and then
 *    every response is marked mock/demo.
 *  - The gate and the provider client read ONE configuration snapshot, so a key set or
 *    removed after startup cannot make the gate say "live" while a mock runs (or the
 *    reverse), and a partial configuration is never live.
 *  - The faucet never reports a mint that did not happen, and never calls a submitted
 *    transaction a mint.
 *
 * The routes' configuration is read once per module instance, so each case builds a fresh
 * app (vi.resetModules) with the environment it needs.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// The faucet's on-chain mint must never reach a network from tests.
const tx = vi.hoisted(() => ({ mode: "throw" as "throw" | "hash" }));
vi.mock("viem", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    createWalletClient: () => ({
      sendTransaction: async () => {
        if (tx.mode === "hash") return "0x" + "ab".repeat(32);
        throw new Error("rpc unreachable (test)");
      },
    }),
  };
});

const WALLET_A = "0xaaaa00000000000000000000000000000000000a";
const WALLET_B = "0xbbbb00000000000000000000000000000000000b";
const ADMIN = "fiat-test-admin-key";
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
  "DEPLOYER_PRIVATE_KEY",
  "PCC_GATEWAY_PRIVATE_KEY",
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
  tx.mode = "throw";
  process.env.NODE_ENV = savedNodeEnv;
});

async function buildApp(env: Record<string, string> = {}, opts: { own?: boolean } = {}): Promise<FastifyInstance> {
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
  // `own`: the caller keeps and closes this app (the shared afterEach does not).
  if (!opts.own) app = a;
  return a;
}

const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, principal: string | null = WALLET_A, headers: Record<string, string> = {}) =>
  app!.inject({ method, url, payload: payload as any, headers: { ...(principal ? { "x-test-principal": principal } : {}), ...headers } });

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

type Route = [string, "GET" | "POST" | "DELETE", string, unknown];
const COINBASE_ROUTES: Route[] = [
  ["coinbase", "POST", "/api/fiat-ramp/coinbase/onramp", { walletAddress: WALLET_A, amount: 20 }],
  ["coinbase", "GET", `/api/fiat-ramp/coinbase/onramp-url?wallet=${WALLET_A}`, undefined],
];
const OTHER_ROUTES: Route[] = [
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
const ALL_ROUTES = [...COINBASE_ROUTES, ...OTHER_ROUTES];

// ── Fail closed ─────────────────────────────────────────────────────────────

describe("NEGATIVE: an unconfigured provider fails closed (no provider-shaped data)", () => {
  for (const [provider, method, url, body] of ALL_ROUTES) {
    it(`${method} ${url.split("?")[0]} -> 503 not_configured`, async () => {
      await buildApp();
      const res = await call(method, url, body);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: "not_configured", provider });
      expect(res.body).not.toMatch(/PAGA|TRC20|cos_mock|COMPLETED|onrampUrl|pay\.coinbase\.com/);
    });
  }

  it("status says demo routes are off and every provider is mock", async () => {
    await buildApp();
    const body = (await call("GET", "/api/fiat-ramp/status")).json();
    expect(body.demoRoutes).toBe(false);
    for (const p of ["coinbase", "stripe", "yellowcard", "wise", "cdp"]) {
      expect(body.providers[p], p).toMatchObject({ mock: true, environment: null, available: false });
    }
  });
});

describe("NEGATIVE (coord-watch #2934): a partial configuration is never live", () => {
  const cases: Array<[string, Record<string, string>, Route]> = [
    ["Stripe secret without the publishable key", { STRIPE_SECRET_KEY: "sk_test_x" }, OTHER_ROUTES[0]!],
    ["Yellowcard API key without the secret", { YELLOWCARD_API_KEY: "yc_x" }, OTHER_ROUTES[1]!],
    ["Wise token without the profile", { WISE_API_TOKEN: "t" }, OTHER_ROUTES[5]!],
    ["a CDP key id without its secrets", { CDP_API_KEY_ID: "id" }, OTHER_ROUTES[7]!],
  ];
  for (const [name, env, [provider, method, url, body]] of cases) {
    it(`${name}: 503 not_configured, status mock, and no provider call`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      await buildApp(env);
      const res = await call(method, url, body);
      expect(res.statusCode).toBe(503);
      expect(res.json().provider).toBe(provider);
      expect((await call("GET", "/api/fiat-ramp/status")).json().providers[provider].mock).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

describe("NEGATIVE (coord-watch #2934): the gate and the client read the same snapshot", () => {
  const stripeOk = () =>
    vi.fn(async () => new Response(JSON.stringify({ id: "cos_live_1", client_secret: "cs_1", status: "initialized" }), { status: 200 }));

  it("a key set after startup does not make the gate live while a mock client runs", async () => {
    const fetchSpy = stripeOk();
    vi.stubGlobal("fetch", fetchSpy);
    await buildApp();
    expect((await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A })).statusCode).toBe(503);
    process.env.STRIPE_SECRET_KEY = "sk_test_late";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_late";
    const again = await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A });
    expect(again.statusCode).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await call("GET", "/api/fiat-ramp/status")).json().providers.stripe.mock).toBe(true);
  });

  it("a live provider stays live (and real) after the env changes, and a sandbox says so", async () => {
    const fetchSpy = stripeOk();
    vi.stubGlobal("fetch", fetchSpy);
    await buildApp({ STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_PUBLISHABLE_KEY: "pk_test_abc" });
    const first = await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ environment: "sandbox", sandbox: true, provider: "stripe" });
    expect(first.json().mock).toBeUndefined();
    expect(first.json().demo).toBeUndefined();
    delete process.env.STRIPE_SECRET_KEY;
    const second = await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A });
    expect(second.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((await call("GET", "/api/fiat-ramp/status")).json().providers.stripe).toMatchObject({ mock: false, environment: "sandbox" });
  });

  it("a live production key is labelled production", async () => {
    vi.stubGlobal("fetch", stripeOk());
    await buildApp({ STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_PUBLISHABLE_KEY: "pk_live_abc" });
    const res = await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A });
    expect(res.json().environment).toBe("production");
    expect(res.json().sandbox).toBeUndefined();
  });

  it("with demos on, a Wise token without a profile runs the MOCK client, marked demo (not a live payout to profile 0)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await buildApp({ WISE_API_TOKEN: "t", PCC_DEMO_ROUTES: "true" });
    const res = await call("POST", "/api/fiat-ramp/wise/payout", WISE);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mock: true, demo: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Demo ─────────────────────────────────────────────────────────────────────

describe("PCC_DEMO_ROUTES=true: simulated responses, each marked mock/demo", () => {
  for (const [, method, url, body] of OTHER_ROUTES) {
    it(`${method} ${url.split("?")[0]} -> 200 with mock:true, demo:true`, async () => {
      await buildApp({ PCC_DEMO_ROUTES: "true" });
      const res = await call(method, url, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ mock: true, demo: true });
    });
  }

  it("NEGATIVE: demo never builds a real-money checkout: Coinbase refuses while the CDP wallet is mock", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    for (const [, method, url, body] of COINBASE_ROUTES) {
      const res = await call(method, url, body);
      expect(res.statusCode, url).toBe(503);
      expect(res.json().error).toBe("cdp_wallet_mock");
      expect(res.body).not.toContain("pay.coinbase.com");
    }
  });

  it("NEGATIVE: with a real CDP wallet but no Coinbase app, demo returns no checkout URL at all", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true", CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "s", CDP_WALLET_SECRET: "w" });
    const post = await call("POST", "/api/fiat-ramp/coinbase/onramp", { walletAddress: WALLET_A });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ onrampUrl: null, mock: true, demo: true });
    const get = await call("GET", `/api/fiat-ramp/coinbase/onramp-url?wallet=${WALLET_A}`);
    expect(get.json()).toMatchObject({ url: null, demo: true });
    expect(post.body + get.body).not.toContain("pay.coinbase.com");
  });

  it("a simulated CDP wallet is not usable", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const res = await call("POST", "/api/fiat-ramp/cdp/wallet");
    expect(res.json()).toMatchObject({ usableNow: false, mock: true, demo: true });
  });

  it("NEGATIVE (coord-watch #2934): PCC_DEMO_ROUTES is refused under NODE_ENV=production", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    process.env.NODE_ENV = "production";
    const res = await call("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A });
    expect(res.statusCode).toBe(503);
    expect((await call("GET", "/api/fiat-ramp/status")).json().demoRoutes).toBe(false);
    const { isDemoRoutesOn } = await import("../config/demo-routes.js");
    expect(isDemoRoutesOn()).toBe(false);
  });
});

// ── Sessions ─────────────────────────────────────────────────────────────────

describe("NEGATIVE: GET /api/fiat-ramp/sessions is owner-scoped", () => {
  const EMAIL = "someone@example.invalid";
  let own: FastifyInstance;
  const as = (method: "GET" | "POST", url: string, payload: unknown, principal: string) =>
    own.inject({ method, url, payload: payload as any, headers: { "x-test-principal": principal } });
  beforeAll(async () => {
    own = await buildApp({ PCC_DEMO_ROUTES: "true", PCC_ADMIN_KEY: ADMIN }, { own: true });
    // Two wallet accounts each open a (demo) session into their own wallet; an account
    // identified by email opens one into WALLET_B's wallet.
    expect((await as("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_A }, WALLET_A)).statusCode).toBe(200);
    expect((await as("POST", "/api/fiat-ramp/stripe/onramp", { walletAddress: WALLET_B }, WALLET_B)).statusCode).toBe(200);
    expect((await as("POST", "/api/fiat-ramp/yellowcard/withdraw", { ...YC_WITHDRAW, walletAddress: WALLET_B }, EMAIL)).statusCode).toBe(200);
  });
  afterAll(async () => {
    await own.close();
  });

  const list = (principal: string | null, headers: Record<string, string> = {}) =>
    own.inject({ method: "GET", url: "/api/fiat-ramp/sessions", headers: { ...(principal ? { "x-test-principal": principal } : {}), ...headers } });
  const wallets = (res: { json(): any }) => (res.json().sessions as Array<{ walletAddress: string }>).map((s) => s.walletAddress.toLowerCase());

  it("a wallet caller sees the sessions into or out of its wallet, and those it created", async () => {
    const a = await list(WALLET_A.toUpperCase().replace("0X", "0x"));
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ scope: "caller", matchedBy: ["created_by", "wallet"] });
    expect(new Set(wallets(a))).toEqual(new Set([WALLET_A]));
    // WALLET_B sees its own session AND the one filed into its wallet by someone else
    // (the gateway's LOW: noise, not a leak).
    expect(wallets(await list(WALLET_B))).toEqual([WALLET_B, WALLET_B]);
  });

  it("a caller identified by email sees the sessions it created, and only those", async () => {
    const mine = await list(EMAIL);
    expect(mine.json()).toMatchObject({ scope: "caller", matchedBy: ["created_by"] });
    expect(mine.json().sessions).toHaveLength(1);
    expect(mine.json().sessions[0]).toMatchObject({ createdBy: EMAIL, provider: "yellowcard" });
    expect((await list("other@example.invalid")).json().sessions).toEqual([]);
  });

  it("anonymous is 401", async () => {
    expect((await list(null)).statusCode).toBe(401);
  });

  it("a valid admin key sees every session; a wrong or empty one does not", async () => {
    const admin = await list("ops@example.invalid", { "x-admin-key": ADMIN });
    expect(admin.json().scope).toBe("all");
    expect(wallets(admin)).toEqual(expect.arrayContaining([WALLET_A, WALLET_B]));
    expect((await list("ops@example.invalid", { "x-admin-key": ADMIN + "x" })).json().sessions).toEqual([]);
    expect((await list("ops@example.invalid", { "x-admin-key": "" })).json().sessions).toEqual([]);
  });
});

// ── Faucet ───────────────────────────────────────────────────────────────────

describe("NEGATIVE: the faucet never reports a mint that did not happen", () => {
  it("no minting key and no demo flag: 503, success false", async () => {
    await buildApp();
    const res = await call("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, error: "not_configured" });
  });

  it("a failed send is 502 with an unknown outcome: never 'nothing was minted', never a made-up hash", async () => {
    await buildApp({ DEPLOYER_PRIVATE_KEY: "0x" + "11".repeat(32) });
    const res = await call("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, error: "mint_failed", submitted: "unknown" });
    expect(res.json().message).toMatch(/could not be confirmed/);
    expect(res.json().message).not.toMatch(/Nothing was minted/);
    expect(res.body).not.toContain("f".repeat(64));
  });

  it("a returned hash is a submitted transaction, not a confirmed mint", async () => {
    tx.mode = "hash";
    await buildApp({ DEPLOYER_PRIVATE_KEY: "0x" + "11".repeat(32) });
    const res = await call("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ submitted: true, confirmed: false, txHash: "0x" + "ab".repeat(32) });
    expect(res.json().note).toMatch(/not confirmed/);
  });

  it("demo: success false, nothing minted, no transaction hash", async () => {
    await buildApp({ PCC_DEMO_ROUTES: "true" });
    const res = await call("POST", "/api/faucet/usdc", { walletAddress: WALLET_A, amount: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: false, minted: false, txHash: null, mock: true, demo: true });
  });

  it("GET ?wallet= never reports a drip", async () => {
    await buildApp();
    const res = await call("GET", `/api/faucet/usdc?wallet=${WALLET_A}&amount=100`);
    expect(res.statusCode).toBe(405);
    expect(res.json()).toMatchObject({ success: false, error: "use_post" });
  });
});

// ── Legacy (dev-only) credits ────────────────────────────────────────────────

describe("NEGATIVE (coord-watch #2934): the dev-only legacy credit read is owner-scoped", () => {
  it("a caller reads only its own credit balance; an admin reads any", async () => {
    await buildApp({ PCC_LEGACY_FIAT_WEBHOOKS: "true", PCC_ADMIN_KEY: ADMIN });
    // Mock credits: the legacy deposit credits the caller directly.
    expect((await call("POST", "/api/fiat-ramp/stripe/credits/deposit", { amountUsd: 5 }, "user-1")).statusCode).toBe(200);
    expect((await call("GET", "/api/fiat-ramp/stripe/credits/user-1", undefined, "user-1")).statusCode).toBe(200);
    expect((await call("GET", "/api/fiat-ramp/stripe/credits/user-1", undefined, "user-2")).statusCode).toBe(404);
    expect((await call("GET", "/api/fiat-ramp/stripe/credits/user-1", undefined, "user-2", { "x-admin-key": ADMIN })).statusCode).toBe(200);
  });
});
