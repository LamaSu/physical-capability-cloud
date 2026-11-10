import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sql } from "@pcc/store";
import { maskPayoutDestination, OperatorBindingDTOSchema } from "@pcc/spec";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { kernelPayoutRoutes } from "../routes/kernel-payout.js";
import { kitRoutes } from "../routes/kits.js";
import { operatorBindingRoutes } from "../routes/operator-binding.js";
import { provisionRoutes } from "../routes/provision.js";
import { walletsRoutes } from "../routes/wallets.js";
import { KitRegistry } from "../services/kit-registry.js";
import { PAYOUT_CONSENT_SHA256, PAYOUT_CONSENT_VERSION } from "../services/payout/consent.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true, canSiweVerify: () => true,
}));

// Ephemeral accounts and real credentials; no request identity or proof is injected.
const OWNER = privateKeyToAccount(generatePrivateKey());
const FOREIGN = privateKeyToAccount(generatePrivateKey());
const ADMIN = randomUUID();
const KERNEL = "k3-auth-kernel";
const CAPABILITY = "k3-auth-capability";
const CSD = "pcc://capabilities/liquid-handling/v1";
const CHAIN = 84532;
const H = (c: string) => `sha256:${c.repeat(64)}`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
type Headers = Record<string, string>;
const BIND_PROOF_REQUIRED = { error: "forbidden", reason: "operator_proof_required",
  message: "Binding needs a wallet sign-in proof that you control the kernel's operator wallet. The admin secret and wallet-link proofs don't bind." };
const SHARED_PROOF_REQUIRED = { error: "forbidden", reason: "operator_proof_required",
  message: "This needs the gateway admin secret, or proof that you control the kernel's operator wallet (wallet sign-in proof, WP-A). An API key's claimed identity is not proof." };
const ME_PROOF_REQUIRED = { error: "forbidden", reason: "operator_proof_required",
  message: "Your bindings need a wallet sign-in proof that you control a kernel's operator wallet." };
const manifest = {
  schema: "pcc.capability-kit/v1", name: "K3 auth kit", version: "1.0.0", parentKitDigest: null,
  capabilities: [{ csdUrl: CSD, capabilityContractDigest: H("a") }],
  artifacts: [
    { role: "method", name: "method.py", mediaType: "text/x-python", digest: H("1") },
    { role: "tests", name: "tests.json", mediaType: "application/json", digest: H("2") },
    { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: H("3") },
    { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: H("4") },
  ], economics: { spdxLicense: "Apache-2.0" }, declaredAssuranceTiers: [3],
};
let app: FastifyInstance;
let rootDir: string;
let registry: KitRegistry;
let kitDigest: string;

beforeEach(async () => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_NETWORK", "base-sepolia");
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY",
    "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION",
    "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS", "TENANT_ENFORCE"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  seedKernel();
  seedCapability();
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "k3-binding-auth-"));
  registry = new KitRegistry({ rootDir, durable: () => true, audit: () => {} });
  kitDigest = (await registry.publish(manifest, "k3-publisher@example.test")).kitDigest;
  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: randomUUID() });
  await app.register(siweAuthPlugin);
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(provisionRoutes);
  await app.register(walletsRoutes);
  await app.register(kitRoutes, { registry });
  await app.register(operatorBindingRoutes, { registry });
  await app.register(kernelPayoutRoutes);
  app.post("/api/kits/:segment", async () => ({ reached: true }));
  app.post("/api/kits/:digest/anything", async () => ({ reached: true }));
  app.post("/api/escrow/probe", async () => ({ reached: true }));
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  closeStore();
  __resetScopeCacheForTests();
  if (rootDir) await fs.rm(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seedKernel(id = KERNEL, operatorAddress = OWNER.address) {
  const now = new Date().toISOString();
  getRepos().kernels.insert({ id, name: id, operatorAddress, location: { lat: 0, lng: 0 },
    physicalAddress: "test", maxAssuranceTier: 0, publicKey: "test-public-key", status: "online",
    registeredAt: now, lastHeartbeat: now, version: "1" });
}

function seedCapability(id = CAPABILITY, kernelId = KERNEL) {
  getRepos().capabilities.insert({ id, kernelId, type: CSD, name: id, materials: [], assuranceTiers: [0],
    pricing: { currency: "USD", baseCost: "25", minimum: "25" },
    availability: { mode: "always" }, location: { lat: 0, lng: 0 } });
}

async function signIn(account = OWNER) {
  const host = "localhost";
  const nonce = await app.inject({ url: "/api/auth/nonce", headers: { host } });
  expect(nonce.statusCode).toBe(200);
  const message = [
    `${host} wants you to sign in with your Ethereum account:`, account.address.toLowerCase(),
    "", "Sign in to PCC.", "", `URI: http://${host}`, "Version: 1", "Chain ID: 8453",
    `Nonce: ${nonce.json().nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const response = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host },
    payload: { message, signature: await account.signMessage({ message }) } });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>();
}

async function ownerCredentials(account = OWNER) {
  const session = await signIn(account);
  const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(session.token) });
  expect(minted.statusCode).toBe(201);
  const key = minted.json<{ api_key: string; key_id: string }>();
  expect(JSON.parse(getRepos().apiKeys.findById(key.key_id)!.scopes)).toEqual(["operator:basic"]);
  return { headers: bearer(key.api_key), session: bearer(session.token),
    cookie: { cookie: `pcc_session=${app.signCookie(session.token)}` }, keyId: key.key_id };
}

async function selfProvision() {
  const response = await app.inject({ method: "POST", url: "/api/auth/provision",
    payload: { walletAddress: OWNER.address.toLowerCase(), name: "claimed owner" } });
  expect(response.statusCode).toBe(201);
  expect(response.json().operator_id).toBe(OWNER.address.toLowerCase());
  expect(response.json().scopes).toEqual(["operator:basic"]);
  return bearer(response.json<{ api_key: string }>().api_key);
}

const bind = (headers: Headers, kernelId = KERNEL, capabilityId = CAPABILITY) => app.inject({
  method: "POST", url: `/api/kits/${kitDigest}/bindings`, headers,
  payload: { csdUrl: CSD, kernelId, capabilityId },
});
const withdraw = (headers: Headers, id: string) => app.inject({
  method: "POST", url: `/api/kits/${kitDigest}/bindings/${id}/withdraw`, headers,
});
const me = (headers: Headers) => app.inject({ url: "/api/operators/me/binding", headers });
async function ownerBinding() {
  const owner = await ownerCredentials();
  const response = await bind(owner.headers);
  expect(response.statusCode).toBe(201);
  return { owner, id: response.json().binding.bindingId as string };
}

describe("kit binding authority through real credentials", () => {
  it("B1 self-provisioned owner claims reach the proof refusal on all three endpoints", async () => {
    const headers = await selfProvision();
    const response = await bind(headers);
    expect(response.statusCode).toBe(403); expect(response.json()).toEqual(BIND_PROOF_REQUIRED);
    const projection = await me(headers);
    expect(projection.statusCode).toBe(403); expect(projection.json()).toEqual(ME_PROOF_REQUIRED);
    const { id } = await ownerBinding();
    const unbound = await withdraw(headers, id);
    expect(unbound.statusCode).toBe(403); expect(unbound.json()).toEqual(SHARED_PROOF_REQUIRED);
  });

  it("B2 a legacy wildcard key claiming the owner cannot bind or withdraw", async () => {
    const key = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const response = await bind(bearer(key.rawKey));
    expect(response.statusCode).toBe(403); expect(response.json()).toEqual(BIND_PROOF_REQUIRED);
    const { id } = await ownerBinding();
    const unbound = await withdraw(bearer(key.rawKey), id);
    expect(unbound.statusCode).toBe(403); expect(unbound.json()).toEqual(SHARED_PROOF_REQUIRED);
  });

  it("B3 the owner's SIWE session key binds and withdraws as owner", async () => {
    const { owner, id } = await ownerBinding();
    expect((await registry.readBinding(id))?.binding).toMatchObject({ identityStatus: "proven", boundBy: hash(OWNER.address.toLowerCase()) });
    const response = await withdraw(owner.headers, id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ bindingId: id, created: true });
    expect((await registry.readBinding(id))?.withdrawal).toMatchObject({ withdrawnAs: "owner", withdrawnBy: hash(OWNER.address.toLowerCase()) });
  });

  it("B4 bearer and cookie sessions without a key fail at the scope checker", async () => {
    const owner = await ownerCredentials();
    for (const headers of [owner.session, owner.cookie]) {
      const response = await bind(headers);
      expect(response.statusCode).toBe(403); expect(response.json().error).toBe("insufficient_scope");
      expect(response.json()).not.toHaveProperty("binding");
    }
  });

  it("B5 a real approved self-link reaches kit routes but cannot bind or withdraw", async () => {
    const key = provisionApiKey({ operatorId: OWNER.address.toLowerCase(), scopes: ["*"] });
    const headers = bearer(key.rawKey);
    expect((await me(headers)).statusCode).toBe(403);
    const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers,
      payload: { keyType: "secp256k1", address: OWNER.address, chainId: CHAIN, role: "agent", label: "k3-self-link" } });
    expect(created.statusCode).toBe(201);
    const link = created.json<{ requestId: string; userCode: string; message: string }>();
    const proof = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/proof`,
      payload: { signature: await OWNER.signMessage({ message: link.message }) } });
    expect(proof.statusCode).toBe(200);
    const approved = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${link.requestId}/approve`, headers,
      payload: { userCode: link.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
    expect(approved.statusCode).toBe(200);
    const linked = { ...headers, "x-pcc-wallet": OWNER.address };
    const projection = await me(linked);
    expect(projection.statusCode).toBe(200);
    expect(projection.json().principal).toEqual({ operatorId: OWNER.address.toLowerCase(), identityStatus: "proven" });
    const response = await bind(linked);
    expect(response.statusCode).toBe(403); expect(response.json()).toEqual(BIND_PROOF_REQUIRED);
    const { id } = await ownerBinding();
    const unbound = await withdraw(linked, id);
    expect(unbound.statusCode).toBe(403); expect(unbound.json()).toEqual(SHARED_PROOF_REQUIRED);
  });

  it("B6 admin key and secret withdraw as admin; binding still needs owner proof", async () => {
    const key = provisionApiKey({ operatorId: "k3-admin", scopes: ["admin"] });
    const admin = { ...bearer(key.rawKey), "x-admin-key": ADMIN };
    const denied = await bind(admin);
    expect(denied.statusCode).toBe(403); expect(denied.json()).toEqual(BIND_PROOF_REQUIRED);
    const owner = await ownerCredentials();
    const response = await bind({ ...owner.headers, "x-admin-key": ADMIN });
    expect(response.statusCode).toBe(201);
    const id = response.json().binding.bindingId;
    expect((await registry.readBinding(id))?.binding.boundBy).toBe(hash(OWNER.address.toLowerCase()));
    const secretOnly = await withdraw({ "x-admin-key": ADMIN }, id);
    expect(secretOnly.statusCode).toBe(401); expect(secretOnly.json().error).toBe("api_key_required");
    const unbound = await withdraw(admin, id);
    expect(unbound.statusCode).toBe(200);
    expect((await registry.readBinding(id))?.withdrawal).toMatchObject({ withdrawnAs: "admin", withdrawnBy: hash(`admin:key:${key.record!.id}`) });
    expect(unbound.json()).not.toHaveProperty("withdrawnBy");
  });

  it("B7 only a publishing key may fork", async () => {
    const owner = await ownerCredentials();
    const author = provisionApiKey({ operatorId: "author@example.test", scopes: ["template_author"] });
    const url = `/api/kits/${kitDigest}/fork`;
    const payload = { ...manifest, version: "1.0.1", parentKitDigest: kitDigest };
    const denied = await app.inject({ method: "POST", url, headers: owner.headers, payload });
    expect(denied.statusCode).toBe(403); expect(denied.json().error).toBe("insufficient_scope");
    const forked = await app.inject({ method: "POST", url, headers: bearer(author.rawKey), payload });
    expect(forked.statusCode).toBe(201);
    expect((await registry.get(forked.json().kitDigest))?.manifest.parentKitDigest).toBe(kitDigest);
  });

  it("B8 the specific withdraw rule beats the nested catch-all", async () => {
    const { owner, id } = await ownerBinding();
    expect((await withdraw(owner.headers, id)).statusCode).toBe(200);
  });

  it.each(["one segment", "nested"])("B8 closes the %s gap while allowing a template author", async kind => {
    const owner = await ownerCredentials();
    const author = provisionApiKey({ operatorId: "author@example.test", scopes: ["template_author"] });
    const url = kind === "one segment" ? "/api/kits/probe" : `/api/kits/${kitDigest}/anything`;
    const denied = await app.inject({ method: "POST", url, headers: owner.headers });
    expect(denied.statusCode).toBe(403); expect(denied.json().error).toBe("insufficient_scope");
    expect(denied.json()).not.toHaveProperty("reached");
    const allowed = await app.inject({ method: "POST", url, headers: bearer(author.rawKey) });
    expect(allowed.statusCode).toBe(200); expect(allowed.json()).toEqual({ reached: true });
  });

  it("B9 /me lists only the proven wallet's kernels and rejects a claimed-only key", async () => {
    seedKernel("foreign-kernel", FOREIGN.address); seedCapability("foreign-cap", "foreign-kernel");
    const foreign = await ownerCredentials(FOREIGN);
    expect((await bind(foreign.headers, "foreign-kernel", "foreign-cap")).statusCode).toBe(201);
    const { owner } = await ownerBinding();
    const response = await me(owner.headers);
    expect(response.statusCode).toBe(200);
    expect(OperatorBindingDTOSchema.safeParse(response.json()).success).toBe(true);
    expect(response.json().principal).toEqual({ operatorId: OWNER.address.toLowerCase(), identityStatus: "proven" });
    expect(response.json().bindings).toEqual([expect.objectContaining({ kind: "kernel", id: KERNEL, assuranceTierCap: 0 })]);
    expect(response.json().unmappedCapacity).toEqual([]);
    const denied = await me(await selfProvision());
    expect(denied.statusCode).toBe(403); expect(denied.json()).toEqual(ME_PROOF_REQUIRED);
  });

  it("B10 /me follows the real payout PUT, revoke and current ownership", async () => {
    const owner = await ownerCredentials();
    const put = () => app.inject({ method: "PUT", url: `/api/operator/payout/${KERNEL}`, headers: owner.headers,
      payload: { chainId: CHAIN, consentVersion: PAYOUT_CONSENT_VERSION, consentSha256: PAYOUT_CONSENT_SHA256 } });
    expect((await me(owner.headers)).json().payee).toBeNull();
    expect((await put()).statusCode).toBe(200);
    const response = await me(owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().payee).toEqual({ kind: "wallet", maskedDestination: maskPayoutDestination(OWNER.address.toLowerCase()), source: "payout_record", verified: true });
    const revoked = await app.inject({ method: "POST", url: `/api/operator/payout/${KERNEL}/revoke`,
      headers: owner.headers, payload: { chainId: CHAIN } });
    expect(revoked.statusCode).toBe(200);
    expect((await me(owner.headers)).json().payee).toBeNull();
    expect((await put()).statusCode).toBe(200);
    expect((await me(owner.headers)).json().payee).not.toBeNull();
    getRepos().kernels.update(KERNEL, { operatorAddress: FOREIGN.address });
    expect((await me(owner.headers)).json().payee).toBeNull();
    const foreign = await ownerCredentials(FOREIGN);
    expect((await me(foreign.headers)).json().payee).toBeNull();
  });

  it("B11 binding grants no capability claim rights", async () => {
    const { owner } = await ownerBinding();
    const response = await me(owner.headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().executionAuthority.canClaimCapabilityTypes).toEqual([]);
    expect(response.json().moneyAuthority).toBe("none");
  });

  it("B12 binding does not set a payout wallet or authorize money", async () => {
    const { owner } = await ownerBinding();
    expect(getStore().db.all(sql`SELECT * FROM kernel_payout_bindings`)).toEqual([]);
    const response = await app.inject({ method: "POST", url: "/api/escrow/probe", headers: owner.headers });
    expect(response.statusCode).toBe(403); expect(response.json().error).toBe("insufficient_scope");
    expect(response.json()).not.toHaveProperty("reached");
  });
});
