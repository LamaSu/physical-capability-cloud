/**
 * N2 has no environment exception (astra, pack 53 verdict, weakest link).
 *
 * checkAdminKey() (auth/admin-key.ts) returned success, mode "dev-open", whenever
 * PCC_ADMIN_KEY was unset and NODE_ENV was "test" or "development". Any
 * authenticated caller presenting ANY X-Admin-Key then got every privileged view,
 * for example the cross-tenant audit log. A deployment that runs with
 * NODE_ENV=development and no admin key (a staging box, a demo) served that to
 * anyone with a self-service key. Reproduced at f76e93d5 before any code changed.
 *
 * Now an unset or blank PCC_ADMIN_KEY refuses (503 admin_key_unconfigured) in EVERY
 * environment, as the three exports already did (requireAdminSecretStrict).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.PCC_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.PCC_SEED_DATA = "false";
delete process.env.PCC_ADMIN_KEY;

const A = "tenant-a@x.test";
const B = "tenant-b@x.test";

let app: FastifyInstance;
let getRepos: typeof import("../db.js").getRepos;
let generateApiKey: typeof import("../auth/api-key-auth.js").generateApiKey;
let checkAdminKey: typeof import("../auth/admin-key.js").checkAdminKey;
let seq = 0;
let ipSeq = 10;

function seedKey(operatorId: string): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `n2-env-key-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
  return rawKey;
}

const inj = (url: string, raw: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "GET",
    url,
    remoteAddress: `10.103.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    headers: { authorization: `Bearer ${raw}`, ...headers },
  });

let keyA: string;

beforeAll(async () => {
  const server = await import("../server.js");
  ({ getRepos } = await import("../db.js"));
  ({ generateApiKey } = await import("../auth/api-key-auth.js"));
  ({ checkAdminKey } = await import("../auth/admin-key.js"));
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  keyA = seedKey(A);
  seedKey(B);
  // Tenant B's activity in the audit log, which tenant A must never see.
  const { auditService } = await import("../services/audit-service.js");
  auditService.log({
    eventType: "tenant.b.private",
    actor: B,
    resourceType: "thing",
    resourceId: "secret-of-b",
    action: "create",
    metadata: {},
  } as never);
});

afterAll(async () => {
  await app?.close();
});

describe("N2: the admin secret has no environment exception", () => {
  it("[neg] NODE_ENV=test with PCC_ADMIN_KEY unset: any X-Admin-Key does NOT open the cross-tenant audit view (503)", async () => {
    const res = await inj("/api/audit/log", keyA, { "x-admin-key": "anything-at-all" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("secret-of-b");
  });

  it("[neg] the same for NODE_ENV=development", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const res = await inj("/api/audit/log", keyA, { "x-admin-key": "anything-at-all" });
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain("secret-of-b");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("[neg] checkAdminKey itself never succeeds without a configured key, in any environment", () => {
    for (const env of ["test", "development", "production", undefined]) {
      const prev = process.env.NODE_ENV;
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      try {
        const verdict = checkAdminKey({ headers: { "x-admin-key": "anything" } } as never);
        expect(verdict.ok, String(env)).toBe(false);
      } finally {
        process.env.NODE_ENV = prev;
      }
    }
  });

  it("control: without X-Admin-Key the caller still gets its own scoped view", async () => {
    const res = await inj("/api/audit/log", keyA);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { scoped: boolean }).scoped).toBe(true);
    expect(res.body).not.toContain("secret-of-b");
  });
});
