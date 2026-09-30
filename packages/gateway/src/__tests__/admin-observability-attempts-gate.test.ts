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

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-attempts-gate-"));
  feedbackFile = join(tmpDir, "feedback.jsonl");
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite");
  initStore({ seed: false });
  ({ adminObservabilityRoutes } = await import("../routes/admin-observability.js"));
});

async function buildRealApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(scopeChecker);
  await app.register(adminObservabilityRoutes);
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
        const { rawKey } = provisionApiKey({ operatorId: "op-not-allowlisted", scopes: ["admin"] });
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
        const { rawKey } = provisionApiKey({ operatorId: ADMIN, scopes: ["admin"] });
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

      it("a valid key WITHOUT admin scope, operator allowlisted: documents the real scope-checker behavior for this nested route", async () => {
        const { rawKey } = provisionApiKey({ operatorId: ADMIN, scopes: ["operator"] });
        const app = await buildRealApp();
        try {
          const res = await app.inject({
            method: "GET",
            url: `/api/admin/observability/attempts${query}`,
            headers: { authorization: `Bearer ${rawKey}` },
          });
          // See the repro file (467-followups-repro.md, F4) for the full
          // explanation: scope-checker's DEFAULT_SCOPE_REQUIREMENTS entry for
          // "/api/admin/*" compiles (via patternToRegex) to
          // ^/api/admin/[^/]*(?:\?.*)?$ — a SINGLE wildcard segment. It does
          // NOT match a nested path like /api/admin/observability/attempts
          // (two segments after /api/admin/), so with an empty/default
          // governance table (as in any fresh deployment or test store with
          // no seeded endpointScopes rows) scope-checker finds no matching
          // requirement for this route and allows ANY authenticated,
          // non-money-path request through regardless of scope. The ONLY
          // thing gating this route today is isObservabilityAdmin()'s own
          // operatorId allowlist check inside admin-observability.ts, which
          // the tests above confirm still fails closed correctly. Fixing the
          // scope-checker pattern itself (e.g. "/api/admin/**") is outside
          // this task's file scope (middleware/scope-checker.ts is not one
          // of the three files this lane is allowed to touch) and is NOT
          // done here — flagged instead for the operator.
          expect(res.statusCode).toBe(200);
        } finally {
          await app.close();
        }
      });
    });
  }
});
