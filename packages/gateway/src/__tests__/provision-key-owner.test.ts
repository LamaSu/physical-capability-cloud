import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { provisionRoutes } from "../routes/provision.js";

vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: () => true,
  canSiweVerify: () => true,
}));

const ADDRESS = "0xAbCdEf0123456789012345678901234567890123";
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
const HOUR_MS = 3_600_000;
const ADMIN_SECRET = "key-owner-test-admin-secret";
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION", "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS", "PCC_ADMIN_KEY"]) {
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

async function buildApp(opts: {
  authenticatedKeyId?: string;
  provenWallet?: string;
} = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "provision-key-owner-cookie-secret" });
  if (opts.authenticatedKeyId) {
    app.addHook("onRequest", async (req) => {
      const key = getRepos().apiKeys.findById(opts.authenticatedKeyId!)!;
      req.apiKeyId = key.id;
      req.operatorId = key.operatorId;
      req.userId = key.operatorId as `0x${string}`;
    });
  } else {
    await app.register(apiGate);
    await app.register(sc.scopeChecker);
  }
  if (opts.provenWallet) {
    app.addHook("preHandler", async (req) => {
      (req as FastifyRequest & { provenWallet: string }).provenWallet = opts.provenWallet!;
    });
  }
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  await app.ready();
  return app;
}

function issueSession(address = ADDRESS, expiresAt = new Date(Date.now() + HOUR_MS).toISOString()) {
  const now = new Date().toISOString();
  return getRepos().sessions.insert({
    id: randomUUID(), walletAddress: address, token: randomUUID(), createdAt: now,
    expiresAt, lastActiveAt: now,
  })!;
}

function insertKey(operatorId = ADDRESS, opts: {
  expiresAt?: string;
  metadata?: Record<string, unknown>;
} = {}) {
  const key = provisionApiKey({ operatorId, ...opts });
  return { rawKey: key.rawKey, row: key.record! };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

function sessionHeaders(app: FastifyInstance, token: string, path: "cookie" | "bearer") {
  return path === "cookie" ? { cookie: `pcc_session=${app.signCookie(token)}` } : bearer(token);
}

async function provision(app: FastifyInstance, walletAddress = ADDRESS) {
  const response = await app.inject({
    method: "POST", url: "/api/auth/provision", payload: { walletAddress },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ api_key: string; key_id: string; operator_id: string }>();
}

async function mint(app: FastifyInstance, token: string, path: "cookie" | "bearer" = "bearer") {
  const response = await app.inject({
    method: "POST", url: "/api/auth/session-key", headers: sessionHeaders(app, token, path),
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ api_key: string; key_id: string }>();
}

async function expectKeys(app: FastifyInstance, headers: Record<string, string>, ids: string[]) {
  const response = await app.inject({ method: "GET", url: "/api/auth/keys", headers });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ keys: Array<{ id: string }> }>();
  expect(Object.keys(body)).toEqual(["keys"]);
  expect(body.keys.map((key) => key.id).sort()).toEqual([...ids].sort());
  return response;
}

function revoke(app: FastifyInstance, headers: Record<string, string>, id: string) {
  return app.inject({ method: "DELETE", url: `/api/auth/keys/${id}`, headers });
}

describe("API key management requires a proven owner for other keys", () => {
  it("a stranger provisioned with another wallet address lists only its own key", async () => {
    const app = await buildApp();
    const victim = insertKey();
    const stranger = await provision(app);
    expect(stranger.operator_id).toBe(victim.row.operatorId);

    const response = await expectKeys(app, bearer(stranger.api_key), [stranger.key_id]);
    expect(response.json().keys).toEqual([expect.objectContaining({
      id: stranger.key_id, active: true, revoked_at: null,
    })]);
  });

  it("a stranger provisioned with another wallet address cannot revoke its key", async () => {
    const app = await buildApp();
    const victim = insertKey();
    const stranger = await provision(app);

    const response = await revoke(app, bearer(stranger.api_key), victim.row.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Key not found" });
    const row = getRepos().apiKeys.findById(victim.row.id)!;
    expect(row.revokedAt).toBeNull();
    expect(getRepos().apiKeys.findActiveByHash(row.keyHash)?.id).toBe(victim.row.id);
  });

  it("a key lists itself and self revocation retains the 200 and 409 responses", async () => {
    const caller = insertKey();
    const peer = insertKey();
    // A key may always list and revoke itself, including the already-revoked response.
    const app = await buildApp({ authenticatedKeyId: caller.row.id });
    const response = await expectKeys(app, bearer(caller.rawKey), [caller.row.id]);
    expect(response.json().keys[0]).toEqual({
      id: caller.row.id, prefix: caller.row.keyPrefix, name: caller.row.name,
      description: caller.row.description, scopes: JSON.parse(caller.row.scopes),
      rate_limit: caller.row.rateLimit, usage_count: Number(caller.row.usageCount),
      last_used_at: caller.row.lastUsedAt, created_at: caller.row.createdAt,
      expires_at: caller.row.expiresAt, revoked_at: null, active: true,
    });

    const first = await revoke(app, bearer(caller.rawKey), caller.row.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, key_id: caller.row.id, revoked_at: expect.any(String) });
    expect(getRepos().apiKeys.findById(caller.row.id)!.revokedAt).not.toBeNull();
    expect(getRepos().apiKeys.findById(peer.row.id)!.revokedAt).toBeNull();
    const second = await revoke(app, bearer(caller.rawKey), caller.row.id);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "Key already revoked" });
  });

  it.each(["cookie", "bearer"] as const)("a verified %s SIWE session lists all address keys and revokes another key", async (path) => {
    const app = await buildApp();
    const session = issueSession();
    const target = insertKey();
    const peer = insertKey();
    const other = insertKey(OTHER_ADDRESS);
    const headers = sessionHeaders(app, session.token, path);

    await expectKeys(app, headers, [target.row.id, peer.row.id]);
    expect((await revoke(app, headers, target.row.id)).statusCode).toBe(200);
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).not.toBeNull();
    expect(getRepos().apiKeys.findById(peer.row.id)!.revokedAt).toBeNull();
    expect(getRepos().apiKeys.findById(other.row.id)!.revokedAt).toBeNull();
  });

  it.each(["cookie", "bearer"] as const)("a session key minted from a %s session lists all address keys and revokes another key", async (path) => {
    const app = await buildApp();
    const session = issueSession();
    const target = insertKey();
    const peer = insertKey();
    const other = insertKey(OTHER_ADDRESS);
    const caller = await mint(app, session.token, path);
    const row = getRepos().apiKeys.findById(caller.key_id)!;
    expect(JSON.parse(row.metadata!)).toMatchObject({ source: "siwe-session", sessionId: session.id });
    expect(row.revokedAt).toBeNull();
    expect(new Date(row.expiresAt!).getTime()).toBeGreaterThan(Date.now());

    await expectKeys(app, bearer(caller.api_key), [target.row.id, peer.row.id, caller.key_id]);
    expect((await revoke(app, bearer(caller.api_key), target.row.id)).statusCode).toBe(200);
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).not.toBeNull();
    expect(getRepos().apiKeys.findById(peer.row.id)!.revokedAt).toBeNull();
    expect(getRepos().apiKeys.findById(other.row.id)!.revokedAt).toBeNull();
  });

  it("a request-level proven wallet is not owner proof for listing or revoking other keys", async () => {
    const caller = insertKey(OTHER_ADDRESS);
    const target = insertKey();
    const peer = insertKey();
    const app = await buildApp({ provenWallet: ADDRESS });

    await expectKeys(app, bearer(caller.rawKey), [caller.row.id]);
    const response = await revoke(app, bearer(caller.rawKey), target.row.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Key not found" });
    const row = getRepos().apiKeys.findById(target.row.id)!;
    expect(row.revokedAt).toBeNull();
    expect(getRepos().apiKeys.findActiveByHash(row.keyHash)?.id).toBe(target.row.id);
  });

  it("the admin secret allows an authenticated caller to revoke any address key", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN_SECRET);
    const app = await buildApp();
    const caller = insertKey(OTHER_ADDRESS);
    const target = insertKey();

    const response = await revoke(app, { ...bearer(caller.rawKey), "x-admin-key": ADMIN_SECRET }, target.row.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, key_id: target.row.id });
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).not.toBeNull();
  });

  it("the admin secret allows listing other keys of the caller address", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN_SECRET);
    const app = await buildApp();
    const caller = insertKey();
    const peer = insertKey();
    insertKey(OTHER_ADDRESS);

    await expectKeys(app, { ...bearer(caller.rawKey), "x-admin-key": ADMIN_SECRET }, [caller.row.id, peer.row.id]);
  });

  it("an incorrect admin secret does not authorize another key", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", ADMIN_SECRET);
    const app = await buildApp();
    const caller = insertKey();
    const target = insertKey();
    const headers = { ...bearer(caller.rawKey), "x-admin-key": "incorrect-secret" };

    await expectKeys(app, headers, [caller.row.id]);
    const response = await revoke(app, headers, target.row.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Key not found" });
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).toBeNull();
  });

  it.each(["session", "session-key"] as const)("a proven %s address matches operator ids with different hex case", async (kind) => {
    const app = await buildApp();
    const session = issueSession(ADDRESS.toLowerCase());
    const target = insertKey(ADDRESS);
    const lower = insertKey(ADDRESS.toLowerCase());
    const caller = kind === "session-key" ? await mint(app, session.token) : null;
    const headers = bearer(caller?.api_key ?? session.token);

    await expectKeys(app, headers, [target.row.id, lower.row.id, ...(caller ? [caller.key_id] : [])]);
    expect((await revoke(app, headers, target.row.id)).statusCode).toBe(200);
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).not.toBeNull();
  });

  it.each(["unsigned", "tampered", "expired"] as const)("a %s session cookie does not authorize another key", async (kind) => {
    const app = await buildApp();
    const session = issueSession(ADDRESS, kind === "expired"
      ? new Date(Date.now() - HOUR_MS).toISOString() : undefined);
    const caller = insertKey();
    const target = insertKey();
    const cookieValue = kind === "unsigned" ? session.token
      : kind === "tampered" ? `${app.signCookie(session.token)}tampered` : app.signCookie(session.token);
    const headers = { ...bearer(caller.rawKey), cookie: `pcc_session=${cookieValue}` };

    await expectKeys(app, headers, [caller.row.id]);
    const response = await revoke(app, headers, target.row.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Key not found" });
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).toBeNull();
  });

  it.each(["expired", "revoked", "invalid-expiry"] as const)("an authenticated %s session key cannot prove ownership of another key", async (state) => {
    const caller = insertKey(ADDRESS, {
      expiresAt: state === "invalid-expiry" ? "invalid-date"
        : new Date(Date.now() + (state === "expired" ? -HOUR_MS : HOUR_MS)).toISOString(),
      metadata: { source: "siwe-session", sessionId: randomUUID() },
    });
    const target = insertKey();
    if (state === "revoked") getRepos().apiKeys.revoke(caller.row.id);
    const app = await buildApp({ authenticatedKeyId: caller.row.id });

    await expectKeys(app, bearer(caller.rawKey), [caller.row.id]);
    const response = await revoke(app, bearer(caller.rawKey), target.row.id);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Key not found" });
    expect(getRepos().apiKeys.findById(target.row.id)!.revokedAt).toBeNull();
  });
});
