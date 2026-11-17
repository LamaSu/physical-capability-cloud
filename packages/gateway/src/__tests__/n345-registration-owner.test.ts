import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { authorityOf, EXPLICIT_CREDENTIAL_REQUIRED } from "../auth/kernel-authority.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { onboardRoutes, registrationAccess } from "../routes/onboard.js";
import { operatorsPublicRoutes } from "../routes/operators-public.js";
import { auditService } from "../services/audit-service.js";
import { listMatchQueriesForOperator } from "../services/match-log.js";
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
vi.mock("../services/match-log.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/match-log.js")>();
  return { ...original, listMatchQueriesForOperator: vi.fn(original.listMatchQueriesForOperator) };
});

const SECRET = "synthetic-n345-admin-secret";
const WALLET_A = "0xaAbBcCdDeEfF00112233445566778899aAbBcCdD";
const WALLET_B = "0xbBcCdDeEfFaA11223344556677889900bBcCdDeE";
const ZERO = "0x0000000000000000000000000000000000000000";
const evidence = { evidence: { deviceHealth: { status: "idle", model: "TestBot 9000", firmware: "1.0" } } };
const writes = ["PATCH", "DELETE", "prove"] as const;
type Write = typeof writes[number];
type Headers = Record<string, string>;
type Key = ReturnType<typeof provisionApiKey>;
type Row = NonNullable<ReturnType<ReturnType<typeof getRepos>["registrations"]["findById"]>>;
type Session = { cookie: Headers; bearer: Headers; key: Headers; keyId: string };
let app: FastifyInstance;
let KEY_PLAIN: Key, KEY_REG: Key, KEY_OTHER: Key, KEY_ADMIN: Key, KEY_CLAIM: Key;
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
const discovery = (id: string) => `/api/operators/${id}/discoverability`;
const stored = (id: string): Row => JSON.parse(JSON.stringify(getRepos().registrations.findById(id)));
const listed = (r: Row) => ({ id: r.id, status: r.status, name: r.name, createdAt: r.createdAt });
const forbidden = (write: Write) => ({ error: "forbidden", message: `You can only ${write === "PATCH" ? "edit" : write === "DELETE" ? "delete" : "prove"} your own registration` });
const readForbidden = { error: "forbidden", message: "You can only read your own registration's discoverability" };

function seed(wallet = WALLET_A, createdByKeyId: string | null = null, tenantId: string | null = null, extra: Partial<Row> = {}): Row {
  const n = ++sequence;
  return getRepos().registrations.insert({
    id: `reg-n345-${n}`, name: `N345 machine ${n}`, category: "custom", manufacturer: "Synthetic", model: "TestBot 9000",
    serialNumber: `serial-n345-${n}`, description: "Synthetic machine description", photos: ["synthetic-photo"],
    capabilities: [{ id: `cap-n345-${n}`, type: "custom", name: "Synthetic capability", description: "Test", materials: ["PLA"], params: [], source: "synthetic" }],
    spaceRequirements: { marker: "synthetic-space" }, pricing: { baseCost: "1", minimum: "0", currency: "USDC" },
    operator: { walletAddress: wallet, displayName: "Synthetic operator", certifications: [], trainingAcknowledgments: {} },
    complianceRegulations: ["N345-REG"], tenantId, createdByKeyId, status: "submitted",
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
function writeRequest(write: Write, id: string, headers: Headers, patch: Record<string, unknown> = {}) {
  return app.inject({
    method: write === "prove" ? "POST" : write,
    url: url(id) + (write === "prove" ? "/prove" : ""), headers,
    ...(write === "PATCH" ? { payload: { description: "n345 edit", ...patch } } : write === "prove" ? { payload: evidence } : {}),
  });
}
async function pass(write: Write, row: Row, headers: Headers) {
  const res = await writeRequest(write, row.id, headers);
  expect(res.statusCode, `${write}: ${res.body}`).toBe(200);
  const after = stored(row.id);
  if (write === "PATCH") expect(after.description).toBe("n345 edit");
  else expect(after.status).toBe(write === "DELETE" ? "deleted" : "active");
  return res;
}
async function refuse(write: Write, row: Row | string, headers: Headers, status = 403, body: unknown = forbidden(write), patch = {}) {
  const id = typeof row === "string" ? row : row.id;
  const before = typeof row === "string" ? undefined : stored(id);
  clearEffects();
  const res = await writeRequest(write, id, headers, patch);
  expect(res.statusCode, `${write}: ${res.body}`).toBe(status);
  expect(res.json()).toStrictEqual(body);
  expectNoEffects();
  if (before) expect(stored(id)).toStrictEqual(before);
}
async function refuseRead(id: string, headers: Headers, status = 403) {
  clearEffects();
  const res = await app.inject({ url: discovery(id), headers });
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json()).toStrictEqual(status === 404 ? { error: "not_found" } : readForbidden);
  expectNoEffects();
}
function otherCallers(): Headers[] {
  return [sessionB.key, sessionB.bearer, proof(WALLET_B),
    proof(WALLET_A, { "x-test-proven-wallet-via": "self-link:device" }),
    proof(WALLET_A, { "x-test-proven-wallet-via": "siwe" }),
    keyHeaders(KEY_CLAIM), keyHeaders(KEY_PLAIN),
    { ...keyHeaders(KEY_PLAIN), "x-posted-by": WALLET_A }];
}

async function makeSession(wallet: string): Promise<Session> {
  const token = `synthetic-session-n345-${wallet.toLowerCase()}`;
  const now = new Date().toISOString();
  getRepos().sessions.insert({ id: token, token, walletAddress: wallet.toLowerCase(),
    createdAt: now, lastActiveAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const headers = bearer(token);
  const minted = await app.inject({ method: "POST", url: "/api/auth/session-key", headers });
  expect(minted.statusCode, minted.body).toBe(201);
  const key = bearer(minted.json().api_key);
  const probe = await app.inject({ url: "/api/n345-test/authority", headers: key });
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
  delete process.env.TENANT_ENFORCE;
  closeStore();
  initStore({ seed: false });
  __resetScopeCacheForTests();
  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(cookie, { secret: "synthetic-n345-signed-cookie-secret" });
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
  await app.register(operatorsPublicRoutes);
  app.get("/api/n345-test/authority", async req => authorityOf(req));
  await app.ready();
  const key = (operatorId: string, scopes = ["operator:basic"]) => provisionApiKey({ operatorId, scopes });
  KEY_PLAIN = key("operator-n345-plain");
  KEY_REG = key("operator-n345-registrar");
  KEY_OTHER = key("operator-n345-other");
  KEY_ADMIN = key("operator-n345-admin", ["admin"]);
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

describe("registration owner access", () => {
  it("RH1 the harness carriers prove what they claim", async () => {
    for (const [wallet, session] of [[WALLET_A, sessionA], [WALLET_B, sessionB]] as const) {
      for (const [headers, via, carrier] of [
        [session.key, "siwe-session", "key"], [session.bearer, "siwe-session", "bearer-session"],
        [session.cookie, "siwe-session", "cookie"], [proof(wallet), "self-link:agent", "key"],
      ] as const) {
        const res = await app.inject({ url: "/api/n345-test/authority", headers });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ provenWallet: headers === session.key || headers === session.bearer || headers === session.cookie ? wallet.toLowerCase() : wallet,
          provenWalletVia: via, provenWalletCarrier: carrier });
      }
    }
    const row = seed(WALLET_B, KEY_REG.record!.id);
    const request = { headers: {}, raw: { rawHeaders: [] }, apiKeyId: ` ${KEY_REG.record!.id} ` } as unknown as FastifyRequest;
    expect(registrationAccess(request, row, "write")).toBe("owner");
    for (const id of [null, undefined, "", " ", KEY_REG.record!.id.toUpperCase()]) {
      expect(registrationAccess({ ...request, apiKeyId: id } as FastifyRequest, row, "write")).toBe("none");
    }
    expect(registrationAccess({ headers: {}, raw: { rawHeaders: [] } } as unknown as FastifyRequest, seed(), "write")).toBe("none");
  });

  it("RW1 the admin writes any registration, by the secret beside a key or by an admin-scope key", async () => {
    for (const headers of [admin(), keyHeaders(KEY_ADMIN)]) for (const wallet of [WALLET_A, ZERO, "operator-n345-not-a-wallet"])
      for (const write of writes) await pass(write, seed(wallet), headers);
    for (const headers of [admin(), keyHeaders(KEY_ADMIN)]) {
      const untouched = { get operator(): never { throw new Error("unreadable operator"); }, get createdByKeyId(): never { throw new Error("unreadable key"); } };
      expect(registrationAccess({ headers, raw: { rawHeaders: headers["x-admin-key"] ? ["x-admin-key", SECRET] : [] }, apiKeyId: KEY_ADMIN.record!.id } as unknown as FastifyRequest, untouched, "write")).toBe("admin");
    }
  });

  it("RW2 the proven owner writes by wallet session key, bearer session or self-link agent proof", async () => {
    for (const headers of [sessionA.key, sessionA.bearer, proof(WALLET_A.toLowerCase())])
      for (const write of writes) await pass(write, seed(), headers);
  });

  it("RW3 a proven wallet matches the stored wallet in any letter case", async () => {
    const upper = "0x" + WALLET_A.slice(2).toUpperCase();
    for (const [wallet, headers] of [[WALLET_A, proof(upper)], [WALLET_A.toLowerCase(), proof()], [upper, sessionA.key]] as const)
      for (const write of writes) await pass(write, seed(wallet), headers);
  });

  it("RW4 a cookie-only session that proves the row's wallet gets 403 on every write", async () => {
    for (const headers of [sessionA.cookie, proof(WALLET_A, { "x-test-proven-wallet-carrier": "none" })])
      for (const write of writes) await refuse(write, seed(), headers, 403, EXPLICIT_CREDENTIAL_REQUIRED);
    // Cookie-only authority is refused before either owner leg, including a recorded key.
    for (const write of writes) await refuse(write, seed(WALLET_A, KEY_PLAIN.record!.id),
      proof(WALLET_A, { "x-test-proven-wallet-carrier": "cookie" }), 403, EXPLICIT_CREDENTIAL_REQUIRED);
  });

  it("RW5 every other caller gets the route's 403 before any write or operator audit", async () => {
    for (const headers of otherCallers()) for (const write of writes)
      await refuse(write, seed(), headers, 403, forbidden(write), { walletAddress: WALLET_A, operatorId: WALLET_A });
    for (const headers of [
      { ...keyHeaders(KEY_PLAIN), "x-admin-key": "wrong-n345-secret" },
      { ...keyHeaders(KEY_ADMIN), "x-admin-key": "wrong-n345-secret" },
    ]) for (const write of writes) await refuse(write, seed(), headers);
    vi.stubEnv("PCC_ADMIN_KEY", "*");
    for (const write of writes) await refuse(write, seed(), { ...keyHeaders(KEY_PLAIN), "x-admin-key": "*" });
  });

  it("RW6 a row without a usable wallet or a recorded key is the admin's alone", async () => {
    const nonWalletKey = provisionApiKey({ operatorId: "operator-n345-not-a-wallet", scopes: ["operator:basic"] });
    for (const wallet of [ZERO, "", "operator-n345-not-a-wallet", WALLET_A.slice(0, -1)])
      for (const headers of [proof(ZERO), keyHeaders(nonWalletKey), sessionA.key])
        for (const write of writes) await refuse(write, seed(wallet), headers);
    for (const wallet of ["", "operator-n345-not-a-wallet", WALLET_A.slice(0, -1)])
      for (const write of writes) await refuse(write, seed(wallet), proof(wallet));
  });

  it("RW7 the registering key writes the rows it registered and no other key does", async () => {
    for (const write of writes) {
      await pass(write, seed(WALLET_B, KEY_REG.record!.id), keyHeaders(KEY_REG));
      await refuse(write, seed(WALLET_B, KEY_REG.record!.id), keyHeaders(KEY_OTHER));
      await refuse(write, seed(WALLET_B), keyHeaders(KEY_REG));
      await refuse(write, seed(WALLET_B, KEY_OTHER.record!.id), keyHeaders(KEY_REG));
    }
  });

  it("RW8 a missing registration is 404 on every write for every caller", async () => {
    for (const headers of [admin(), sessionA.key, sessionA.cookie, keyHeaders(KEY_PLAIN)])
      for (const write of writes) await refuse(write, "reg-n345-unknown", headers, 404, { error: "not_found" });
  });

  it("RW9 under TENANT_ENFORCE another tenant's row is 404 on the writes and on discoverability, the admin included", async () => {
    vi.stubEnv("TENANT_ENFORCE", "true");
    for (const headers of [admin(), sessionA.key, keyHeaders(KEY_REG)]) {
      const otherTenant = { ...headers, "x-test-tenant": "tenant-n345-b" };
      for (const write of writes) await refuse(write, seed(WALLET_A, KEY_REG.record!.id, "tenant-n345-a"), otherTenant, 404, { error: "not_found" });
      const row = seed(WALLET_A, KEY_REG.record!.id, "tenant-n345-a");
      await refuseRead(row.id, otherTenant, 404);
      expect(stored(row.id)).toStrictEqual(row);
      const sameTenant = { ...headers, "x-test-tenant": "tenant-n345-a" };
      for (const write of writes) await pass(write, seed(WALLET_A, KEY_REG.record!.id, "tenant-n345-a"), sameTenant);
      const res = await app.inject({ url: discovery(row.id), headers: sameTenant });
      expect(res.statusCode, res.body).toBe(200);
    }
  });

  it("RW10 an owner test that throws refuses every non-admin and still admits the admin", async () => {
    const row = seed(WALLET_A, KEY_REG.record!.id);
    const repos = getRepos().registrations;
    const original = repos.findById.bind(repos);
    const standIn = { ...row, get operator(): Row["operator"] { throw new Error("synthetic operator error"); },
      get createdByKeyId(): string { throw new Error("synthetic key error"); } };
    const spy = vi.spyOn(repos, "findById").mockImplementation(id => id === row.id ? standIn : original(id));
    try {
      for (const headers of [sessionA.key, keyHeaders(KEY_REG)]) {
        for (const write of writes) {
          clearEffects();
          const res = await writeRequest(write, row.id, headers);
          expect(res.statusCode, res.body).toBe(403);
          expect(res.json()).toStrictEqual(forbidden(write));
          expect(original(row.id)).toStrictEqual(row);
          expectNoEffects();
        }
        await refuseRead(row.id, headers);
        const detail = await app.inject({ url: url(row.id), headers });
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json()).toStrictEqual({ registration: listed(row) });
      }
      const res = await writeRequest("PATCH", row.id, admin());
      expect(res.statusCode, res.body).toBe(200);
      expect(original(row.id)?.description).toBe("n345 edit");
    } finally { spy.mockRestore(); }
    // A throw from authorityOf also refuses, and no row member is needed by the admin.
    const req = { headers: {}, raw: { rawHeaders: [] }, get provenWallet(): never { throw new Error("synthetic proof error"); } } as unknown as FastifyRequest;
    expect(registrationAccess(req, row, "write")).toBe("none");
    const keyGetter = { ...row, get createdByKeyId(): never { throw new Error("synthetic key error"); } };
    expect(registrationAccess({ headers: {}, raw: { rawHeaders: [] }, apiKeyId: KEY_REG.record!.id } as unknown as FastifyRequest, keyGetter, "read")).toBe("none");
  });

  it("RR1 discoverability answers the admin and the proven owner by any carrier, the cookie included", async () => {
    const row = seed();
    for (const headers of [admin(), sessionA.key, sessionA.bearer, sessionA.cookie, proof()]) {
      const res = await app.inject({ url: discovery(row.id), headers });
      expect(res.statusCode, res.body).toBe(200);
      expect(Object.keys(res.json()).sort()).toStrictEqual(["operatorId", "indexed_at", "last_match_query_at", "top_keyword_misses", "suggestions", "data_quality"].sort());
      expect(res.json().operatorId).toBe(row.id);
    }
  });

  it("RR2 discoverability gives every other caller 403 before the match log is read", async () => {
    const row = seed();
    vi.mocked(listMatchQueriesForOperator).mockClear();
    for (const headers of [...otherCallers(), sessionB.cookie]) await refuseRead(row.id, headers);
    expect(listMatchQueriesForOperator).not.toHaveBeenCalled();
    expect(stored(row.id)).toStrictEqual(row);
  });

  it("RR3 discoverability answers the registering key and gives 404 for a missing row", async () => {
    const row = seed(WALLET_A, KEY_REG.record!.id);
    const res = await app.inject({ url: discovery(row.id), headers: keyHeaders(KEY_REG) });
    expect(res.statusCode, res.body).toBe(200);
    await refuseRead(row.id, keyHeaders(KEY_OTHER));
    for (const headers of [admin(), sessionA.key]) await refuseRead("reg-n345-unknown", headers, 404);
  });

  it("RR4 the detail read gives the admin and the owner the stored row and everyone else the listing's fields", async () => {
    const row = seed(WALLET_A, KEY_REG.record!.id);
    for (const headers of [admin(), sessionA.key, sessionA.cookie, proof(), keyHeaders(KEY_REG)]) {
      const res = await app.inject({ url: url(row.id), headers });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toStrictEqual({ registration: stored(row.id) });
      expect(res.json().registration.createdByKeyId).toBe(KEY_REG.record!.id);
    }
    for (const headers of [keyHeaders(KEY_PLAIN), keyHeaders(KEY_OTHER), sessionB.key, keyHeaders(KEY_CLAIM)]) {
      const res = await app.inject({ url: url(row.id), headers });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toStrictEqual({ registration: listed(row) });
    }
  });

  it("RR5 every admitted write replies with the full row", async () => {
    for (const [headers, keyId] of [[sessionA.key, null], [keyHeaders(KEY_REG), KEY_REG.record!.id]] as const) {
      const patch = await pass("PATCH", seed(WALLET_A, keyId), headers);
      expect(patch.json().registration).toStrictEqual(stored(patch.json().registration.id));
      const row = seed(WALLET_A, keyId);
      const deleted = await pass("DELETE", row, headers);
      expect(Object.keys(deleted.json().registration).sort()).toStrictEqual(Object.keys(stored(row.id)).sort());
      expect(deleted.json().registration.createdByKeyId).toBe(keyId);
      expect(deleted.json().registration.status).toBe("deleted");
      const again = await writeRequest("DELETE", row.id, headers);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toStrictEqual({ registration: stored(row.id), alreadyDeleted: true });
      const provedRow = seed(WALLET_A, keyId);
      const proved = await pass("prove", provedRow, headers);
      expect(Object.keys(proved.json().registration).sort()).toStrictEqual(Object.keys(stored(provedRow.id)).sort());
      expect(proved.json().registration.createdByKeyId).toBe(keyId);
      expect(proved.json().registration.status).toBe("active");
    }
  });

  function registerInCell() {
    const ids = new Set<string>();
    let previous = 0;
    return async (headers: Headers, extra = {}) => {
      if (ids.size) while (Date.now() <= previous) await new Promise(resolve => setTimeout(resolve, 2));
      previous = Date.now();
      const res = await app.inject({ method: "POST", url: "/api/onboard/register", headers, payload: {
        name: "Test Printer", category: "fdm", manufacturer: "Test Co", model: "TestBot",
        complianceRegulations: ["N345-REG"], operator: { walletAddress: WALLET_B, displayName: "Test Operator", certifications: [], trainingAcknowledgments: {} }, ...extra,
      } });
      expect(res.statusCode, res.body).toBe(200);
      const id = res.json().registration.id;
      previous = Number(id.slice("reg-".length));
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      expect(getRepos().registrations.findById(id)).toBeDefined();
      return res;
    };
  }

  it("RG1 register records the calling key's id and never a value from the body", async () => {
    const register = registerInCell();
    for (const [headers, keyId] of [[keyHeaders(KEY_REG), KEY_REG.record!.id], [sessionA.key, sessionA.keyId], [sessionA.bearer, null], [sessionA.cookie, null]] as const) {
      const res = await register(headers, { createdByKeyId: KEY_OTHER.record!.id, created_by_key_id: KEY_OTHER.record!.id });
      const registration = res.json().registration;
      expect(stored(registration.id).createdByKeyId).toBe(keyId);
      expect(registration).not.toHaveProperty("createdByKeyId");
      expect(registration).not.toHaveProperty("created_by_key_id");
    }
  });

  it("RG2 a machine registered by a key is that key's to write", async () => {
    const register = registerInCell();
    const first = (await register(keyHeaders(KEY_REG))).json().registration.id;
    const second = (await register(keyHeaders(KEY_REG))).json().registration.id;
    await pass("PATCH", stored(first), keyHeaders(KEY_REG));
    const res = await app.inject({ url: discovery(first), headers: keyHeaders(KEY_REG) });
    expect(res.statusCode, res.body).toBe(200);
    await pass("prove", stored(second), keyHeaders(KEY_REG));
    await pass("DELETE", stored(second), keyHeaders(KEY_REG));
    for (const headers of [keyHeaders(KEY_PLAIN), sessionA.key]) for (const write of writes) {
      await refuse(write, stored(first), headers);
      await refuse(write, stored(second), headers);
    }
  });

  it("RG3 a PATCH body cannot set the recorded key", async () => {
    for (const [headers, keyId] of [[sessionA.key, null], [keyHeaders(KEY_REG), KEY_REG.record!.id]] as const) {
      const row = seed(WALLET_A, keyId);
      const res = await writeRequest("PATCH", row.id, headers, { createdByKeyId: KEY_OTHER.record!.id, created_by_key_id: KEY_OTHER.record!.id });
      expect(res.statusCode, res.body).toBe(200);
      expect(stored(row.id).createdByKeyId).toBe(keyId);
    }
  });

  it("RD1 by-compliance hides the gateway's own status notes and keeps an operator's text", async () => {
    const descriptions = ["PROVED: {}", "REJECTED: synthetic reason", "DELETED at 2026-11-16T00:00:00.000Z by admin",
      "An operator's own words", "Our machine PROVED: fast", "proved: lower case"];
    const rows = descriptions.map(description => seed(WALLET_A, null, null, { status: "approved", description }));
    const res = await app.inject({ url: "/api/operators/by-compliance/N345-REG", headers: keyHeaders(KEY_PLAIN) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().count).toBe(rows.length);
    for (const [i, row] of rows.entries()) {
      expect(res.json().operators.find((r: { id: string }) => r.id === row.id)).toStrictEqual({
        id: row.id, name: row.name, category: row.category, manufacturer: row.manufacturer, model: row.model,
        description: i < 3 ? null : descriptions[i], photos: row.photos,
        capabilities: row.capabilities.map(c => ({ id: c.id, type: c.type, name: c.name, materials: c.materials })),
        complianceRegulations: row.complianceRegulations, status: row.status, createdAt: row.createdAt,
      });
    }
  });

  it("RD2 delete records the role, and the audit keeps the actor", async () => {
    for (const [headers, role, keyId, actor] of [
      [admin(), "admin", KEY_PLAIN.record!.id, "operator-n345-plain"],
      [sessionA.key, "owner", sessionA.keyId, WALLET_A.toLowerCase()],
      [keyHeaders(KEY_REG), "owner", KEY_REG.record!.id, "operator-n345-registrar"],
    ] as const) {
      const row = seed(WALLET_A, role === "admin" ? null : keyId);
      clearEffects();
      const res = await pass("DELETE", row, headers);
      const description = stored(row.id).description!;
      expect(description).toBe(`DELETED at ${res.json().deletedAt} by ${role} — original: ${row.description}`);
      for (const marker of [keyId, actor, WALLET_A]) expect(description.toLowerCase()).not.toContain(marker.toLowerCase());
      expect(auditLog.mock.calls.filter(([event]) => event.eventType === "operator.deleted").map(([event]) => event.actor)).toStrictEqual([actor]);
    }
  });
});
