import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CdpSpendPermissionService, YellowcardOfframp } from "@pcc/payments";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { fiatRampRoutes } from "../routes/fiat-ramp.js";
import {
  SCOPE_COVERED_ROUTES, UNSCOPED_ROUTES, PUBLIC_SCOPED_URL,
  type ScopeCoveredRoute,
} from "./helpers/scope-covered-routes.js";

const FRESH_WALLET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "CDP_API_KEY_ID", "YELLOWCARD_API_KEY", "PCC_LEGACY_FIAT_WEBHOOKS"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  initStore({ seed: true });
  sc.__resetScopeCacheForTests();
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  vi.restoreAllMocks();
  closeStore();
  sc.__resetScopeCacheForTests();
  vi.unstubAllEnvs();
});

async function buildApp(routes: "stubs" | "fiat" | "siwe" = "stubs") {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "n109-session-scope-cookie-secret" });
  await app.register(apiGate);
  await app.register(sc.scopeChecker);
  if (routes === "fiat") await app.register(fiatRampRoutes);
  else if (routes === "siwe") await app.register(siweAuthPlugin);
  else {
    for (const route of [...SCOPE_COVERED_ROUTES, ...UNSCOPED_ROUTES]) {
      app.route({ method: route.method, url: route.path, handler: async () => ({ reached: true }) });
    }
  }
  await app.ready();
  return app;
}

function issueSession(wallet = FRESH_WALLET) {
  const token = randomUUID();
  const createdAt = new Date().toISOString();
  getRepos().sessions.insert({
    id: randomUUID(), walletAddress: wallet, token, createdAt,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), lastActiveAt: createdAt,
  });
  return token;
}

function issueEmptyScopeKey() {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: randomUUID(), keyHash, keyPrefix, operatorId: FRESH_WALLET,
    name: "empty scopes", description: null, scopes: "[]", rateLimit: "1000/hour",
    usageCount: "0", createdAt: new Date().toISOString(), expiresAt: null,
    metadata: null, publicKey: null,
  });
  return rawKey;
}

function requiredScopes(route: ScopeCoveredRoute) {
  if (route.requirement === "money-default-deny") return ["operator", "admin"];
  if (route.requirement.includes("operator") && route.class !== "money-write" && route.class !== "admin") {
    return [...route.requirement, "operator:basic"];
  }
  return route.requirement;
}

describe("a wallet session holds no scopes", () => {
  it("the scope-covered table contains all 57 registrations", () => {
    expect(SCOPE_COVERED_ROUTES).toHaveLength(57);
    expect(SCOPE_COVERED_ROUTES.filter((route) => route.url !== PUBLIC_SCOPED_URL)).toHaveLength(56);
  });

  // apiGate deliberately leaves public feedback without a principal, even when credentials are sent.
  it.each(SCOPE_COVERED_ROUTES)("$method $path judges a resolved session with no scopes", async (route) => {
    const app = await buildApp();
    const response = await app.inject({
      method: route.method, url: route.url,
      headers: { authorization: `Bearer ${issueSession()}` },
    });
    if (route.url === PUBLIC_SCOPED_URL) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ reached: true });
      return;
    }
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: "insufficient_scope", required_scopes: requiredScopes(route), caller_scopes: [],
    });
    expect(response.json().reached).toBeUndefined();
  });

  it.each(UNSCOPED_ROUTES)("$method $path permits a session on an unscoped route", async (route) => {
    const app = await buildApp();
    const response = await app.inject({
      method: route.method, url: route.url,
      headers: { authorization: `Bearer ${issueSession()}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reached: true });
  });

  it.each(["none", "bearer", "cookie"] as const)("public feedback has no principal with %s credentials", async (credentials) => {
    const app = await buildApp();
    const token = issueSession();
    const headers = credentials === "bearer"
      ? { authorization: `Bearer ${token}` }
      : credentials === "cookie" ? { cookie: `pcc_session=${app.signCookie(token)}` } : {};
    const response = await app.inject({ method: "GET", url: PUBLIC_SCOPED_URL, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reached: true });
  });

  it("an empty userId is still a resolved principal with no scopes", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "POST", url: "/api/kernels/register",
      headers: { authorization: `Bearer ${issueSession("")}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "insufficient_scope", caller_scopes: [] });
    expect(response.json().reached).toBeUndefined();
  });

  it("governance loading fails closed for sessions and scoped keys alike on unscoped routes", async () => {
    const app = await buildApp();
    vi.spyOn(getRepos().governance, "findAllEndpointScopes").mockImplementation(() => {
      throw new Error("governance unavailable");
    });
    for (const token of [issueSession(), issueEmptyScopeKey()]) {
      sc.__resetScopeCacheForTests();
      const response = await app.inject({
        method: "GET", url: "/api/escrow", headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error).toBe("scope_requirements_unavailable");
      expect(response.json().reached).toBeUndefined();
    }
  });

  it("a session cannot issue a spend permission through the real fiat routes", async () => {
    const issue = vi.spyOn(CdpSpendPermissionService.prototype, "issue");
    const app = await buildApp("fiat");
    const response = await app.inject({
      method: "POST", url: "/api/fiat-ramp/cdp/spend-permission",
      headers: { authorization: `Bearer ${issueSession()}` },
      payload: {
        walletAddress: "0x1111111111111111111111111111111111111111",
        spender: "0x2222222222222222222222222222222222222222",
        allowanceUSDC: 500, periodSec: 86_400,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("insufficient_scope");
    expect(issue).not.toHaveBeenCalled();
  });

  it("a session cannot submit a withdrawal through the real fiat routes", async () => {
    const submit = vi.spyOn(YellowcardOfframp.prototype, "submitWithdrawal");
    const app = await buildApp("fiat");
    const response = await app.inject({
      method: "POST", url: "/api/fiat-ramp/yellowcard/withdraw",
      headers: { authorization: `Bearer ${issueSession()}` },
      payload: {
        walletAddress: "0x1111111111111111111111111111111111111111",
        amountUsd: "250", fiatCurrency: "NGN", country: "NG", channelId: "channel1",
        destination: { type: "bank_transfer", accountName: "Test", accountNumber: "0000000000", country: "NG" },
        sender: { name: "Test", country: "NG", address: "x", dob: "1990-01-01", email: "test@example.com", idNumber: "1", idType: "passport" },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("insufficient_scope");
    expect(submit).not.toHaveBeenCalled();
  });

  it("SIWE authentication routes remain open through the real login and session flow", async () => {
    const app = await buildApp("siwe");
    const hostname = "capability.network";
    const nonceResponse = await app.inject({
      method: "GET", url: "/api/auth/nonce", headers: { host: hostname },
    });
    expect(nonceResponse.statusCode).toBe(200);
    const account = privateKeyToAccount(generatePrivateKey());
    const message = [
      `${hostname} wants you to sign in with your Ethereum account:`, account.address,
      "", "Sign in to PCC.", "", `URI: https://${hostname}`, "Version: 1", "Chain ID: 8453",
      `Nonce: ${nonceResponse.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = await account.signMessage({ message });
    const verifyResponse = await app.inject({
      method: "POST", url: "/api/auth/verify", headers: { host: hostname }, payload: { message, signature },
    });
    expect(verifyResponse.statusCode).toBe(200);
    const token = verifyResponse.json().token;
    expect(typeof token).toBe("string");
    const headers = { authorization: `Bearer ${token}` };
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ address: account.address });
    const sessions = await app.inject({ method: "GET", url: "/api/auth/sessions", headers });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json().count).toBe(1);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect(getRepos().sessions.findByToken(token)).toBeUndefined();
  });
});
