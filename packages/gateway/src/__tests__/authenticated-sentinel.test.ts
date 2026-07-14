import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore, getRepos } from "../db.js";

/**
 * PR 1 — SIWE authenticated-only policy via the "@authenticated" policy-only
 * sentinel (audit classification). Enforce mode (NODE_ENV is "test", so the
 * prod inventory-digest gate is skipped — DEFAULT_SCOPE_REQUIREMENTS apply).
 *
 * Proves:
 *   - anonymous denial on me/sessions/logout (api-gate 401, they are NOT public);
 *   - ANY normalized principal — incl. a scopeless ([]) key — is allowed on the
 *     authenticated-only routes (the sentinel, not a role intersection);
 *   - default-deny is preserved (unpoliced authenticated route → 403);
 *   - the sentinel is SCOPED to its own rules: a []-principal is still denied on
 *     a real-role route (/api/admin/*), so the sentinel never leaks a grant;
 *   - nonce/verify are reachable unauthenticated (public pre-auth handshake);
 *   - "@authenticated" is never grantable to an API key (issuance/grant reject).
 */
describe("@authenticated sentinel — SIWE authenticated-only policy (PR 1)", () => {
  let app: FastifyInstance;
  const prevMode = process.env.SCOPE_ENFORCEMENT_MODE;
  let n = 0;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.SCOPE_ENFORCEMENT_MODE = "enforce";
    initStore({ seed: false });
    app = Fastify();
    await app.register(apiGate);
    await app.register(scopeChecker);
    // authenticated-only (DEFAULT @authenticated rules)
    app.get("/api/auth/me", async () => ({ ok: true }));
    app.get("/api/auth/sessions", async () => ({ ok: true }));
    app.post("/api/auth/logout", async () => ({ ok: true }));
    // public pre-auth handshake (api-gate PUBLIC_EXACT)
    app.get("/api/auth/nonce", async () => ({ nonce: "0xabc" }));
    app.post("/api/auth/verify", async () => ({ session: "s1" }));
    // real-role route (DEFAULT ["admin"]) — the sentinel must NOT grant here
    app.get("/api/admin/probe", async () => ({ ok: true }));
    // unpoliced — default-deny must still apply
    app.post("/api/itest/unpoliced", async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (prevMode === undefined) delete process.env.SCOPE_ENFORCEMENT_MODE;
    else process.env.SCOPE_ENFORCEMENT_MODE = prevMode;
  });

  const bearer = (scopes: string[]) => ({
    authorization: `Bearer ${provisionApiKey({ operatorId: `authn-${++n}@x.com`, scopes }).rawKey}`,
  });

  // ── anonymous denial (authenticated-only, NOT public) ────────────
  it("401s an anonymous caller on GET /api/auth/me", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });
  it("401s an anonymous caller on POST /api/auth/logout", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(401);
  });

  // ── ANY normalized principal is allowed (the point of the sentinel) ──
  it("ALLOWS an authenticated caller WITH a role on /api/auth/me", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/me", headers: bearer(["operator"]) });
    expect(r.statusCode).toBe(200);
  });
  it("ALLOWS a SCOPELESS ([]) authenticated caller on /api/auth/me — the sentinel, not a role", async () => {
    const r = await app.inject({ method: "GET", url: "/api/auth/me", headers: bearer([]) });
    expect(r.statusCode).toBe(200);
  });
  it("ALLOWS a scopeless caller on GET /api/auth/sessions and POST /api/auth/logout", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/sessions", headers: bearer([]) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", headers: bearer([]) })).statusCode).toBe(200);
  });

  // ── the sentinel is SCOPED to its own rules (no leaked grant) ────
  it("STILL denies a scopeless caller on a real-role route (/api/admin/* → 403)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/probe", headers: bearer([]) });
    expect(r.statusCode).toBe(403);
  });

  // ── default-deny preserved ───────────────────────────────────────
  it("STILL default-denies a scopeless caller on an unpoliced route (403, enforce)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/itest/unpoliced", headers: bearer([]) });
    expect(r.statusCode).toBe(403);
  });

  // ── public pre-auth handshake reachable unauthenticated ──────────
  it("nonce + verify are reachable WITHOUT auth (public pre-auth handshake)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/nonce" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/verify" })).statusCode).toBe(200);
  });

  // ── "@authenticated" is never grantable to an API key ────────────
  it("updateScopes REJECTS a reserved @-scope (never grantable to a key)", () => {
    expect(() => getRepos().apiKeys.updateScopes("any-key-id", ["@authenticated"])).toThrow(
      /reserved policy-only scope/,
    );
    expect(() => getRepos().apiKeys.updateScopes("any-key-id", ["operator", "@authenticated"])).toThrow();
  });
  it("updateScopes ALLOWS ordinary role scopes (guard is namespace-scoped, not blanket)", () => {
    expect(() => getRepos().apiKeys.updateScopes("any-key-id", ["operator", "verifier"])).not.toThrow();
  });
  it("insert REJECTS an @-namespaced scope before touching the db", () => {
    expect(() =>
      getRepos().apiKeys.insert({ scopes: ["@authenticated"] } as never),
    ).toThrow(/reserved policy-only scope/);
  });
});
