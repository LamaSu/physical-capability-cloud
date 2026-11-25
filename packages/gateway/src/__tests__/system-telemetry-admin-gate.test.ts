import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { isAdminCaller } from "../auth/admin-caller.js";
import { getRepos } from "../db.js";
import { getKernelFacade, getJobFacade } from "../facades/index.js";
import { auditService } from "../services/audit-service.js";
import { isAgentBridgeReady } from "../agent-bridge.js";

vi.mock("../agent-bridge.js", async (original) => {
  const real = await original<typeof import("../agent-bridge.js")>();
  return { ...real, isAgentBridgeReady: vi.fn(real.isAgentBridgeReady) };
});

const path = "/api/telemetry/system";
const secret = "synthetic-admin-secret-n339";
let app: FastifyInstance;
let keys: ReturnType<typeof provisionApiKey>[];
let readSpies: Record<string, { mockClear(): unknown }> = {};

function restoreEnv() {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PCC_DB_PATH", ":memory:");
  vi.stubEnv("PCC_SEED_DATA", "false");
  vi.stubEnv("SERVE_DASHBOARD", "false");
  vi.stubEnv("PCC_ADMIN_KEY", secret);
  vi.stubEnv("TENANT_ENFORCE", "");
  delete process.env.TENANT_ENFORCE;
}

const bearer = (index = 0) => ({ authorization: `Bearer ${keys[index].rawKey}` });

function request(headers: Record<string, string>, method: "GET" | "HEAD" = "GET") {
  for (const spy of Object.values(readSpies)) spy.mockClear();
  return app.inject({ method, url: path, headers });
}

function expectNoRead() {
  for (const [name, spy] of Object.entries(readSpies)) expect(spy, name).not.toHaveBeenCalled();
}

async function expectForbidden(headers: Record<string, string>) {
  const res = await request(headers);
  expectNoRead();
  expect(res.statusCode).toBe(403);
  expect(res.body).toBe('{"error":"forbidden"}');
}

function expectShape(res: Awaited<ReturnType<typeof request>>) {
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(Object.keys(body).sort()).toEqual(["timestamp", "uptime_seconds", "response_ms", "db", "agents", "audit", "env"].sort());
  expect(Object.keys(body.db).sort()).toEqual(["kernels", "devices", "jobs", "evidence", "registrations", "capabilities"].sort());
}

beforeAll(async () => {
  restoreEnv();
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keys = [["admin"], ["*"], ["*", "admin"], ["operator:basic"], ["admin", "*"]].map((scopes, index) =>
    provisionApiKey({ operatorId: `synthetic-n339-operator-${index}`, name: `synthetic-n339-key-${index}`, scopes }),
  );
  const repos = getRepos();
  readSpies = {
    "kernelFacade.list": vi.spyOn(getKernelFacade(), "list"),
    "jobFacade.list": vi.spyOn(getJobFacade(), "list"),
    "evidence.findAll": vi.spyOn(repos.evidence, "findAll"),
    "kernels.findAll": vi.spyOn(repos.kernels, "findAll"),
    "capabilities.findAll": vi.spyOn(repos.capabilities, "findAll"),
    ...(repos.registrations ? { "registrations.findAll": vi.spyOn(repos.registrations, "findAll") } : {}),
    "auditService.query": vi.spyOn(auditService, "query"),
    isAgentBridgeReady: vi.mocked(isAgentBridgeReady),
  };
}, 180_000);

beforeEach(restoreEnv);

afterAll(async () => {
  try { await app?.close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});

describe("system telemetry is admin only, with 403 before any read otherwise", () => {
  it("SG1 an admin-scope key receives the system shape and exercises the read spies", async () => {
    expectShape(await request(bearer()));
    expect(readSpies["kernelFacade.list"]).toHaveBeenCalledTimes(1);
    expect(readSpies["auditService.query"]).toHaveBeenCalledTimes(1);
    expect(Object.keys(readSpies).sort()).toEqual([
      "kernelFacade.list", "jobFacade.list", "evidence.findAll", "kernels.findAll",
      "capabilities.findAll", "registrations.findAll", "auditService.query", "isAgentBridgeReady",
    ].sort());
    for (const [name, spy] of Object.entries(readSpies)) expect(spy, name).toHaveBeenCalled();
  });

  it("SG2 a self-service key with one valid admin header receives the system shape", async () => {
    expectShape(await request({ ...bearer(3), "x-admin-key": secret }));
  });

  it("SG3 a self-service key or session receives 403 before any read, including HEAD", async () => {
    await expectForbidden(bearer(3));
    const token = "synthetic-n339-session";
    const now = Date.now();
    getRepos().sessions.insert({ id: token, token, walletAddress: "0x1111111111111111111111111111111111111111", createdAt: new Date(now).toISOString(), lastActiveAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() });
    await expectForbidden({ cookie: `pcc_session=${app.signCookie(token)}` });
    expectShape(await request({ cookie: `pcc_session=${app.signCookie(token)}`, "x-admin-key": secret }));
    const head = await request(bearer(3), "HEAD");
    expectNoRead();
    expect(head.statusCode).toBe(403);
  });

  it("SG4 a self-service key with a wrong admin header receives 403 before any read", async () => {
    await expectForbidden({ ...bearer(3), "x-admin-key": "synthetic-wrong-n339" });
  });

  it("SG5 a wrong admin header receives 403 before any read despite an admin-scope key", async () => {
    await expectForbidden({ ...bearer(), "x-admin-key": "synthetic-wrong-n339" });
  });

  it("SG6 a wildcard admin secret receives 403 before any read", async () => {
    vi.stubEnv("PCC_ADMIN_KEY", "*");
    await expectForbidden({ ...bearer(3), "x-admin-key": "*" });
  });

  it("SG7 wildcard scopes with admin receive 403 before any read", async () => {
    await expectForbidden(bearer(2));
    expect(JSON.parse(keys[4].record!.scopes)).toEqual(["admin", "*"]);
    await expectForbidden(bearer(4));
  });

  it("SG8 a wildcard-only key receives 403 before any read", async () => {
    await expectForbidden(bearer(1));
  });

  it("SG9 TENANT_ENFORCE gives every admin 403 before any read and is checked per request", async () => {
    vi.stubEnv("TENANT_ENFORCE", "true");
    await expectForbidden(bearer());
    await expectForbidden({ ...bearer(3), "x-admin-key": secret });
    delete process.env.TENANT_ENFORCE;
    expectShape(await request(bearer()));
    vi.stubEnv("TENANT_ENFORCE", "false");
    expectShape(await request(bearer()));
    for (const flag of ["TRUE", " true", "1"]) {
      vi.stubEnv("TENANT_ENFORCE", flag);
      expectShape(await request(bearer()));
    }
  });

  it("SG10 duplicate admin fields are refused without falling through to admin scopes", () => {
    const adminKey = keys[0].record;
    if (!adminKey) throw new Error("Admin key record required");
    const req = {
      raw: { rawHeaders: ["X-Admin-Key", secret, "x-admin-key", secret] },
      headers: { "x-admin-key": `${secret}, ${secret}` },
      apiKeyId: adminKey.id,
    } as unknown as FastifyRequest;
    expect(isAdminCaller(req)).toBe(false);
    req.raw.rawHeaders = [];
    delete req.headers["x-admin-key"];
    expect(isAdminCaller(req)).toBe(true);
  });

  it("SG11 an empty, all-space or unset admin secret grants no one access, 403 before any read", async () => {
    for (const blank of ["", "   "]) {
      vi.stubEnv("PCC_ADMIN_KEY", blank);
      await expectForbidden({ ...bearer(3), "x-admin-key": blank });
    }
    delete process.env.PCC_ADMIN_KEY;
    expect(Object.keys(process.env)).not.toContain("PCC_ADMIN_KEY");
    await expectForbidden({ ...bearer(3), "x-admin-key": "" });
    await expectForbidden({ ...bearer(3), "x-admin-key": "undefined" });
  });

  it("SG12 the admin test refuses when it cannot read the request", () => {
    const req = {
      get raw() { throw new Error("synthetic unreadable request"); },
    } as unknown as FastifyRequest;
    expect(isAdminCaller(req)).toBe(false);
    const adminKey = keys[0].record;
    if (!adminKey) throw new Error("Admin key record required");
    const unreadable = {
      apiKeyId: adminKey.id,
      headers: {},
      get raw() { throw new Error("synthetic unreadable admin request"); },
    } as unknown as FastifyRequest;
    expect(isAdminCaller(unreadable)).toBe(false);
    const missingRaw = {
      apiKeyId: adminKey.id,
      headers: {},
    } as unknown as FastifyRequest;
    expect(isAdminCaller(missingRaw)).toBe(false);
  });
});
