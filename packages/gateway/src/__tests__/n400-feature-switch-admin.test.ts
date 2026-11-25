import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "@pcc/store";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { getRepos, getStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { adminFeatureRoutes } from "../routes/admin-features.js";
import { auditService } from "../services/audit-service.js";
import { acceptsAdminKey, ADMIN_KEY_ROUTES } from "../middleware/api-gate.js";

vi.unmock("../services/feature-switches.js");

const names = ["key_minting", "signups", "sign_in", "onboard_chat", "device_identify", "onboard_analysis", "commentary", "request_planner", "job_submission"];
const secret = "synthetic-n400-admin-secret";
const headers = () => ({ "x-admin-key": secret });
const rows = () => getStore().db.all(sql`SELECT * FROM feature_switches ORDER BY name`);
const records = () => getRepos().auditLog.query({ eventType: "admin.features.set", limit: 1000 });
let app: FastifyInstance;
let bare: FastifyInstance;
let keys: ReturnType<typeof provisionApiKey>[];
const bearer = (index: number) => ({ authorization: `Bearer ${keys[index].rawKey}` });
const set = (name: string, enabled: boolean, auth = headers()) => app.inject({ method: "PUT", url: `/api/admin/features/${name}`, headers: auth, payload: { enabled } });

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "false");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keys = [["admin"], ["operator:basic"], ["*"], ["*", "admin"]].map((scopes, n) => provisionApiKey({ operatorId: `n400-actor-${n}`, name: `synthetic-${n}`, scopes }));
  const now = new Date().toISOString();
  getRepos().sessions.insert({ id: "n400-session", token: "n400-session", walletAddress: "0x1111111111111111111111111111111111111111", createdAt: now, lastActiveAt: now, expiresAt: new Date(Date.now() + 86400000).toISOString() });

  // Exercise each handler's own gate even for callers rejected by earlier middleware.
  bare = Fastify();
  bare.addHook("onRequest", async (req) => {
    const match = keys.find((k) => req.headers.authorization === `Bearer ${k.rawKey}`);
    if (match) req.apiKeyId = match.record.id;
    // light-my-request folds repeated fields. Supply the actual raw field list,
    // as Node's HTTP server does, to exercise duplicate rejection without a socket.
    if (req.headers["x-n400-duplicate"]) req.raw.rawHeaders.push("x-admin-key", secret);
  });
  await bare.register(adminFeatureRoutes);
  await bare.ready();
}, 180_000);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  getStore().db.run(sql`CREATE TABLE IF NOT EXISTS feature_switches (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), updated_at TEXT NOT NULL, updated_by TEXT)`);
  for (const name of names) getStore().db.run(sql`INSERT OR REPLACE INTO feature_switches VALUES (${name}, ${name === "key_minting" ? 0 : 1}, ${"2026-11-24T00:00:00.000Z"}, NULL)`);
  getStore().db.run(sql`DELETE FROM audit_log WHERE event_type = 'admin.features.set'`);
});

afterAll(async () => {
  await bare?.close();
  await app?.close();
  vi.unstubAllEnvs();
});

describe("N400 admin features", () => {
  it.each(["GET", "PUT"] as const)("T7: %s refuses every unprivileged caller in the gateway and in the handler", async (method) => {
    const url = method === "GET" ? "/api/admin/features" : "/api/admin/features/key_minting";
    const callers = [
      { headers: {}, status: 401 },
      { headers: bearer(1), status: 403 },
      { headers: { cookie: `pcc_session=${app.signCookie("n400-session")}` }, status: 403 },
      { headers: bearer(2), status: 403 },
      { headers: bearer(3), status: 403 },
      { headers: { "x-admin-key": "*" }, status: 403, wildcard: true },
    ];
    for (const caller of callers) {
      vi.stubEnv("PCC_ADMIN_KEY", caller.wildcard ? "*" : secret);
      const before = rows();
      const options = { method, url, headers: caller.headers, ...(method === "PUT" ? { payload: { enabled: true } } : {}) };
      expect((await app.inject(options)).statusCode).toBe(caller.status);
      const direct = await bare.inject(options);
      expect(direct.statusCode).toBe(403);
      expect(direct.json()).toEqual({ error: "forbidden" });
      expect(rows()).toEqual(before);
      expect(records()).toEqual([]);
    }
  });

  it.each(["GET", "PUT"] as const)("T7: %s refuses two raw X-Admin-Key fields even with an admin-scoped key", async (method) => {
    const before = rows();
    for (const auth of [{}, bearer(0)]) {
      const response = await bare.inject({ method, url: method === "GET" ? "/api/admin/features" : "/api/admin/features/key_minting", headers: { ...auth, ...headers(), "x-n400-duplicate": "true" }, ...(method === "PUT" ? { payload: { enabled: true } } : {}) });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden" });
      expect(rows()).toEqual(before);
      expect(records()).toEqual([]);
    }
  });

  it("T7: secret and literal admin scope can read and set; HEAD has no handler", async () => {
    for (const auth of [headers(), bearer(0)]) {
      expect((await app.inject({ url: "/api/admin/features", headers: auth })).statusCode).toBe(200);
      expect((await set("key_minting", true, auth)).statusCode).toBe(200);
    }
    // An admin-scoped key authenticates HEAD independently of the admin-secret allowlist.
    expect((await app.inject({ method: "HEAD", url: "/api/admin/features", headers: bearer(0) })).statusCode).toBe(404);
  });

  it("T7: the admin-secret declarations admit only the exact paths and verbs", () => {
    expect(ADMIN_KEY_ROUTES.slice(-2).map((entry) => ({ methods: entry.methods, match: entry.match, path: String(entry.path), why: entry.why }))).toEqual([
      { methods: ["GET"], match: "exact", path: "/api/admin/features", why: "N400 feature switches read: also accepts the gateway admin secret itself" },
      { methods: ["PUT"], match: "regex", path: String(/^\/api\/admin\/features\/[^/]+$/), why: "N400 feature switch set: also accepts the gateway admin secret itself" },
    ]);
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const url of ["/api/admin/features", "/api/admin/features/key_minting", "/api/admin/features/", "/api/admin/features/key_minting/extra", "/api/admin/featuresx", "/x/api/admin/features/key_minting", "/api/admin/features/key1", "/api/admin/features/KEY", "/api/admin/features/key_minting/"]) {
        expect(acceptsAdminKey(url, method), `${method} ${url}`).toBe((method === "GET" && url === "/api/admin/features") || (method === "PUT" && ["/api/admin/features/key_minting", "/api/admin/features/key1", "/api/admin/features/KEY"].includes(url)));
      }
    }
  });

  it.each([{}, { enabled: "true" }, { enabled: 1 }, { enabled: true, x: 1 }, [], null, { x: true }])("T8: rejects invalid body %j without changes", async (payload) => {
    const before = rows();
    const response = await app.inject({ method: "PUT", url: "/api/admin/features/key_minting", headers: { ...headers(), "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_body" });
    expect(rows()).toEqual(before);
    expect(records()).toEqual([]);
  });

  it("T8: missing body and unknown name do not write", async () => {
    const before = rows();
    const absent = await app.inject({ method: "PUT", url: "/api/admin/features/key_minting", headers: headers() });
    expect(absent.statusCode).toBe(400);
    expect(absent.json()).toEqual({ error: "invalid_body" });
    const unknown = await set("unknown", true);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "not_found" });
    expect(rows()).toEqual(before);
    expect(records()).toEqual([]);
  });

  it.each(["header", "key"])("T9: every set, including no-op, records the exact actor and transition (%s)", async (kind) => {
    const auth = kind === "header" ? headers() : bearer(0);
    const actor = kind === "header" ? "admin-key" : keys[0].record.id;
    let from = false;
    for (const to of [true, true, false, false]) {
      const count = records().length;
      const before = Date.now();
      const response = await set("key_minting", to, auth);
      expect(response.statusCode).toBe(200);
      const entry = response.json();
      expect(entry).toEqual({ name: "key_minting", enabled: to, updatedAt: expect.any(String), updatedBy: actor });
      expect(new Date(entry.updatedAt).toISOString()).toBe(entry.updatedAt);
      expect(Date.parse(entry.updatedAt)).toBeGreaterThanOrEqual(before);
      expect(records()).toHaveLength(count + 1);
      const record = records()[0];
      expect(record).toEqual({ id: expect.any(Number), timestamp: expect.any(String), eventType: "admin.features.set", action: "update", resourceType: "feature_switch", resourceId: "key_minting", actor, metadata: { from, to }, ip: null, userAgent: null });
      expect(getStore().db.get(sql`SELECT * FROM feature_switches WHERE name = 'key_minting'`)).toEqual({ name: "key_minting", enabled: to ? 1 : 0, updated_at: entry.updatedAt, updated_by: actor });
      expect(JSON.stringify([record, entry])).not.toContain(secret);
      expect(JSON.stringify([record, entry])).not.toContain(keys[0].rawKey);
      from = to;
    }
  });

  it.each(names)("T9: %s records its own name and exact transition on every set", async (name) => {
    const from = name !== "key_minting";
    const response = await set(name, !from);
    expect(response.statusCode).toBe(200);
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ eventType: "admin.features.set", actor: "admin-key", action: "update", resourceType: "feature_switch", resourceId: name, metadata: { from, to: !from } });
    expect(getStore().db.get(sql`SELECT enabled, updated_by FROM feature_switches WHERE name = ${name}`)).toEqual({ enabled: from ? 0 : 1, updated_by: "admin-key" });
  });

  it("T9: setting a missing row inserts it and records from false", async () => {
    getStore().db.run(sql`DELETE FROM feature_switches WHERE name = 'signups'`);
    expect((await set("signups", true)).json()).toMatchObject({ name: "signups", enabled: true, updatedBy: "admin-key" });
    expect(records()).toHaveLength(1);
    expect(records()[0].metadata).toEqual({ from: false, to: true });
  });

  it.each(["false", "throw", "write-then-false", "write-then-throw"])("T9: audit failure %s rolls back both the flip and any inserted record", async (failure) => {
    const original = auditService.log.bind(auditService);
    vi.spyOn(auditService, "log").mockImplementation((entry) => {
      if (entry.eventType !== "admin.features.set") return original(entry);
      if (failure.startsWith("write-then")) original(entry);
      if (failure.endsWith("throw")) throw new Error("synthetic audit failure");
      return false;
    });
    const before = rows();
    const response = await set("key_minting", true);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "feature_switches_unavailable" });
    expect(rows()).toEqual(before);
    expect(records()).toEqual([]);
  });

  it("T10: GET has nine ordered entries, no-store, and nulls for a missing row", async () => {
    getStore().db.run(sql`DELETE FROM feature_switches WHERE name = 'signups'`);
    const response = await app.inject({ url: "/api/admin/features", headers: headers() });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ features: names.map((name) => ({ name, enabled: name !== "key_minting" && name !== "signups", updatedAt: name === "signups" ? null : "2026-11-24T00:00:00.000Z", updatedBy: null })) });
  });

  it("T10: GET lists every stored value other than the integer 1 as off", async () => {
    getStore().db.run(sql`DROP TABLE feature_switches`);
    try {
      getStore().db.run(sql`CREATE TABLE feature_switches (name TEXT PRIMARY KEY, enabled, updated_at TEXT NOT NULL, updated_by TEXT)`);
      getStore().db.run(sql`INSERT INTO feature_switches VALUES
        ('signups', ${"1"}, '2026-11-24T00:00:00.000Z', NULL),
        ('sign_in', CAST(1 AS REAL), '2026-11-24T00:00:00.000Z', NULL),
        ('onboard_chat', 2, '2026-11-24T00:00:00.000Z', NULL),
        ('key_minting', 0, '2026-11-24T00:00:00.000Z', NULL),
        ('device_identify', 1, '2026-11-24T00:00:00.000Z', NULL),
        ('onboard_analysis', 1, '2026-11-24T00:00:00.000Z', NULL),
        ('commentary', 1, '2026-11-24T00:00:00.000Z', NULL),
        ('request_planner', 1, '2026-11-24T00:00:00.000Z', NULL),
        ('job_submission', 1, '2026-11-24T00:00:00.000Z', NULL)`);
      const response = await app.inject({ url: "/api/admin/features", headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ features: names.map((name) => ({ name, enabled: !["signups", "sign_in", "onboard_chat", "key_minting"].includes(name), updatedAt: "2026-11-24T00:00:00.000Z", updatedBy: null })) });
    } finally {
      getStore().db.run(sql`DROP TABLE feature_switches`);
    }
  });

  it("T10: unreadable table gives 503 for GET and PUT", async () => {
    getStore().db.run(sql`DROP TABLE feature_switches`);
    for (const response of [await app.inject({ url: "/api/admin/features", headers: headers() }), await set("key_minting", true)]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "feature_switches_unavailable" });
    }
    expect(records()).toEqual([]);
  });

  it("R10: with key minting off, a wallet can still sign in and use its session", async () => {
    const account = privateKeyToAccount(`0x${"14".repeat(32)}`);
    const nonce = (await app.inject({ url: "/api/auth/nonce" })).json().nonce;
    const message = createSiweMessage({ address: account.address, domain: "localhost", uri: "http://localhost", version: "1", chainId: 84532, nonce, issuedAt: new Date(), statement: "Synthetic N400 sign-in" });
    const payload = { message, signature: await account.signMessage({ message }) };
    const signedIn = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: "localhost" }, payload });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.headers["set-cookie"]).toBeDefined();
    const sessionHeaders = { cookie: String(signedIn.headers["set-cookie"]).split(";")[0] };
    expect((await app.inject({ url: "/api/auth/me", headers: sessionHeaders })).statusCode).toBe(200);
    const paused = await app.inject({ method: "POST", url: "/api/auth/session-key", headers: sessionHeaders, payload: {} });
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toEqual({ error: "feature_paused", feature: "key_minting", message: "Creating API keys is paused." });
    expect((await set("sign_in", false)).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/auth/me", headers: sessionHeaders })).statusCode).toBe(200);
    const before = getRepos().sessions.countActive();
    const refused = await app.inject({ method: "POST", url: "/api/auth/verify", headers: { host: "localhost" }, payload });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "feature_paused", feature: "sign_in", message: "Sign-in is paused." });
    expect(refused.headers["set-cookie"]).toBeUndefined();
    expect(getRepos().sessions.countActive()).toBe(before);
  });

  it("T12: all switches off leave the admin API, health, e-stop, resume and recovery usable", async () => {
    // Existing demo kernel state is unnecessary for emergency policy writes by the admin.
    const kernelId = "synthetic-n400-emergency-kernel";
    const operatorHeaders = { ...headers(), ...bearer(0) };
    const exercise = async (enabled: number) => {
      getStore().db.run(sql`UPDATE feature_switches SET enabled = ${enabled}`);
      const stop = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", headers: operatorHeaders, payload: { kernelId, reason: "n400 test" } });
      expect(stop.statusCode).toBe(200);
      expect(stop.json()).toMatchObject({ stopped: true, kernelId });
      const before = getStore().db.all(sql`SELECT * FROM operator_policies`);
      expect((await set("commentary", false)).statusCode).toBe(200);
      expect(getStore().db.all(sql`SELECT * FROM operator_policies`)).toEqual(before);
      expect((await app.inject({ url: "/api/admin/features", headers: headers() })).statusCode).toBe(200);
      expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
      const resume = await app.inject({ method: "POST", url: "/api/operator/emergency-resume", headers: operatorHeaders, payload: { kernelId } });
      expect(resume.statusCode).toBe(200);
      expect(resume.json()).toMatchObject({ resumed: true, kernelId });
      const resumed = getStore().db.all(sql`SELECT * FROM operator_policies`);
      expect((await set("job_submission", true)).statusCode).toBe(200);
      expect(getStore().db.all(sql`SELECT * FROM operator_policies`)).toEqual(resumed);
      getStore().db.run(sql`INSERT OR REPLACE INTO negotiation_sessions (id, status, user_agent_id, kernel_id, capability_type, selections, operator_constraints, transitions, created_at, expires_at, job_id, escrow_address)
        VALUES ('n400-recovery', 'settlement_failed', 'n400-buyer', ${kernelId}, 'fdm', '{}', '{}', '[]', ${new Date().toISOString()}, ${new Date(Date.now() + 86400000).toISOString()}, 'n400-recovered-job', '0x1111111111111111111111111111111111111111')`);
      // Keep job_submission off during recovery, too.
      getStore().db.run(sql`UPDATE feature_switches SET enabled = ${enabled}`);
      const recovery = await app.inject({ method: "POST", url: "/api/negotiate/session/n400-recovery/retry-settlement", headers: operatorHeaders });
      expect(recovery.statusCode).toBe(200);
      expect(recovery.json()).toMatchObject({ resumed: true, sessionId: "n400-recovery", escrowAddress: "0x1111111111111111111111111111111111111111" });
      return recovery.json();
    };
    expect(await exercise(0)).toEqual(await exercise(1));
  });
});
