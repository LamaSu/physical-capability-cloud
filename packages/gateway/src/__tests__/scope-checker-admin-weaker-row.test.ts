/**
 * scope-checker: an endpoint_scopes row can't weaken the admin boundary (#490 round 2).
 *
 * A row matching an admin route with a weaker scope ("operator") used to become the
 * matched requirement and let an operator key in. The admin check now runs before
 * any row is consulted. Real apiGate + scopeChecker + the admin observability route.
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

const ADMIN = "op-admin-weaker-row";
let adminObservabilityRoutes: typeof import("../routes/admin-observability.js").adminObservabilityRoutes;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "pcc-scope-weaker-row-"));
  process.env.PCC_DB_PATH = join(dir, "pcc.sqlite");
  writeFileSync(join(dir, "feedback.jsonl"), "", "utf8");
  initStore({ seed: false });
  getRepos().governance.insertEndpointScope({ id: "es-weaker-1", method: "GET", routePattern: "/api/admin/observability/attempts", requiredScopes: ["operator"] });
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
  await app.ready();
  return app;
}

describe("an endpoint_scopes row requiring only 'operator' on an admin route", () => {
  it("does not let an operator-scoped key in; an admin-scoped key still reaches the route", async () => {
    const limited = provisionApiKey({ operatorId: ADMIN, scopes: ["operator"] }).rawKey;
    const admin = provisionApiKey({ operatorId: ADMIN, scopes: ["admin", "operator"] }).rawKey;
    const app = await buildApp();
    try {
      const no = await app.inject({ method: "GET", url: "/api/admin/observability/attempts", headers: { authorization: `Bearer ${limited}` } });
      expect(no.statusCode).toBe(403);
      expect(no.json().message).toBe("Admin routes need the admin scope.");
      const ok = await app.inject({ method: "GET", url: "/api/admin/observability/attempts", headers: { authorization: `Bearer ${admin}` } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
