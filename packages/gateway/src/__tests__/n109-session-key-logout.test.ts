import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { generateApiKey, provisionApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { provisionRoutes } from "../routes/provision.js";

const ADDRESS = "0xAbCdEf0123456789012345678901234567890123";
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY", "PCC_WILDCARD_KEY_MIGRATION", "PCC_WILDCARD_KEY_KEEP_IDS", "PCC_WILDCARD_KEY_REVOKE_IDS"]) {
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

async function buildApp() {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "n109-session-key-logout-cookie-secret" });
  await app.register(apiGate);
  await app.register(sc.scopeChecker);
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  // As in session-key.test.ts, exercise the real auth/scope gates with a minimal handler.
  app.post("/api/kernels/register", async () => ({ reached: true }));
  await app.ready();
  return app;
}

function issueSession(address = ADDRESS) {
  const now = new Date().toISOString();
  return getRepos().sessions.insert({
    id: randomUUID(), walletAddress: address, token: randomUUID(), createdAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), lastActiveAt: now,
  })!;
}

function insertKey(operatorId: string, metadata: string | null, revoked = false) {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  const row = getRepos().apiKeys.insert({
    id: randomUUID(), keyHash, keyPrefix, operatorId,
    scopes: JSON.stringify(sc.SELF_SERVICE_KEY_SCOPES), rateLimit: "1000/hour", usageCount: "0",
    createdAt: new Date().toISOString(), metadata,
    revokedAt: revoked ? "2026-01-01T00:00:00.000Z" : null,
  })!;
  return { rawKey, row };
}

function sessionHeaders(app: FastifyInstance, token: string, path: "cookie" | "bearer") {
  return path === "cookie"
    ? { cookie: `pcc_session=${app.signCookie(token)}` }
    : { authorization: `Bearer ${token}` };
}

async function mint(app: FastifyInstance, token: string, path: "cookie" | "bearer" = "bearer") {
  const response = await app.inject({
    method: "POST", url: "/api/auth/session-key", headers: sessionHeaders(app, token, path),
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ api_key: string; key_id: string }>();
}

function validate(app: FastifyInstance, rawKey: string) {
  return app.inject({ method: "GET", url: "/api/auth/validate", headers: { authorization: `Bearer ${rawKey}` } });
}

function register(app: FastifyInstance, rawKey: string) {
  return app.inject({ method: "POST", url: "/api/kernels/register", headers: { authorization: `Bearer ${rawKey}` } });
}

describe("N109 session keys end at logout", () => {
  it.each(["cookie", "bearer"] as const)("%s logout revokes its key and refuses validation and a previously reached scoped route", async (path) => {
    const app = await buildApp();
    const session = issueSession();
    const key = await mint(app, session.token, path);
    expect((await validate(app, key.api_key)).statusCode).toBe(200);
    expect((await register(app, key.api_key)).json()).toEqual({ reached: true });

    const logout = await app.inject({
      method: "POST", url: "/api/auth/logout", headers: sessionHeaders(app, session.token, path),
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ ok: true });
    expect(logout.headers["set-cookie"]).toContain("pcc_session=;");
    expect(getRepos().sessions.findByToken(session.token)).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: sessionHeaders(app, session.token, path) })).statusCode).toBe(401);
    expect((await validate(app, key.api_key)).statusCode).toBe(401);
    expect((await register(app, key.api_key)).statusCode).toBe(401);
    expect(getRepos().apiKeys.findById(key.key_id)!.revokedAt).not.toBeNull();
  });

  it("revokes both deleted sessions when cookie and bearer identify different sessions", async () => {
    const app = await buildApp();
    const cookieSession = issueSession();
    const bearerSession = issueSession(OTHER_ADDRESS);
    const cookieKey = await mint(app, cookieSession.token);
    const bearerKey = await mint(app, bearerSession.token);
    const response = await app.inject({
      method: "POST", url: "/api/auth/logout", headers: {
        cookie: `pcc_session=${app.signCookie(cookieSession.token)}`,
        authorization: `Bearer ${bearerSession.token}`,
      },
    });
    expect(response.statusCode).toBe(200);
    for (const [session, key] of [[cookieSession, cookieKey], [bearerSession, bearerKey]] as const) {
      expect(getRepos().sessions.findByToken(session.token)).toBeUndefined();
      expect((await validate(app, key.api_key)).statusCode).toBe(401);
    }
  });

  it("revokes all of its own live keys and preserves other sessions, provisioned keys and nonmatching metadata", async () => {
    const app = await buildApp();
    const session = issueSession();
    const otherSession = issueSession();
    const ownKey = await mint(app, session.token);
    const otherKey = await mint(app, otherSession.token);
    const provisioned = provisionApiKey({ operatorId: ADDRESS, metadata: { source: "landing-page" } });
    const metadata = JSON.stringify({ source: "siwe-session", sessionId: session.id });
    const extraOwn = insertKey(ADDRESS, metadata);
    const survivors = [
      getRepos().apiKeys.findById(otherKey.key_id)!, provisioned.record!,
      insertKey(OTHER_ADDRESS, metadata).row,
      insertKey(ADDRESS, JSON.stringify({ source: "landing-page", sessionId: session.id })).row,
      insertKey(ADDRESS, JSON.stringify({ source: "siwe-session", sessionId: "different-session" })).row,
      insertKey(ADDRESS, JSON.stringify({ source: "siwe-session" })).row,
      insertKey(ADDRESS, "{malformed").row,
      insertKey(ADDRESS, "null").row,
      insertKey(ADDRESS, null).row,
      insertKey(ADDRESS, metadata, true).row,
    ];
    const response = await app.inject({
      method: "POST", url: "/api/auth/logout", headers: sessionHeaders(app, session.token, "cookie"),
    });
    expect(response.statusCode).toBe(200);
    for (const id of [ownKey.key_id, extraOwn.row.id]) {
      expect(getRepos().apiKeys.findById(id)!.revokedAt).not.toBeNull();
    }
    for (const row of survivors) expect(getRepos().apiKeys.findById(row.id)).toEqual(row);
    expect(getRepos().sessions.findByToken(otherSession.token)).toEqual(otherSession);
    expect((await validate(app, otherKey.api_key)).statusCode).toBe(200);
    expect((await register(app, otherKey.api_key)).statusCode).toBe(200);
    expect((await validate(app, provisioned.rawKey)).statusCode).toBe(200);
  });

  it.each(["no-session", "invalid-signature", "unsigned-cookie"] as const)("%s logout leaves session keys untouched", async (path) => {
    const app = await buildApp();
    const session = issueSession();
    const key = await mint(app, session.token);
    const caller = provisionApiKey({ operatorId: OTHER_ADDRESS });
    const cookieValue = path === "invalid-signature"
      ? `${app.signCookie(session.token)}tampered`
      : path === "unsigned-cookie" ? session.token : undefined;
    const before = getRepos().apiKeys.findById(key.key_id)!;
    const response = await app.inject({
      method: "POST", url: "/api/auth/logout", headers: {
        authorization: `Bearer ${caller.rawKey}`,
        ...(cookieValue ? { cookie: `pcc_session=${cookieValue}` } : {}),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(getRepos().sessions.findByToken(session.token)).toEqual(session);
    expect(getRepos().apiKeys.findById(key.key_id)).toEqual(before);
    expect((await validate(app, key.api_key)).statusCode).toBe(200);
  });

  it("anonymous logout is refused without revoking any key", async () => {
    const app = await buildApp();
    const session = issueSession();
    const key = await mint(app, session.token);
    const before = getRepos().apiKeys.findById(key.key_id)!;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(401);
    expect(getRepos().sessions.findByToken(session.token)).toEqual(session);
    expect(getRepos().apiKeys.findById(key.key_id)).toEqual(before);
  });

  it("a failed session deletion rolls back key revocation", async () => {
    const app = await buildApp();
    const session = issueSession();
    const key = await mint(app, session.token);
    const before = getRepos().apiKeys.findById(key.key_id)!;
    vi.spyOn(getRepos().sessions, "deleteByToken").mockImplementation(() => { throw new Error("fixture deletion failure"); });
    const response = await app.inject({
      method: "POST", url: "/api/auth/logout", headers: sessionHeaders(app, session.token, "bearer"),
    });
    expect(response.statusCode).toBe(500);
    expect(getRepos().sessions.findByToken(session.token)).toEqual(session);
    expect(getRepos().apiKeys.findById(key.key_id)).toEqual(before);
  });
});
