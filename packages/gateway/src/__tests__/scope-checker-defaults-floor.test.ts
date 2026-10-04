/**
 * Scope requirements compose with the built-in defaults.
 *
 * Builds the REAL `apiGate` + `scopeChecker` middleware, registered in the
 * same order `server.ts` uses, against a REAL in-memory store seeded by the
 * REAL governance seed (`seedGovernance`, reached via
 * `initStore({ seed: true })` -> `seedAll`). Nothing here is mocked.
 *
 * The `endpoint_scopes` table's rows ADD requirements on top of
 * DEFAULT_SCOPE_REQUIREMENTS; they never replace them. A key holding only a
 * seeded, unrelated scope (`contributor:read`) does not reach a route a
 * built-in default covers, and a row on the same route as a default cannot
 * waive the default's requirement.
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker, __resetScopeCacheForTests } from "../middleware/scope-checker.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  // seed: true (the default) runs seedAll -> seedGovernance, exactly as a
  // real boot does. This is NOT a hand-rolled fixture of the seed's rows.
  initStore({ seed: true });
  // The module-level scope cache has a 5-minute TTL and otherwise survives
  // across it()s in this file (same module instance). Drop it so THIS
  // test's governance rows (seeded + any inserted by the test itself) are
  // what gets read on the first request, not a previous test's snapshot.
  __resetScopeCacheForTests();

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


describe("scope-checker: defaults compose with governance rows", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  describe("governance rows add to the built-in defaults, never replace them", () => {
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

});
