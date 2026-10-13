import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { sql } from "@pcc/store";
import { initStore, closeStore, getStore, getRepos } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { rateLimiter, __resetRateLimitState } from "../middleware/rate-limiter.js";
import { hashApiKey } from "../auth/api-key-auth.js";
import { walletsRoutes } from "../routes/wallets.js";
import { resolveActiveWalletLink } from "../services/wallet-links/repository.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import * as config from "../services/wallet-links/config.js";

const path = "/api/wallets/link-requests";
const owner = { authorization: "Bearer pcc_test_wallet_owner" };
const other = { authorization: "Bearer pcc_test_wallet_other" };
let app: FastifyInstance;
let logLines: string[];
let clockNow: number;

async function buildApp() {
  const instance = Fastify({ logger: { level: "info", stream: { write: (s: string) => { logLines.push(s); } } }, disableRequestLogging: true });
  await instance.register(cookie);
  await instance.register(rateLimiter);
  await instance.register(apiGate);
  await instance.register(tenantContext);
  await instance.register(scopeChecker);
  instance.get("/api/dht/w1-rate-control", async () => ({ ok: true }));
  await instance.register(walletsRoutes);
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  clockNow = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clockNow);
  logLines = [];
  __resetRateLimitState();
  const store = initStore({ seed: false });
  for (const [id, token, operatorId, scopes] of [
    ["owner", "pcc_test_wallet_owner", "account-a", "[]"],
    ["other", "pcc_test_wallet_other", "account-b", '["*"]'],
  ]) {
    store.repos.apiKeys.insert({ id, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 12), operatorId,
      name: null, description: null, scopes, rateLimit: "1000/hour", usageCount: "0",
      createdAt: new Date(clockNow).toISOString(), expiresAt: null, metadata: null, publicKey: null });
  }
  app = await buildApp();
});

afterEach(async () => { await app?.close(); closeStore(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function create(overrides: Record<string, unknown> = {}, ip = "203.0.113.27") {
  const account = privateKeyToAccount(generatePrivateKey());
  const response = await app.inject({ method: "POST", url: path, remoteAddress: ip,
    payload: { keyType: "secp256k1", address: account.address.toLowerCase(), role: "agent", label: "cli@laptop", chainId: 84532, ...overrides } });
  expect(response.statusCode).toBe(201);
  return { account, request: response.json() as {requestId: string;userCode: string;message: string;expiresAt: string;verificationUri: string;interval: number} };
}
async function proved(overrides: Record<string, unknown> = {}) {
  const result = await create(overrides);
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
    const consent = await app.inject({ url: `${path}/by-code/${request.userCode.toLowerCase().replace("-", "%20")}`, headers: owner });
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
    expect((await app.inject(`${path}/${request.requestId}`)).json()).toEqual({ status: "approved", linkId, accountId });
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
    const consent = (await app.inject({ url: `${path}/by-code/${request.userCode}`, headers: owner })).json();
    expect(consent).toMatchObject({ publicKey, kernelId: "kernel_lab-1", requesterIpClass: "2001:0db8:1234::/48" });
    expect(consent.consent.text).toContain("It cannot spend.");
    const decision = await approve(request);
    expect(decision.statusCode).toBe(200);
    const row = (await app.inject({ url: "/api/wallets", headers: owner })).json().links[0];
    expect(row).toMatchObject({ keyType: "ed25519", publicKey, expiresAt: null });
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

  it("wrong code is 403 and fifth wrong code blocks later attempts with 429", async () => {
    const { request } = await proved();
    for (let i = 0; i < 5; i++) {
      const response = await approve(request, owner, { userCode: "BBBB-BBBB" === request.userCode ? "CCCC-CCCC" : "BBBB-BBBB" });
      expect(response.statusCode).toBe(403); expect(response.json()).toEqual({ error: "code_mismatch" });
    }
    expect((await approve(request)).json()).toEqual({ error: "too_many_attempts" });
    clockNow += 600001;
    expect((await app.inject({ url: `${path}/by-code/BBBB-BBBB`, headers: owner })).statusCode).toBe(404);
  });

  it("by-code shares wrong-code counter per principal", async () => {
    const { request } = await proved();
    for (let i = 0; i < 5; i++) expect((await app.inject({ url: `${path}/by-code/BBBB-BBBB`, headers: owner })).statusCode).toBe(404);
    const response = await app.inject({ url: `${path}/by-code/${request.userCode}`, headers: owner });
    expect(response.statusCode).toBe(429);
    expect((await app.inject({ url: `${path}/by-code/${request.userCode}`, headers: other })).statusCode).toBe(200);
  });

  it("a second approve by either account is already_decided", async () => {
    const { request } = await proved();
    expect((await approve(request)).statusCode).toBe(200);
    for (const headers of [owner, other]) {
      const response = await approve(request, headers);
      expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: "already_decided" });
    }
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
    expect((await app.inject({ url: `${path}/by-code/${request.userCode}`, headers: owner })).statusCode).toBe(404);
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

  it("public by-code is hidden until proof and unknown ids have 404", async () => {
    const { request } = await create();
    expect((await app.inject({ url: `${path}/by-code/${request.userCode}`, headers: owner })).statusCode).toBe(404);
    expect((await app.inject(`${path}/lr_${"A".repeat(26)}`)).json()).toEqual({ error: "not_found" });
    expect((await app.inject({ method: "POST", url: `${path}/lr_${"A".repeat(26)}/proof`, payload: { signature: "abc" } })).statusCode).toBe(404);
    expect((await app.inject(`${path}/does-not-exist`)).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${path}/does-not-exist/proof`, payload: { signature: "abc" } })).statusCode).toBe(404);
  });

  it("four owner routes refuse anonymous callers with normal gateway 401", async () => {
    for (const [method, url, payload] of [["GET", `${path}/by-code/BBBB-BBBB`, undefined], ["POST", `${path}/lr_${"A".repeat(26)}/approve`, {}], ["GET", "/api/wallets", undefined], ["POST", `/api/wallets/wl_${"A".repeat(26)}/revoke`, {}]] as const) {
      const response = await app.inject({ method, url, payload });
      expect(response.statusCode).toBe(401); expect(response.json().error).toBe("api_key_required");
    }
  });

  it("I1 takes priority over owner auth and GET body validation", async () => {
    const { request } = await create();
    for (const [method, url] of [["POST", `${path}/${request.requestId}/approve`], ["POST", `/api/wallets/wl_${"A".repeat(26)}/revoke`], ["GET", "/api/wallets"], ["GET", `${path}/by-code/BBBB-BBBB`]] as const) {
      const response = await app.inject({ method, url, payload: { nested: [{ seed_phrase: "refused-sentinel" }] } });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "key_material_refused" });
      expect(response.body).not.toContain("refused-sentinel");
    }
    const unexpected = await app.inject({ method: "GET", url: `/api/wallets`, headers: owner, payload: { unknown: true } });
    expect(unexpected.statusCode).toBe(400); expect(unexpected.json()).toEqual({ error: "invalid_request" });
  });

  it("I1 takes priority over the coarse global rate limit without auth usage", async () => {
    const { request } = await create();
    for (let i = 0; i < 201; i++) await app.inject(`${path}/${request.requestId}`);
    const before = getRepos().apiKeys.findById("owner")?.usageCount;
    const response = await app.inject({ method: "POST", url: `${path}/${request.requestId}/approve`, headers: owner, payload: { secret: "refused-sentinel" } });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: "key_material_refused" });
    expect(getRepos().apiKeys.findById("owner")?.usageCount).toBe(before);
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
    const sessionCookie = { cookie: "pcc_session=session-owner" };
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
