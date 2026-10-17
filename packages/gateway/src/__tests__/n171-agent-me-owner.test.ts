import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { schema } from "@pcc/store";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { agentIntrospectionRoutes } from "../routes/agent-introspection.js";
import { provisionRoutes } from "../routes/provision.js";
import { walletsRoutes } from "../routes/wallets.js";
import { CONSENT_SHA256 } from "../services/wallet-links/consent.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true,
  canSiweVerify: () => true,
}));

const OTHER = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN = "n171-agent-me-owner-admin";
const HOUR_MS = 3_600_000;
const KERNEL = "kernel-n171-owner";
const JOB = "job-n171-owner";
const DEVICE = "device-n171-owner";
const OTHER_KERNEL = "kernel-n171-other";
const OTHER_JOB = "job-n171-other";
const REASON = "requires owner proof (SIWE sign-in, a session key, or a linked wallet)";
let wallet: ReturnType<typeof privateKeyToAccount>;
let owner: string;
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("DATABASE_URL", ":memory:");
  vi.stubEnv("PCC_ADMIN_KEY", ADMIN);
  vi.stubEnv("PCC_PUBLIC_URL", "https://capability.network");
  vi.stubEnv("NODE_ENV", "staging");
  for (const name of ["RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
    vi.stubEnv(name, "");
    delete process.env[name];
  }
  closeStore();
  const { repos } = initStore({ seed: true });
  do {
    wallet = privateKeyToAccount(generatePrivateKey());
  } while (wallet.address === wallet.address.toLowerCase());
  owner = wallet.address.toLowerCase();
  const kernel = repos.kernels.findAll()[0]!;
  const job = repos.jobs.findAll()[0]!;
  const device = repos.kernels.findDevicesByKernel(kernel.id)[0]!;
  repos.kernels.insert({ ...kernel, id: KERNEL, name: "N171 owner site", operatorAddress: wallet.address });
  repos.kernels.insert({ ...kernel, id: OTHER_KERNEL, operatorAddress: OTHER });
  repos.jobs.insert({ ...job, id: JOB, kernelId: KERNEL, status: "in_progress", progress: 37, evidenceBundleId: null });
  repos.jobs.insert({ ...job, id: `${JOB}-completed`, kernelId: KERNEL, status: "completed", progress: 100, evidenceBundleId: null });
  repos.jobs.insert({ ...job, id: OTHER_JOB, kernelId: OTHER_KERNEL, status: "queued", progress: 12, evidenceBundleId: null });
  repos.kernels.insertDevice({ ...device, id: DEVICE, kernelId: KERNEL });
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.close();
  vi.restoreAllMocks();
  closeStore();
  vi.unstubAllEnvs();
});

async function buildApp(proof?: { wallet: string | null; via?: string | null }) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "n171-agent-me-cookie-secret" });
  await app.register(apiGate);
  if (proof) {
    // Model another trusted server hook, never client-supplied proof headers.
    app.addHook("preHandler", async req => {
      req.provenWallet = proof.wallet;
      req.provenWalletVia = proof.via;
    });
  }
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  // Preserve production sibling semantics: W1b's hook must reach earlier routes.
  await app.register(agentIntrospectionRoutes);
  await app.register(walletsRoutes);
  await app.ready();
  return app;
}

function key(operatorId = owner, opts: { scopes?: string[]; expiresAt?: string; metadata?: Record<string, unknown> } = {}) {
  const credential = provisionApiKey({ operatorId, name: "N171 caller", ...opts });
  return { raw: credential.rawKey, row: credential.record! };
}

function session(address = owner, expiresAt = new Date(Date.now() + HOUR_MS).toISOString()) {
  const now = new Date().toISOString();
  return getRepos().sessions.insert({
    id: randomUUID(), token: randomUUID(), walletAddress: address,
    createdAt: now, lastActiveAt: now, expiresAt,
  })!;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function me(app: FastifyInstance, headers: Record<string, string>) {
  const response = await app.inject({ method: "GET", url: "/api/agent/me", headers });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function expectWithheld(body: Awaited<ReturnType<typeof me>>) {
  expect(body).toMatchObject({
    ok: true,
    kernels: { count: null, items: [], unavailable: REASON },
    devices: { count: null, unavailable: REASON },
    work: { in_flight: null, items: [], unavailable: REASON },
    keys: { active: null, wildcard_keys: null, unavailable: REASON },
    next: [REASON],
  });
  for (const privateValue of [KERNEL, JOB, DEVICE, OTHER_KERNEL, OTHER_JOB, "N171 owner site"]) {
    expect(JSON.stringify(body)).not.toContain(privateValue);
  }
}

function expectOwner(body: Awaited<ReturnType<typeof me>>, activeKeys: number) {
  expect(body.identity.operator).toBe(owner);
  expect(body.kernels).toEqual({ count: 1, items: [expect.objectContaining({ id: KERNEL, name: "N171 owner site" })] });
  expect(body.devices).toEqual({ count: 1 });
  expect(body.work).toEqual({ in_flight: 1, items: [{ id: JOB, kernel_id: KERNEL, status: "in_progress", progress: 37, held: false }] });
  expect(body.keys.active).toBe(activeKeys);
  expect(body.keys).not.toHaveProperty("unavailable");
  expect(body.next).toEqual(["1 job(s) in flight — GET /api/jobs/{jobId} for detail."]);
  expect(JSON.stringify(body)).not.toContain(OTHER_KERNEL);
  expect(JSON.stringify(body)).not.toContain(OTHER_JOB);
}

async function selfLink(app: FastifyInstance, rawKey: string) {
  const created = await app.inject({ method: "POST", url: "/api/wallets/link-requests", headers: bearer(rawKey),
    payload: { keyType: "secp256k1", address: owner, chainId: 84532, role: "agent", label: "n171-agent-me" } });
  expect(created.statusCode).toBe(201);
  const request = created.json<{ requestId: string; userCode: string; message: string }>();
  const signature = await wallet.signMessage({ message: request.message });
  const proof = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/proof`, payload: { signature } });
  expect(proof.statusCode).toBe(200);
  const approved = await app.inject({ method: "POST", url: `/api/wallets/link-requests/${request.requestId}/approve`, headers: bearer(rawKey),
    payload: { userCode: request.userCode, decision: "approve", consentSha256: CONSENT_SHA256 } });
  expect(approved.statusCode).toBe(200);
}

describe("N171 /api/agent/me scopes operator sections to a proven owner", () => {
  it("a key without owner proof gets operator sections withheld", async () => {
    const app = await buildApp();
    key(); // A real owner key exists as well as its site, device and jobs.
    const issued = await app.inject({ method: "POST", url: "/api/auth/provision", payload: { walletAddress: owner } });
    expect(issued.statusCode).toBe(201);
    const caller = issued.json<{ api_key: string; key_id: string; operator_id: string; scopes: string[] }>();
    expect(caller.operator_id).toBe(owner);
    const body = await me(app, bearer(caller.api_key));
    expectWithheld(body);
    expect(body.identity).toEqual({ operator: owner, key_id: caller.key_id, key_name: null, scopes: caller.scopes });
  });

  it("does not perform any operator-scoped reads for an unproven key", async () => {
    const app = await buildApp();
    const caller = key();
    const repos = getRepos();
    const reads = [
      vi.spyOn(repos.kernels, "findAll"), vi.spyOn(repos.jobs, "findByKernel"),
      vi.spyOn(repos.kernels, "findDevicesByKernel"), vi.spyOn(repos.apiKeys, "findByOperator"),
      vi.spyOn(repos.apiKeys, "listActive"),
    ];
    // Authentication reads one key with .get(); operator key counts use .all().
    const keyEnumeration = vi.fn();
    const db = getStore().db;
    const select = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation((...args) => {
      const builder = select(...args);
      const from = builder.from.bind(builder);
      vi.spyOn(builder, "from").mockImplementation(table => {
        const query = from(table);
        if (table === schema.apiKeys) {
          const all = query.all.bind(query);
          vi.spyOn(query, "all").mockImplementation((...placeholders) => {
            keyEnumeration();
            return all(...placeholders);
          });
        }
        return query;
      });
      return builder;
    });
    expectWithheld(await me(app, bearer(caller.raw)));
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(keyEnumeration).not.toHaveBeenCalled();
  });

  it("a matching signed SIWE cookie provides owner proof", async () => {
    const app = await buildApp();
    const caller = key();
    const signedIn = session();
    const body = await me(app, { ...bearer(caller.raw), cookie: `pcc_session=${app.signCookie(signedIn.token)}` });
    expectOwner(body, 1);
    expect(body.identity.key_id).toBe(caller.row.id);
  });

  it("a nonmatching signed SIWE cookie leaves operator sections withheld", async () => {
    const app = await buildApp();
    const caller = key(OTHER);
    key();
    const signedIn = session();
    const body = await me(app, { ...bearer(caller.raw), cookie: `pcc_session=${app.signCookie(signedIn.token)}` });
    expectWithheld(body);
    expect(body.identity.operator).toBe(OTHER);
    expect(body.identity.key_id).toBe(caller.row.id);
  });

  it("a bearer SIWE session can read its owner sections without an API key", async () => {
    const app = await buildApp();
    key();
    const body = await me(app, bearer(session().token));
    expectOwner(body, 1);
    expect(body.identity).toEqual({ operator: owner, key_id: null, key_name: null, scopes: [] });
  });

  it("a session key minted by SIWE proves ownership", async () => {
    const app = await buildApp();
    key();
    const signedIn = session();
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(signedIn.token) });
    expect(minted.statusCode).toBe(201);
    const credential = minted.json<{ api_key: string; key_id: string }>();
    const stored = getRepos().apiKeys.findById(credential.key_id)!;
    expect(JSON.parse(stored.metadata!)).toMatchObject({ source: "siwe-session", sessionId: signedIn.id });
    expectOwner(await me(app, bearer(credential.api_key)), 2);
  });

  it("a session key retains its owner sections with a nonmatching cookie", async () => {
    const app = await buildApp();
    key();
    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: bearer(session().token) });
    expect(minted.statusCode).toBe(201);
    const credential = minted.json<{ api_key: string; key_id: string }>();
    const body = await me(app, { ...bearer(credential.api_key),
      cookie: `pcc_session=${app.signCookie(session(OTHER).token)}` });
    expectOwner(body, 2);
    expect(body.identity.key_id).toBe(credential.key_id);
  });

  it("a W1b agent self-link scopes to the linked wallet rather than the key's claim", async () => {
    const app = await buildApp();
    const caller = key(OTHER);
    key();
    await selfLink(app, caller.raw);
    expectOwner(await me(app, { ...bearer(caller.raw), "x-pcc-wallet": wallet.address }), 1);
    // The link alone grants nothing without selecting the proven wallet.
    expectWithheld(await me(app, bearer(caller.raw)));
  });

  it("accepts the explicitly allowed request proof provenance siwe-session", async () => {
    const app = await buildApp({ wallet: owner, via: "siwe-session" });
    const caller = key(OTHER);
    key();
    expectOwner(await me(app, bearer(caller.raw)), 1);
  });

  it("the gateway admin secret may read the key's claimed operator sections", async () => {
    const app = await buildApp();
    const caller = key(wallet.address);
    expectOwner(await me(app, { ...bearer(caller.raw), "x-admin-key": ADMIN }), 1);
    expectWithheld(await me(app, { ...bearer(caller.raw), "x-admin-key": "wrong-secret" }));
  });

  it("owner proof takes precedence over an admin key and a differing claimed operator", async () => {
    const app = await buildApp({ wallet: owner, via: "self-link:agent" });
    const caller = key(OTHER);
    key();
    expectOwner(await me(app, { ...bearer(caller.raw), "x-admin-key": ADMIN }), 1);
  });

  it.each(["", ZERO])("an unowned wallet provides no owner proof (%j)", async address => {
    const app = await buildApp({ wallet: address, via: "self-link:agent" });
    const repos = getRepos();
    repos.kernels.insert({ ...repos.kernels.findAll()[0]!, id: "kernel-n171-unowned", operatorAddress: ZERO });
    repos.jobs.insert({ ...repos.jobs.findAll()[0]!, id: "job-n171-unowned", kernelId: "kernel-n171-unowned",
      status: "in_progress", evidenceBundleId: null });
    const body = await me(app, bearer(key(ZERO).raw));
    expectWithheld(body);
    expect(JSON.stringify(body)).not.toContain("kernel-n171-unowned");
    expect(JSON.stringify(body)).not.toContain("job-n171-unowned");
  });

  it("the admin view excludes unowned kernels and their jobs", async () => {
    const app = await buildApp();
    const repos = getRepos();
    repos.kernels.insert({ ...repos.kernels.findAll()[0]!, id: "kernel-n171-unowned", operatorAddress: ZERO });
    repos.jobs.insert({ ...repos.jobs.findAll()[0]!, id: "job-n171-unowned", kernelId: "kernel-n171-unowned",
      status: "in_progress", evidenceBundleId: null });
    const caller = key(ZERO);
    const body = await me(app, { ...bearer(caller.raw), "x-admin-key": ADMIN });
    expect(body.identity.operator).toBe(ZERO);
    expect(body.kernels).toEqual({ count: 0, items: [] });
    expect(body.devices).toEqual({ count: 0 });
    expect(body.work).toEqual({ in_flight: 0, items: [] });
    expect(body.keys.active).toBe(1);
    expect(body.keys).not.toHaveProperty("unavailable");
    expect(JSON.stringify(body)).not.toContain("kernel-n171-unowned");
    expect(JSON.stringify(body)).not.toContain("job-n171-unowned");
  });

  it.each(["admin-mint", "self-link:device", "SIWE-session", "", undefined, null])(
    "default-denies request-level wallet provenance %s", async via => {
      const app = await buildApp({ wallet: owner, via });
      const caller = key();
      expectWithheld(await me(app, bearer(caller.raw)));
    },
  );

  it("an allowed provenance without a proven wallet grants no owner access", async () => {
    const app = await buildApp({ wallet: null, via: "self-link:agent" });
    const caller = key();
    expectWithheld(await me(app, bearer(caller.raw)));
  });

  it.each(["unsigned", "tampered", "expired"] as const)("a %s SIWE cookie grants no owner access", async kind => {
    const app = await buildApp();
    const caller = key();
    const signedIn = session(owner, kind === "expired" ? new Date(Date.now() - HOUR_MS).toISOString() : undefined);
    const value = kind === "unsigned" ? signedIn.token
      : `${app.signCookie(signedIn.token)}${kind === "tampered" ? "tampered" : ""}`;
    expectWithheld(await me(app, { ...bearer(caller.raw), cookie: `pcc_session=${value}` }));
  });

  it("a malformed session-key expiry cannot prove ownership", async () => {
    const app = await buildApp();
    const caller = key(owner, { expiresAt: "invalid-date", metadata: { source: "siwe-session" } });
    expectWithheld(await me(app, bearer(caller.raw)));
  });

  it("active and wildcard counts exclude revoked, expired and malformed-expiry keys", async () => {
    const app = await buildApp();
    key(owner, { scopes: ["operator.read"] });
    key(wallet.address, { scopes: ["*"] });
    const revoked = key(owner, { scopes: ["*"] });
    getRepos().apiKeys.revoke(revoked.row.id);
    key(owner, { scopes: ["*"], expiresAt: new Date(Date.now() - HOUR_MS).toISOString() });
    key(owner, { scopes: ["*"], expiresAt: "invalid-date" });
    const body = await me(app, bearer(session().token));
    expectOwner(body, 2);
    expect(body.keys).toEqual({ active: 2, wildcard_keys: 1 });
  });
});
