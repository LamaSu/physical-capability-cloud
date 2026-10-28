import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";
import { schema, sql } from "@pcc/store";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { authorityOf } from "../auth/kernel-authority.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { batchRoutes } from "../routes/batches.js";
import { deviceRelayRoutes, emergencyStopState } from "../routes/device-relay.js";
import { kernelAgentPackageRoutes } from "../routes/kernel-agent-package.js";
import { kernelRoutes } from "../routes/kernels.js";
import { operatorRoutes } from "../routes/operator.js";
import { walletsRoutes } from "../routes/wallets.js";
import { identitySessionRoutes } from "../routes/identity-session.js";
import { fiatRampRoutes } from "../routes/fiat-ramp.js";
import { evidenceEncryptedRoutes } from "../routes/evidence-encrypted.js";
import { contributorRoutes } from "../routes/contributors.js";
import { CdpSpendPermissionService } from "@pcc/payments";
import { SessionKeyService } from "@pcc/verifier";
import * as embeddedWallet from "../auth/embedded-wallet.js";
import { batchTracker, encryptionService } from "../services.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true,
  canSiweVerify: () => true,
}));

const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const FOREIGN = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const KERNEL = "n176-explicit-decision-owner";
const ADMIN = "n176-admin-secret";
const PROOF_URL = "/api/n176/proof";
const EXPLICIT_REQUIRED = {
  error: "explicit_credential_required",
  message: "This decision needs an API key or a session key in the Authorization header; the sign-in cookie alone can't authorize it.",
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION", "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS", "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "LIT_API_KEY", "PRIVY_APP_ID", "PRIVY_APP_SECRET"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  vi.stubEnv("LIT_API_KEY", randomUUID());
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function buildApp(routesBeforeGate = false, carrierlessProof = false) {
  const app = Fastify({ logger: false });
  apps.push(app);
  // A proof whose carrier was never recorded, as a writer that forgets it would leave it.
  if (carrierlessProof) app.addHook("onRequest", async req => {
    if (req.headers["x-n176-carrierless-proof"] === "1") req.provenWallet = OWNER.address.toLowerCase();
  });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "n176-signed-session-cookie-secret" });
  const registerRoutes = async () => {
    await app.register(siweAuthPlugin);
    await app.register(kernelRoutes);
    await app.register(operatorRoutes);
    await app.register(deviceRelayRoutes);
    await app.register(kernelAgentPackageRoutes);
    await app.register(walletsRoutes);
    await app.register(batchRoutes);
    await app.register(identitySessionRoutes);
    await app.register(fiatRampRoutes);
    await app.register(evidenceEncryptedRoutes);
    await app.register(contributorRoutes);
    await app.register((await import("../routes/lit-provision.js")).litProvisionRoutes);
    app.get(PROOF_URL, async req => authorityOf(req));
  };
  // createGateway registers its route siblings before apiGate.
  if (routesBeforeGate) await registerRoutes();
  await app.register(apiGate);
  await app.register(scopeChecker);
  if (!routesBeforeGate) await registerRoutes();
  await app.ready();
  return app;
}

// Use the real EIP-4361 nonce/signature flow and real session-key endpoint, as N173 does.
async function signIn(app: FastifyInstance, account = OWNER) {
  const host = "capability.network";
  const nonce = await app.inject({ url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode, nonce.body).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address.toLowerCase(),
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

const sessionCookie = (app: FastifyInstance, token: string) => ({ cookie: `pcc_session=${app.signCookie(token)}` });

async function registerOwner(app: FastifyInstance) {
  const session = await signIn(app);
  const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(session.token) });
  expect(minted.statusCode, minted.body).toBe(201);
  const key = minted.json<{ api_key: string }>();
  const headers = bearer(key.api_key);
  const registered = await app.inject({ method: "POST", url: "/api/kernels", headers,
    payload: { id: KERNEL, name: "N176 explicit decision credentials" } });
  expect(registered.statusCode, registered.body).toBe(201);
  return { session, headers, cookie: sessionCookie(app, session.token) };
}

function seedScope(id: string, createdBy = OWNER.address.toLowerCase(), status = "active") {
  getStore().db.insert(schema.executionScopes).values({
    id, kernelId: KERNEL, createdBy, status, allowedTools: ["health"],
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }).run();
}

function decisionState() {
  const { db } = getStore();
  return {
    policies: db.select().from(schema.operatorPolicies).all(),
    approvals: db.select().from(schema.pendingApprovals).all(),
    scopes: db.select().from(schema.executionScopes).all(),
    calls: db.select().from(schema.toolCallRelay).all(),
    chat: db.select().from(schema.ot2ChatMessages).all(),
  };
}

function resume(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({ method: "POST", url: "/api/operator/emergency-resume", headers, payload: { kernelId: KERNEL } });
}

async function engage(app: FastifyInstance, headers: Record<string, string>) {
  const response = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers, payload: { kernelId: KERNEL } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ stopped: true });
  expect(emergencyStopState(KERNEL)).toBe("stopped");
}

describe("N176 explicit credentials for kernel decisions", () => {
  const issuers = ["identity session", "evidence grant", "contributor quickstart", "Lit usage"] as const;
  const issuerCases = issuers.flatMap(issuer => [false, true].map(routesBeforeGate => ({ issuer, routesBeforeGate })));
  it.each(issuerCases)("$issuer refuses cookie-only authority before issuance (routesBeforeGate=$routesBeforeGate)", async ({ issuer, routesBeforeGate }) => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const foreign = await signIn(app, FOREIGN);
    const issueSession = vi.spyOn(SessionKeyService.prototype, "issueSessionKey");
    const grant = vi.spyOn(encryptionService, "grantAccess");
    const embedded = vi.spyOn(embeddedWallet, "getEmbeddedWalletAdapter");
    const persistGrant = vi.spyOn(getRepos().encryption, "insertGrant").mockReturnValue(undefined);
    if (issuer === "evidence grant") {
      vi.spyOn(getRepos().encryption, "findEncryptedByBundleId").mockReturnValue({
        id: "n176-encrypted", bundleId: "n176-bundle", bundleHash: "fixture", ciphertext: "fixture",
        iv: "fixture", authTag: "fixture", encryptedAt: new Date().toISOString(),
        ipfsCid: null, ipfsMetadataCid: null, filecoinDealId: null, litCiphertext: null,
        litDataToEncryptHash: null, litAccessConditions: null, litNetwork: null,
      });
    }
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ usage_api_key: randomUUID() }), { status: 200 },
    ));
    const keys = getStore().db.select().from(schema.apiKeys).all();
    const request: InjectOptions = { method: "POST", ...(issuer === "identity session"
      ? { url: "/api/identity/session", payload: { principalAgentId: "n176-delegated-agent" } }
      : issuer === "evidence grant"
      ? { url: "/api/evidence/encrypted/n176-bundle/grant", payload: { recipientAddress: FOREIGN.address } }
      : issuer === "contributor quickstart"
      ? { url: "/api/contributors/quickstart", payload: { email: "n176@example.test", role: "operator", ratePercent: 1 } }
      : { url: "/api/lit/provision", payload: { kernelId: KERNEL, operatorDid: "n176-operator" } }) };
    for (const headers of [owner.cookie, { ...owner.cookie, ...bearer(foreign.token) }, { ...owner.cookie, ...bearer("pcc_test_n176_invalid_key") }]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toEqual({
        error: "session_required", message: "An explicit bearer session is required to create or delegate credentials.",
      });
    }
    expect(issueSession).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(persistGrant).not.toHaveBeenCalled();
    expect(embedded).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(getStore().db.select().from(schema.apiKeys).all()).toEqual(keys);
    expect(getStore().db.select().from(schema.accessGrants).all()).toEqual([]);
    for (const headers of [bearer(owner.session.token), { ...owner.cookie, ...bearer(owner.session.token) }]) {
      const response = await app.inject({ ...request, headers });
      const status = issuer === "contributor quickstart" || issuer === "Lit usage" ? 201 : 200;
      expect(response.statusCode, response.body).toBe(status);
    }
    if (issuer === "identity session") expect(issueSession).toHaveBeenCalledTimes(2);
    if (issuer === "contributor quickstart") expect(embedded).toHaveBeenCalledTimes(2);
    if (issuer === "evidence grant") {
      expect(grant).toHaveBeenCalledTimes(2);
      expect(persistGrant).toHaveBeenCalledTimes(2);
    }
    if (issuer === "Lit usage") expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each(issuerCases)("$issuer keeps a validated API key and the admin secret explicit beside the cookie (routesBeforeGate=$routesBeforeGate)", async ({ issuer, routesBeforeGate }) => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    vi.spyOn(getRepos().encryption, "insertGrant").mockReturnValue(undefined);
    if (issuer === "evidence grant") {
      vi.spyOn(getRepos().encryption, "findEncryptedByBundleId").mockReturnValue({
        id: "n176-encrypted", bundleId: "n176-bundle", bundleHash: "fixture", ciphertext: "fixture",
        iv: "fixture", authTag: "fixture", encryptedAt: new Date().toISOString(),
        ipfsCid: null, ipfsMetadataCid: null, filecoinDealId: null, litCiphertext: null,
        litDataToEncryptHash: null, litAccessConditions: null, litNetwork: null,
      });
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ usage_api_key: randomUUID() }), { status: 200 },
    ));
    const request: InjectOptions = { method: "POST", ...(issuer === "identity session"
      ? { url: "/api/identity/session", payload: { principalAgentId: "n176-delegated-agent" } }
      : issuer === "evidence grant"
      ? { url: "/api/evidence/encrypted/n176-bundle/grant", payload: { recipientAddress: FOREIGN.address } }
      : issuer === "contributor quickstart"
      ? { url: "/api/contributors/quickstart", payload: { email: "n176@example.test", role: "operator", ratePercent: 1 } }
      : { url: "/api/lit/provision", payload: { kernelId: KERNEL, operatorDid: "n176-operator" } }) };
    for (const headers of [{ ...owner.cookie, ...owner.headers }, { ...owner.cookie, "x-admin-key": ADMIN }]) {
      const response = await app.inject({ ...request, headers });
      expect(response.statusCode, response.body).toBe(issuer === "contributor quickstart" || issuer === "Lit usage" ? 201 : 200);
    }
  });

  it.each([false, true])("spending delegation already requires API-key scopes (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const spend = vi.spyOn(CdpSpendPermissionService.prototype, "issue");
    for (const headers of [owner.cookie, bearer(owner.session.token), owner.headers]) {
      const response = await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/spend-permission", headers,
        payload: { walletAddress: OWNER.address, spender: FOREIGN.address, allowanceUSDC: 1 } });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error).toBe("insufficient_scope");
    }
    expect(spend).not.toHaveBeenCalled();
  });

  it.each([false, true])("a cookie cannot mint decision authority or replace the earlier key (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const foreign = await signIn(app, FOREIGN);
    const keys = () => getStore().db.select().from(schema.apiKeys).all();
    const before = keys();
    for (const headers of [owner.cookie, { ...owner.cookie, ...bearer(foreign.token) },
      { ...owner.cookie, authorization: "Basic unrelated" },
      { ...owner.cookie, authorization: `bearer ${owner.session.token}` }, { ...owner.cookie, ...bearer("pcc_test_n176_invalid_key") }]) {
      const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers });
      expect(minted.statusCode, minted.body).toBe(401);
      expect(minted.json()).toEqual({
        error: "session_required", message: "An explicitly carried SIWE session is required to mint a session key",
      });
      expect(minted.json()).not.toHaveProperty("api_key");
      expect(keys()).toEqual(before);
    }

    // The end-to-end escalation stops at minting; no decision state changes.
    await engage(app, owner.cookie);
    const decisions = decisionState();
    const kernel = getRepos().kernels.findById(KERNEL);
    const requests: InjectOptions[] = [
      { method: "POST", url: "/api/operator/emergency-resume", payload: { kernelId: KERNEL } },
      { method: "PUT", url: `/api/operator/policy/${KERNEL}`, payload: DEFAULT_OPERATOR_POLICY },
      { method: "POST", url: "/api/operator/approvals", payload: { kernelId: KERNEL, agentId: "n176-mint-chain", autoApprove: true } },
      { method: "POST", url: "/api/kernels", payload: { id: KERNEL, locationVisibility: "exact" } },
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: owner.cookie });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toEqual(EXPLICIT_REQUIRED);
    }
    expect(emergencyStopState(KERNEL)).toBe("stopped");
    expect(decisionState()).toEqual(decisions);
    expect(getRepos().kernels.findById(KERNEL)).toEqual(kernel);
    expect(keys()).toEqual(before);
    const earlier = await app.inject({ url: PROOF_URL, headers: owner.headers });
    expect(earlier.statusCode, earlier.body).toBe(200);
    expect(earlier.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(), provenWalletCarrier: "key" });
    expect((await resume(app, owner.headers)).statusCode).toBe(200);
  });

  it.each([false, true])("bearer mint and cookie plus matching bearer mint succeed (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const session = await signIn(app);
    for (const headers of [bearer(session.token), { ...sessionCookie(app, session.token), ...bearer(session.token) }]) {
      const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers });
      expect(minted.statusCode, minted.body).toBe(201);
      const proof = await app.inject({ url: PROOF_URL, headers: bearer(minted.json().api_key) });
      expect(proof.statusCode, proof.body).toBe(200);
      expect(proof.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(), provenWalletCarrier: "key" });
    }
  });

  it.each([false, true])("a wallet link cannot bind authority from the cookie alone (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const foreign = await signIn(app, FOREIGN);
    const claimed = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers: bearer(claimed.rawKey),
      payload: { keyType: "secp256k1", address: OWNER.address.toLowerCase(), chainId: 84532, role: "agent", label: "n176-explicit-binding" } });
    expect(created.statusCode, created.body).toBe(201);
    const link = created.json<{ requestId: string; userCode: string; message: string }>();
    const signed = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/proof`,
      payload: { signature: await OWNER.signMessage({ message: link.message }) } });
    expect(signed.statusCode, signed.body).toBe(200);
    const state = () => ({
      requests: getStore().db.all(sql`SELECT * FROM wallet_link_requests`),
      links: getStore().db.all(sql`SELECT * FROM wallet_links`),
    });
    const before = state();
    const payload = { userCode: link.userCode, decision: "approve", consentSha256: CONSENT_SHA256 };
    for (const headers of [owner.cookie, { ...owner.cookie, ...bearer(foreign.token) }, { ...owner.cookie, ...bearer("pcc_test_n176_invalid_key") }]) {
      const response = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/approve`,
        headers: { ...headers, origin: "https://capability.network" }, payload });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json()).toMatchObject({ error: "session_required" });
      expect(state()).toEqual(before);
    }
    const accepted = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/approve`,
      headers: { ...owner.cookie, ...bearer(owner.session.token), origin: "https://capability.network" }, payload });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ status: "approved" });
    expect(state().links).toHaveLength(1);
  });

  it.each([false, true])("cookie-only RESUME is refused, bearer-session and session key resume (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    await engage(app, owner.cookie);
    const refused = await resume(app, owner.cookie);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual(EXPLICIT_REQUIRED);
    expect(emergencyStopState(KERNEL)).toBe("stopped");
    for (const headers of [bearer(owner.session.token), owner.headers]) {
      const response = await resume(app, headers);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ resumed: true });
      expect(emergencyStopState(KERNEL)).toBe("clear");
      await engage(app, owner.cookie);
    }
  });

  const cases = ["policy PUT", "policy PATCH", "approval preApproved", "approval approve", "approval reject", "scope accept", "relay scope", "relay chat", "relay tool-call", "agent-package configure"] as const;
  it.each(cases)("%s refuses the cookie without writes and accepts the owner's session key", async family => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    let request: InjectOptions;
    let expected = 200;
    if (family === "policy PUT") request = { method: "PUT", url: `/api/operator/policy/${KERNEL}`, payload: DEFAULT_OPERATOR_POLICY };
    else if (family === "policy PATCH") request = { method: "PATCH", url: `/api/operator/policy/${KERNEL}`, payload: { emergencyStop: false } };
    else if (family === "approval preApproved") request = { method: "POST", url: "/api/operator/approvals", payload: { kernelId: KERNEL, agentId: "n176-agent", autoApprove: true } };
    else if (family === "approval approve" || family === "approval reject") {
      const pending = await app.inject({ method: "POST", url: "/api/operator/approvals", headers: owner.cookie,
        payload: { kernelId: KERNEL, agentId: "n176-agent" } });
      expect(pending.statusCode, pending.body).toBe(200);
      expect(pending.json().approval.status).toBe("pending");
      request = { method: "POST", url: `/api/operator/approvals/${pending.json().approval.id}/${family.split(" ")[1]}`, payload: { reason: "N176 review" } };
    } else if (family === "scope accept") {
      seedScope("n176-accept", OWNER.address.toLowerCase(), "awaiting_acceptance");
      request = { method: "POST", url: "/api/operator/scopes/n176-accept/accept" };
    } else if (family === "relay scope") {
      request = { method: "POST", url: `/api/relay/${KERNEL}/scope`, payload: { allowedTools: ["health"] } };
      expected = 201;
    } else if (family === "relay chat") {
      request = { method: "POST", url: `/api/relay/${KERNEL}/chat`, payload: { message: "N176 operator instruction" } };
      expected = 201;
    } else if (family === "relay tool-call") {
      seedScope("n176-operator-scope");
      request = { method: "POST", url: `/api/relay/${KERNEL}/tool-call`, payload: { scopeId: "n176-operator-scope", toolName: "health" } };
      expected = 201;
    } else request = { method: "PUT", url: `/api/kernels/${KERNEL}/agent-package/configure`, payload: { enabledTools: ["health"] } };

    const before = decisionState();
    const refused = await app.inject({ ...request, headers: owner.cookie });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual(EXPLICIT_REQUIRED);
    expect(decisionState()).toEqual(before);
    const accepted = await app.inject({ ...request, headers: owner.headers });
    expect(accepted.statusCode, accepted.body).toBe(expected);
    expect(decisionState()).not.toEqual(before);
  });

  it("a scope holder's cookie cannot waive a tool-call's explicit credential refusal", async () => {
    const app = await buildApp();
    await registerOwner(app);
    const foreign = await signIn(app, FOREIGN);
    seedScope("n176-delegated", FOREIGN.address.toLowerCase());
    const before = decisionState();
    const response = await app.inject({ method: "POST", url: `/api/relay/${KERNEL}/tool-call`,
      headers: sessionCookie(app, foreign.token), payload: { scopeId: "n176-delegated", toolName: "health" } });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual(EXPLICIT_REQUIRED);
    expect(decisionState()).toEqual(before);
  });

  it("the sign-in cookie still proves reads, ENGAGE and pending approval submission", async () => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    seedScope("n176-read-scope", FOREIGN.address.toLowerCase());
    for (const url of [PROOF_URL, `/api/operator/policy/${KERNEL}`, "/api/operator/approvals",
      `/api/relay/${KERNEL}/manifest`, `/api/relay/${KERNEL}/chat/messages`,
      `/api/relay/${KERNEL}/scope/n176-read-scope`, `/api/relay/${KERNEL}/scope/n176-read-scope/audit`]) {
      const response = await app.inject({ url, headers: owner.cookie });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      if (url === PROOF_URL) expect(response.json()).toMatchObject({
        provenWallet: OWNER.address.toLowerCase(), provenWalletVia: "siwe-session", provenWalletCarrier: "cookie",
      });
    }
    await engage(app, owner.cookie);
    const pending = await app.inject({ method: "POST", url: "/api/operator/approvals", headers: owner.cookie,
      payload: { kernelId: KERNEL, agentId: "n176-pending-agent", autoApprove: false } });
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json().approval.status).toBe("pending");
  });

  it("records each proof's actual carrier, including a matching cookie and bearer", async () => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    for (const [headers, carrier] of [
      [owner.cookie, "cookie"], [owner.headers, "key"],
      [bearer(owner.session.token), "bearer-session"],
      [{ ...owner.cookie, ...bearer(owner.session.token) }, "bearer-session"],
    ] as const) {
      const response = await app.inject({ url: PROOF_URL, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(), provenWalletCarrier: carrier });
    }
    await engage(app, owner.cookie);
    const response = await resume(app, { ...owner.cookie, ...bearer(owner.session.token) });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("a real W1b self-link's API key and X-PCC-Wallet carry key proof and can decide", async () => {
    const app = await buildApp(true);
    const owner = await registerOwner(app);
    const key = provisionApiKey({ operatorId: "n176-self-linked-key", scopes: ["*"] });
    const headers = bearer(key.rawKey);
    const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers,
      payload: { keyType: "secp256k1", address: OWNER.address.toLowerCase(), chainId: 84532,
        role: "agent", label: "n176-self-link" } });
    expect(created.statusCode, created.body).toBe(201);
    const link = created.json<{ requestId: string; userCode: string; message: string }>();
    const signed = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/proof`,
      payload: { signature: await OWNER.signMessage({ message: link.message }) } });
    expect(signed.statusCode, signed.body).toBe(200);
    const approved = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/approve`, headers,
      payload: { userCode: link.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
    expect(approved.statusCode, approved.body).toBe(200);
    const provenHeaders = { ...headers, "x-pcc-wallet": OWNER.address };
    const proof = await app.inject({ url: PROOF_URL, headers: provenHeaders });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(),
      provenWalletVia: "self-link:agent", provenWalletCarrier: "key" });
    await engage(app, owner.cookie);
    const response = await resume(app, provenHeaders);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ resumed: true });
  });

  it.each(["Basic unrelated", "Bearer invalid-session"])("%s does not upgrade a cookie proof", async authorization => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    await engage(app, owner.cookie);
    const headers = { ...owner.cookie, authorization };
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(), provenWalletCarrier: "cookie" });
    const response = await resume(app, headers);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual(EXPLICIT_REQUIRED);
  });

  it("a foreign bearer session cannot lend its explicit carrier to the owner's cookie proof", async () => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    const foreign = await signIn(app, FOREIGN);
    await engage(app, owner.cookie);
    const headers = { ...owner.cookie, ...bearer(foreign.token) };
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.statusCode, proof.body).toBe(200);
    expect(proof.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(), provenWalletCarrier: "cookie" });
    const response = await resume(app, headers);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual(EXPLICIT_REQUIRED);
  });

  it("the admin can still decide with the owner's ambient cookie", async () => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    await engage(app, owner.cookie);
    const response = await resume(app, { ...owner.cookie, "x-admin-key": ADMIN });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ resumed: true });
    expect(emergencyStopState(KERNEL)).toBe("clear");
    // The owner proof remains cookie-carried; the separately checked admin secret authorizes it.
    const proof = await app.inject({ url: PROOF_URL, headers: { ...owner.cookie, "x-admin-key": ADMIN } });
    expect(proof.json()).toMatchObject({ admin: true, provenWalletCarrier: "cookie" });
  });
});

describe("N176 batch operator decisions", () => {
  const CAPABILITY = "n176-batch-capability";
  const JOB = "n176-batch-job";
  const FOREIGN_KERNEL = `${KERNEL}-foreign`;
  const sharedInput = (kernelId = KERNEL) => ({
    kernelId, capabilityType: "hplc", totalSlots: 8, protocolType: "n176-protocol", pricePerSlot: "2.50",
  });
  const slotInput = (position = "A1", jobId = JOB) => ({
    position, jobId, stepId: "n176-batch-step", userId: OWNER.address.toLowerCase(), sampleLabel: `n176-${position}`,
  });

  function seedBatch() {
    const repos = getRepos();
    repos.capabilities.insert({
      id: CAPABILITY, kernelId: KERNEL, type: "hplc", name: "N176 batch assay", materials: [],
      assuranceTiers: [0], pricing: { currency: "USDC", baseCost: "2.50", minimum: "2.50" },
      availability: {}, location: { lat: 0, lng: 0 },
    });
    repos.jobs.insert({
      id: JOB, stepId: "n176-batch-step", cwmId: "n176-batch-workflow", capabilityId: CAPABILITY,
      kernelId: KERNEL, status: "queued", assignedDevices: [], progress: 0,
    });
    return batchTracker.createBatch(KERNEL, "n176-batch-device", CAPABILITY, {});
  }

  function seedForeignKernel() {
    const ownerKernel = getRepos().kernels.findById(KERNEL)!;
    getRepos().kernels.insert({ ...ownerKernel, id: FOREIGN_KERNEL, operatorAddress: FOREIGN.address.toLowerCase() });
    return batchTracker.createBatch(FOREIGN_KERNEL, "n176-foreign-device", "n176-foreign-capability", {});
  }

  async function batchState(app: FastifyInstance, headers: Record<string, string>) {
    const open = await app.inject({ url: "/api/batches/shared/open", headers });
    expect(open.statusCode, open.body).toBe(200);
    return {
      manifests: structuredClone(batchTracker.getAllBatches()),
      events: structuredClone(batchTracker.getAllBatches().map(batch => batchTracker.getEvents(batch.id))),
      shared: open.json(),
    };
  }

  it.each([false, true])("slots refuse the owner's cookie without writes; explicit proofs and admin write (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const batch = seedBatch();
    const before = await batchState(app, owner.cookie);
    const refused = await app.inject({ method: "POST", url: `/api/batches/${batch.id}/slots`,
      headers: owner.cookie, payload: slotInput() });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual(EXPLICIT_REQUIRED);
    expect(await batchState(app, owner.cookie)).toEqual(before);
    expect(batchTracker.getBatch(batch.id)?.slots).toEqual([]);

    for (const [index, headers] of [owner.headers, bearer(owner.session.token), { ...owner.cookie, "x-admin-key": ADMIN }].entries()) {
      const input = slotInput(`A${index + 1}`);
      const accepted = await app.inject({ method: "POST", url: `/api/batches/${batch.id}/slots`, headers, payload: input });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().slot).toMatchObject({ ...input, status: "pending" });
      expect(batchTracker.getBatch(batch.id)?.slots).toHaveLength(index + 1);
      expect(batchTracker.getBatch(batch.id)?.slots[index]).toEqual(accepted.json().slot);
    }
    const read = await app.inject({ url: `/api/batches/${batch.id}`, headers: owner.cookie });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().batch.slots).toEqual(batchTracker.getBatch(batch.id)?.slots);
  });

  it.each([false, true])("shared offers refuse the owner's cookie without writes; explicit proofs and admin write (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    seedBatch();
    const before = await batchState(app, owner.cookie);
    const refused = await app.inject({ method: "POST", url: "/api/batches/shared", headers: owner.cookie, payload: sharedInput() });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toEqual(EXPLICIT_REQUIRED);
    expect(await batchState(app, owner.cookie)).toEqual(before);

    for (const [index, headers] of [owner.headers, bearer(owner.session.token), { ...owner.cookie, "x-admin-key": ADMIN }].entries()) {
      const accepted = await app.inject({ method: "POST", url: "/api/batches/shared", headers, payload: sharedInput() });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const batch = accepted.json().batch;
      expect(batch).toMatchObject({ ...sharedInput(), status: "open", claimedSlots: [] });
      const after = await batchState(app, owner.cookie);
      expect(after.manifests).toEqual(before.manifests);
      expect(after.events).toEqual(before.events);
      expect(after.shared.batches).toHaveLength(before.shared.batches.length + index + 1);
      expect(after.shared.batches).toContainEqual(batch);
      const detail = await app.inject({ url: `/api/batches/shared/${batch.id}`, headers: owner.cookie });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ batch, summary: { totalSlots: 8, availableSlots: 8, claimedSlots: 0 } });
      const availability = await app.inject({ url: `/api/batches/shared/${batch.id}/availability`, headers: owner.cookie });
      expect(availability.statusCode, availability.body).toBe(200);
      expect(availability.json()).toEqual({
        total: 8, claimed: 0, available: 8, availableIndices: [0, 1, 2, 3, 4, 5, 6, 7], claimedBy: [],
        pricePerSlot: "2.50", currency: "USDC",
      });
    }
  });

  it.each([false, true])("cookie refusal precedes batch existence, kernel scope, job and input gates (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const batch = seedBatch();
    const foreignBatch = seedForeignKernel();
    const before = await batchState(app, owner.cookie);
    const requests: InjectOptions[] = [
      { url: "/api/batches/n176-missing-batch/slots", payload: slotInput() },
      { url: `/api/batches/${foreignBatch.id}/slots`, payload: slotInput() },
      { url: `/api/batches/${batch.id}/slots`, payload: slotInput("A1", "n176-missing-job") },
      { url: `/api/batches/${batch.id}/slots`, payload: {} },
      { url: "/api/batches/shared", payload: sharedInput(FOREIGN_KERNEL) },
      { url: "/api/batches/shared", payload: {} },
    ];
    for (const request of requests) {
      const refused = await app.inject({ ...request, method: "POST", headers: owner.cookie });
      expect(refused.statusCode, `${request.url}: ${refused.body}`).toBe(403);
      expect(refused.json()).toEqual(EXPLICIT_REQUIRED);
    }
    expect(await batchState(app, owner.cookie)).toEqual(before);

    const foreignSlots = await app.inject({ method: "POST", url: `/api/batches/${foreignBatch.id}/slots`,
      headers: owner.headers, payload: slotInput() });
    expect(foreignSlots.statusCode, foreignSlots.body).toBe(400);
    expect(foreignSlots.json()).toEqual({ error: `Batch ${foreignBatch.id} not found` });
    const foreignOffer = await app.inject({ method: "POST", url: "/api/batches/shared", headers: owner.headers, payload: sharedInput(FOREIGN_KERNEL) });
    expect(foreignOffer.statusCode, foreignOffer.body).toBe(403);
    expect(foreignOffer.json()).toEqual({ error: "forbidden", message: "Only the kernel's operator or an admin may open a shared batch on it." });
    const missingJob = await app.inject({ method: "POST", url: `/api/batches/${batch.id}/slots`,
      headers: owner.headers, payload: slotInput("A1", "n176-missing-job") });
    expect(missingJob.statusCode, missingJob.body).toBe(400);
    expect(missingJob.json()).toEqual({ error: "Job n176-missing-job not found on this batch's kernel" });
    expect(await batchState(app, owner.cookie)).toEqual(before);
  });

  it.each([false, true])("a proof with no recorded carrier cannot opt into exact location or write batches (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate, true);
    await registerOwner(app);
    const batch = seedBatch();
    const claimed = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const headers = { ...bearer(claimed.rawKey), "x-n176-carrierless-proof": "1" };
    const proof = await app.inject({ url: PROOF_URL, headers });
    expect(proof.json()).toMatchObject({ provenWallet: OWNER.address.toLowerCase(), provenWalletCarrier: null });
    const kernel = getRepos().kernels.findById(KERNEL);
    const before = await batchState(app, bearer(claimed.rawKey));
    for (const request of [
      { url: "/api/kernels", payload: { id: KERNEL, locationVisibility: "exact" } },
      { url: "/api/kernels", payload: { id: `${KERNEL}-carrierless`, locationVisibility: "exact" } },
      { url: `/api/batches/${batch.id}/slots`, payload: slotInput() },
      { url: "/api/batches/shared", payload: sharedInput() },
    ] as InjectOptions[]) {
      const refused = await app.inject({ ...request, method: "POST", headers });
      expect(refused.statusCode, `${request.url}: ${refused.body}`).toBe(403);
      expect(refused.json()).toMatchObject({ error: "explicit_credential_required" });
    }
    expect(getRepos().kernels.findById(KERNEL)).toEqual(kernel);
    expect(getRepos().kernels.findById(`${KERNEL}-carrierless`)).toBeUndefined();
    expect(await batchState(app, bearer(claimed.rawKey))).toEqual(before);
  });

  it.each([false, true])("batch identity refusals keep their 401/403 statuses and bodies (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const batch = seedBatch();
    const claimed = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const before = await batchState(app, owner.cookie);
    for (const [url, payload] of [[`/api/batches/${batch.id}/slots`, slotInput()], ["/api/batches/shared", sharedInput()]] as const) {
      const anonymous = await app.inject({ method: "POST", url, payload });
      expect(anonymous.statusCode, anonymous.body).toBe(401);
      expect(anonymous.json()).toEqual({
        error: "api_key_required",
        message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.",
        provision_url: "/api/auth/provision", docs: "https://capability.network/whitepaper.md",
      });
      const unproven = await app.inject({ method: "POST", url, payload, headers: bearer(claimed.rawKey) });
      expect(unproven.statusCode, unproven.body).toBe(403);
      expect(unproven.json()).toEqual({
        error: "identity_unverified",
        message: "A job's records are shown only to a proven identity: sign in with a wallet (SIWE), or use an API key " +
          "minted from a wallet session. An email or a self-declared operator id is not proof.",
      });
    }
    expect(await batchState(app, owner.cookie)).toEqual(before);
  });
});

describe("N176 exact-location decisions", () => {
  const row = (id = KERNEL) => getRepos().kernels.findById(id);
  const register = (app: FastifyInstance, headers: Record<string, string>, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/kernels", headers, payload });

  it.each([false, true])("cookie-only exact create is refused without a row (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const id = `${KERNEL}-exact-create`;
    const response = await register(app, owner.cookie, {
      id, name: "Cookie exact create", locationVisibility: "exact", location: { lat: 47.62, lng: -122.35 },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual(EXPLICIT_REQUIRED);
    expect(row(id)).toBeUndefined();
  });

  it.each([false, true])("cookie-only exact update is refused without writes (routesBeforeGate=%s)", async routesBeforeGate => {
    const app = await buildApp(routesBeforeGate);
    const owner = await registerOwner(app);
    const before = row();
    expect(before?.location).toEqual({ lat: 0, lng: 0 });
    const response = await register(app, owner.cookie, {
      id: KERNEL, name: "Must not be written", locationVisibility: "exact", location: { lat: 47.62, lng: -122.35 },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual(EXPLICIT_REQUIRED);
    expect(row()).toEqual(before);
    expect(row()?.location).toEqual({ lat: 0, lng: 0 });
  });

  it.each(["session key", "admin"])("a cookie can keep exact visibility established by the %s, then choose approximate", async setup => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    const headers = setup === "admin" ? { ...owner.cookie, "x-admin-key": ADMIN } : owner.headers;
    const optedIn = await register(app, headers, { id: KERNEL, locationVisibility: "exact" });
    expect(optedIn.statusCode, optedIn.body).toBe(200);
    expect(row()?.location).toMatchObject({ visibility: "exact" });
    for (const visibility of ["exact", undefined, "approximate"] as const) {
      const response = await register(app, owner.cookie, {
        id: KERNEL, ...(visibility === undefined ? {} : { locationVisibility: visibility }),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(row()?.location).toEqual(visibility === "approximate"
        ? { lat: 0, lng: 0 } : { lat: 0, lng: 0, visibility: "exact" });
    }
  });

  it.each(["session key", "bearer session"])("the owner's %s can opt in at both create and update", async carrier => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    const headers = carrier === "session key" ? owner.headers : bearer(owner.session.token);
    const id = `${KERNEL}-explicit-create`;
    const created = await register(app, headers, { id, locationVisibility: "exact" });
    expect(created.statusCode, created.body).toBe(201);
    expect(row(id)?.location).toMatchObject({ visibility: "exact" });
    const updated = await register(app, headers, { id: KERNEL, locationVisibility: "exact" });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(row()?.location).toMatchObject({ visibility: "exact" });
  });

  it("the admin with an ambient cookie can opt in at both create and update", async () => {
    const app = await buildApp();
    const owner = await registerOwner(app);
    const headers = { ...owner.cookie, "x-admin-key": ADMIN };
    const id = `${KERNEL}-admin-create`;
    const created = await register(app, headers, { id, locationVisibility: "exact" });
    expect(created.statusCode, created.body).toBe(201);
    expect(row(id)?.location).toMatchObject({ visibility: "exact" });
    const updated = await register(app, headers, { id: KERNEL, locationVisibility: "exact" });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(row()?.location).toMatchObject({ visibility: "exact" });
  });

  it("a non-owner update retains its existing FORBIDDEN body", async () => {
    const app = await buildApp();
    await registerOwner(app);
    const foreign = await signIn(app, FOREIGN);
    const before = row();
    const response = await register(app, sessionCookie(app, foreign.token), { id: KERNEL, locationVisibility: "exact" });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toEqual({
      error: "FORBIDDEN", message: `Authenticated actor does not own kernel '${KERNEL}'`,
    });
    expect(row()).toEqual(before);
  });

  it("claimed-only exact create and update retain their existing refusal bodies", async () => {
    const app = await buildApp();
    await registerOwner(app);
    const claimed = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const before = row();
    for (const id of [`${KERNEL}-claimed-create`, KERNEL]) {
      const response = await register(app, bearer(claimed.rawKey), { id, locationVisibility: "exact" });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toEqual({
        error: "FORBIDDEN",
        message: `Publishing the exact location of kernel '${id}' needs the X-Admin-Key header, ` +
          "or a wallet you proved (SIWE) that is the kernel's operator",
      });
    }
    expect(row(`${KERNEL}-claimed-create`)).toBeUndefined();
    expect(row()).toEqual(before);
  });
});
