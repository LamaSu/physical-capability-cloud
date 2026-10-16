import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { sql } from "@pcc/store";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { provisionRoutes } from "../routes/provision.js";
import { walletsRoutes } from "../routes/wallets.js";
import { decideLinkRequest, getLinkRequest, resolveActiveWalletLink } from "../services/wallet-links/repository.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import * as config from "../services/wallet-links/config.js";
import { telemetryLookalikeHook } from "../services/telemetry-privacy.js";

const path = "/api/wallets/link-requests";
const owner = { authorization: "Bearer pcc_test_wallet_owner" };
const other = { authorization: "Bearer pcc_test_wallet_other" };
const sameAccount = { authorization: "Bearer pcc_test_wallet_same_account" };
let app: FastifyInstance;
let logLines: string[];
let clockNow: number;
let bodyStreamIterations: number;
let provisioningIp = 1;

async function buildApp() {
  const instance = Fastify({ logger: { level: "info", stream: { write: (s: string) => { logLines.push(s); } } }, disableRequestLogging: true });
  instance.addHook("onRequest", telemetryLookalikeHook);
  await instance.register(cookie, { secret: "w1-wallet-route-test-cookie-secret" });
  await instance.register(rateLimiter);
  await instance.register(apiGate);
  await instance.register(tenantContext);
  await instance.register(scopeChecker);
  instance.addHook("onRequest", async req => {
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const iterator = req.raw[Symbol.asyncIterator];
    req.raw[Symbol.asyncIterator] = function () { bodyStreamIterations++; return iterator.call(this); };
  });
  instance.get("/api/dht/w1-rate-control", async () => ({ ok: true }));
  await instance.register(siweAuthPlugin);
  await instance.register(provisionRoutes);
  await instance.register(walletsRoutes);
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  vi.stubEnv("PCC_DEPLOYMENT_ENV", "");
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
  vi.stubEnv("PCC_GATEWAY_PRIVATE_KEY", "");
  vi.stubEnv("DEPLOYER_PRIVATE_KEY", "");
  vi.stubEnv("POSTHOG_API_KEY", "");
  clockNow = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clockNow);
  logLines = [];
  bodyStreamIterations = 0;
  __resetRateLimitState();
  __resetScopeCacheForTests();
  const store = initStore({ seed: false });
  for (const [id, token, operatorId, scopes] of [
    ["owner", "pcc_test_wallet_owner", "account-a", "[]"],
    ["other", "pcc_test_wallet_other", "account-b", '["*"]'],
    ["same-account-key", "pcc_test_wallet_same_account", "account-a", '["*"]'],
  ]) {
    store.repos.apiKeys.insert({ id, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 12), operatorId,
      name: null, description: null, scopes, rateLimit: "1000/hour", usageCount: "0",
      createdAt: new Date(clockNow).toISOString(), expiresAt: null, metadata: null, publicKey: null });
  }
  app = await buildApp();
});

afterEach(async () => { await app?.close(); closeStore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function create(overrides: Record<string, unknown> = {}, ip = "203.0.113.27", headers: Record<string, string> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const response = await app.inject({ method: "POST", url: path, remoteAddress: ip, headers,
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), role: "agent", label: "cli@laptop", chainId: 84532, ...overrides } });
  expect(response.statusCode).toBe(201);
  return { account, request: response.json() as {requestId: string;userCode: string;message: string;expiresAt: string;verificationUri: string;interval: number} };
}
async function proved(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const result = await create(overrides, "203.0.113.27", headers);
  const signature = await result.account.signMessage({ message: result.request.message });
  const response = await app.inject({ method: "POST", url: `${path}/${result.request.requestId}/proof`, payload: { signature } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "awaiting_approval" });
  return { ...result, signature };
}
async function approve(request: { requestId: string; userCode: string }, headers: Record<string, string> = owner, payload = {}) {
  return app.inject({ method: "POST", url: `${path}/${request.requestId}/approve`, headers,
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256, ...payload } });
}
async function lookup(userCode: string, headers: Record<string, string> = owner, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `${path}/lookup`, headers, payload: { userCode, ...extra } });
}
function sessionHeaders(token: string, accountId = privateKeyToAccount(generatePrivateKey()).address) {
  getRepos().sessions.insert({ id: token, token, walletAddress: accountId,
    createdAt: new Date(clockNow).toISOString(), lastActiveAt: new Date(clockNow).toISOString(),
    expiresAt: new Date(clockNow + 86400000).toISOString() });
  return { cookie: `pcc_session=${app.signCookie(token)}`, origin: "https://capability.network" };
}

async function signIn(account = privateKeyToAccount(generatePrivateKey())) {
  const { nonce } = (await app.inject({ url: "/api/auth/nonce", headers: { host: "capability.network" } })).json();
  const message = `capability.network wants you to sign in with your Ethereum account:\n${account.address}\n\nSign in to PCC.\n\nURI: https://capability.network\nVersion: 1\nChain ID: 84532\nNonce: ${nonce}\nIssued At: ${new Date(clockNow).toISOString()}`;
  const response = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: "capability.network" },
    payload: { message, signature: await account.signMessage({ message }) } });
  expect(response.statusCode).toBe(200);
  const headers = { cookie: `pcc_session=${app.signCookie(response.json().token)}`, origin: "https://capability.network" };
  return { account, headers, token: response.json().token as string };
}

async function mintSessionKey(headers: Record<string, string>, context?: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/session-key", headers });
  expect(response.statusCode, context).toBe(201);
  return { headers: { authorization: `Bearer ${response.json().api_key}` }, id: response.json().key_id as string };
}

async function provisionClaimedKey(address: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/provision", remoteAddress: `198.51.100.${provisioningIp++}`,
    payload: { walletAddress: address, metadata: { source: "siwe-session", sessionId: "forged" } } });
  expect(response.statusCode).toBe(201);
  expect(JSON.parse(getRepos().apiKeys.findById(response.json().key_id)!.metadata!)).toMatchObject({ source: "landing-page" });
  return { headers: { authorization: `Bearer ${response.json().api_key}` }, id: response.json().key_id as string };
}

async function revoke(linkId: string, headers: Record<string, string>, payload: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers, payload });
}
function updateRequest(id: string, set: ReturnType<typeof sql>) {
  getStore().db.run(sql`UPDATE wallet_link_requests SET ${set} WHERE id = ${id}`);
}

describe("W1 wallet ceremony", () => {
  it("happy path secp256k1 agent, consent receipt and account-bound lookup", async () => {
    const { account, request } = await proved({ clientInfo: { name: "pcc-cli", version: "0.3.0" } });
    expect(request.requestId).toMatch(/^lr_[A-Z2-7]{26}$/);
    expect(request.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(request.verificationUri).toBe("https://capability.network/link");
    expect(request.interval).toBe(5);
    expect(Date.parse(request.expiresAt) - clockNow).toBe(600000);
    expect(request.message).toContain(account.address);
    expect(request.message).toContain(`urn:pcc:consent:wallet-link-v1:sha256:${CONSENT_SHA256}`);
    const poll = await app.inject(`${path}/${request.requestId}`);
    expect(poll.json()).toEqual({ status: "authorization_pending" });
    const consent = await lookup(request.userCode.toLowerCase().replace("-", " "));
    expect(consent.statusCode).toBe(200);
    expect(consent.json()).toMatchObject({ requestId: request.requestId, address: account.address, role: "agent", chainId: 84532,
      network: "Base Sepolia (test network, chain 84532)", requesterIpClass: "203.0.113.x", clientInfo: { name: "pcc-cli", version: "0.3.0" },
      consent: { version: "wallet-link-v1", sha256: CONSENT_SHA256 } });
    expect(consent.json().consent.text).toContain("1 test USDC");
    const decision = await approve(request);
    expect(decision.statusCode).toBe(200);
    const { linkId, accountId } = decision.json();
    expect(linkId).toMatch(/^wl_[A-Z2-7]{26}$/);
    expect(accountId).toBe("account-a");
    clockNow += 5000;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "approved", linkId });
    const list = await app.inject({ url: "/api/wallets", headers: owner });
    expect(list.json().links).toHaveLength(1);
    expect(list.json().links[0]).toMatchObject({ linkId, status: "active", address: account.address, role: "agent" });
    expect(Date.parse(list.json().links[0].expiresAt) - Date.parse(list.json().links[0].createdAt)).toBe(30 * 86400000);
    expect((await app.inject({ url: "/api/wallets", headers: other })).json()).toEqual({ links: [] });
    expect(await resolveActiveWalletLink({ address: account.address.toLowerCase(), chainId: 84532 })).toMatchObject({ linkId, accountId, role: "agent", keyType: "secp256k1" });
    const receipt = getStore().db.get<any>(sql`SELECT * FROM wallet_links WHERE id = ${linkId}`);
    expect(receipt).toMatchObject({ proof_message: request.message, request_id: request.requestId, approved_by: accountId, consent_sha256: CONSENT_SHA256, approval_signature: null });
    expect(receipt.proof_signature).toMatch(/^0x/);
  });

  it("happy path ed25519 device with kernelId", async () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
    const response = await app.inject({ method: "POST", url: path, remoteAddress: "2001:db8:1234:abcd::1",
      payload: { keyType: "ed25519", publicKey: publicKey.toUpperCase(), role: "device", label: "lab-device", kernelId: "kernel_lab-1", chainId: 84532 } });
    expect(response.statusCode).toBe(201);
    const request = response.json();
    expect(request.message.startsWith("PCC-LINK-V1\n")).toBe(true);
    expect(JSON.parse(request.message.slice(12))).toMatchObject({ publicKey, kernelId: "kernel_lab-1" });
    const signature = sign(null, Buffer.from(request.message), pair.privateKey).toString("hex");
    expect((await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } })).statusCode).toBe(200);
    const consent = (await lookup(request.userCode)).json();
    expect(consent).toMatchObject({ publicKey, kernelId: "kernel_lab-1", requesterIpClass: "2001:0db8:1234::/48" });
    expect(consent.consent.text).toContain("It cannot spend.");
    const decision = await approve(request);
    expect(decision.statusCode).toBe(200);
    const row = (await app.inject({ url: "/api/wallets", headers: owner })).json().links[0];
    expect(row).toMatchObject({ keyType: "ed25519", publicKey, expiresAt: null });
  });

  it("POST lookup accepts the code only in its body and the removed GET path always gives 404", async () => {
    const { request } = await proved();
    for (const code of [request.userCode, "BBBB-BBBB", request.userCode.toLowerCase()]) {
      for (const headers of [owner, other, {}]) {
        const response = await app.inject({ method: "GET", url: `${path}/by-code/${code}`, headers });
        expect(response.statusCode).toBe(404);
      }
    }
    const response = await lookup(request.userCode);
    expect(response.statusCode).toBe(200);
    expect(response.json().requestId).toBe(request.requestId);
    expect(logLines.join("")).not.toContain(request.userCode);
    expect(logLines.join("")).not.toContain(request.userCode.replace("-", ""));
  });

  it("POST lookup has an exact body schema and refuses I1 before unknown-field validation", async () => {
    const { request } = await proved();
    for (const payload of [{}, { userCode: 1 }, { userCode: request.userCode, unknown: true }, { userCode: request.userCode, clientInfo: {} }]) {
      const response = await app.inject({ method: "POST", url: `${path}/lookup`, headers: owner, payload });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "invalid_request" });
    }
    const response = await lookup(request.userCode, owner, { unknown: [{ nested: { private_key: "never-logged-lookup" } }] });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "key_material_refused" });
    expect(response.body).not.toContain("never-logged-lookup");
    expect(logLines.join("")).not.toContain("never-logged-lookup");
  });

  it("records creating and approving API key ids separately from account ids without returning them", async () => {
    const { request } = await proved({}, owner);
    const pending = getStore().db.get<any>(sql`SELECT * FROM wallet_link_requests WHERE id = ${request.requestId}`);
    expect(pending).toMatchObject({ created_by_key_id: "owner", approved_by_key_id: null });
    const response = await approve(request, sameAccount);
    expect(response.statusCode).toBe(200);
    const { linkId } = response.json();
    const decided = getStore().db.get<any>(sql`SELECT * FROM wallet_link_requests WHERE id = ${request.requestId}`);
    expect(decided).toMatchObject({ created_by_key_id: "owner", approved_by_key_id: "same-account-key", approved_by: "account-a" });
    const link = getStore().db.get<any>(sql`SELECT * FROM wallet_links WHERE id = ${linkId}`);
    expect(link).toMatchObject({ created_by_key_id: "owner", approved_by_key_id: "same-account-key", approved_by: "account-a" });
    for (const result of [request, response.json(), (await lookup(request.userCode)).json(),
      (await app.inject(`${path}/${request.requestId}`)).json(), (await app.inject({ url: "/api/wallets", headers: sameAccount })).json()]) {
      expect(JSON.stringify(result)).not.toMatch(/created_by_key_id|approved_by_key_id|createdByKeyId|approvedByKeyId/);
    }
  });

  it("C2 keeps the creating key write-once through proof, approval and revocation", async () => {
    const { account, request } = await create({}, "203.0.113.27", owner);
    const creator = () => getLinkRequest(request.requestId)?.created_by_key_id;
    expect(creator()).toBe("owner");
    const proof = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, headers: other,
      payload: { signature: await account.signMessage({ message: request.message }) } });
    expect(proof.statusCode).toBe(200);
    expect(getLinkRequest(request.requestId)?.status).toBe("awaiting_approval");
    expect(creator()).toBe("owner");

    const approval = await approve(request, sameAccount);
    expect(approval.statusCode).toBe(200);
    const { linkId } = approval.json();
    const receipt = () => getStore().db.get<{ created_by_key_id: string; approved_by_key_id: string }>(
      sql`SELECT created_by_key_id, approved_by_key_id FROM wallet_links WHERE id = ${linkId}`);
    expect(getLinkRequest(request.requestId)).toMatchObject({ status: "approved", created_by_key_id: "owner", approved_by_key_id: "same-account-key" });
    expect(receipt()).toEqual({ created_by_key_id: creator(), approved_by_key_id: "same-account-key" });

    expect((await revoke(linkId, sameAccount)).statusCode).toBe(200);
    expect(creator()).toBe("owner");
    expect(receipt()?.created_by_key_id).toBe(creator());
    expect(getStore().db.get<{ revoked_at: string | null }>(sql`SELECT revoked_at FROM wallet_links WHERE id = ${linkId}`)?.revoked_at).not.toBeNull();
  });

  it("C2 keeps the creating key write-once through denial", async () => {
    const { request } = await proved({}, owner);
    expect(getLinkRequest(request.requestId)?.created_by_key_id).toBe("owner");
    const denied = await approve(request, sameAccount, { decision: "deny" });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({ status: "denied" });
    expect(getLinkRequest(request.requestId)).toMatchObject({ status: "denied", created_by_key_id: "owner", approved_by_key_id: "same-account-key", link_id: null });
    expect(getStore().db.get<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_links WHERE request_id = ${request.requestId}`)?.n).toBe(0);
  });

  it.each(["pending_proof", "awaiting_approval"] as const)("C2 keeps the creating key write-once when %s expires", async status => {
    const { request } = status === "pending_proof" ? await create({}, "203.0.113.27", owner) : await proved({}, owner);
    expect(getLinkRequest(request.requestId)).toMatchObject({ status, created_by_key_id: "owner" });
    clockNow = Date.parse(request.expiresAt) + 1;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "expired" });
    expect(getLinkRequest(request.requestId)?.created_by_key_id).toBe("owner");
    // Creation persists expiration of old pending rows as part of slot cleanup.
    await create({}, "203.0.113.28", other);
    expect(getLinkRequest(request.requestId)).toMatchObject({ status: "expired", created_by_key_id: "owner", link_id: null });
    expect(getStore().db.get<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_links WHERE request_id = ${request.requestId}`)?.n).toBe(0);
  });

  it.each(["id", "requestId"])("C2 rejects a client-chosen %s and generates fresh request ids", async field => {
    const chosenId = `lr_${"A".repeat(26)}`;
    const account = privateKeyToAccount(generatePrivateKey());
    const rejected = await app.inject({ method: "POST", url: path, headers: owner,
      payload: { keyType: "secp256k1", address: account.address, role: "agent", label: "cli", chainId: 84532, [field]: chosenId } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toEqual({ error: "invalid_request" });
    expect(getStore().db.get<{ n: number }>(sql`SELECT count(*) AS n FROM wallet_link_requests`)?.n).toBe(0);
    const first = await create({}, "203.0.113.27", owner);
    const second = await create({}, "203.0.113.27", owner);
    const ids = [first.request.requestId, second.request.requestId];
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^lr_[A-Z2-7]{26}$/);
      expect(id).not.toBe(chosenId);
      expect(getLinkRequest(id)?.id).toBe(id);
    }
    expect(getLinkRequest(chosenId)).toBeUndefined();
  });

  it("anonymous create and cookie approval store null key ids on the request and link", async () => {
    const { request } = await proved();
    expect(getStore().db.get<any>(sql`SELECT * FROM wallet_link_requests WHERE id = ${request.requestId}`).created_by_key_id).toBeNull();
    const headers = sessionHeaders("cookie-approval");
    const response = await approve(request, headers);
    expect(response.statusCode).toBe(200);
    expect(getStore().db.get<any>(sql`SELECT * FROM wallet_link_requests WHERE id = ${request.requestId}`))
      .toMatchObject({ created_by_key_id: null, approved_by_key_id: null });
    expect(getStore().db.get<any>(sql`SELECT * FROM wallet_links WHERE id = ${response.json().linkId}`))
      .toMatchObject({ created_by_key_id: null, approved_by_key_id: null });
  });

  it("create with a presented invalid API key returns the gateway 401 and stores no anonymous request", async () => {
    const validSession = sessionHeaders("valid-cookie-with-invalid-key");
    for (const cookieHeaders of [{}, validSession]) {
      const response = await app.inject({ method: "POST", url: path,
        headers: { ...cookieHeaders, authorization: "Bearer pcc_test_invalid_wallet_key" },
        payload: { keyType: "secp256k1", address: privateKeyToAccount(generatePrivateKey()).address, role: "agent", label: "cli", chainId: 84532 } });
      expect(response.statusCode).toBe(401); expect(response.json().error).toBe("api_key_required");
      expect(getStore().db.get<any>(sql`SELECT count(*) AS n FROM wallet_link_requests`).n).toBe(0);
    }
  });

  it.each([
    ["valid", "pcc_test_wallet_owner"], ["invalid", "pcc_test_invalid_wallet_key"], ["empty", ""],
  ])("create refuses a %s X-PCC-API-Key with or without Authorization before persisting", async (_kind, key) => {
    const account = privateKeyToAccount(generatePrivateKey());
    for (const authorization of [undefined, owner.authorization]) {
      const response = await app.inject({ method: "POST", url: path,
        headers: { "x-pcc-api-key": key, ...(authorization ? { authorization } : {}) },
        payload: { keyType: "secp256k1", address: account.address, role: "agent", label: "cli", chainId: 84532 } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "api_key_required" });
      expect(response.json().message).toContain("Authorization: Bearer <key>");
      expect(response.json().message).toMatch(/X-PCC-API-Key.*not read/i);
      expect(getStore().db.get<any>(sql`SELECT count(*) AS n FROM wallet_link_requests`).n).toBe(0);
    }
  });

  it("create remains anonymous without credentials and records a valid Authorization bearer key", async () => {
    const anonymous = await create();
    const authenticated = await create({}, "203.0.113.27", owner);
    expect(getStore().db.get<any>(sql`SELECT created_by_key_id FROM wallet_link_requests WHERE id = ${anonymous.request.requestId}`))
      .toEqual({ created_by_key_id: null });
    expect(getStore().db.get<any>(sql`SELECT created_by_key_id FROM wallet_link_requests WHERE id = ${authenticated.request.requestId}`))
      .toEqual({ created_by_key_id: "owner" });
  });

  it.each(["lookup", "proof", "poll"] as const)("X-PCC-API-Key alongside valid Authorization preserves %s", async endpoint => {
    const { account, request } = endpoint === "proof" ? await create() : await proved();
    const headers = { ...owner, "x-pcc-api-key": "pcc_test_wallet_other" };
    const response = endpoint === "lookup" ? await lookup(request.userCode, headers)
      : endpoint === "proof" ? await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, headers,
        payload: { signature: await account.signMessage({ message: request.message }) } })
      : await app.inject({ url: `${path}/${request.requestId}`, headers });
    expect(response.statusCode).toBe(200);
    if (endpoint === "lookup") expect(response.json()).toMatchObject({ requestId: request.requestId, address: account.address });
    else expect(response.json()).toEqual({ status: endpoint === "proof" ? "awaiting_approval" : "authorization_pending" });
  });

  it("scopeChecker enforces POST /api/wallets/** endpoint scopes for an owner key without wildcard", async () => {
    const { request } = await proved();
    getRepos().governance.insertEndpointScope({ id: "wallet-scope-rule", method: "POST", routePattern: "/api/wallets/**",
      requiredScopes: ["wallet:manage"], description: "wallet test" });
    __resetScopeCacheForTests();
    for (const [endpoint, payload] of [
      [`${path}/lookup`, { userCode: request.userCode }],
      [`${path}/${request.requestId}/approve`, { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 }],
      [`/api/wallets/wl_${"A".repeat(26)}/revoke`, {}],
    ] as const) {
      const response = await app.inject({ method: "POST", url: endpoint, headers: owner, payload });
      expect(response.statusCode).toBe(403); expect(response.json().error).toBe("insufficient_scope");
      expect(response.json().required_scopes).toEqual(["wallet:manage"]);
    }
    expect(getLinkRequest(request.requestId)?.status).toBe("awaiting_approval");
    expect((await approve(request, other)).statusCode).toBe(200);
  });

  it("proof messages use the gateway deployment environment ahead of NODE_ENV and bind it at proof", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "railway-stage");
    const railway = await create();
    expect(railway.request.message).toContain("urn:pcc:env:railway-stage");
    vi.stubEnv("PCC_DEPLOYMENT_ENV", " PreVIEW ");
    const preview = await create();
    expect(preview.request.message).toContain("urn:pcc:env:preview");
    expect(preview.request.message).not.toContain("urn:pcc:env:prod\n");
    const signature = await preview.account.signMessage({ message: preview.request.message });
    vi.stubEnv("PCC_DEPLOYMENT_ENV", "production");
    const response = await app.inject({ method: "POST", url: `${path}/${preview.request.requestId}/proof`, payload: { signature } });
    expect(response.statusCode).toBe(401); expect(response.json()).toEqual({ error: "invalid_proof" });
    expect(getLinkRequest(preview.request.requestId)?.status).toBe("failed");
  });

  it("replay consumes once, including two concurrent valid proofs", async () => {
    const { account, request } = await create();
    const signature = await account.signMessage({ message: request.message });
    const submit = () => app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } });
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find(r => r.statusCode === 409)?.json()).toEqual({ error: "already_used" });
    expect((await submit()).json()).toEqual({ error: "already_used" });
  });

  it("expired request refuses proof and approve with 410", async () => {
    const { account, request } = await create();
    const signature = await account.signMessage({ message: request.message });
    updateRequest(request.requestId, sql`expires_at = ${new Date(clockNow - 1).toISOString()}`);
    const proof = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } });
    expect(proof.statusCode).toBe(410); expect(proof.json()).toEqual({ error: "expired" });
    expect((await approve(request)).statusCode).toBe(410);
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "expired" });
  });

  it("wrong signer burns proof and correct signature cannot retry", async () => {
    const { account, request } = await create();
    const wrong = privateKeyToAccount(generatePrivateKey());
    const send = (signature: string) => app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } });
    expect((await send(await wrong.signMessage({ message: request.message }))).json()).toEqual({ error: "invalid_proof" });
    expect((await send(await account.signMessage({ message: request.message }))).statusCode).toBe(409);
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "failed" });
  });

  it.each(["env", "domain", "chain", "allowlist", "uri", "consent", "issuedAt", "message"])("proof binds current %s config and burns mismatches", async field => {
    const { account, request } = await create();
    const signature = await account.signMessage({ message: request.message });
    if (field === "env") { await app.close(); vi.stubEnv("NODE_ENV", "prod"); app = await buildApp(); }
    if (field === "domain") { await app.close(); vi.stubEnv("PCC_PUBLIC_URL", "https://other.example"); app = await buildApp(); }
    if (field === "chain") updateRequest(request.requestId, sql`chain_id = 8453`);
    if (field === "allowlist") vi.spyOn(config, "walletLinkConfig").mockReturnValue({ ...config.walletLinkConfig(), allowedChainIds: [] });
    if (field === "uri") vi.spyOn(config, "walletLinkConfig").mockReturnValue({ ...config.walletLinkConfig(), uri: "https://capability.network/other" });
    if (field === "consent") updateRequest(request.requestId, sql`consent_sha256 = ${"0".repeat(64)}`);
    if (field === "issuedAt") updateRequest(request.requestId, sql`created_at = ${new Date(clockNow - 600001).toISOString()}`);
    if (field === "message") updateRequest(request.requestId, sql`message = message || 'tamper'`);
    const response = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } });
    expect(response.statusCode).toBe(401); expect(response.json()).toEqual({ error: "invalid_proof" });
    expect((await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature } })).statusCode).toBe(409);
  });

  it("stale consent at approve is 409 consent_changed", async () => {
    const { request } = await proved();
    const response = await approve(request, owner, { consentSha256: "0".repeat(64) });
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: "consent_changed" });
    updateRequest(request.requestId, sql`consent_sha256 = ${"0".repeat(64)}`);
    expect((await approve(request)).json()).toEqual({ error: "consent_changed" });
  });

  it("approval refuses a stored consent version changed since proof", async () => {
    const { request } = await proved();
    updateRequest(request.requestId, sql`consent_version = 'wallet-link-obsolete'`);
    const response = await approve(request);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "consent_changed" });
    expect(getStore().db.get<any>(sql`SELECT count(*) AS n FROM wallet_links`).n).toBe(0);
  });

  it("wrong code is 403 and fifth wrong code blocks later attempts with 429", async () => {
    const { request } = await proved();
    for (let i = 0; i < 5; i++) {
      const response = await approve(request, owner, { userCode: "BBBB-BBBB" === request.userCode ? "CCCC-CCCC" : "BBBB-BBBB" });
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual({ error: "code_mismatch" });
    }
    expect((await approve(request)).json()).toEqual({ error: "too_many_attempts" });
    clockNow += 600001;
    expect((await lookup("BBBB-BBBB")).statusCode).toBe(404);
  });

  it("POST lookup shares the wrong-code counter per authenticated credential", async () => {
    const { request } = await proved();
    for (let i = 0; i < 5; i++) expect((await lookup("BBBB-BBBB")).statusCode).toBe(404);
    const response = await lookup(request.userCode);
    expect(response.statusCode).toBe(429);
    expect((await lookup(request.userCode, other)).statusCode).toBe(200);
  });

  it("a second API key claiming the same account does not lock out the first key after five wrong codes", async () => {
    const { request } = await proved();
    const wrong = request.userCode === "BBBB-BBBB" ? "CCCC-CCCC" : "BBBB-BBBB";
    for (let i = 0; i < 5; i++) {
      const response = await lookup(wrong, sameAccount);
      expect(response.statusCode).toBe(404); expect(response.json()).toEqual({ error: "not_found" });
    }
    expect((await lookup(request.userCode, sameAccount)).statusCode).toBe(429);
    expect((await lookup(request.userCode, owner)).statusCode).toBe(200);
    expect((await approve(request, owner)).statusCode).toBe(200);
  });

  it("wrong codes are counted per session token rather than a shared cookie account", async () => {
    const accountId = privateKeyToAccount(generatePrivateKey()).address;
    const first = sessionHeaders("cookie-first", accountId);
    const second = sessionHeaders("cookie-second", accountId);
    const { request } = await proved();
    const wrong = request.userCode === "BBBB-BBBB" ? "CCCC-CCCC" : "BBBB-BBBB";
    for (let i = 0; i < 5; i++) expect((await lookup(wrong, second)).statusCode).toBe(404);
    expect((await lookup(request.userCode, second)).statusCode).toBe(429);
    expect((await lookup(request.userCode, first)).statusCode).toBe(200);
  });

  it("a second approve by either account is already_decided", async () => {
    const { request } = await proved();
    expect((await approve(request)).statusCode).toBe(200);
    for (const headers of [owner, other]) {
      const response = await approve(request, headers);
      expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: "already_decided" });
    }
  });

  it("repository approve then deny refuses already_decided and leaves the link active", async () => {
    const { account, request } = await proved();
    const approved = decideLinkRequest(request.requestId, "account-a", "approve", clockNow);
    expect(approved.status).toBe("approved");
    expect(() => decideLinkRequest(request.requestId, "account-a", "deny", clockNow + 1))
      .toThrow(expect.objectContaining({ status: 409, code: "already_decided" }));
    expect(getLinkRequest(request.requestId)?.status).toBe("approved");
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 }))
      .toMatchObject({ linkId: "linkId" in approved ? approved.linkId : undefined, accountId: "account-a" });
    expect(getStore().db.get<any>(sql`SELECT revoked_at FROM wallet_links`).revoked_at).toBeNull();
  });

  it("approve compares accepted consent SHA256 hex case-insensitively", async () => {
    const { request } = await proved();
    const response = await approve(request, owner, { consentSha256: CONSENT_SHA256.toUpperCase() });
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe("approved");
  });

  it("concurrent approvals create exactly one receipt", async () => {
    const { request } = await proved();
    const responses = await Promise.all([approve(request), approve(request, other)]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(getStore().db.get<any>(sql`SELECT count(*) AS n FROM wallet_links`).n).toBe(1);
  });

  it("deny creates no link and hides consent lookup", async () => {
    const { request } = await proved();
    expect((await approve(request, owner, { decision: "deny" })).json()).toEqual({ status: "denied" });
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "denied" });
    expect((await lookup(request.userCode)).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/wallets", headers: owner })).json()).toEqual({ links: [] });
  });

  it.each(["privateKey", "private_key", "secret", "MNEMONIC", "seed", "seedPhrase", "seed_phrase"])("I1 refuses %s before validation without echo or logs", async field => {
    const { request } = await create();
    const sentinel = "must-never-appear-key-material-777";
    for (const endpoint of [path, `${path}/${request.requestId}/proof`, `${path}/${request.requestId}/approve`]) {
      for (const payload of [{ [field]: sentinel }, { clientInfo: { [field]: sentinel } }, { unknown: [{ deeper: { [field]: sentinel } }] }]) {
        const response = await app.inject({ method: "POST", url: endpoint, headers: owner, payload });
        expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "key_material_refused" });
        expect(response.body).not.toContain(sentinel);
      }
    }
    expect(logLines.join("")).not.toContain(sentinel);
    expect(getStore().db.get<any>(sql`SELECT proof_consumed_at FROM wallet_link_requests WHERE id = ${request.requestId}`).proof_consumed_at).toBeNull();
  });

  it("exact schemas reject unknown fields, invalid labels/client and agent kernelId", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const base = { keyType: "secp256k1", address: account.address, role: "agent", label: "cli", chainId: 84532 };
    for (const extra of [{ unknown: true }, { label: "line\nbreak" }, { clientInfo: { name: "cli", version: "1", unknown: true } }, { clientInfo: { name: "bad name", version: "1" } }, { kernelId: "kernel_abc" }, { publicKey: "f".repeat(64) }]) {
      const response = await app.inject({ method: "POST", url: path, payload: { ...base, ...extra } });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "invalid_request" });
    }
    const { request } = await proved();
    expect((await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`, payload: { signature: "x", unknown: true } })).json()).toEqual({ error: "invalid_request" });
    expect((await approve(request, owner, { unknown: true })).json()).toEqual({ error: "invalid_request" });
  });

  it("rejects unsupported mainnet chain and owner role", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const base = { keyType: "secp256k1", address: account.address, role: "agent", label: "cli", chainId: 84532 };
    for (const [extra, error] of [[{ chainId: 8453 }, "unsupported_chain"], [{ role: "owner" }, "unsupported_role"]] as const) {
      const response = await app.inject({ method: "POST", url: path, payload: { ...base, ...extra } });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error });
    }
  });

  it("owner revoke is immediate, idempotent, account-bound and allows re-link", async () => {
    const { account, request } = await proved();
    const { linkId } = (await approve(request)).json();
    const revoke = (headers = owner, payload = {}) => app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers, payload });
    expect((await revoke(other)).statusCode).toBe(404);
    const first = await revoke(owner, { reason: "rotated" });
    expect(first.statusCode).toBe(200); expect(first.json().status).toBe("revoked");
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toBeNull();
    clockNow += 1000;
    expect((await revoke()).json()).toEqual(first.json());
    expect((await app.inject({ url: "/api/wallets", headers: owner })).json().links[0].status).toBe("revoked");
    const relink = await create({ address: account.address });
    const signature = await account.signMessage({ message: relink.request.message });
    expect((await app.inject({ method: "POST", url: `${path}/${relink.request.requestId}/proof`, payload: { signature } })).statusCode).toBe(200);
    expect((await approve(relink.request)).statusCode).toBe(200);
    expect((await revoke(owner, { reason: "BAD" })).json()).toEqual({ error: "invalid_request" });
  });

  it("cookie-session revoke rejects a foreign Origin without changing any links", async () => {
    const headers = sessionHeaders("cookie-revoke-foreign-origin");
    const linkIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { request } = await proved();
      const approval = await approve(request, headers);
      expect(approval.statusCode).toBe(200);
      linkIds.push(approval.json().linkId);
    }
    const before = getStore().db.all(sql`SELECT * FROM wallet_links ORDER BY id`);
    for (const linkId of linkIds) {
      const response = await revoke(linkId, { ...headers, origin: "https://evil.example" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "origin_mismatch" });
    }
    expect(getStore().db.all(sql`SELECT * FROM wallet_links ORDER BY id`)).toEqual(before);
    expect((await app.inject({ url: "/api/wallets", headers })).json().links.map((link: { status: string }) => link.status)).toEqual(["active", "active"]);
  });

  it("cookie-session revoke accepts the configured public Origin", async () => {
    const headers = sessionHeaders("cookie-revoke-public-origin");
    const { account, request } = await proved();
    const approval = await approve(request, headers);
    expect(approval.statusCode).toBe(200);
    const response = await revoke(approval.json().linkId, headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("revoked");
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toBeNull();
  });

  it("API-key-authenticated revoke remains valid with a foreign Origin", async () => {
    const { account, request } = await proved();
    const approval = await approve(request);
    expect(approval.statusCode).toBe(200);
    const response = await revoke(approval.json().linkId, { ...owner, origin: "https://evil.example" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("revoked");
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toBeNull();
  });

  it("the approving API key alone lists and revokes a link when another key claims the same account", async () => {
    const { request } = await proved({}, sameAccount);
    const { linkId } = (await approve(request, owner)).json();
    expect((await app.inject({ url: "/api/wallets", headers: owner })).json().links).toHaveLength(1);
    expect((await app.inject({ url: "/api/wallets", headers: sameAccount })).json()).toEqual({ links: [] });
    const stranger = await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: sameAccount, payload: {} });
    expect(stranger.statusCode).toBe(404); expect(stranger.json()).toEqual({ error: "not_found" });
    expect(getStore().db.get<any>(sql`SELECT revoked_at FROM wallet_links WHERE id = ${linkId}`).revoked_at).toBeNull();
    const revoke = await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: owner });
    expect(revoke.statusCode).toBe(200); expect(revoke.json().status).toBe("revoked");
  });

  it("cookie-approved links are manageable by same-account cookie sessions and hidden from its API keys", async () => {
    const accountId = privateKeyToAccount(generatePrivateKey()).address;
    const approvingSession = sessionHeaders("cookie-manages-first", accountId);
    const anotherSession = sessionHeaders("cookie-manages-second", accountId);
    getStore().db.run(sql`UPDATE api_keys SET operator_id = ${accountId} WHERE id = 'same-account-key'`);
    const { request } = await proved();
    const { linkId } = (await approve(request, approvingSession)).json();
    expect((await app.inject({ url: "/api/wallets", headers: anotherSession })).json().links).toHaveLength(1);
    expect((await app.inject({ url: "/api/wallets", headers: sameAccount })).json()).toEqual({ links: [] });
    const keyRevoke = await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: sameAccount, payload: {} });
    expect(keyRevoke.statusCode).toBe(404); expect(keyRevoke.json()).toEqual({ error: "not_found" });
    expect((await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: anotherSession, payload: {} })).statusCode).toBe(200);
  });

  it("API-key-approved links are manageable by a SIWE cookie session of the same account", async () => {
    const accountId = privateKeyToAccount(generatePrivateKey()).address;
    const cookieHeaders = sessionHeaders("cookie-with-key-approved-link", accountId);
    getStore().db.run(sql`UPDATE api_keys SET operator_id = ${accountId} WHERE id = 'owner'`);
    const { request } = await proved();
    const { linkId } = (await approve(request)).json();
    expect((await app.inject({ url: "/api/wallets", headers: cookieHeaders })).json().links).toHaveLength(1);
    const response = await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: cookieHeaders, payload: {} });
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe("revoked");
    expect((await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: owner, payload: {} })).statusCode).toBe(200);
  });

  it.each(["session-key", "cookie"] as const)("a rotated session key leaves DEVICE links manageable through %s", async management => {
    const session = await signIn();
    const sk1 = await mintSessionKey(session.headers);
    const { account, request } = await proved({ role: "device" });
    const approval = await approve(request, sk1.headers);
    expect(approval.statusCode).toBe(200);
    const { linkId } = approval.json();
    const sk2 = await mintSessionKey(session.headers);
    expect(sk2.id).not.toBe(sk1.id);
    expect(getRepos().apiKeys.findById(sk1.id)?.revokedAt).not.toBeNull();
    expect((await app.inject({ url: "/api/wallets", headers: sk1.headers })).statusCode).toBe(401);
    const headers = management === "session-key" ? sk2.headers : session.headers;
    const listed = await app.inject({ url: "/api/wallets", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().links).toHaveLength(1);
    expect(listed.json().links[0]).toMatchObject({ linkId, address: account.address, expiresAt: null });
    const response = await revoke(linkId, headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("revoked");
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toBeNull();
    const row = getStore().db.get<any>(sql`SELECT revoked_by FROM wallet_links WHERE id = ${linkId}`);
    expect(row.revoked_by).toBe(session.account.address);
    clockNow += 1000;
    expect((await revoke(linkId, headers)).json()).toEqual(response.json());
  });

  it("a publicly provisioned key claiming the owner address cannot list or revoke the owner's link", async () => {
    const session = await signIn();
    const sk = await mintSessionKey(session.headers);
    const { request } = await proved({ role: "device" });
    const approval = await approve(request, sk.headers);
    expect(approval.statusCode).toBe(200);
    const claimed = await provisionClaimedKey(session.account.address);
    expect((await app.inject({ url: "/api/wallets", headers: claimed.headers })).json()).toEqual({ links: [] });
    const response = await revoke(approval.json().linkId, claimed.headers);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("owner revocation after rotation allows a new DEVICE link for the same EOA", async () => {
    const session = await signIn();
    const sk1 = await mintSessionKey(session.headers);
    const { account, request } = await proved({ role: "device" });
    const first = await approve(request, sk1.headers);
    expect(first.statusCode).toBe(200);
    const sk2 = await mintSessionKey(session.headers);
    expect((await revoke(first.json().linkId, sk2.headers)).statusCode).toBe(200);
    const second = await create({ role: "device", address: account.address });
    const proof = await app.inject({ method: "POST", url: `${path}/${second.request.requestId}/proof`,
      payload: { signature: await account.signMessage({ message: second.request.message }) } });
    expect(proof.statusCode).toBe(200);
    const approval = await approve(second.request, sk2.headers);
    expect(approval.statusCode).toBe(200);
    expect(approval.json().linkId).not.toBe(first.json().linkId);
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 }))
      .toMatchObject({ linkId: approval.json().linkId, accountProof: "siwe" });
  });

  it("the checksummed SIWE owner can revoke a stranger's claimed approval filed under the lowercase address", async () => {
    const victim = await signIn();
    const stranger = await provisionClaimedKey(victim.account.address.toLowerCase());
    const { account: strangerEoa, request } = await proved({ role: "device" });
    const approval = await approve(request, stranger.headers);
    expect(approval.statusCode).toBe(200);
    const listed = await app.inject({ url: "/api/wallets", headers: victim.headers });
    expect(listed.json().links).toHaveLength(1);
    expect(listed.json().links[0].linkId).toBe(approval.json().linkId);
    expect((await revoke(approval.json().linkId, victim.headers)).statusCode).toBe(200);
    expect(await resolveActiveWalletLink({ address: strangerEoa.address, chainId: 84532 })).toBeNull();
  });

  it("a SIWE owner can list and revoke after the approving plain API key is revoked", async () => {
    const session = await signIn();
    const plain = await provisionClaimedKey(session.account.address);
    const { account, request } = await proved({ role: "device" });
    expect(account.address).not.toBe(session.account.address);
    const approval = await approve(request, plain.headers);
    expect(approval.statusCode).toBe(200);
    const keyRevocation = await app.inject({ method: "DELETE", url: `/api/auth/keys/${plain.id}`, headers: plain.headers });
    expect(keyRevocation.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/wallets", headers: plain.headers })).statusCode).toBe(401);
    const listed = await app.inject({ url: "/api/wallets", headers: session.headers });
    expect(listed.json().links).toHaveLength(1);
    expect(listed.json().links[0].linkId).toBe(approval.json().linkId);
    expect((await revoke(approval.json().linkId, session.headers)).statusCode).toBe(200);
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toBeNull();
  });

  it.each(["cookie", "session-key", "claimed-key"] as const)("resolver records %s account proof without adding it to HTTP responses", async principal => {
    const session = await signIn();
    const caller = principal === "cookie" ? session : principal === "session-key"
      ? await mintSessionKey(session.headers) : await provisionClaimedKey(session.account.address);
    const { account, request } = await proved();
    const approval = await approve(request, caller.headers);
    expect(approval.statusCode).toBe(200);
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 }))
      .toMatchObject({ accountProof: principal === "claimed-key" ? "claimed" : "siwe" });
    expect(approval.json()).not.toHaveProperty("accountProof");
    const listed = await app.inject({ url: "/api/wallets", headers: caller.headers });
    expect(listed.json().links[0]).not.toHaveProperty("accountProof");
  });

  it.each(["malformed", "missing-session", "wrong-address"] as const)("a key with %s SIWE metadata remains a claimed principal", async mismatch => {
    const session = await signIn();
    const approving = await mintSessionKey(session.headers);
    const { request } = await proved({ role: "device" });
    const approval = await approve(request, approving.headers);
    expect(approval.statusCode).toBe(200);
    const claimant = await provisionClaimedKey(session.account.address);
    const sessionRow = getRepos().sessions.findByToken(session.token)!;
    const metadata = mismatch === "malformed" ? "{malformed" : JSON.stringify({ source: "siwe-session",
      sessionId: mismatch === "missing-session" ? "not-a-session" : sessionRow.id });
    getStore().db.run(sql`UPDATE api_keys SET metadata = ${metadata} WHERE id = ${claimant.id}`);
    if (mismatch === "wrong-address") {
      getStore().db.run(sql`UPDATE sessions SET wallet_address = ${privateKeyToAccount(generatePrivateKey()).address} WHERE id = ${sessionRow.id}`);
    }
    expect((await app.inject({ url: "/api/wallets", headers: claimant.headers })).json()).toEqual({ links: [] });
    expect((await revoke(approval.json().linkId, claimant.headers)).statusCode).toBe(404);
  });

  it("revoke refuses an unknown body member before changing the receipt", async () => {
    const { request } = await proved();
    const { linkId } = (await approve(request)).json();
    const response = await revoke(linkId, owner, { unknown: true });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_request" });
    expect(getStore().db.get<any>(sql`SELECT revoked_at FROM wallet_links WHERE id = ${linkId}`).revoked_at).toBeNull();
  });

  it("revoke without a body is treated as an empty object and remains idempotent", async () => {
    const { request } = await proved();
    const { linkId } = (await approve(request)).json();
    const first = await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: owner });
    expect(first.statusCode).toBe(200); expect(first.json().status).toBe("revoked");
    clockNow += 1000;
    expect((await app.inject({ method: "POST", url: `/api/wallets/${linkId}/revoke`, headers: owner })).json()).toEqual(first.json());
  });

  it("expired links are excluded and revoked in the replacement approval transaction", async () => {
    const { account, request } = await proved();
    const { linkId } = (await approve(request)).json();
    getStore().db.run(sql`UPDATE wallet_links SET expires_at = ${new Date(clockNow - 1).toISOString()} WHERE id = ${linkId}`);
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toBeNull();
    expect((await app.inject({ url: "/api/wallets", headers: owner })).json().links[0].status).toBe("expired");
    const relink = await create({ address: account.address });
    const signature = await account.signMessage({ message: relink.request.message });
    await app.inject({ method: "POST", url: `${path}/${relink.request.requestId}/proof`, payload: { signature } });
    expect((await approve(relink.request, other)).statusCode).toBe(200);
    expect(getStore().db.get<any>(sql`SELECT revoke_reason FROM wallet_links WHERE id = ${linkId}`).revoke_reason).toBe("expired");
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toMatchObject({ accountId: "account-b" });
  });

  it("global uniqueness rejects second account approval, without create-time oracle", async () => {
    const { account, request } = await proved();
    await approve(request);
    const second = await create({ address: account.address.toLowerCase() });
    const signature = await account.signMessage({ message: second.request.message });
    await app.inject({ method: "POST", url: `${path}/${second.request.requestId}/proof`, payload: { signature } });
    const response = await approve(second.request, other);
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: "already_linked" });
    expect(getStore().db.get<any>(sql`SELECT status, account_id FROM wallet_link_requests WHERE id = ${second.request.requestId}`)).toEqual({ status: "awaiting_approval", account_id: null });
    expect((await app.inject({ url: "/api/wallets", headers: other })).json()).toEqual({ links: [] });
  });

  it("poll faster than five seconds returns slow_down", async () => {
    const { request } = await create();
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "authorization_pending" });
    clockNow += 4999;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "slow_down" });
    clockNow += 5000;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "authorization_pending" });
  });

  it("approved public poll has exactly status and linkId", async () => {
    const { request } = await proved();
    const approval = await approve(request);
    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toMatchObject({ accountId: "account-a" });
    const response = await app.inject(`${path}/${request.requestId}`);
    expect(response.json()).toEqual({ status: "approved", linkId: approval.json().linkId });
    expect(Object.keys(response.json()).sort()).toEqual(["linkId", "status"]);
  });

  it.each(["approved", "denied", "failed", "expired"] as const)("public poll returns final %s one second apart despite the pending poll interval", async status => {
    const { account, request } = await create();
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "authorization_pending" });
    const signer = status === "failed" ? privateKeyToAccount(generatePrivateKey()) : account;
    const proof = await app.inject({ method: "POST", url: `${path}/${request.requestId}/proof`,
      payload: { signature: await signer.signMessage({ message: request.message }) } });
    expect(proof.statusCode).toBe(status === "failed" ? 401 : 200);
    let linkId: string | undefined;
    if (status === "approved" || status === "denied") {
      const decision = await approve(request, owner, { decision: status === "approved" ? "approve" : "deny" });
      expect(decision.statusCode).toBe(200);
      linkId = decision.json().linkId;
    }
    if (status === "expired") updateRequest(request.requestId, sql`expires_at = ${new Date(clockNow - 1).toISOString()}`);
    const expected = status === "approved" ? { status, linkId } : { status };
    clockNow += 1000;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual(expected);
    clockNow += 1000;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual(expected);
  });

  it("a pending public poll one second after the first still returns slow_down", async () => {
    const { request } = await proved();
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "authorization_pending" });
    clockNow += 1000;
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "slow_down" });
  });

  it("POST lookup is hidden until proof and unknown ids have 404", async () => {
    const { request } = await create();
    expect((await lookup(request.userCode)).statusCode).toBe(404);
    expect((await app.inject(`${path}/lr_${"A".repeat(26)}`)).json()).toEqual({ error: "not_found" });
    expect((await app.inject({ method: "POST", url: `${path}/lr_${"A".repeat(26)}/proof`, payload: { signature: "abc" } })).statusCode).toBe(404);
    expect((await app.inject(`${path}/does-not-exist`)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${path}/does-not-exist/proof`, payload: { signature: "abc" } })).statusCode).toBe(404);
  });

  it("four owner routes refuse anonymous callers with normal gateway 401", async () => {
    for (const [method, url, payload] of [["POST", `${path}/lookup`, { userCode: "BBBB-BBBB" }], ["POST", `${path}/lr_${"A".repeat(26)}/approve`, {}], ["GET", "/api/wallets", undefined], ["POST", `/api/wallets/wl_${"A".repeat(26)}/revoke`, {}]] as const) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode).toBe(401); expect(response.json().error).toBe("api_key_required");
    }
  });

  it("owner authentication onRequest precedes I1; authenticated I1 precedes body validation", async () => {
    const { request } = await create();
    for (const url of [`${path}/lookup`, `${path}/${request.requestId}/approve`, `/api/wallets/wl_${"A".repeat(26)}/revoke`]) {
      const payload = { nested: [{ seed_phrase: "refused-sentinel" }] };
      const anonymous = await app.inject({ method: "POST", url, payload });
      expect(anonymous.statusCode).toBe(401); expect(anonymous.json().error).toBe("api_key_required");
      const response = await app.inject({ method: "POST", url, headers: owner, payload });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "key_material_refused" });
      expect(response.body).not.toContain("refused-sentinel");
    }
  });

  it("global onRequest rate limit precedes I1 without authenticating an exhausted IP", async () => {
    const { request } = await create();
    for (let i = 0; i < 201; i++) await app.inject(`${path}/${request.requestId}`);
    const before = getRepos().apiKeys.findById("owner")?.usageCount;
    const response = await app.inject({ method: "POST", url: `${path}/${request.requestId}/approve`, headers: owner, payload: { secret: "refused-sentinel" } });
    expect(response.statusCode).toBe(429); expect(response.json()).toEqual({ error: "rate_limited" });
    expect(getRepos().apiKeys.findById("owner")?.usageCount).toBe(before);
  });

  it.each(["GET", "HEAD"] as const)("%s with a body is invalid_request without reading the stream", async method => {
    for (const headers of [{ "content-length": "24" }, { "transfer-encoding": "chunked" }]) {
      const response = await app.inject({ method, url: "/api/wallets", headers: { ...owner, ...headers }, payload: '{"secret":"unread-body"}' });
      expect(response.statusCode).toBe(400);
      if (method === "GET") expect(response.json()).toEqual({ error: "invalid_request" });
      expect(bodyStreamIterations).toBe(0);
    }
  });

  it("coarse rate accounting remains shared with other gateway routes", async () => {
    const { request } = await create({}, "127.0.0.1");
    for (let i = 0; i < 199; i++) expect((await app.inject("/api/dht/w1-rate-control")).statusCode).toBe(200);
    const response = await app.inject(`${path}/${request.requestId}`);
    expect(response.statusCode).toBe(429); expect(response.json()).toEqual({ error: "rate_limited" });
  });

  it("cookie approval requires configured Origin; bearer sessions do not", async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    getRepos().sessions.insert({ id: "session-owner", token: "session-owner", walletAddress: address,
      createdAt: new Date(clockNow).toISOString(), lastActiveAt: new Date(clockNow).toISOString(),
      expiresAt: new Date(clockNow + 86400000).toISOString() });
    const { request } = await proved();
    const sessionCookie = { cookie: `pcc_session=${app.signCookie("session-owner")}` };
    expect((await approve(request, sessionCookie)).statusCode).toBe(403);
    expect((await approve(request, { ...sessionCookie, origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await approve(request, { ...sessionCookie, origin: "https://capability.network" })).statusCode).toBe(200);
    const second = await proved();
    expect((await approve(second.request, { authorization: "Bearer session-owner" })).statusCode).toBe(200);
  });

  it("ten creates per IP/hour and at most three pending per key", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    for (let i = 0; i < 3; i++) await create({ address: account.address });
    const pendingLimit = await app.inject({ method: "POST", url: path, payload: { keyType: "secp256k1", address: account.address, role: "agent", label: "cli", chainId: 84532 } });
    expect(pendingLimit.statusCode).toBe(429);
    for (let i = 3; i < 10; i++) await create();
    const response = await app.inject({ method: "POST", url: path, remoteAddress: "203.0.113.27", payload: { keyType: "secp256k1", address: privateKeyToAccount(generatePrivateKey()).address, role: "agent", label: "cli", chainId: 84532 } });
    expect(response.statusCode).toBe(429); expect(response.json()).toEqual({ error: "rate_limited" });
  });

  it("W1 source contains no key-material fields or columns except refusal regex", () => {
    const sources = [new URL("../routes/wallets.ts", import.meta.url), new URL("../../../db/src/migrations/0004_wallet_links.sql", import.meta.url), ...readdirSync(new URL("../services/wallet-links/", import.meta.url)).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).map(name => new URL(`../services/wallet-links/${name}`, import.meta.url))];
    for (const source of sources) {
      const text = readFileSync(source, "utf8").replace(/^.*const KEY_MATERIAL_FIELD.*$/m, "");
      expect(text).not.toMatch(/\b(?:private_?key|mnemonic|seed(?:_?phrase)?)\b/i);
    }
  });
});

describe("SIWE principals reach only their own address", () => {
  it("B's cookie, session key and invalid key with cookie cannot list or revoke A's link", async () => {
    const a = await signIn();
    const skA = await mintSessionKey(a.headers);
    const { account, request } = await proved({ role: "device" });
    const approval = await approve(request, skA.headers);
    expect(approval.statusCode).toBe(200);
    const linkId = approval.json().linkId;
    const b = await signIn();
    const skB = await mintSessionKey(b.headers);
    const invalidWithCookie = { ...b.headers, authorization: "Bearer pcc_test_not_a_real_key" };
    for (const headers of [b.headers, skB.headers, invalidWithCookie]) {
      const listed = await app.inject({ url: "/api/wallets", headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ links: [] });
      const refused = await revoke(linkId, headers);
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toEqual({ error: "not_found" });
    }
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toMatchObject({ linkId, accountProof: "siwe" });
    const listedByA = await app.inject({ url: "/api/wallets", headers: a.headers });
    expect(listedByA.statusCode).toBe(200);
    expect(listedByA.json().links).toHaveLength(1);
    // Invalid-key fallback uses the cookie session, so Origin is checked before ownership.
    expect((await revoke(linkId, { ...invalidWithCookie, origin: "https://evil.example" })).statusCode).toBe(403);
  });
});

describe("the linked key's own SIWE principal cannot list or revoke its link", () => {
  it("the linked EOA signs in as itself (cookie and minted key) and gets [] and 404", async () => {
    const a = await signIn();
    const { account, request } = await proved({ role: "device" });
    const approval = await approve(request, a.headers);
    expect(approval.statusCode).toBe(200);
    const self = await signIn(account);
    const skSelf = await mintSessionKey(self.headers);
    for (const headers of [self.headers, skSelf.headers]) {
      expect((await app.inject({ url: "/api/wallets", headers })).json()).toEqual({ links: [] });
      expect((await revoke(approval.json().linkId, headers)).statusCode).toBe(404);
    }
    expect(await resolveActiveWalletLink({ address: account.address, chainId: 84532 })).toMatchObject({ linkId: approval.json().linkId });
  });
});

describe("SIWE principals: near-miss addresses and cookie-approved links", () => {
  it("near-miss addresses at every hex position and another account cannot list or revoke A's key- and cookie-approved links", async () => {
    const a = await signIn();
    const skA = await mintSessionKey(a.headers);
    const viaKey = await approve((await proved({ role: "device" })).request, skA.headers);
    const viaCookie = await approve((await proved({ role: "device" })).request, a.headers);
    expect([viaKey.statusCode, viaCookie.statusCode]).toEqual([200, 200]);
    const linkIds = [viaKey.json().linkId, viaCookie.json().linkId];
    async function cannotAccess(headers: Record<string, string>, context: string) {
      const listed = await app.inject({ url: "/api/wallets", headers });
      expect(listed.statusCode, context).toBe(200);
      expect(listed.json(), context).toEqual({ links: [] });
      for (const [linkIndex, linkId] of linkIds.entries()) {
        expect((await revoke(linkId, headers)).statusCode, `${context} on L${linkIndex + 1}`).toBe(404);
      }
    }
    // Every hex position must participate in ownership, for cookies and minted keys
    // against both approval paths, even when a comparison skips just one position.
    for (let index = 2; index < 42; index++) {
      __resetRateLimitState();
      const digit = a.account.address[index]!.toLowerCase() === "0" ? "1" : "0";
      const nearMiss = `${a.account.address.slice(0, index)}${digit}${a.account.address.slice(index + 1)}`;
      const near = sessionHeaders(`near-miss-${index}`, nearMiss as typeof a.account.address);
      const nearKey = await mintSessionKey(near, `near miss at index ${index}, key mint`);
      for (const [principal, headers] of [["cookie", near], ["key", nearKey.headers]] as const) {
        await cannotAccess(headers, `near miss at index ${index}, ${principal}`);
      }
    }
    const b = await signIn();
    await cannotAccess(b.headers, "B cookie");
    expect((await app.inject({ url: "/api/wallets", headers: a.headers })).json().links.map((link: { status: string }) => link.status)).toEqual(["active", "active"]);
  });
});

describe("X-PCC-API-Key never changes the lookup principal", () => {
  it("lookup with X-PCC-API-Key equals the same lookup without it", async () => {
    const { request } = await proved();
    const plain = await lookup(request.userCode);
    const withHeader = await lookup(request.userCode, { ...owner, "x-pcc-api-key": "pcc_test_wallet_other" });
    expect(withHeader.statusCode).toBe(200);
    expect(withHeader.json()).toEqual(plain.json());
    expect(withHeader.json().consent.text).toContain("account-a");
  });
});
