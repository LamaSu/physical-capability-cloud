import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Exercise the SIWE principal path through the REAL apiGate → scopeChecker chain
// without the full SIWE crypto: a request carrying `x-mock-siwe: 1` resolves to a
// session, so apiGate sets req.userId exactly as it would for a real login.
vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: (req: { headers: Record<string, string | undefined> }) =>
    req.headers["x-mock-siwe"] === "1" ? { address: "0xSIWEtestwallet" } : null,
}));

import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, getRepos, closeStore } from "../db.js";

/**
 * Real-app apiGate → scopeChecker integration (audit P0, lane d749deff).
 *
 * Proves the two middlewares compose correctly in the production registration
 * order (server.ts: apiGate at :456 THEN scopeChecker at :533) under
 * SCOPE_ENFORCEMENT_MODE=enforce:
 *   - apiGate resolves the principal (API key or SIWE) before scopeChecker runs,
 *   - scopeChecker allows when the required scope is present, 403s when absent,
 *   - default-deny 403s an unpoliced route,
 *   - a SIWE principal is ENFORCED (denied), not skipped (the C-02 fix).
 *
 * Uses the always-present default rule `/api/admin/* -> ["admin"]` so the test
 * doesn't depend on the module-level scope cache being seeded from this store.
 */
describe("apiGate → scopeChecker integration (enforce mode)", () => {
  let app: FastifyInstance;
  const prevMode = process.env.SCOPE_ENFORCEMENT_MODE;
  let n = 0;
  const hits = { admin: 0, unpoliced: 0 }; // handler side-effect counters (finding #6)

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.SCOPE_ENFORCEMENT_MODE = "enforce"; // read at scopeChecker registration
    initStore({ seed: false });
    // Precedence fixture: a MORE-specific rule (0 wildcards) than the /api/admin/*
    // default (1 wildcard), so it must win scope-checker's most-specific-first sort.
    getRepos().governance.insertEndpointScope({
      id: "it-audit-only",
      method: "POST",
      routePattern: "/api/admin/audit-only",
      requiredScopes: ["auditor"],
      description: "precedence integration fixture",
    });
    app = Fastify({ logger: false });
    await app.register(apiGate); // server.ts:456 — resolves API-key / SIWE principal
    await app.register(scopeChecker); // server.ts:533 — enforces scopes on it
    app.post("/api/admin/itest", async () => { hits.admin++; return { ok: true }; }); // default ["admin"]
    app.post("/api/admin/audit-only", async () => ({ ok: true })); // specific policy: ["auditor"]
    app.post("/api/itest/unpoliced", async () => { hits.unpoliced++; return { ok: true }; }); // no policy
    app.get("/api/health/itest", async () => ({ ok: true })); // public prefix /api/health
    // Encapsulation: a route registered in a SEPARATE child plugin must still be
    // enforced by the non-encapsulated (skip-override) scopeChecker hook.
    await app.register(async (sibling) => {
      sibling.post("/api/admin/sibling", async () => ({ ok: true })); // default ["admin"]
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (prevMode === undefined) delete process.env.SCOPE_ENFORCEMENT_MODE;
    else process.env.SCOPE_ENFORCEMENT_MODE = prevMode;
  });

  const bearer = (scopes: string[]) => ({
    authorization: `Bearer ${provisionApiKey({ operatorId: `it-${++n}@x.com`, scopes }).rawKey}`,
  });
  const post = (url: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url, headers });

  it("unauthenticated request is 401 at apiGate (never reaches scopeChecker)", async () => {
    expect((await post("/api/admin/itest", {})).statusCode).toBe(401);
  });

  it("apiGate resolves the key; scopeChecker ALLOWS when the required scope is present", async () => {
    expect((await post("/api/admin/itest", bearer(["admin"]))).statusCode).toBe(200);
  });

  it("scopeChecker DENIES a lacking principal (403) and the handler does NOT execute", async () => {
    const before = hits.admin;
    const res = await post("/api/admin/itest", bearer(["operator"]));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
    expect(hits.admin).toBe(before); // finding #6: a 403 leaves the handler side-effect at zero
  });

  it("default-deny: an authenticated key on an unpoliced route is 403, handler not run", async () => {
    const before = hits.unpoliced;
    expect((await post("/api/itest/unpoliced", bearer(["admin"]))).statusCode).toBe(403);
    expect(hits.unpoliced).toBe(before);
  });

  it("C-02: a SIWE principal REACHES scopeChecker and is DENIED, not skipped", async () => {
    // Mocked SIWE session → apiGate sets req.userId → scopeChecker enforces.
    // A SIWE caller carries no scopes, so it is denied (pre-fix it was skipped).
    expect((await post("/api/admin/itest", { "x-mock-siwe": "1" })).statusCode).toBe(403);
  });

  it("precedence: a more-specific rule beats the broad domain default", async () => {
    // /api/admin/audit-only -> ["auditor"] (0 wildcards) must win over the
    // /api/admin/* -> ["admin"] default (1 wildcard). This is the ordering the
    // manifest's admin-only sub-paths (approve/reject/activate) rely on.
    const auditor = bearer(["auditor"]);
    expect((await post("/api/admin/audit-only", auditor)).statusCode).toBe(200); // specific wins
    expect((await post("/api/admin/itest", auditor)).statusCode).toBe(403); // broad still needs admin
  });

  it("public routes stay public — scopeChecker never blocks them, no bypass either way", async () => {
    const get = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: "/api/health/itest", headers });
    expect((await get({})).statusCode).toBe(200); // unauthenticated public read → allowed
    expect((await get(bearer(["operator"]))).statusCode).toBe(200); // authed → still public, not scope-gated
  });

  it("encapsulation: scopeChecker enforces on routes in a SEPARATE child plugin", async () => {
    // The skip-override symbol makes the hook non-encapsulated; without it a
    // sibling-plugin route would be unenforced (the pre-fix inert state).
    expect((await post("/api/admin/sibling", bearer(["operator"]))).statusCode).toBe(403); // enforced
    expect((await post("/api/admin/sibling", bearer(["admin"]))).statusCode).toBe(200);
  });
});
