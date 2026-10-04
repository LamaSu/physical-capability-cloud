/**
 * Repro + regression tests: scope-checker defaults/governance composition,
 * and the session-auth scope floor.
 *
 * Builds the REAL `apiGate` + `scopeChecker` middleware, registered in the
 * same order `server.ts` uses, against a REAL in-memory store seeded by the
 * REAL governance seed (`seedGovernance`, reached via
 * `initStore({ seed: true })` -> `seedAll`) — nothing here is mocked.
 *
 * Two holes reproduced below:
 *
 *   1. `refreshScopeCache` replaces DEFAULT_SCOPE_REQUIREMENTS WHOLESALE the
 *      moment the `endpoint_scopes` table has any row. The governance seed
 *      always writes rows (the contributor-economics scopes), so in any
 *      environment where that seed has run, every built-in default —
 *      kernels, evidence, negotiate, jobs, build, admin, templates, audit,
 *      compliance — silently stops being enforced. An API key holding only
 *      a legitimately-seeded, unrelated scope (`contributor:read`) should
 *      NOT reach /api/admin/** or /api/jobs/** on that basis alone.
 *
 *   2. The `onRequest` hook returns immediately when `!req.apiKeyId`, so a
 *      SIWE session (wallet-auth, no API key — the dashboard's auth mode)
 *      skips the ENTIRE scope layer, before even the money-path check. A
 *      session with no key should never pass a route a default rule covers.
 *
 * Both assertions below encode the FIXED behaviour (403). At master
 * 108c7788 (before the fix in this branch) both observe 200 instead — that
 * is the repro; see n108-repro-108c7788.log for the captured run.
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  // seed: true (the default) runs seedAll -> seedGovernance, exactly as a
  // real boot does. This is NOT a hand-rolled fixture of the seed's rows.
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  // Same order as server.ts: apiGate resolves the principal, scopeChecker
  // enforces scopes against it.
  await app.register(apiGate);
  await app.register(scopeChecker);

  const ok = async () => ({ reached: true });
  app.get("/api/admin/widgets", ok);
  app.post("/api/jobs/create", ok);

  await app.ready();
  return app;
}

/** Inserts a REAL api_keys row (not a mock) and returns the bearer token. */
function issueApiKey(scopes: string[]): string {
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: randomUUID(),
    keyHash,
    keyPrefix,
    operatorId: "0x9999999999999999999999999999999999999a",
    name: "repro key",
    description: null,
    scopes: JSON.stringify(scopes),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    metadata: null,
    publicKey: null,
  });
  return rawKey;
}

/** Inserts a REAL sessions row (not a mock) and returns the bearer token. */
function issueSession(): string {
  const token = randomUUID();
  const now = Date.now();
  getRepos().sessions.insert({
    id: randomUUID(),
    walletAddress: "0x8888888888888888888888888888888888888b",
    token,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    lastActiveAt: new Date(now).toISOString(),
  });
  return token;
}

describe("scope-checker — defaults compose with governance rows, session holds no scopes", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  describe("N108 repro — governance rows must not replace the built-in defaults", () => {
    it("REFUSES GET /api/admin/** to a key holding only a seeded, non-admin scope", async () => {
      app = await buildApp();
      const rawKey = issueApiKey(["contributor:read"]); // real seeded scope; not admin
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/widgets",
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      expect(res.json().reached).toBeUndefined();
    });

    it("REFUSES POST /api/jobs/** to a key holding only a seeded, non-job scope", async () => {
      app = await buildApp();
      const rawKey = issueApiKey(["contributor:read"]);
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/create",
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });

    it("REFUSES a write when a row covers the SAME route as a default but the default is unsatisfied", async () => {
      // A row can ADD a requirement; it must never let a caller skip a
      // default that also matches this exact route. Insert a row on the
      // IDENTICAL path the jobs default covers, requiring a scope the
      // default does not accept, and prove the default alone still binds —
      // satisfying the row is not enough.
      app = await buildApp();
      getRepos().governance.insertEndpointScope({
        id: "scope:test:jobs-create-row",
        method: "POST",
        routePattern: "/api/jobs/create",
        requiredScopes: ["ops:custom"],
        description: "test-only row overlapping the jobs default",
      });
      const rawKey = issueApiKey(["ops:custom"]); // satisfies the ROW, not the default
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/create",
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });
  });

  describe("N109 repro — a session with no API key holds no scopes", () => {
    it("REFUSES GET /api/admin/** to a wallet session carrying no API key", async () => {
      app = await buildApp();
      const token = issueSession();
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/widgets",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      expect(res.json().reached).toBeUndefined();
      // Session-specific hint: the caller needs to provision a key.
      expect(String(res.json().message).toLowerCase()).toContain("api key");
    });

    it("REFUSES POST /api/jobs/** to a wallet session carrying no API key", async () => {
      app = await buildApp();
      const token = issueSession();
      const res = await app.inject({
        method: "POST",
        url: "/api/jobs/create",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
    });
  });
});
