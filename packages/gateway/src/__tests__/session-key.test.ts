import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { eq, schema, sql } from "@pcc/store";
import { generateApiKey, provisionApiKey } from "../auth/api-key-auth.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { provisionRoutes } from "../routes/provision.js";
import { auditService } from "../services/audit-service.js";
import * as identity from "../services/erc8004-identity-write.js";
import { SCOPE_COVERED_ROUTES, UNSCOPED_ROUTES } from "./helpers/scope-covered-routes.js";

const ADDRESS = "0xAbCdEf0123456789012345678901234567890123";
const HOUR_MS = 3_600_000;
let apps: FastifyInstance[];

beforeEach(() => {
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  for (const name of ["DATABASE_URL", "RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
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
  vi.useRealTimers();
  closeStore();
  sc.__resetScopeCacheForTests();
  vi.unstubAllEnvs();
});

async function buildApp(beforeHandler?: () => void) {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "session-key-test-cookie-secret" });
  await app.register(apiGate);
  await app.register(sc.scopeChecker);
  if (beforeHandler) app.addHook("preHandler", async () => beforeHandler());
  await app.register(siweAuthPlugin);
  await app.register(provisionRoutes);
  for (const route of [...SCOPE_COVERED_ROUTES, ...UNSCOPED_ROUTES]) {
    app.route({ method: route.method, url: route.path, handler: async () => ({ reached: true }) });
  }
  await app.ready();
  return app;
}

function issueSession(hours = 1, address = ADDRESS) {
  const now = Date.now();
  return getRepos().sessions.insert({
    id: randomUUID(), walletAddress: address, token: randomUUID(),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * HOUR_MS).toISOString(),
    lastActiveAt: new Date(now).toISOString(),
  })!;
}

function insertKey(opts: { operatorId?: string; expiresAt?: string; metadata?: Record<string, unknown> } = {}) {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  const record = getRepos().apiKeys.insert({
    id: randomUUID(), keyHash, keyPrefix, operatorId: opts.operatorId ?? ADDRESS,
    name: "session key invariant fixture", description: null, scopes: JSON.stringify(sc.SELF_SERVICE_KEY_SCOPES),
    rateLimit: "1000/hour", usageCount: "0", createdAt: new Date().toISOString(),
    expiresAt: opts.expiresAt ?? new Date(Date.now() + HOUR_MS).toISOString(),
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
  })!;
  return { rawKey, record };
}

function mint(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST", url: "/api/auth/session-key", headers: { authorization: `Bearer ${token}` },
  });
}

function validate(app: FastifyInstance, rawKey: string) {
  return app.inject({
    method: "GET", url: "/api/auth/validate", headers: { authorization: `Bearer ${rawKey}` },
  });
}

function assertResponseKeys(value: unknown) {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/private|ed25519|wallet/i);
    assertResponseKeys(child);
  }
}

describe("session keys are bound to the session address and self-service scope set", () => {
  it("an anonymous request is refused by apiGate before minting", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/session-key" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("api_key_required");
    expect(getRepos().apiKeys.findByOperator(ADDRESS)).toEqual([]);
  });

  it.each([false, true])("an API key cannot mint a session key with a signed session cookie present: %s", async (withCookie) => {
    const app = await buildApp();
    const session = issueSession();
    const { rawKey, record } = insertKey();
    const response = await app.inject({
      method: "POST", url: "/api/auth/session-key",
      headers: {
        authorization: `Bearer ${rawKey}`,
        ...(withCookie ? { cookie: `pcc_session=${app.signCookie(session.token)}` } : {}),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "session_required", message: "A SIWE session is required to mint a session key" });
    expect(getRepos().apiKeys.findByOperator(ADDRESS).map((key) => key.id)).toEqual([record.id]);
  });

  it("an expired session is refused before minting", async () => {
    const app = await buildApp();
    const response = await mint(app, issueSession(-1).token);
    expect(response.statusCode).toBe(401);
    expect(getRepos().apiKeys.findByOperator(ADDRESS)).toEqual([]);
  });

  it.each(["missing", "expired"] as const)("a session row that becomes %s after apiGate is refused with a closed code", async (state) => {
    const session = issueSession();
    const app = await buildApp(() => {
      if (state === "missing") getRepos().sessions.deleteByToken(session.token);
      else getStore().db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1).toISOString() })
        .where(eq(schema.sessions.id, session.id)).run();
    });
    const response = await mint(app, session.token);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "session_required", message: "A valid SIWE session is required to mint a session key" });
    expect(getRepos().apiKeys.findByOperator(ADDRESS)).toEqual([]);
  });

  it("a fresh session mints exactly the self-service scopes without wallet or identity writes", async () => {
    const app = await buildApp();
    const session = issueSession();
    const register = vi.spyOn(identity, "registerAgentOnChain");
    const audit = vi.spyOn(auditService, "log");
    const mintStart = Date.now();
    const response = await app.inject({
      method: "POST", url: "/api/auth/session-key",
      headers: { cookie: `pcc_session=${app.signCookie(session.token)}`, authorization: `Bearer ${session.token}` },
      payload: { operatorId: "unrelated", scopes: ["*"], expiresInDays: 30 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["api_key", "created_at", "expires_at", "key_id", "operator_id", "scopes"]);
    assertResponseKeys(body);
    expect(body.api_key).toMatch(/^pcc_live_/);
    expect(body.scopes).toEqual(sc.SELF_SERVICE_KEY_SCOPES);
    expect(body.operator_id).toBe(session.walletAddress);
    expect(body.expires_at).toBe(session.expiresAt);
    expect(Date.parse(body.expires_at)).toBeLessThanOrEqual(mintStart + 12 * HOUR_MS);
    const row = getRepos().apiKeys.findById(body.key_id)!;
    expect(row.operatorId).toBe(session.walletAddress);
    expect(JSON.parse(row.scopes)).toEqual(sc.SELF_SERVICE_KEY_SCOPES);
    expect(row.expiresAt).toBe(body.expires_at);
    expect(row.createdAt).toBe(body.created_at);
    expect(row.operatorWalletAddress).toBeNull();
    const walletPrivateKey = getStore().db.get<{ v: string | null }>(
      sql`SELECT operator_wallet_private_key AS v FROM api_keys WHERE id = ${row.id}`,
    )!;
    expect(walletPrivateKey.v).toBeNull();
    expect(row.operatorWalletCustody).toBeNull();
    expect(getRepos().apiKeys.listPendingOnchain().map((key) => key.id)).not.toContain(row.id);
    expect(JSON.parse(row.metadata!)).toEqual({
      source: "siwe-session", sessionId: session.id, provisionedAt: expect.any(String),
    });
    expect(JSON.stringify(row)).not.toContain(session.token);
    expect(register).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      eventType: "auth.session_key_minted", actor: session.walletAddress,
      resourceId: body.key_id, metadata: { expires_at: body.expires_at },
    });
    expect(auditService.query({ actor: session.walletAddress })).toEqual([
      expect.objectContaining({
        eventType: "auth.session_key_minted", resourceId: body.key_id, metadata: { expires_at: body.expires_at },
      }),
    ]);
    expect((await validate(app, body.api_key)).statusCode).toBe(200);
  });

  it("a session with twenty hours remaining mints a key capped at twelve hours", async () => {
    const app = await buildApp();
    const session = issueSession(20);
    const before = Date.now();
    const response = await mint(app, session.token);
    const after = Date.now();
    expect(response.statusCode).toBe(201);
    const expiry = Date.parse(response.json().expires_at);
    expect(expiry).toBeGreaterThanOrEqual(before + 12 * HOUR_MS);
    expect(expiry).toBeLessThanOrEqual(after + 12 * HOUR_MS);
    expect(expiry).toBeLessThanOrEqual(Date.parse(session.expiresAt));
    expect(after - before).toBeLessThan(1000);
  });

  it("every scoped and unscoped pair has the same decision as a simultaneous self-service provision", async () => {
    const app = await buildApp();
    // The invariant is never wider; equality also preserves each self-service decision.
    const now = new Date();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sessionResponse = await mint(app, issueSession().token);
    const provisionResponse = await app.inject({
      method: "POST", url: "/api/auth/provision", payload: { email: "session-key-comparison@example.com" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    expect(provisionResponse.statusCode).toBe(201);
    expect(sessionResponse.json().created_at).toBe(provisionResponse.json().created_at);
    const sessionKey = sessionResponse.json().api_key;
    const provisionKey = provisionResponse.json().api_key;
    expect((await validate(app, sessionKey)).statusCode).toBe(200);
    for (const route of [...SCOPE_COVERED_ROUTES, ...UNSCOPED_ROUTES]) {
      const decisions = [];
      for (const key of [sessionKey, provisionKey]) {
        decisions.push(await app.inject({
          method: route.method, url: route.url, headers: { authorization: `Bearer ${key}` },
        }));
      }
      const [sessionDecision, provisionDecision] = decisions;
      const label = `${route.method} ${route.url}`;
      const permitted = (status: number) => status >= 200 && status < 300;
      expect(Number(permitted(sessionDecision.statusCode)), label)
        .toBeLessThanOrEqual(Number(permitted(provisionDecision.statusCode)));
      expect(sessionDecision.statusCode, label).toBe(provisionDecision.statusCode);
      expect(sessionDecision.json(), label).toEqual(provisionDecision.json());
    }
  });

  it("re-minting replaces the same session's live key and the earlier key stops authenticating", async () => {
    const app = await buildApp();
    const session = issueSession();
    const first = await mint(app, session.token);
    const second = await mint(app, session.token);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().key_id).not.toBe(first.json().key_id);
    const live = getRepos().apiKeys.findByOperator(session.walletAddress).filter((key) => !key.revokedAt);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(second.json().key_id);
    expect(JSON.parse(live[0].metadata!).source).toBe("siwe-session");
    expect((await validate(app, first.json().api_key)).statusCode).toBe(401);
    expect((await validate(app, second.json().api_key)).statusCode).toBe(200);
  });

  it("five expired session keys are revoked before the active-key cap is checked", async () => {
    const app = await buildApp();
    const session = issueSession();
    const expiredKeys = Array.from({ length: 5 }, () => insertKey({
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      metadata: { source: "siwe-session", sessionId: randomUUID() },
    }));
    const response = await mint(app, session.token);
    expect(response.statusCode).toBe(201);
    for (const { record } of expiredKeys) expect(getRepos().apiKeys.findById(record.id)!.revokedAt).not.toBeNull();
    expect(getRepos().apiKeys.countByOperator(session.walletAddress)).toBe(1);
  });

  it("five live non-session keys retain the cap and return only too_many_keys", async () => {
    const app = await buildApp();
    const session = issueSession();
    const keys = Array.from({ length: 5 }, () => insertKey({ metadata: { source: "landing-page" } }));
    const response = await mint(app, session.token);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "too_many_keys", message: "Maximum 5 active API keys per operator" });
    expect(getRepos().apiKeys.findByOperator(session.walletAddress)).toEqual(keys.map(({ record }) => record));
  });

  it("cleanup preserves other sessions, non-session keys and keys for another address", async () => {
    const app = await buildApp();
    const session = issueSession();
    const earlier = insertKey({ metadata: { source: "siwe-session", sessionId: session.id } });
    const expired = insertKey({
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
      metadata: { source: "siwe-session", sessionId: randomUUID() },
    });
    const retained = [
      insertKey({ metadata: { source: "siwe-session", sessionId: randomUUID() } }),
      insertKey({ expiresAt: new Date(Date.now() - HOUR_MS).toISOString(), metadata: { source: "landing-page", sessionId: session.id } }),
      insertKey({ operatorId: "0x1111111111111111111111111111111111111111", metadata: { source: "siwe-session", sessionId: session.id } }),
    ];
    const response = await mint(app, session.token);
    expect(response.statusCode).toBe(201);
    for (const { record } of [earlier, expired]) expect(getRepos().apiKeys.findById(record.id)!.revokedAt).not.toBeNull();
    for (const { record } of retained) expect(getRepos().apiKeys.findById(record.id)).toEqual(record);
  });

  it("a minted key stops authenticating once its expiry is in the past", async () => {
    const app = await buildApp();
    const response = await mint(app, issueSession().token);
    expect(response.statusCode).toBe(201);
    expect((await validate(app, response.json().api_key)).statusCode).toBe(200);
    getStore().db.update(schema.apiKeys).set({ expiresAt: new Date(Date.now() - 1).toISOString() })
      .where(eq(schema.apiKeys.id, response.json().key_id)).run();
    const expired = await validate(app, response.json().api_key);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toEqual({ error: "invalid_key" });
  });

  it("an unexpected provisioning exception returns a constant provision_failed response", async () => {
    const app = await buildApp();
    const session = issueSession();
    const earlier = insertKey({ metadata: { source: "siwe-session", sessionId: session.id } });
    const canary = "session-key-provision-error-canary";
    vi.spyOn(getRepos().apiKeys, "insert").mockImplementation(() => { throw new Error(canary); });
    const response = await mint(app, session.token);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "provision_failed", message: "Failed to provision key" });
    expect(response.body).not.toContain(canary);
    expect(getRepos().apiKeys.findById(earlier.record.id)).toEqual(earlier.record);
    expect((await validate(app, earlier.rawKey)).statusCode).toBe(200);
    expect(auditService.query({ actor: session.walletAddress })).toEqual([]);
  });

  it("an explicit expiry instant takes precedence over expiresInDays", () => {
    const expiresAt = new Date(Date.now() + HOUR_MS).toISOString();
    const { record } = provisionApiKey({ operatorId: ADDRESS, expiresAt, expiresInDays: 30 });
    expect(record!.expiresAt).toBe(expiresAt);
    expect(getRepos().apiKeys.findById(record!.id)!.expiresAt).toBe(expiresAt);
  });
});

describe("session-key authentication and scope checks hold in server registration order", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    apps.push(app);
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(cookie, { secret: "session-key-test-cookie-secret" });
    await app.register(siweAuthPlugin);
    await app.register(provisionRoutes);
    await app.register(apiGate);
    await app.register(sc.scopeChecker);
    app.post("/api/kernels/register", async () => ({ reached: true }));
    await app.ready();
  });

  it("apiGate refuses an anonymous request to the earlier-registered session-key route", async () => {
    const response = await app.inject({ method: "POST", url: "/api/auth/session-key" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("api_key_required");
    expect(getRepos().apiKeys.findByOperator(ADDRESS)).toEqual([]);
  });

  it("an API key with a valid signed session cookie cannot mint another key", async () => {
    const session = issueSession();
    const { rawKey, record } = insertKey();
    const response = await app.inject({
      method: "POST", url: "/api/auth/session-key",
      headers: {
        authorization: `Bearer ${rawKey}`,
        cookie: `pcc_session=${app.signCookie(session.token)}`,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("session_required");
    expect(getRepos().apiKeys.findByOperator(ADDRESS).map((key) => key.id)).toEqual([record.id]);
  });

  it("a valid signed session mints exactly the self-service scopes", async () => {
    const session = issueSession();
    const response = await app.inject({
      method: "POST", url: "/api/auth/session-key",
      headers: { cookie: `pcc_session=${app.signCookie(session.token)}`, authorization: `Bearer ${session.token}` },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().scopes).toEqual(sc.SELF_SERVICE_KEY_SCOPES);
  });

  it("a session needs its minted key to reach the scoped kernel registration stub", async () => {
    const session = issueSession();
    const headers = { cookie: `pcc_session=${app.signCookie(session.token)}` };
    const sessionResponse = await app.inject({
      method: "POST", url: "/api/kernels/register", headers,
    });
    expect(sessionResponse.statusCode).toBe(403);
    expect(sessionResponse.json().error).toBe("insufficient_scope");

    const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: { ...headers, authorization: `Bearer ${session.token}` } });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().scopes).toEqual(sc.SELF_SERVICE_KEY_SCOPES);
    const keyResponse = await app.inject({
      method: "POST", url: "/api/kernels/register",
      headers: { authorization: `Bearer ${minted.json().api_key}` },
    });
    expect(keyResponse.statusCode).toBe(200);
    expect(keyResponse.json()).toEqual({ reached: true });
  });
});
