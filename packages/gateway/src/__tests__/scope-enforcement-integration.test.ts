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
import { initStore, closeStore } from "../db.js";

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

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.SCOPE_ENFORCEMENT_MODE = "enforce"; // read at scopeChecker registration
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(apiGate); // server.ts:456 — resolves API-key / SIWE principal
    await app.register(scopeChecker); // server.ts:533 — enforces scopes on it
    app.post("/api/admin/itest", async () => ({ ok: true })); // default policy: ["admin"]
    app.post("/api/itest/unpoliced", async () => ({ ok: true })); // no policy → default-deny
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

  it("scopeChecker DENIES a resolved principal that lacks the scope (403)", async () => {
    const res = await post("/api/admin/itest", bearer(["operator"]));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_scope");
  });

  it("default-deny: an authenticated key on an unpoliced route is 403", async () => {
    expect((await post("/api/itest/unpoliced", bearer(["admin"]))).statusCode).toBe(403);
  });

  it("C-02: a SIWE principal REACHES scopeChecker and is DENIED, not skipped", async () => {
    // Mocked SIWE session → apiGate sets req.userId → scopeChecker enforces.
    // A SIWE caller carries no scopes, so it is denied (pre-fix it was skipped).
    expect((await post("/api/admin/itest", { "x-mock-siwe": "1" })).statusCode).toBe(403);
  });
});
