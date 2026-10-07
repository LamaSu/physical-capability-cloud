/**
 * admin-observability-attempts-gate.test.ts — F4 follow-up to PR #467 review
 * (pp-item10a-467-analysis-r1-9fc6c1c3, MEDIUM finding 4): the existing
 * attempts-view tests (admin-observability-attempts.test.ts) inject
 * `operatorId` directly via a test-only onRequest hook and never mount the
 * REAL production middleware chain — apiGate -> scopeChecker ->
 * adminObservabilityRoutes, in the order server.ts registers them
 * (server.ts:520 apiGate, server.ts:631 scopeChecker, server.ts:650
 * adminObservabilityRoutes).
 *
 * This file mounts that real chain (skipping only middlewares that don't
 * affect auth/scope for this route — tenantContext, dlpRedactor, x402Gate,
 * etc. — which sit between apiGate/scopeChecker/adminObservabilityRoutes in
 * server.ts but don't gate or transform this response) and asserts the full
 * stack's behavior for both the JSON view and ?format=digest.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore } from "../db.js";

let tmpDir: string;
let feedbackFile: string;
let adminObservabilityRoutes: typeof import("../routes/admin-observability.js").adminObservabilityRoutes;

const ADMIN = "op-admin-f4";
let keys: Record<"admin" | "limited" | "wildcard" | "adminNotAllowlisted" | "wildcardNotAllowlisted", string>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-attempts-gate-"));
  feedbackFile = join(tmpDir, "feedback.jsonl");
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite");
  initStore({ seed: false });
  ({ adminObservabilityRoutes } = await import("../routes/admin-observability.js"));
  // Provisioned once: an operator may hold at most 5 active keys.
  keys = {
    admin: provisionApiKey({ operatorId: ADMIN, scopes: ["admin"] }).rawKey,
    limited: provisionApiKey({ operatorId: ADMIN, scopes: ["operator"] }).rawKey,
    wildcard: provisionApiKey({ operatorId: ADMIN, scopes: ["*"] }).rawKey,
    adminNotAllowlisted: provisionApiKey({ operatorId: "op-not-allowlisted", scopes: ["admin"] }).rawKey,
    wildcardNotAllowlisted: provisionApiKey({ operatorId: "op-wildcard-not-allowlisted", scopes: ["*"] }).rawKey,
  };
});

async function buildRealApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(adminObservabilityRoutes);
  // A one-segment admin route, which the old /api/admin/* rule already covered.
  app.get("/api/admin/ping", async () => ({ ok: true }));
  await app.ready();
  return app;
}

const envKeys = ["NODE_ENV", "PCC_OBSERVABILITY_ADMINS", "PCC_OBSERVABILITY_DEV_OPEN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of envKeys) saved[k] = process.env[k];
  process.env.NODE_ENV = "production";
  process.env.PCC_OBSERVABILITY_ADMINS = ADMIN;
  delete process.env.PCC_OBSERVABILITY_DEV_OPEN;
  writeFileSync(feedbackFile, "", "utf8");
});

afterEach(() => {
  for (const k of envKeys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("GET /api/admin/observability/attempts — F4: real production gate chain", () => {
  for (const query of ["", "?format=digest"]) {
    describe(`format${query || " (json)"}`, () => {
      it("401s with no credentials at all", async () => {
        const app = await buildRealApp();
        try {
          const res = await app.inject({ method: "GET", url: `/api/admin/observability/attempts${query}` });
          expect(res.statusCode).toBe(401);
        } finally {
          await app.close();
        }
      });

      it("403s an admin-scoped key whose operator is NOT in PCC_OBSERVABILITY_ADMINS", async () => {
        const rawKey = keys.adminNotAllowlisted;
        const app = await buildRealApp();
        try {
          const res = await app.inject({
            method: "GET",
            url: `/api/admin/observability/attempts${query}`,
            headers: { authorization: `Bearer ${rawKey}` },
          });
          expect(res.statusCode).toBe(403);
        } finally {
          await app.close();
        }
      });

      it("200s an admin-scoped, allowlisted operator", async () => {
        const rawKey = keys.admin;
        const app = await buildRealApp();
        try {
          const res = await app.inject({
            method: "GET",
            url: `/api/admin/observability/attempts${query}`,
            headers: { authorization: `Bearer ${rawKey}` },
          });
          expect(res.statusCode).toBe(200);
        } finally {
          await app.close();
        }
      });

      it("403s a key without admin scope, even for an allowlisted operator (#490: /api/admin/** covers nested routes)", async () => {
        const rawKey = keys.limited;
        const app = await buildRealApp();
        try {
          const res = await app.inject({
            method: "GET",
            url: `/api/admin/observability/attempts${query}`,
            headers: { authorization: `Bearer ${rawKey}` },
          });
          expect(res.statusCode).toBe(403);
          expect(res.json().error).toBe("insufficient_scope");
          expect(res.json().message).toBe("Admin routes need the admin scope.");
        } finally {
          await app.close();
        }
      });

      it("leaves a wildcard (*) key to the route's own allowlist", async () => {
        const allowed = keys.wildcard;
        const other = keys.wildcardNotAllowlisted;
        const app = await buildRealApp();
        try {
          const ok = await app.inject({ method: "GET", url: `/api/admin/observability/attempts${query}`, headers: { authorization: `Bearer ${allowed}` } });
          const no = await app.inject({ method: "GET", url: `/api/admin/observability/attempts${query}`, headers: { authorization: `Bearer ${other}` } });
          expect(ok.statusCode).toBe(200);
          expect(no.statusCode).toBe(403);
          expect(no.json().error).not.toBe("insufficient_scope");
        } finally {
          await app.close();
        }
      });
    });
  }
});

describe("one-segment admin routes behave as before", () => {
  it("403s a key without admin scope and passes an admin-scoped key", async () => {
    const limited = keys.limited;
    const admin = keys.admin;
    const app = await buildRealApp();
    try {
      expect((await app.inject({ method: "GET", url: "/api/admin/ping", headers: { authorization: `Bearer ${limited}` } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/api/admin/ping", headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
