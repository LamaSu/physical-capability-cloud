import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { authorityOf, EXPLICIT_CREDENTIAL_REQUIRED } from "../auth/kernel-authority.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { onboardRoutes } from "../routes/onboard.js";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";
import { pipelineTelemetry } from "../telemetry.js";

vi.mock("../services/posthog-service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/posthog-service.js")>(),
  trackServerEvent: vi.fn(),
  initPostHog: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));
const SECRET = "synthetic-md-admin-secret";
const WALLET_A = "0xaAbBcCdDeEfF00112233445566778899aAbBcCdD";
const WALLET_B = "0xbBcCdDeEfFaA11223344556677889900bBcCdDeE";
const evidence = { evidence: { deviceHealth: { status: "idle", model: "TestBot 9000", firmware: "1.0" } } };
const DELETED = { error: "deleted", message: "Registration was soft-deleted" };
type Write = "DELETE" | "prove" | "reject";
type Headers = Record<string, string>;
type Key = ReturnType<typeof provisionApiKey>;
type Row = NonNullable<ReturnType<ReturnType<typeof getRepos>["registrations"]["findById"]>>;
type Session = { cookie: Headers; bearer: Headers; key: Headers; keyId: string };
let app: FastifyInstance;
let KEY_PLAIN: Key, KEY_REG: Key, KEY_ADMIN: Key, KEY_CLAIM: Key;
let sessionA: Session, sessionB: Session;
let sequence = 0;
let auditLog: ReturnType<typeof vi.spyOn<typeof auditService, "log">>;
const bearer = (token: string): Headers => ({ authorization: `Bearer ${token}` });
const keyHeaders = (key: Key) => bearer(key.rawKey);
const admin = () => ({ ...keyHeaders(KEY_PLAIN), "x-admin-key": SECRET });
const proof = (wallet = WALLET_A, extra: Headers = {}): Headers => ({
  ...keyHeaders(KEY_PLAIN), "x-test-proven-wallet": wallet, ...extra,
});
const url = (id: string) => `/api/onboard/registrations/${id}`;
const stored = (id: string): Row => JSON.parse(JSON.stringify(getRepos().registrations.findById(id)));
const forbidden = (write: "prove") => ({ error: "forbidden", message: `You can only ${write} your own registration` });

function seed(wallet = WALLET_A, createdByKeyId: string | null = null, tenantId: string | null = null, extra: Partial<Row> = {}): Row {
  const n = ++sequence;
  return getRepos().registrations.insert({
    id: `reg-md-${n}`, name: `MD machine ${n}`, category: "custom", manufacturer: "Synthetic", model: "TestBot 9000",
    serialNumber: `serial-md-${n}`, description: "Synthetic machine description", photos: ["synthetic-photo"],
    capabilities: [{ id: `cap-md-${n}`, type: "custom", name: "Synthetic capability", description: "Test", materials: ["PLA"], params: [], source: "synthetic" }],
    spaceRequirements: { marker: "synthetic-space" }, pricing: { baseCost: "1", minimum: "0", currency: "USDC" },
    operator: { walletAddress: wallet, displayName: "Synthetic operator", certifications: [], trainingAcknowledgments: {} },
    complianceRegulations: ["MD-REG"], tenantId, createdByKeyId, status: "submitted",
    createdAt: "2026-11-16T00:00:00.000Z", submittedAt: "2026-11-16T00:00:00.000Z", ...extra,
  })!;
}

function clearEffects() {
  auditLog.mockClear();
  vi.mocked(pipelineTelemetry.emit).mockClear();
  vi.mocked(trackServerEvent).mockClear();
}
function expectNoEffects() {
  expect(auditLog.mock.calls.filter(([event]) => event.eventType.startsWith("operator."))).toStrictEqual([]);
  expect(pipelineTelemetry.emit).not.toHaveBeenCalled();
  expect(trackServerEvent).not.toHaveBeenCalled();
}
function writeRequest(write: Write, id: string, headers: Headers, payload: Record<string, unknown> | undefined = evidence) {
  return app.inject({
    method: write === "DELETE" ? "DELETE" : "POST",
    url: url(id) + (write === "DELETE" ? "" : `/${write}`), headers,
    ...(write !== "DELETE" && payload !== undefined ? { payload } : {}),
  });
}
async function pass(write: "DELETE" | "prove", row: Row, headers: Headers) {
  const res = await writeRequest(write, row.id, headers);
  expect(res.statusCode, `${write}: ${res.body}`).toBe(200);
  expect(stored(row.id).status).toBe(write === "DELETE" ? "deleted" : "active");
  return res;
}
async function deleted(row = seed()): Promise<Row> {
  vi.stubEnv("TENANT_ENFORCE", "");
  await pass("DELETE", row, admin());
  return stored(row.id);
}
async function refuse(write: "prove" | "reject", row: Row, headers: Headers, status: number, body: unknown, payload: Record<string, unknown> | undefined) {
  const before = stored(row.id);
  clearEffects();
  const res = await app.inject({
    method: "POST", url: url(row.id) + `/${write}`, headers,
    ...(payload === undefined ? {} : { payload }),
  });
  expect(res.statusCode, `${write}: ${res.body}`).toBe(status);
  expect(res.json()).toStrictEqual(body);
  expectNoEffects();
  expect(stored(row.id)).toStrictEqual(before);
}
function otherCallers(): Headers[] {
  return [sessionB.key, sessionB.bearer, proof(WALLET_B),
    proof(WALLET_A, { "x-test-proven-wallet-via": "self-link:device" }),
    proof(WALLET_A, { "x-test-proven-wallet-via": "siwe" }),
    keyHeaders(KEY_CLAIM), keyHeaders(KEY_PLAIN),
    { ...keyHeaders(KEY_PLAIN), "x-posted-by": WALLET_A }];
}

async function makeSession(wallet: string): Promise<Session> {
  const token = `synthetic-session-md-${wallet.toLowerCase()}`;
  const now = new Date().toISOString();
  getRepos().sessions.insert({ id: token, token, walletAddress: wallet.toLowerCase(),
    createdAt: now, lastActiveAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const headers = bearer(token);
  const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers });
  expect(minted.statusCode, minted.body).toBe(201);
  const key = bearer(minted.json().api_key);
  const probe = await app.inject({ url: "/api/md-test/authority", headers: key });
  const keyId = probe.json().apiKeyId;
  expect(getRepos().apiKeys.findById(keyId)).toBeDefined();
  return { cookie: { cookie: `pcc_session=${app.signCookie(token)}` }, bearer: headers, key, keyId };
}

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("PCC_ADMIN_KEY", SECRET);
  vi.stubEnv("TENANT_ENFORCE", "");
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "synthetic-md-signed-cookie-secret" });
  app.addHook("onRequest", async req => {
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") {
      req.provenWallet = proven;
      req.provenWalletVia = typeof req.headers["x-test-proven-wallet-via"] === "string"
        ? req.headers["x-test-proven-wallet-via"] : "self-link:agent";
      const carrier = req.headers["x-test-proven-wallet-carrier"];
      if (carrier === "none") delete req.provenWalletCarrier;
      else req.provenWalletCarrier = carrier === "key" || carrier === "bearer-session" || carrier === "cookie" ? carrier : "key";
    }
    if (typeof req.headers["x-test-tenant"] === "string") req.tenantId = req.headers["x-test-tenant"];
  });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(siweAuthPlugin);
  await app.register(onboardRoutes);
  app.get("/api/md-test/authority", async req => authorityOf(req));
  await app.ready();
  const key = (operatorId: string, scopes = ["operator:basic"]) => provisionApiKey({ operatorId, scopes });
  KEY_PLAIN = key("operator-md-plain");
  KEY_REG = key("operator-md-registrar");
  KEY_ADMIN = key("operator-md-admin", ["admin"]);
  KEY_CLAIM = key(WALLET_A.toLowerCase());
  sessionA = await makeSession(WALLET_A);
  sessionB = await makeSession(WALLET_B);
  auditLog = vi.spyOn(auditService, "log");
  clearEffects();
});
afterEach(async () => {
  await app?.close();
  closeStore();
  __resetScopeCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("missing and deleted registrations", () => {
  it("MD1 a missing registration is 404 not_found on detail for every caller, and a stored one is 200", async () => {
    for (const headers of [admin(), keyHeaders(KEY_ADMIN), sessionA.key, sessionA.cookie, keyHeaders(KEY_PLAIN), proof(WALLET_B)]) {
      const res = await app.inject({ url: url("reg-md-missing"), headers });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json()).toStrictEqual({ error: "not_found" });
    }
    const row = seed();
    const res = await app.inject({ url: url(row.id), headers: admin() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().registration.id).toBe(row.id);
  });

  it("MD2 under TENANT_ENFORCE another tenant's row and a tenant-less row are 404 not_found on detail, as a missing id is", async () => {
    vi.stubEnv("TENANT_ENFORCE", "true");
    const tenantRow = seed(WALLET_A, null, "tenant-md-a");
    const tenantless = seed();
    for (const caller of [admin(), keyHeaders(KEY_PLAIN)]) {
      const headers = { ...caller, "x-test-tenant": "tenant-md-b" };
      for (const id of [tenantRow.id, tenantless.id, "reg-md-missing"]) {
        const before = [stored(tenantRow.id), stored(tenantless.id)];
        const res = await app.inject({ url: url(id), headers });
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json()).toStrictEqual({ error: "not_found" });
        expect([stored(tenantRow.id), stored(tenantless.id)]).toStrictEqual(before);
      }
    }
    const res = await app.inject({ url: url(tenantRow.id), headers: { ...admin(), "x-test-tenant": "tenant-md-a" } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().registration.id).toBe(tenantRow.id);
  });

  it("MD3 /prove answers a deleted registration 410 for every admitted caller and writes nothing", async () => {
    for (const headers of [admin(), keyHeaders(KEY_ADMIN), sessionA.key, sessionA.bearer, proof(WALLET_A)]) {
      for (const payload of [evidence, {}]) {
        await refuse("prove", await deleted(seed(WALLET_A)), headers, 410, DELETED, payload);
      }
    }
    for (const payload of [evidence, {}]) {
      await refuse("prove", await deleted(seed(WALLET_B, KEY_REG.record!.id)), keyHeaders(KEY_REG), 410, DELETED, payload);
    }
    await pass("prove", seed(), admin());
  });

  it("MD4 /prove gives a refused caller its 403 on a deleted registration, and another tenant's deleted row is 404", async () => {
    const row = await deleted(seed(WALLET_A));
    for (const headers of otherCallers()) {
      await refuse("prove", row, headers, 403, forbidden("prove"), evidence);
    }
    await refuse("prove", row, sessionA.cookie, 403, EXPLICIT_CREDENTIAL_REQUIRED, evidence);
    const tenantRow = await deleted(seed(WALLET_A, null, "tenant-md-a"));
    vi.stubEnv("TENANT_ENFORCE", "true");
    await refuse("prove", tenantRow, { ...admin(), "x-test-tenant": "tenant-md-b" }, 404, { error: "not_found" }, evidence);
    await refuse("prove", tenantRow, { ...admin(), "x-test-tenant": "tenant-md-a" }, 410, DELETED, evidence);
  });

  it("MD5 /reject answers a deleted registration 410 for the admin and writes nothing", async () => {
    const row = await deleted();
    for (const headers of [admin(), keyHeaders(KEY_ADMIN)]) {
      for (const payload of [{ reason: "md reason" }, undefined]) {
        await refuse("reject", row, headers, 410, DELETED, payload);
      }
    }
    const submitted = seed();
    const res = await writeRequest("reject", submitted.id, admin(), { reason: "md reason" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rejected).toBe(true);
    expect(stored(submitted.id).status).toBe("rejected");
  });

  it("MD6 /reject gives a non-admin its 403 on a deleted registration, and another tenant's deleted row is 404", async () => {
    const row = await deleted(seed(WALLET_A));
    for (const headers of [sessionA.key, sessionA.bearer, sessionA.cookie, proof(WALLET_A), keyHeaders(KEY_REG), keyHeaders(KEY_PLAIN)]) {
      await refuse("reject", row, headers, 403, { error: "forbidden" }, { reason: "md reason" });
    }
    const tenantRow = await deleted(seed(WALLET_A, null, "tenant-md-a"));
    vi.stubEnv("TENANT_ENFORCE", "true");
    await refuse("reject", tenantRow, { ...admin(), "x-test-tenant": "tenant-md-b" }, 404, { error: "not_found" }, { reason: "md reason" });
    await refuse("reject", tenantRow, { ...admin(), "x-test-tenant": "tenant-md-a" }, 410, DELETED, { reason: "md reason" });
  });
});
