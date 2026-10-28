import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { privateKeyToAccount } from "viem/accounts";
import { eq, schema } from "@pcc/store";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { bindBuyer, BUYER_PROOF_REQUIRED } from "../auth/buyer-identity.js";
import { authorityOf, type KernelAuthority } from "../auth/kernel-authority.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker, SELF_SERVICE_KEY_SCOPES } from "../middleware/scope-checker.js";
import { emergencyStopState } from "../routes/device-relay.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";
import * as walletLinks from "../services/wallet-links/repository.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true,
  canSiweVerify: () => true,
}));

// Real EIP-4361 challenge/signature helpers.
// Registration deliberately uses master's POST /api/kernels.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const FOREIGN = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const KERNEL = "n173-wallet-only-owner-estop";
const ZERO = "0x0000000000000000000000000000000000000000";
const PROOF_URL = "/api/n173/proof";
const HOUR_MS = 3_600_000;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
let apps: FastifyInstance[];
let observations: KernelAuthority[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_ADMIN_KEY", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION", "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  apps = [];
  observations = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildApp(opts: {
  routesBeforeGate?: boolean;
  existingProof?: { wallet: string; via: string };
} = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "n173-siwe-session-cookie-secret" });
  app.addHook("onResponse", async req => { observations.push(authorityOf(req)); });
  if (opts.existingProof) {
    app.addHook("onRequest", async req => {
      req.provenWallet = opts.existingProof!.wallet;
      req.provenWalletCarrier = "key";
      req.provenWalletVia = opts.existingProof!.via;
    });
  }
  const registerRoutes = async () => {
    await app.register(siweAuthPlugin);
    await app.register(kernelRoutes);
    await app.register(operatorRoutes);
    await app.register(walletsRoutes);
    app.get(PROOF_URL, async req => ({
      apiKeyId: req.apiKeyId ?? null,
      ...authorityOf(req),
    }));
    app.post<{ Body: { buyer: string } }>("/api/n173/buyer", async (req, reply) => {
      const bound = bindBuyer(authorityOf(req), req.body.buyer);
      return bound.ok ? { buyer: bound.buyer } : reply.code(bound.status).send(bound.body);
    });
  };
  // createGateway registers route siblings before apiGate. Exercise that order too.
  if (opts.routesBeforeGate) await registerRoutes();
  await app.register(apiGate);
  await app.register(scopeChecker);
  if (!opts.routesBeforeGate) await registerRoutes();
  await app.ready();
  return app;
}

async function signIn(app: FastifyInstance, account = OWNER) {
  const host = "capability.network";
  const nonce = await app.inject({ method: "GET", url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode, nonce.body).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address,
    "", "Sign in to PCC.", "", `URI: https://${host}`, "Version: 1", "Chain ID: 8453",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const response = await app.inject({
    method: "POST", url: "/api/auth/verify", headers: { host },
    payload: { message, signature: await account.signMessage({ message }) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ token: string }>();
}

async function mint(app: FastifyInstance, token: string) {
  const response = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(token) });
  expect(response.statusCode, response.body).toBe(201);
  expect(response.json().scopes).toEqual(SELF_SERVICE_KEY_SCOPES);
  return response.json<{ api_key: string; key_id: string }>();
}

function sessionCookie(app: FastifyInstance, token: string) {
  return { cookie: `pcc_session=${app.signCookie(token)}` };
}

async function registerOwner(app: FastifyInstance) {
  const session = await signIn(app);
  const key = await mint(app, session.token);
  const row = getRepos().apiKeys.findById(key.key_id)!;
  expect(row.operatorId).toBe(OWNER.address);
  expect(row.operatorWalletCustody).toBeNull();
  expect(JSON.parse(row.metadata!)).toMatchObject({ source: "siwe-session" });
  const headers = bearer(key.api_key);
  const registered = await app.inject({
    method: "POST", url: "/api/kernels", headers,
    payload: { id: KERNEL, name: "N173 wallet-only owner kernel" },
  });
  expect(registered.statusCode, registered.body).toBe(201);
  expect(getRepos().kernels.findById(KERNEL)!.operatorAddress).toBe(OWNER.address);
  return { session, key, headers };
}

async function engage(app: FastifyInstance, headers: Record<string, string>) {
  const response = await app.inject({
    method: "POST", url: "/api/operator/emergency-stop", headers,
    payload: { kernelId: KERNEL, reason: "N173 owner emergency-stop regression" },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ stopped: true, kernelId: KERNEL });
  expect(emergencyStopState(KERNEL)).toBe("stopped");
}

function resume(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({ method: "POST", url: "/api/operator/emergency-resume", headers, payload: { kernelId: KERNEL } });
}

describe("N173 SIWE session proof at apiGate", () => {
  it("the wallet-only owner's real SIWE session key registers, ENGAGEs and RESUMEs on master", async () => {
    const app = await buildApp();
    const { key, headers } = await registerOwner(app);
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({
      apiKeyId: key.key_id,
      provenWallet: OWNER.address.toLowerCase(), provenWalletVia: "siwe-session",
    });
    await engage(app, headers);
    const response = await resume(app, headers);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ resumed: true, kernelId: KERNEL });
    expect(emergencyStopState(KERNEL)).toBe("clear");
  });

  it.each(["cookie", "bearer"] as const)("the owner's %s SIWE session proves its wallet; RESUME needs an explicit credential (N176)", async path => {
    const app = await buildApp();
    const { session, headers } = await registerOwner(app);
    await engage(app, headers);
    const sessionHeaders = path === "cookie" ? sessionCookie(app, session.token) : bearer(session.token);
    const proof = await app.inject({ url: PROOF_URL, headers: sessionHeaders });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({ apiKeyId: null, provenWallet: OWNER.address.toLowerCase(), provenWalletVia: "siwe-session" });
    const response = await resume(app, sessionHeaders);
    expect(response.statusCode, response.body).toBe(path === "cookie" ? 403 : 200);
    if (path === "cookie") expect(response.json()).toEqual({
      error: "explicit_credential_required",
      message: "This decision needs an API key or a session key in the Authorization header; the sign-in cookie alone can't authorize it.",
    });
    expect(emergencyStopState(KERNEL)).toBe(path === "cookie" ? "stopped" : "clear");
  });

  it.each([undefined, "provisioned", "SIWE-SESSION", "siwe-session-other"])("a key merely claiming the owner with source %s may ENGAGE but cannot RESUME", async source => {
    const app = await buildApp();
    await registerOwner(app);
    const claimed = provisionApiKey({ operatorId: OWNER.address, metadata: source === undefined ? undefined : { source } });
    const headers = bearer(claimed.rawKey);
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({ provenWallet: null, provenWalletVia: null });
    await engage(app, headers);
    const response = await resume(app, headers);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ reason: "operator_proof_required" });
    expect(emergencyStopState(KERNEL)).toBe("stopped");
  });

  it.each(["claimed", "siwe-session"] as const)("a foreign %s key never borrows the owner's SIWE cookie", async kind => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    await engage(app, owner.headers);
    const foreignSession = kind === "siwe-session" ? await signIn(app, FOREIGN) : null;
    const foreignKey = foreignSession ? (await mint(app, foreignSession.token)).api_key
      : provisionApiKey({ operatorId: FOREIGN.address }).rawKey;
    const headers = { ...bearer(foreignKey), ...sessionCookie(app, owner.session.token) };
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({
      claimed: FOREIGN.address,
      provenWallet: kind === "siwe-session" ? FOREIGN.address.toLowerCase() : null,
      provenWalletVia: kind === "siwe-session" ? "siwe-session" : null,
    });
    const response = await resume(app, headers);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ reason: "operator_proof_required" });
    expect(emergencyStopState(KERNEL)).toBe("stopped");
  });

  it.each([
    "Bearer pcc_test_<garbage>",
    "bearer <foreign key>",
    "Bearer  <foreign key>",
    "X-PCC-API-Key: <foreign key>",
  ] as const)("%s with the owner's valid cookie authenticates without proof and cannot RESUME", async form => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    await engage(app, owner.headers);
    const foreign = provisionApiKey({ operatorId: FOREIGN.address });
    const keyHeaders = form === "X-PCC-API-Key: <foreign key>"
      ? { "x-pcc-api-key": foreign.rawKey }
      : { authorization: form.replace("<garbage>", "n173_invalid").replace("<foreign key>", foreign.rawKey) };
    const headers = { ...keyHeaders, ...sessionCookie(app, owner.session.token) };
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({
      apiKeyId: null, claimed: OWNER.address, provenWallet: null, provenWalletVia: null,
    });
    const response = await resume(app, headers);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ reason: "operator_proof_required" });
    expect(observations.at(-1)).toMatchObject({ claimed: OWNER.address, provenWallet: null, provenWalletVia: null });
    expect(emergencyStopState(KERNEL)).toBe("stopped");
  });

  it.each(["expired", "revoked"] as const)("an %s session key has no proof, even with the owner's valid cookie", async state => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    await engage(app, owner.headers);
    if (state === "revoked") getRepos().apiKeys.revoke(owner.key.key_id);
    else getStore().db.update(schema.apiKeys).set({ expiresAt: new Date(Date.now() - HOUR_MS).toISOString() })
      .where(eq(schema.apiKeys.id, owner.key.key_id)).run();
    for (const headers of [owner.headers, { ...owner.headers, ...sessionCookie(app, owner.session.token) }]) {
      const response = await resume(app, headers);
      expect([401, 403], response.body).toContain(response.statusCode);
      expect(observations.at(-1)).toMatchObject({ provenWallet: null, provenWalletVia: null });
    }
    expect(emergencyStopState(KERNEL)).toBe("stopped");
  });

  it.each(["", ZERO, "0x0", "operator@example.com"])("a session key's placeholder or nonwallet identity %s never becomes proof", async operatorId => {
    const app = await buildApp();
    const key = provisionApiKey({ operatorId, metadata: { source: "siwe-session" }, expiresInDays: 1 });
    const response = await app.inject({ url: PROOF_URL, headers: bearer(key.rawKey) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ provenWallet: null, provenWalletVia: null });
  });

  it.each(["", ZERO, "0x0"])("a session's placeholder address %s never becomes proof", async walletAddress => {
    const app = await buildApp();
    const now = new Date().toISOString();
    const session = getRepos().sessions.insert({ id: randomUUID(), walletAddress, token: randomUUID(),
      createdAt: now, expiresAt: new Date(Date.now() + HOUR_MS).toISOString(), lastActiveAt: now })!;
    const response = await app.inject({ url: PROOF_URL, headers: bearer(session.token) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ provenWallet: null, provenWalletVia: null });
  });

  it("session-key provenance binds a buyer while an address-claiming key still cannot", async () => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    const accepted = await app.inject({ method: "POST", url: "/api/n173/buyer", headers: owner.headers, payload: { buyer: OWNER.address } });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ buyer: OWNER.address.toLowerCase() });
    const claimed = provisionApiKey({ operatorId: OWNER.address, metadata: { source: "provisioned" } });
    const refused = await app.inject({ method: "POST", url: "/api/n173/buyer", headers: bearer(claimed.rawKey), payload: { buyer: OWNER.address } });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual(BUYER_PROOF_REQUIRED);
  });

  it("a session key's SIWE proof preempts its real agent self-link without a self-link lookup", async () => {
    const app = await buildApp({ routesBeforeGate: true });
    const session = await signIn(app);
    const key = await mint(app, session.token);
    const headers = bearer(key.api_key);
    const created = await app.inject({
      method: "POST", url: "/api/wallets/link-requests", headers,
      payload: { keyType: "secp256k1", address: FOREIGN.address, chainId: 84532,
        role: "agent", label: "n173-session-key-self-link" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const request = created.json<{ requestId: string; userCode: string; message: string }>();
    const signed = await app.inject({
      method: "POST", url: `/api/wallets/link-requests/${request.requestId}/proof`,
      payload: { signature: await FOREIGN.signMessage({ message: request.message }) },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json()).toEqual({ status: "awaiting_approval" });
    const approved = await app.inject({
      method: "POST", url: `/api/wallets/link-requests/${request.requestId}/approve`, headers,
      payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", accountId: OWNER.address });
    // Confirm the ceremony created a usable self-link before testing its precedence.
    expect(walletLinks.findSelfLinkedWallet({ address: FOREIGN.address, apiKeyId: key.key_id,
      operatorId: OWNER.address, now: Date.now() })).toBe("agent");
    const lookup = vi.spyOn(walletLinks, "findSelfLinkedWallet");
    const proof = await app.inject({ url: PROOF_URL, headers: { ...headers, "x-pcc-wallet": FOREIGN.address } });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({ apiKeyId: key.key_id, claimed: OWNER.address,
      provenWallet: OWNER.address.toLowerCase(), provenWalletVia: "siwe-session" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["key", "session"] as const)("an earlier stronger proof survives %s authentication", async kind => {
    const existingProof = { wallet: FOREIGN.address.toLowerCase(), via: "self-link:agent" };
    const app = await buildApp({ existingProof });
    const session = await signIn(app);
    const headers = bearer(kind === "key" ? (await mint(app, session.token)).api_key : session.token);
    const response = await app.inject({ url: PROOF_URL, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ provenWallet: existingProof.wallet, provenWalletVia: existingProof.via });
  });
});

describe("N173 production registration order: routes precede apiGate", () => {
  it("RESUMEs for the owner's session key and refuses a foreign key plus the owner's cookie", async () => {
    const app = await buildApp({ routesBeforeGate: true });
    const owner = await registerOwner(app);
    await engage(app, owner.headers);
    const resumed = await resume(app, owner.headers);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(emergencyStopState(KERNEL)).toBe("clear");
    await engage(app, owner.headers);
    const foreign = provisionApiKey({ operatorId: FOREIGN.address });
    const refused = await resume(app, { ...bearer(foreign.rawKey), ...sessionCookie(app, owner.session.token) });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ reason: "operator_proof_required" });
    expect(observations.at(-1)).toMatchObject({ provenWallet: null, provenWalletVia: null });
    expect(emergencyStopState(KERNEL)).toBe("stopped");
  });
});
