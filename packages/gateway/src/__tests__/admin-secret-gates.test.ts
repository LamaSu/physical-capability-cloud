/**
 * WP-A round 5 (coord-watch #2883, board N2 / MUST-CLOSE 9): privileged handlers
 * are gated on the admin SECRET, not on an operatorId allowlist.
 *
 * It runs on the real server (createGateway: apiGate + scope-checker + every real
 * route, in-memory DB, PCC_ADMIN_KEY set). An identity on every old allowlist
 * (AUDIT_ADMINS, PCC_DEMAND_ADMINS, PCC_OBSERVABILITY_ADMINS,
 * PCC_TOOL_INDEX_ADMINS, PCC_AGGREGATOR_ADMINS) holds a legacy key, which is the
 * case identity binding cannot undo for keys minted before it. That key must grant
 * nothing without the secret. A wrong secret is 403; the right one opens the
 * route. Audit reads stay scoped to the caller.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
const SECRET = "admin-secret-gates-test-key-0123456789";
process.env.PCC_ADMIN_KEY = SECRET;
const ALLOWLISTED = "allowlisted-admin@x.test";
for (const v of ["AUDIT_ADMINS", "PCC_DEMAND_ADMINS", "PCC_OBSERVABILITY_ADMINS", "PCC_TOOL_INDEX_ADMINS", "PCC_AGGREGATOR_ADMINS"]) {
  process.env[v] = ALLOWLISTED;
}

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string, scopes: string[]): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `admin-gates-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(scopes),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

const inj = (method: string, url: string, raw: string, headers: Record<string, string> = {}, payload?: unknown) =>
  app.inject({
    method: method as never,
    url,
    remoteAddress: `10.88.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: payload as never,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });
const secret = { "x-admin-key": SECRET };
const wrongSecret = { "x-admin-key": "not-the-admin-key" };

let allowlisted: string; // a legacy key for an allowlisted identity
let allowlistedAdmin: string; // the same identity with an explicit `admin` scope (/api/admin/** needs one)
let tenantB: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  const { auditService } = await import("../services/audit-service.js");
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready();
  allowlisted = seedKey(ALLOWLISTED, ["operator"]);
  allowlistedAdmin = seedKey(ALLOWLISTED, ["operator", "admin"]);
  tenantB = seedKey("tenant-b@x.test", ["operator"]);
  auditService.log({
    eventType: "admin_gates.tenant_b_private",
    actor: "tenant-b@x.test",
    resourceType: "test",
    resourceId: "b-1",
    action: "create",
  } as never);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe("audit reads: scoped to the caller unless the admin secret is presented", () => {
  it("[neg] an allowlisted operatorId asking for another tenant's log sees only its own entries", async () => {
    const res = await inj("GET", "/api/audit/log?actor=tenant-b@x.test&limit=1000", allowlisted);
    expect(res.statusCode).toBe(200);
    expect(res.json().scoped).toBe(true);
    expect(res.body).not.toContain("admin_gates.tenant_b_private");
  });

  it("[neg] a wrong secret is refused (403), never downgraded; the right one gives the cross-tenant view", async () => {
    expect((await inj("GET", "/api/audit/log?actor=tenant-b@x.test", allowlisted, wrongSecret)).statusCode).toBe(403);
    const admin = await inj("GET", "/api/audit/log?actor=tenant-b@x.test&limit=1000", tenantB, secret);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().scoped).toBe(false);
    expect(admin.body).toContain("admin_gates.tenant_b_private");
  });

  it("[neg] global audit stats need the secret; otherwise the counts are the caller's own", async () => {
    const own = await inj("GET", "/api/audit/stats", allowlisted);
    expect(own.statusCode).toBe(200);
    expect(own.json().scoped).toBe(true);
    expect(own.body).not.toContain("admin_gates.tenant_b_private");
    const global = await inj("GET", "/api/audit/stats", allowlisted, secret);
    expect(global.statusCode).toBe(200);
    expect(global.json().scoped).toBe(false);
    expect(global.body).toContain("admin_gates.tenant_b_private");
  });
});

describe("admin handlers: an allowlisted identity grants nothing without the secret", () => {
  it.each<[string, string, string, unknown?]>([
    ["demand status", "GET", "/api/admin/demand/status"],
    ["observability feedback view", "GET", "/api/admin/observability/feedback"],
  ])("[neg] %s: 401 without the secret, 403 with a wrong one, 200 with it", async (_name, method, url) => {
    const none = await inj(method, url, allowlistedAdmin);
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toBe("admin_key_required");
    expect((await inj(method, url, allowlistedAdmin, wrongSecret)).statusCode).toBe(403);
    expect((await inj(method, url, allowlistedAdmin, secret)).statusCode).toBe(200);
  });

  it("[neg] aggregator ingest: 401 without the secret; with it the request reaches validation (400 for no url)", async () => {
    const none = await inj("POST", "/api/aggregator/ingest/mcp", allowlisted, {}, {});
    expect(none.statusCode).toBe(401);
    const admin = await inj("POST", "/api/aggregator/ingest/mcp", allowlisted, secret, {});
    expect(admin.statusCode).toBe(400);
  });

  it("[neg] agntcy status had no check at all: now 401 without the secret, 200 with it", async () => {
    expect((await inj("GET", "/api/aggregator/agntcy/status", tenantB)).statusCode).toBe(401);
    expect((await inj("GET", "/api/aggregator/agntcy/status", tenantB, secret)).statusCode).toBe(200);
  });

  it("[neg] tool-index reload: an allowlisted identity without the secret is 401", async () => {
    expect((await inj("POST", "/api/tools/reload", allowlisted)).statusCode).toBe(401);
  });
});

describe("audit stats count the caller's WHOLE 24h window (round 7, astra r2 new defect 2)", () => {
  it("[neg] 1005 of the caller's events are counted as 1005: the scoped count was a 1000-row query labelled 24h", async () => {
    const { auditService } = await import("../services/audit-service.js");
    const heavy = seedKey("stats-heavy@x.test", ["operator"]);
    for (let i = 0; i < 1005; i += 1) {
      auditService.log({ eventType: "stats.heavy", actor: "stats-heavy@x.test", resourceType: "test", resourceId: `h-${i}`, action: "create" } as never);
    }
    const res = await inj("GET", "/api/audit/stats", heavy);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { stats: Array<{ eventType: string; count: number }>; scoped: boolean; window: string };
    expect(body.scoped).toBe(true);
    expect(body.window).toBe("24h");
    expect(body.stats.find((s) => s.eventType === "stats.heavy")?.count).toBe(1005);
    // Still scoped: tenant B's private event is not in the caller's counts.
    expect(body.stats.some((s) => s.eventType === "admin_gates.tenant_b_private")).toBe(false);
  });
});
