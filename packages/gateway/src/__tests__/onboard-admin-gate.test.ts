import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, type MockInstance } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { getRepos } from "../db.js";
import { auditService } from "../services/audit-service.js";
import { isOnboardAdmin } from "../routes/onboard.js";

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

const secret = "synthetic-admin-secret-n344";
const ownerId = "MARK-n344-owner-wallet";
const TA = "TA";
const TB = "TB";
const actions = ["approve", "reject", "activate"] as const;
const listedKeys = ["createdAt", "id", "name", "status"];
const evidence = { evidence: { deviceHealth: { status: "idle", model: "TestBot 9000", firmware: "1.0" } } };
type Key = ReturnType<typeof provisionApiKey>;
type Headers = Record<string, string>;
type Row = NonNullable<ReturnType<ReturnType<typeof getRepos>["registrations"]["findById"]>>;
let app: FastifyInstance;
let adminKey: Key;
let wildcardKey: Key;
let mixedKey: Key;
let strangerKey: Key;
let ownerKey: Key;
let taAdminKey: Key;
let tbAdminKey: Key;
let tbStrangerKey: Key;
let session: Headers;
let findById: MockInstance<[string], Row | undefined>;
let auditLog: MockInstance<Parameters<typeof auditService.log>, ReturnType<typeof auditService.log>>;
let sequence = 0;

function restoreEnv() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "false");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("TENANT_ENFORCE", "");
  delete process.env.TENANT_ENFORCE;
}

const bearer = (key: Key): Headers => ({ authorization: `Bearer ${key.rawKey}` });
const withAdmin = (key: Key): Headers => ({ ...bearer(key), "x-admin-key": secret });
const url = (id: string, action?: string) => `/api/onboard/registrations/${id}${action ? `/${action}` : ""}`;
const stored = (id: string): Row => JSON.parse(JSON.stringify(getRepos().registrations.findById(id)));
const listed = (row: Row) => ({ id: row.id, status: row.status, name: row.name, createdAt: row.createdAt });

function seed(status = "submitted", tenantId?: string): Row {
  const n = ++sequence;
  const mark = (column: string) => `MARK-n344-${n}-${column}`;
  const row = getRepos().registrations.insert({
    id: `reg-n344-${n}`,
    name: `Synthetic machine ${n}`,
    category: mark("category"),
    manufacturer: mark("manufacturer"),
    model: mark("model"),
    serialNumber: mark("serialNumber"),
    description: mark("description"),
    photos: [mark("photos")],
    capabilities: [{
      id: mark("capabilities"), type: "custom", name: "Synthetic capability",
      description: "Synthetic description", materials: [], params: [], source: "synthetic",
    }],
    spaceRequirements: { marker: mark("spaceRequirements") },
    pricing: { baseCost: mark("pricing"), minimum: "0", currency: "USDC" },
    operator: { walletAddress: ownerId, displayName: mark("operator"), certifications: [], trainingAcknowledgments: {} },
    complianceRegulations: [mark("complianceRegulations")],
    tenantId: tenantId ?? mark("tenantId"),
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    submittedAt: mark("submittedAt"),
    approvedAt: mark("approvedAt"),
  });
  expect(row).toBeDefined();
  return row!;
}

function clearSpies() {
  findById.mockClear();
  auditLog.mockClear();
}

function expectNoOperatorAudit() {
  expect(auditLog.mock.calls.filter(([event]) => event.eventType.startsWith("operator."))).toEqual([]);
}

function expectProjection(res: { statusCode: number; body: string; json(): { registration: unknown } }, row: Row) {
  expect(res.statusCode).toBe(200);
  const registration = res.json().registration;
  expect(Object.keys(registration as object).sort()).toEqual(listedKeys);
  expect(registration).toEqual(listed(row));
  expect(res.body).not.toContain("MARK-n344");
}

async function expectRefused(id: string, action: typeof actions[number], headers: Headers) {
  clearSpies();
  const res = await app.inject({ method: "POST", url: url(id, action), headers });
  // Admins only: 403 otherwise, before any registration read or operator audit.
  expect(findById).not.toHaveBeenCalled();
  expectNoOperatorAudit();
  expect(res.statusCode).toBe(403);
  expect(res.body).toBe('{"error":"forbidden"}');
}

async function expectStateWrite(action: typeof actions[number], headers: Headers, tenantId?: string) {
  const before = seed(action === "activate" ? "approved" : "submitted", tenantId);
  clearSpies();
  const res = await app.inject({
    method: "POST", url: url(before.id, action), headers,
    ...(action === "reject" ? { payload: { reason: "synthetic reason" } } : {}),
  });
  expect(res.statusCode).toBe(200);
  const after = stored(before.id);
  if (action === "approve") {
    expect(res.json()).toEqual({ registration: before, approved: true });
    expect(after).toEqual({ ...before, status: "approved", approvedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(after.approvedAt!))).toBe(false);
  } else if (action === "reject") {
    expect(res.json()).toEqual({ registration: before, rejected: true });
    expect(after).toEqual({ ...before, status: "rejected", description: "REJECTED: synthetic reason" });
  } else {
    expect(res.json()).toEqual({ registration: { ...before, status: "active" }, activated: true });
    expect(after).toEqual({ ...before, status: "active" });
  }
}

beforeAll(async () => {
  restoreEnv();
  const server = await import("../server.js");
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  const key = (operatorId: string, scopes: string[]) => provisionApiKey({ operatorId, name: `synthetic-n344-${operatorId}`, scopes });
  adminKey = key("synthetic-n344-admin", ["admin"]);
  expect(adminKey.record).toBeDefined();
  wildcardKey = key("synthetic-n344-wildcard", ["*"]);
  mixedKey = key("synthetic-n344-mixed", ["*", "admin"]);
  strangerKey = key("synthetic-n344-stranger", ["operator:basic"]);
  ownerKey = key(ownerId, ["operator:basic"]);
  taAdminKey = key(TA, ["admin"]);
  tbAdminKey = key(TB, ["admin"]);
  tbStrangerKey = key(TB, ["operator:basic"]);
  const token = "synthetic-n344-session";
  const now = Date.now();
  getRepos().sessions.insert({
    id: token, token, walletAddress: "0x1111111111111111111111111111111111111111",
    createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
  });
  session = { cookie: `pcc_session=${app.signCookie(token)}` };
  findById = vi.spyOn(getRepos().registrations, "findById");
  auditLog = vi.spyOn(auditService, "log");
}, 180_000);

beforeEach(() => { restoreEnv(); clearSpies(); });
afterAll(async () => {
  try { await app?.close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe("onboard admin gates and registration replies", () => {
  it("OA1 admins receive the stored row on detail", async () => {
    const row = seed();
    for (const headers of [bearer(adminKey), withAdmin(strangerKey)]) {
      clearSpies();
      const res = await app.inject({ url: url(row.id), headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ registration: stored(row.id) });
    }
  });

  it("OA2 non-admins receive exactly the listing's fields on detail", async () => {
    const row = seed();
    for (const headers of [bearer(strangerKey), bearer(ownerKey), session]) {
      clearSpies();
      const res = await app.inject({ url: url(row.id), headers });
      expectProjection(res, row);
      clearSpies();
      const listing = await app.inject({ url: "/api/onboard/registrations" });
      expect(listing.statusCode).toBe(200);
      expect(res.json().registration).toEqual(listing.json().registrations.find((r: { id: string }) => r.id === row.id));
    }
  });

  it("OA3 a wrong admin header gives the listing's fields and 403 before any state read", async () => {
    for (const key of [adminKey, strangerKey]) {
      const headers = { ...bearer(key), "x-admin-key": "synthetic-n344-wrong" };
      const row = seed();
      clearSpies();
      expectProjection(await app.inject({ url: url(row.id), headers }), row);
      for (const action of actions) {
        const target = seed(action === "activate" ? "approved" : "submitted");
        await expectRefused(target.id, action, headers);
      }
    }
  });

  it("OA4 wildcard forms give the listing's fields and 403 before any state read", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", "*");
    for (const headers of [{ ...bearer(strangerKey), "x-admin-key": "*" }, bearer(mixedKey), bearer(wildcardKey)]) {
      const row = seed();
      clearSpies();
      expectProjection(await app.inject({ url: url(row.id), headers }), row);
      for (const action of actions) {
        const target = seed(action === "activate" ? "approved" : "submitted");
        await expectRefused(target.id, action, headers);
      }
    }
  });

  it("OA5 missing detail is 200 not_found for admins and non-admins", async () => {
    seed();
    for (const headers of [bearer(adminKey), bearer(strangerKey)]) {
      clearSpies();
      const res = await app.inject({ url: url("missing-n344"), headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it.each(actions)("OA6 %s is admins only: 403 otherwise, before any read or operator audit", async (action) => {
    for (const headers of [bearer(strangerKey), bearer(ownerKey), session]) {
      const row = seed(action === "activate" ? "approved" : "submitted");
      await expectRefused(row.id, action, headers);
      expect(stored(row.id)).toEqual(row);
    }
  });

  it("OA7 admins receive the state reply and write for approve, reject and activate", async () => {
    for (const headers of [bearer(adminKey), withAdmin(strangerKey)]) {
      for (const action of actions) await expectStateWrite(action, headers);
    }
  });

  it("OA8 missing state targets give non-admins 403 and admins 404", async () => {
    seed();
    for (const action of actions) {
      await expectRefused("missing-n344", action, bearer(strangerKey));
      clearSpies();
      const res = await app.inject({ method: "POST", url: url("missing-n344", action), headers: bearer(adminKey) });
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('{"error":"not_found"}');
    }
  });

  it("OA9 TENANT_ENFORCE makes another tenant's row missing, admins included", async () => {
    vi.stubEnv("TENANT_ENFORCE", "true");
    for (const headers of [bearer(tbAdminKey), withAdmin(tbStrangerKey)]) {
      const row = seed("submitted", TA);
      clearSpies();
      const res = await app.inject({ url: url(row.id), headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ error: "not_found" });
      expect(stored(row.id)).toEqual(row);
      for (const action of actions) {
        const target = seed(action === "activate" ? "approved" : "submitted", TA);
        clearSpies();
        const refused = await app.inject({ method: "POST", url: url(target.id, action), headers });
        expect(refused.statusCode).toBe(404);
        expect(refused.body).toBe('{"error":"not_found"}');
        expectNoOperatorAudit();
        expect(stored(target.id)).toEqual(target);
      }
    }
    const row = seed("submitted", TA);
    clearSpies();
    const detail = await app.inject({ url: url(row.id), headers: bearer(taAdminKey) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ registration: stored(row.id) });
    for (const action of ["approve", "activate", "reject"] as const) await expectStateWrite(action, bearer(taAdminKey), TA);
    delete process.env.TENANT_ENFORCE;
    const crossTenant = seed("submitted", TA);
    clearSpies();
    const unscoped = await app.inject({ url: url(crossTenant.id), headers: bearer(tbAdminKey) });
    expect(unscoped.statusCode).toBe(200);
    expect(unscoped.json()).toEqual({ registration: stored(crossTenant.id) });
    await expectStateWrite("approve", bearer(tbAdminKey), TA);
  });

  it("OA10 owner PATCH, DELETE, repeated DELETE and prove replies carry the listing's fields", async () => {
    const headers = bearer(ownerKey);
    const patchRow = seed();
    clearSpies();
    const patch = await app.inject({ method: "PATCH", url: url(patchRow.id), headers, payload: {} });
    expectProjection(patch, patchRow);
    expect(stored(patchRow.id)).toEqual(patchRow);
    const deleteRow = seed();
    clearSpies();
    const deleted = await app.inject({ method: "DELETE", url: url(deleteRow.id), headers });
    expectProjection(deleted, { ...deleteRow, status: "deleted" });
    expect(deleted.json()).toMatchObject({ soft: true, deletedAt: expect.any(String) });
    expect(stored(deleteRow.id).status).toBe("deleted");
    clearSpies();
    const again = await app.inject({ method: "DELETE", url: url(deleteRow.id), headers });
    expectProjection(again, { ...deleteRow, status: "deleted" });
    expect(again.json().alreadyDeleted).toBe(true);
    const proveRow = seed();
    clearSpies();
    const proved = await app.inject({ method: "POST", url: url(proveRow.id, "prove"), headers, payload: evidence });
    expectProjection(proved, { ...proveRow, status: "active" });
    expect(proved.json()).toMatchObject({ autoApproved: true, activated: true });
    expect(stored(proveRow.id).status).toBe("active");
  });

  it("OA11 owner with a valid admin header receives the full mutation replies", async () => {
    const headers = withAdmin(ownerKey);
    const patchRow = seed();
    clearSpies();
    const patch = await app.inject({ method: "PATCH", url: url(patchRow.id), headers, payload: {} });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ registration: stored(patchRow.id) });
    const deleteRow = seed();
    clearSpies();
    const deleted = await app.inject({ method: "DELETE", url: url(deleteRow.id), headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ registration: { ...deleteRow, status: "deleted" }, soft: true, deletedAt: expect.any(String) });
    clearSpies();
    const again = await app.inject({ method: "DELETE", url: url(deleteRow.id), headers });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ registration: stored(deleteRow.id), alreadyDeleted: true });
    const proveRow = seed();
    clearSpies();
    const proved = await app.inject({ method: "POST", url: url(proveRow.id, "prove"), headers, payload: evidence });
    expect(proved.statusCode).toBe(200);
    const body = proved.json();
    expect(body.registration).toEqual({ ...proveRow, status: "active", approvedAt: expect.any(String) });
    expect(body.registration.approvedAt).toBe(stored(proveRow.id).approvedAt);
    expect(body).toMatchObject({ autoApproved: true, activated: true });
  });

  it("OA12 duplicate admin fields refuse without key fallback, and helper errors refuse", () => {
    seed();
    const duplicate = {
      raw: { rawHeaders: ["X-Admin-Key", secret, "X-Admin-Key", secret] },
      headers: { "x-admin-key": `${secret}, ${secret}` },
      apiKeyId: adminKey.record!.id,
    } as unknown as FastifyRequest;
    expect(isOnboardAdmin(duplicate)).toBe(false);
    const noHeader = { raw: { rawHeaders: [] }, headers: {}, apiKeyId: adminKey.record!.id } as unknown as FastifyRequest;
    expect(isOnboardAdmin(noHeader)).toBe(true);
    const throwing = { get raw() { throw new Error("synthetic-n344-request-error"); } } as unknown as FastifyRequest;
    expect(isOnboardAdmin(throwing)).toBe(false);
  });
});
