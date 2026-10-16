import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { sql } from "@pcc/store";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { walletsRoutes } from "../routes/wallets.js";
import { walletFaucetRoutes } from "../routes/wallet-faucet.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import { telemetryLookalikeHook } from "../services/telemetry-privacy.js";

const path = "/api/wallets/link-requests";
const publicOrigin = "https://capability.network";
const credentials = { PCC_FAUCET_CDP_API_KEY_ID: "dummy-faucet-id", PCC_FAUCET_CDP_API_KEY_SECRET: "dummy-faucet-secret" };
const authenticationRequired = {
  error: "api_key_required",
  message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.",
  provision_url: "/api/auth/provision",
  docs: "https://capability.network/whitepaper.md",
};
type Headers = Record<string, string>;
type Token = "eth" | "usdc";
type PublicClaim = { token: Token; amount: string; status: string; txHash?: string };
type FundingBody = { status: string; claims: PublicClaim[] };
let app: FastifyInstance;
let now: number;
let provisioningIp = 1;
let creationIp: number;
let calls: { address: string; token: Token }[];
const fake = {
  requestFaucet: async (address: `0x${string}`, token: Token) => {
    calls.push({ address, token });
    return { transactionHash: `0x${randomBytes(32).toString("hex")}` };
  },
};

async function buildApp() {
  const instance = Fastify({ logger: false });
  instance.addHook("onRequest", telemetryLookalikeHook);
  await instance.register(cookie, { secret: "w2-owner-route-test-cookie-secret" });
  await instance.register(rateLimiter);
  await instance.register(apiGate);
  await instance.register(tenantContext);
  await instance.register(scopeChecker);
  await instance.register(siweAuthPlugin);
  await instance.register(provisionRoutes);
  await instance.register(walletsRoutes);
  await instance.register(walletFaucetRoutes, { client: fake, env: credentials });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", publicOrigin);
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.stubEnv("POSTHOG_API_KEY", "");
  for (const name of ["PCC_NETWORK", "CDP_NETWORK", "PCC_X402_CHAIN", "CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  creationIp = 1;
  calls = [];
  __resetRateLimitState();
  __resetScopeCacheForTests();
  const store = initStore({ seed: false });
  for (const [id, token, operatorId, scopes] of [
    ["owner", "pcc_test_wallet_owner", "account-a", "[]"],
    ["other", "pcc_test_wallet_other", "account-b", '["*"]'],
    ["same-account-key", "pcc_test_wallet_same_account", "account-a", '["*"]'],
  ]) {
    store.repos.apiKeys.insert({ id: id!, keyHash: hashApiKey(token!), keyPrefix: token!.slice(0, 12), operatorId: operatorId!,
      name: null, description: null, scopes: scopes!, rateLimit: "1000/hour", usageCount: "0",
      createdAt: new Date(now).toISOString(), expiresAt: null, metadata: null, publicKey: null });
  }
  app = await buildApp();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function create() {
  const account = privateKeyToAccount(generatePrivateKey());
  const response = await app.inject({ method: "POST", url: path, remoteAddress: `203.0.113.${creationIp++}`,
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), role: "device", label: "cli", chainId: 84532 } });
  expect(response.statusCode).toBe(201);
  return { account, request: response.json() as { requestId: string; userCode: string; message: string } };
}

async function linked(headers: Headers) {
  const result = await create();
  const signature = await result.account.signMessage({ message: result.request.message });
  expect((await app.inject({ method: "POST", url: `${path}/${result.request.requestId}/proof`, payload: { signature } })).statusCode).toBe(200);
  const response = await app.inject({ method: "POST", url: `${path}/${result.request.requestId}/approve`, headers,
    payload: { userCode: result.request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(response.statusCode).toBe(200);
  return { ...result, linkId: response.json().linkId as string };
}
type Linked = Awaited<ReturnType<typeof linked>>;

// As in W1, raw session insertion is confined to near-miss and lowercase fixtures.
function sessionHeaders(token: string, accountId: string = privateKeyToAccount(generatePrivateKey()).address) {
  getRepos().sessions.insert({ id: token, token, walletAddress: accountId,
    createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString() });
  return { cookie: `pcc_session=${app.signCookie(token)}`, origin: publicOrigin };
}

async function signIn(account = privateKeyToAccount(generatePrivateKey())) {
  const { nonce } = (await app.inject({ url: "/api/auth/nonce", headers: { host: "capability.network" } })).json();
  const message = `capability.network wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to PCC.\n\nURI: https://capability.network\nVersion: 1\nChain ID: 84532\nNonce: ${nonce}\nIssued At: ${new Date(now).toISOString()}`;
  const response = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: "capability.network" },
    payload: { message, signature: await account.signMessage({ message }) } });
  expect(response.statusCode).toBe(200);
  const headers = { cookie: `pcc_session=${app.signCookie(response.json().token)}`, origin: publicOrigin };
  return { account, headers, token: response.json().token as string };
}

async function mintSessionKey(headers: Headers) {
  const response = await app.inject({ method: "POST", url: "/api/auth/session-key", headers });
  expect(response.statusCode).toBe(201);
  return { headers: { authorization: `Bearer ${response.json().api_key}` }, id: response.json().key_id as string };
}

async function provisionClaimedKey(address: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/provision", remoteAddress: `198.51.100.${provisioningIp++}`,
    payload: { walletAddress: address, metadata: { source: "siwe-session", sessionId: "forged" } } });
  expect(response.statusCode).toBe(201);
  expect(JSON.parse(getRepos().apiKeys.findById(response.json().key_id)!.metadata!)).toMatchObject({ source: "landing-page" });
  return { headers: { authorization: `Bearer ${response.json().api_key}` }, id: response.json().key_id as string };
}

async function revoke(linkId: string, headers: Headers) {
  return app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers, payload: {} });
}

function rows(linkId?: string) {
  return getStore().db.all<Record<string, unknown>>(linkId
    ? sql`SELECT * FROM faucet_claims WHERE link_id = ${linkId} ORDER BY CASE token WHEN 'eth' THEN 0 ELSE 1 END, seq`
    : sql`SELECT * FROM faucet_claims`);
}

async function refused(result: Linked, headers: Headers, code = 404, body: object = { error: "link_not_found" }, context?: string) {
  const before = rows();
  const n = calls.length;
  const response = await app.inject({ method: "POST", url: `/api/wallets/${result.linkId}/fund`, headers, payload: {} });
  expect(response.statusCode, context).toBe(code);
  expect(response.json()).toEqual(body);
  expect(rows()).toEqual(before);
  expect(calls).toHaveLength(n);
  return response;
}

function expectFundingBody(body: FundingBody) {
  expect(Object.keys(body).sort()).toEqual(["claims", "status"]);
  expect(body.status).toBe("funded");
  expect(body.claims).toHaveLength(5);
  for (const claim of body.claims) {
    expect(Object.keys(claim).sort()).toEqual(["amount", "status", "token", "txHash"]);
    expect(claim).toMatchObject({ token: "eth", amount: "0.0001", status: "succeeded" });
    expect(claim.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }
}

async function fund(result: Linked, headers?: Headers) {
  const response = await app.inject({ method: "POST", url: headers
    ? `/api/wallets/${result.linkId}/fund` : `${path}/${result.request.requestId}/fund`, ...(headers ? { headers } : {}), payload: {} });
  expect(response.statusCode).toBe(200);
  const body = response.json<FundingBody>();
  expectFundingBody(body);
  return body;
}

describe("W2 owner faucet principals", () => {
  it("T1 other SIWE cookies, session keys and invalid-key cookies cannot fund A's link", async () => {
    const a = await signIn();
    const skA = await mintSessionKey(a.headers);
    const result = await linked(skA.headers);
    const b = await signIn();
    const skB = await mintSessionKey(b.headers);
    for (const headers of [b.headers, skB.headers, { ...b.headers, authorization: "Bearer pcc_test_not_a_real_key" }]) {
      await refused(result, headers);
    }
    const body = await fund(result, a.headers);
    const n = calls.length;
    expect(await fund(result, skA.headers)).toEqual(body);
    expect(calls).toHaveLength(n);
    expect(n).toBe(5);
  });

  it("T1b near-miss principals and B cannot fund key- or cookie-approved links", async () => {
    const a = await signIn();
    const skA = await mintSessionKey(a.headers);
    const results = [await linked(skA.headers), await linked(a.headers)];
    const b = await signIn();
    for (const [linkIndex, result] of results.entries()) {
      await refused(result, b.headers, 404, { error: "link_not_found" }, `B cookie on L${linkIndex + 1}`);
    }
    // A last-digit near miss catches prefix matches; first and middle digits also catch
    // suffix and shortened-display ("0x1234…abcd") partial-address matches.
    for (const index of [2, 21, 41]) {
      const digit = a.account.address[index]!.toLowerCase() === "0" ? "1" : "0";
      const nearMiss = `${a.account.address.slice(0, index)}${digit}${a.account.address.slice(index + 1)}`;
      const near = sessionHeaders(`near-miss-${index}`, nearMiss);
      const nearKey = await mintSessionKey(near);
      for (const [principal, headers] of [["cookie", near], ["key", nearKey.headers]] as const) {
        for (const [linkIndex, result] of results.entries()) {
          await refused(result, headers, 404, { error: "link_not_found" }, `near miss at index ${index}, ${principal} on L${linkIndex + 1}`);
        }
      }
    }
    for (const result of results) await fund(result, a.headers);
    expect(calls).toHaveLength(10);
  });

  it.each(["session-key", "cookie"] as const)("T2 rotated credentials preserve device funding through %s", async principal => {
    const session = await signIn();
    const sk1 = await mintSessionKey(session.headers);
    const result = await linked(sk1.headers);
    const sk2 = await mintSessionKey(session.headers);
    expect(sk2.id).not.toBe(sk1.id);
    await refused(result, sk1.headers, 401, authenticationRequired);
    await fund(result, principal === "session-key" ? sk2.headers : session.headers);
  });

  it("T3 a claimed key naming S cannot fund S's SIWE-approved link", async () => {
    const session = await signIn();
    const sk = await mintSessionKey(session.headers);
    const result = await linked(sk.headers);
    const claimed = await provisionClaimedKey(session.account.address);
    await refused(result, claimed.headers);
  });

  it("T4 a SIWE owner cannot fund a stranger's claimed link but can revoke it", async () => {
    const victim = await signIn();
    const skV = await mintSessionKey(victim.headers);
    const stranger = await provisionClaimedKey(victim.account.address.toLowerCase());
    const result = await linked(stranger.headers);
    expect(result.account.address.toLowerCase()).not.toBe(victim.account.address.toLowerCase());
    await refused(result, victim.headers);
    await refused(result, skV.headers);
    await fund(result, stranger.headers);
    expect((await revoke(result.linkId, victim.headers)).statusCode).toBe(200);
  });

  it("T5 a revoked claimed key does not grant its named SIWE owner funding authority", async () => {
    const session = await signIn();
    const claimed = await provisionClaimedKey(session.account.address);
    const result = await linked(claimed.headers);
    expect((await app.inject({ method: "DELETE", url: `/api/auth/keys/${claimed.id}`, headers: claimed.headers })).statusCode).toBe(200);
    await refused(result, claimed.headers, 401, authenticationRequired);
    await refused(result, session.headers);
    await fund(result);
  });

  it("T6 a lowercase session for the same wallet funds a session-key-approved link", async () => {
    const victim = await signIn();
    const skV = await mintSessionKey(victim.headers);
    const result = await linked(skV.headers);
    const lowercase = sessionHeaders("lowercase-funding-session", victim.account.address.toLowerCase());
    await fund(result, lowercase);
  });

  it.each(["checksummed", "lowercase"] as const)("T7 claimed %s identities and SIWE identities each retain their own account cap", async casing => {
    const victim = await signIn();
    const skV = await mintSessionKey(victim.headers);
    const claimed = await provisionClaimedKey(casing === "checksummed" ? victim.account.address : victim.account.address.toLowerCase());
    for (let index = 0; index < 3; index++) await fund(await linked(claimed.headers));
    await refused(await linked(claimed.headers), claimed.headers, 409, { error: "cap_reached", cap: "account" });
    for (let index = 0; index < 3; index++) await fund(await linked(skV.headers));
    await refused(await linked(skV.headers), skV.headers, 409, { error: "cap_reached", cap: "account" });
  });

  it("T8 cookie, session-key and lowercase SIWE approvals share one account cap", async () => {
    const victim = await signIn();
    const skV = await mintSessionKey(victim.headers);
    await fund(await linked(skV.headers));
    await fund(await linked(skV.headers));
    const lowercase = sessionHeaders("lowercase-cap-session", victim.account.address.toLowerCase());
    await fund(await linked(lowercase));
    await refused(await linked(victim.headers), victim.headers, 409, { error: "cap_reached", cap: "account" });
  });

  it("T9 grant rows keep approval provenance without adding response or claim keys", async () => {
    const session = await signIn();
    const sk = await mintSessionKey(session.headers);
    const claimed = await provisionClaimedKey(session.account.address);
    for (const principal of [
      { headers: session.headers, proof: "siwe", id: null },
      { headers: sk.headers, proof: "siwe", id: sk.id },
      { headers: claimed.headers, proof: "claimed", id: claimed.id },
    ]) {
      const result = await linked(principal.headers);
      await fund(result, principal.headers);
      expect(rows(result.linkId)).toHaveLength(5);
      for (const row of rows(result.linkId)) expect(row).toMatchObject({ account_proof: principal.proof, approved_by_key_id: principal.id });
    }
  });

  it("T22 cookie funding requires the configured Origin while session-key funding does not", async () => {
    const a = await signIn();
    const skA = await mintSessionKey(a.headers);
    const first = await linked(skA.headers);
    await refused(first, { ...a.headers, origin: "https://evil.example" }, 403, { error: "origin_mismatch" });
    await refused(first, { cookie: a.headers.cookie }, 403, { error: "origin_mismatch" });
    await fund(first, a.headers);
    await fund(await linked(skA.headers), skA.headers);
    expect(calls).toHaveLength(10);
  });
});
