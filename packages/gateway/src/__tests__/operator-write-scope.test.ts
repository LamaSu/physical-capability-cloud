/**
 * WP-A fold F4 (operator-ux #2348, board N31): mutating methods on
 * /api/operator/** need an `operator` or `admin` scope in the scope layer.
 *
 * /api/operator/** had no rule, so it was open-by-default: ANY authenticated
 * principal — a contributor-scoped quickstart key, or a key-less SIWE session —
 * could set or clear the emergency stop, decide approvals, rewrite policy, or
 * post relay evidence/heartbeats. Now a mutating method there needs `operator`
 * or `admin` (a floor enforced in the hook, independent of the governance
 * table). Ownership — WHICH kernel a key may act on — is the routes' job
 * (WP-C); this layer only refuses keys that are not operators at all.
 *
 * Legacy "*" keeps this access by design (A1: the wildcard stops being money
 * and admin authority only, and /api/operator/** is neither) — pinned below so
 * the choice is visible rather than accidental.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

let keyScopes: string;
let dbScopeRows: Array<{ method: string; routePattern: string; requiredScopes: string[] }> = [];

vi.mock("../db.js", () => ({
  getRepos: () => ({
    governance: { findAllEndpointScopes: () => dbScopeRows },
    apiKeys: { findById: () => ({ id: "key-1", scopes: keyScopes }) },
  }),
}));

const { scopeChecker, __resetScopeCacheForTests } = await import("../middleware/scope-checker.js");

const CONTRIBUTOR = ["contributor:read", "contributor:write", "schedule:read", "schedule:publish"];

async function buildApp(principal: "key" | "session" = "key"): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    if (principal === "key") (req as unknown as { apiKeyId?: string }).apiKeyId = "key-1";
    else (req as unknown as { userId?: string }).userId = "0x2222222222222222222222222222222222222222";
  });
  await app.register(scopeChecker);
  const ok = async () => ({ reached: true });
  // Real /api/operator/** templates (operator.ts, operator-relay.ts,
  // support-messages.ts, diagnostic-logs.ts).
  app.post("/api/operator/emergency-stop", ok);
  app.post("/api/operator/emergency-resume", ok);
  app.post("/api/operator/approvals", ok);
  app.post("/api/operator/approvals/:id/approve", ok);
  app.post("/api/operator/approvals/:id/reject", ok);
  app.patch("/api/operator/policy/:kernelId", ok);
  app.post("/api/operator/heartbeat", ok);
  app.post("/api/operator/evidence", ok);
  app.post("/api/operator/support", ok);
  app.patch("/api/operator/support/:threadId", ok);
  app.post("/api/operator/diagnostics", ok);
  // Reads, and the PLURAL public namespace, are not affected.
  app.get("/api/operator/machines", ok);
  app.get("/api/operator/approvals", ok);
  app.post("/api/operators/:id/rate", ok);
  await app.ready();
  return app;
}

const WRITES: Array<[string, string]> = [
  ["POST", "/api/operator/emergency-stop"],
  ["POST", "/api/operator/emergency-resume"],
  ["POST", "/api/operator/approvals"],
  ["POST", "/api/operator/approvals/apr-1/approve"],
  ["POST", "/api/operator/approvals/apr-1/reject"],
  ["PATCH", "/api/operator/policy/kernel-1"],
  ["POST", "/api/operator/heartbeat"],
  ["POST", "/api/operator/evidence"],
  ["POST", "/api/operator/support"],
  ["PATCH", "/api/operator/support/thread-1"],
  ["POST", "/api/operator/diagnostics"],
];

type M = "GET" | "POST" | "PATCH";

describe("F4 — /api/operator/** writes need operator or admin", () => {
  beforeEach(() => {
    dbScopeRows = [];
    __resetScopeCacheForTests();
  });

  it.each(WRITES)("%s %s DENIES a contributor-scoped key (403)", async (method, url) => {
    keyScopes = JSON.stringify(CONTRIBUTOR);
    const app = await buildApp();
    const res = await app.inject({ method: method as M, url, payload: { kernelId: "kernel-1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reached).toBeUndefined();
    expect(res.json().required_scopes).toEqual(["operator", "admin"]);
    await app.close();
  });

  it.each(WRITES)("%s %s DENIES a key-less SIWE session (a session holds no scopes)", async (method, url) => {
    const app = await buildApp("session");
    const res = await app.inject({ method: method as M, url, payload: { kernelId: "kernel-1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reached).toBeUndefined();
    await app.close();
  });

  it("DENIES a key with NO scopes at all, and one with an unrelated role", async () => {
    for (const scopes of [[], ["requestor"], ["verifier"], ["auditor"], ["settlement"]]) {
      keyScopes = JSON.stringify(scopes);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: "k" } });
      expect(res.statusCode, JSON.stringify(scopes)).toBe(403);
      await app.close();
    }
  });

  it.each(WRITES)("%s %s ALLOWS an operator key", async (method, url) => {
    keyScopes = JSON.stringify(["operator"]);
    const app = await buildApp();
    const res = await app.inject({ method: method as M, url, payload: { kernelId: "kernel-1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().reached).toBe(true);
    await app.close();
  });

  it("ALLOWS an admin key", async () => {
    keyScopes = JSON.stringify(["admin"]);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: "k" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a legacy wildcard key KEEPS operator writes (A1: \"*\" loses money/admin only)", async () => {
    keyScopes = JSON.stringify(["*"]);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/operator/heartbeat", payload: { kernelId: "k" } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("the floor holds when the governance table has rows (it is not a table rule)", async () => {
    dbScopeRows = [{ method: "GET", routePattern: "/api/unrelated/*", requiredScopes: ["auditor"] }];
    keyScopes = JSON.stringify(CONTRIBUTOR);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: "k" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a governance row cannot WIDEN the floor to a contributor key", async () => {
    dbScopeRows = [
      { method: "POST", routePattern: "/api/operator/**", requiredScopes: ["contributor:write"] },
      { method: "POST", routePattern: "/api/operator/emergency-stop", requiredScopes: ["contributor:write"] },
    ];
    keyScopes = JSON.stringify(CONTRIBUTOR);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: "k" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("a governance row can still TIGHTEN one of these routes (floor first, then the table)", async () => {
    dbScopeRows = [{ method: "POST", routePattern: "/api/operator/emergency-resume", requiredScopes: ["admin"] }];
    keyScopes = JSON.stringify(["operator"]);
    const app = await buildApp();
    const tightened = await app.inject({ method: "POST", url: "/api/operator/emergency-resume", payload: { kernelId: "k" } });
    expect(tightened.statusCode).toBe(403);
    const untouched = await app.inject({ method: "POST", url: "/api/operator/emergency-stop", payload: { kernelId: "k" } });
    expect(untouched.statusCode).toBe(200);
    await app.close();
  });

  it("an ENCODED variant of an operator write is gated like the plain one", async () => {
    keyScopes = JSON.stringify(CONTRIBUTOR);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/%6fperator/emergency-stop", payload: { kernelId: "k" } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // ── Unchanged: reads, and the plural /api/operators namespace ─────
  it.each([
    ["GET", "/api/operator/machines"],
    ["GET", "/api/operator/approvals"],
    ["POST", "/api/operators/op-1/rate"],
  ])("%s %s is not affected (a contributor key still reaches it)", async (method, url) => {
    keyScopes = JSON.stringify(CONTRIBUTOR);
    const app = await buildApp();
    const res = await app.inject({ method: method as M, url, payload: {} });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
