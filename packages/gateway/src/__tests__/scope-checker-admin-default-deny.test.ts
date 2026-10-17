/**
 * scope-checker: admin routes with endpoint_scopes rows present (#490, gateway #4899).
 *
 * When any endpoint_scopes row exists, refreshScopeCache uses ONLY those rows and the
 * default table (with its /api/admin/** rule) is not applied, as in any seeded
 * environment. An admin route then matches no requirement, and the default-deny for
 * every method under /api/admin/ is what keeps a key without the admin scope out.
 * Real apiGate + scopeChecker + the admin observability route.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, getRepos } from "../db.js";

const ADMIN = "op-admin-default-deny";
let adminObservabilityRoutes: typeof import("../routes/admin-observability.js").adminObservabilityRoutes;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcc-scope-default-deny-"));
  process.env.PCC_DB_PATH = join(dir, "pcc.sqlite");
  writeFileSync(join(dir, "feedback.jsonl"), "", "utf8");
  initStore({ seed: false });
  // One row is enough: the default table is no longer applied.
  getRepos().governance.insertEndpointScope({ id: "es-test-1", method: "POST", routePattern: "/api/contributors", requiredScopes: ["contributor:write"] });
  ({ adminObservabilityRoutes } = await import("../routes/admin-observability.js"));
});

beforeEach(() => {
  for (const k of ["NODE_ENV", "PCC_OBSERVABILITY_ADMINS"]) saved[k] = process.env[k];
  process.env.NODE_ENV = "production";
  process.env.PCC_OBSERVABILITY_ADMINS = ADMIN;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(adminObservabilityRoutes);
  app.get("/api/things-for-default-deny-test", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("admin routes when endpoint_scopes rows replace the default table", () => {
  it("deny a key without admin scope on an admin route, for reads too", async () => {
    const limited = provisionApiKey({ operatorId: ADMIN, scopes: ["operator"] }).rawKey;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/admin/observability/attempts", headers: { authorization: `Bearer ${limited}` } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      expect(res.json().message).toBe("Admin routes need the admin scope.");
    } finally {
      await app.close();
    }
  });

  it("let an admin-scoped key through to the route's own allowlist", async () => {
    const admin = provisionApiKey({ operatorId: ADMIN, scopes: ["admin"] }).rawKey;
    const app = await buildApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/observability/attempts", headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("leave a wildcard key to the route, and other unmatched routes open as before", async () => {
    const wildcard = provisionApiKey({ operatorId: ADMIN, scopes: ["*"] }).rawKey;
    const limited = provisionApiKey({ operatorId: ADMIN, scopes: ["operator"] }).rawKey;
    const app = await buildApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/observability/attempts", headers: { authorization: `Bearer ${wildcard}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/things-for-default-deny-test", headers: { authorization: `Bearer ${limited}` } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
