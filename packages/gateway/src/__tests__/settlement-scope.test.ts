/**
 * END-TO-END: money authority is split out of `operator` (#1099 follow-up).
 *
 * The gap this closes: after #1099 narrowed self-service provisioning from
 * scopes:["*"] to scopes:["operator"], `operator` was STILL accepted at
 * /api/escrow/** and /api/fiat-ramp/** — so completing an unverified email
 * signup form still bought the ability to fund/release/dispute an escrow and to
 * trigger a fiat withdrawal. Narrower than a wildcard, but still money.
 *
 * Now `settlement` is its own scope, granted only when the identity was PROVEN
 * by SIWE **and** that proven address is on the PCC_SETTLEMENT_OPERATORS
 * manual-approval allowlist.
 *
 * Unlike scope-checker-money-path.test.ts (which mocks the key repo to test the
 * middleware in isolation), this file drives the REAL path end to end: it
 * provisions through the actual HTTP route, takes the API key that comes back,
 * and calls money + onboarding routes through the real apiGate + scopeChecker
 * with that key. Nothing about the grant decision is stubbed — the only mocks
 * are outbound side effects (audit/telemetry) and the provisioning rate limiter.
 *
 * The load-bearing assertions are the negative ones: the two ways to get an
 * `operator` key must BOTH be refused at the money path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../telemetry.js", () => ({ pipelineTelemetry: { emit: vi.fn() } }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
  canSiweVerify: vi.fn(() => true),
}));

/** Mirrors apps/dashboard/src/hooks/use-auth.ts buildSiweMessage exactly. */
function buildSiweMessage(p: {
  domain: string; address: string; statement: string; uri: string;
  version: string; chainId: number; nonce: string; issuedAt: string;
}): string {
  return [
    `${p.domain} wants you to sign in with your Ethereum account:`,
    p.address, "", p.statement, "",
    `URI: ${p.uri}`,
    `Version: ${p.version}`,
    `Chain ID: ${p.chainId}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
  ].join("\n");
}

describe("settlement scope — money authority is separate from operator", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(cookie, { secret: "test-only-cookie-secret-do-not-use-in-prod" });
    await app.register(siweAuthPlugin);
    await app.register(provisionRoutes);
    // Real gate + real scope check, in the same order server.ts registers them.
    await app.register(apiGate);
    await app.register(scopeChecker);

    const ok = async () => ({ reached: true });
    // Money path.
    app.post("/api/escrow/chain/:address/fund", ok);
    app.post("/api/fiat-ramp/offramp/withdraw", ok);
    app.post("/api/fiat-ramp/payout", ok);
    // Onboarding path — what an `operator` key legitimately needs.
    app.post("/api/kernels/register", ok);
    app.post("/api/capabilities", ok);
    app.post("/api/negotiate/session", ok);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  beforeEach(() => { delete process.env.PCC_SETTLEMENT_OPERATORS; });
  afterEach(() => { delete process.env.PCC_SETTLEMENT_OPERATORS; });

  // ── The SIWE bootstrap must stay reachable ────────────────────────
  //
  // Found by this very file: with the real apiGate mounted, every SIWE test
  // here failed at `POST /api/auth/verify` -> 401, because neither bootstrap
  // endpoint was on apiGate's public allowlist. Verified against PRODUCTION
  // the same day (capability.network returned 401 api_key_required for both),
  // so it was a live defect, not a test-harness artifact: SIWE login was
  // unreachable, and with it every wallet-identity flow -- including the
  // SIWE-gated provisioning that the `settlement` grant below depends on.
  //
  // These two assertions are the regression guard. If either starts 401ing,
  // the deadlock is back and the settlement path is unreachable again.
  describe("SIWE login bootstrap is publicly reachable (regression guard)", () => {
    it("GET /api/auth/nonce does not require auth", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it("POST /api/auth/verify does not require auth (it IS the login endpoint)", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/auth/verify",
        headers: { host: "pcc.test" }, payload: {},
      });
      // 400 = reached the handler and was rejected on its merits (missing
      // message/signature). Anything 401 means the gate ate it first.
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).not.toBe("api_key_required");
    });

    it("session-bearing auth routes stay GATED", async () => {
      // /me and /logout operate on an existing session, so they are not part of
      // the bootstrap and must not have been opened up alongside it.
      const me = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(me.statusCode).toBe(401);
    });
  });

  /** Drive the real nonce -> sign -> verify flow for a throwaway account. */
  async function siweSignIn(account: ReturnType<typeof privateKeyToAccount>) {
    const nonceRes = await app.inject({
      method: "GET", url: "/api/auth/nonce", headers: { host: "pcc.test" },
    });
    const { nonce } = JSON.parse(nonceRes.body) as { nonce: string };
    const message = buildSiweMessage({
      domain: "pcc.test", address: account.address,
      statement: "Sign in to Physical Capability Cloud",
      uri: "http://pcc.test", version: "1", chainId: 1, nonce,
      issuedAt: new Date().toISOString(),
    });
    const signature = await account.signMessage({ message });
    const verifyRes = await app.inject({
      method: "POST", url: "/api/auth/verify",
      headers: { host: "pcc.test" }, payload: { message, signature },
    });
    expect(verifyRes.statusCode).toBe(200);
    return (JSON.parse(verifyRes.body) as { token: string }).token;
  }

  async function provisionByEmail(): Promise<{ key: string; scopes: string[] }> {
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision",
      payload: { email: `settle-${Date.now()}-${Math.random()}@example.com` },
    });
    expect(res.statusCode).toBe(201);
    const b = JSON.parse(res.body) as { api_key: string; scopes: string[] };
    return { key: b.api_key, scopes: b.scopes };
  }

  async function provisionBySiwe(
    account: ReturnType<typeof privateKeyToAccount>,
  ): Promise<{ key: string; scopes: string[] }> {
    const token = await siweSignIn(account);
    const res = await app.inject({
      method: "POST", url: "/api/auth/provision",
      headers: { authorization: `Bearer ${token}` },
      payload: { walletAddress: account.address },
    });
    expect(res.statusCode).toBe(201);
    const b = JSON.parse(res.body) as { api_key: string; scopes: string[] };
    return { key: b.api_key, scopes: b.scopes };
  }

  const call = (key: string, url: string) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}` } });

  // ── The email key: onboarding yes, money no ───────────────────────

  describe("email-provisioned key (identity ASSERTED, not proven)", () => {
    it("is minted with operator only — never settlement, never wildcard", async () => {
      const { scopes } = await provisionByEmail();
      expect(scopes).toEqual(["operator"]);
      expect(scopes).not.toContain("settlement");
      expect(scopes).not.toContain("*");
    });

    it("is REFUSED at escrow funding", async () => {
      const { key } = await provisionByEmail();
      const res = await call(key, "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      expect(res.json().reached).toBeUndefined();
    });

    it("is REFUSED at fiat off-ramp withdrawal", async () => {
      const { key } = await provisionByEmail();
      const res = await call(key, "/api/fiat-ramp/offramp/withdraw");
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });

    it("is REFUSED at enterprise payout", async () => {
      const { key } = await provisionByEmail();
      const res = await call(key, "/api/fiat-ramp/payout");
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });

    // The point of keeping `operator`: onboarding must still work. If these
    // break, the split is too aggressive and self-service signup is useless.
    it("is ALLOWED at kernel registration", async () => {
      const { key } = await provisionByEmail();
      const res = await call(key, "/api/kernels/register");
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
    });

    it("is ALLOWED at capability creation", async () => {
      const { key } = await provisionByEmail();
      const res = await call(key, "/api/capabilities");
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
    });

    it("is ALLOWED at negotiation", async () => {
      const { key } = await provisionByEmail();
      const res = await call(key, "/api/negotiate/session");
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
    });
  });

  // ── SIWE alone is NOT enough: proof of identity != money authority ─

  describe("SIWE-verified but NOT allowlisted", () => {
    it("is minted with operator only — proving who you are does not grant settlement", async () => {
      const { scopes } = await provisionBySiwe(privateKeyToAccount(generatePrivateKey()));
      expect(scopes).toEqual(["operator"]);
    });

    it("is REFUSED at escrow funding", async () => {
      const { key } = await provisionBySiwe(privateKeyToAccount(generatePrivateKey()));
      const res = await call(key, "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund");
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });

    it("is REFUSED at fiat payout", async () => {
      const { key } = await provisionBySiwe(privateKeyToAccount(generatePrivateKey()));
      const res = await call(key, "/api/fiat-ramp/payout");
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });

    it("is still ALLOWED at onboarding", async () => {
      const { key } = await provisionBySiwe(privateKeyToAccount(generatePrivateKey()));
      expect((await call(key, "/api/kernels/register")).statusCode).toBe(200);
    });
  });

  // ── SIWE + manual approval: the only self-service route to money ──

  describe("SIWE-verified AND on the PCC_SETTLEMENT_OPERATORS allowlist", () => {
    it("is minted with operator + settlement", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS = account.address.toLowerCase();
      const { scopes } = await provisionBySiwe(account);
      expect(scopes).toContain("operator");
      expect(scopes).toContain("settlement");
      expect(scopes).not.toContain("*");
      expect(scopes).not.toContain("admin");
    });

    it("is ALLOWED at escrow funding", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS = account.address.toLowerCase();
      const { key } = await provisionBySiwe(account);
      const res = await call(key, "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund");
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
    });

    it("is ALLOWED at fiat payout", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS = account.address.toLowerCase();
      const { key } = await provisionBySiwe(account);
      expect((await call(key, "/api/fiat-ramp/payout")).statusCode).toBe(200);
    });

    // A SIWE session address is checksummed; a human types the env var. Casing
    // must not decide who can move funds.
    it("matches the allowlist case-insensitively", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS = account.address.toUpperCase();
      const { scopes } = await provisionBySiwe(account);
      expect(scopes).toContain("settlement");
    });

    it("tolerates whitespace and multiple entries in the allowlist", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS =
        ` 0xAAaAaA000000000000000000000000000000AaAa , ${account.address} `;
      const { scopes } = await provisionBySiwe(account);
      expect(scopes).toContain("settlement");
    });
  });

  // ── Fail-closed behaviour of the allowlist itself ─────────────────

  describe("the allowlist fails CLOSED", () => {
    it("grants nobody settlement when PCC_SETTLEMENT_OPERATORS is unset", async () => {
      delete process.env.PCC_SETTLEMENT_OPERATORS;
      const { scopes } = await provisionBySiwe(privateKeyToAccount(generatePrivateKey()));
      expect(scopes).not.toContain("settlement");
    });

    it("grants nobody settlement when the allowlist is empty or only separators", async () => {
      process.env.PCC_SETTLEMENT_OPERATORS = " , ,, ";
      const { scopes } = await provisionBySiwe(privateKeyToAccount(generatePrivateKey()));
      expect(scopes).not.toContain("settlement");
    });

    // The allowlist keys off the PROVEN address. An email caller who happens to
    // put an allowlisted address in the email field must not inherit it.
    it("does not grant settlement to an email caller even if the allowlist is populated", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS = account.address.toLowerCase();
      const { scopes } = await provisionByEmail();
      expect(scopes).toEqual(["operator"]);
    });

    // The strongest negative control: an UNVERIFIED caller naming an
    // allowlisted address gets no key at all, so there is no path where an
    // asserted (rather than proven) address reaches the allowlist check.
    it("refuses an unverified caller who merely CLAIMS an allowlisted address", async () => {
      const account = privateKeyToAccount(generatePrivateKey());
      process.env.PCC_SETTLEMENT_OPERATORS = account.address.toLowerCase();
      const res = await app.inject({
        method: "POST", url: "/api/auth/provision",
        payload: { walletAddress: account.address },   // no SIWE session
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe("wallet_not_verified");
    });
  });
});
