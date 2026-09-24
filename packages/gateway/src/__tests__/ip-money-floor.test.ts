/**
 * WP-A fold F2 (economics #2353, steward #2450 N10a): the money-moving Story IP
 * routes are MONEY WRITES in the scope layer.
 *
 *   POST /api/ip/distribute-royalties
 *   POST /api/ip/settle-royalties
 *   POST /api/ip/:ipId/pay
 *   POST /api/ip/:ipId/claim
 *
 * Before this change /api/ip/** had no rule at all, so it was open-by-default:
 * ANY authenticated key (operator, contributor, a legacy "*", even a key-less
 * SIWE session) could trigger royalty settlement or claim vault revenue. They
 * now resolve exactly like MONEY_PATH_FLOOR: an EXPLICIT `settlement`/`admin`
 * scope, a wildcard does not count, a session is refused, and no rule-table row
 * can widen them. The entries are EXACT method + path, not the /api/ip prefix:
 * the non-money IP routes (register, licensing terms, dispute, every read) keep
 * their previous behaviour — pinned below so a prefix rule could not sneak in.
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

const { scopeChecker, __resetScopeCacheForTests, isMoneyWriteRequest } = await import(
  "../middleware/scope-checker.js"
);

async function buildApp(principal: "key" | "session" = "key"): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand-in for api-gate: a key sets req.apiKeyId, a SIWE session only req.userId.
  app.addHook("onRequest", async (req) => {
    if (principal === "key") (req as unknown as { apiKeyId?: string }).apiKeyId = "key-1";
    else (req as unknown as { userId?: string }).userId = "0x2222222222222222222222222222222222222222";
  });
  await app.register(scopeChecker);
  const ok = async () => ({ reached: true });
  // The money-moving routes, with the exact templates routes/ip.ts registers.
  app.post("/api/ip/distribute-royalties", ok);
  app.post("/api/ip/settle-royalties", ok);
  app.post("/api/ip/:ipId/pay", ok);
  app.post("/api/ip/:ipId/claim", ok);
  // Non-money IP routes that must keep their behaviour.
  app.post("/api/ip/register-capability", ok);
  app.post("/api/ip/set-licensing-terms", ok);
  app.post("/api/ip/:ipId/dispute", ok);
  app.get("/api/ip/:ipId/revenue", ok);
  app.get("/api/ip/:ipId/royalty-distribution", ok);
  await app.ready();
  return app;
}

const MONEY_ROUTES: Array<[string, string]> = [
  ["POST", "/api/ip/distribute-royalties"],
  ["POST", "/api/ip/settle-royalties"],
  ["POST", "/api/ip/0xabc123/pay"],
  ["POST", "/api/ip/0xabc123/claim"],
];

describe("F2 — the money-moving /api/ip routes are money writes", () => {
  beforeEach(() => {
    dbScopeRows = [];
    __resetScopeCacheForTests();
  });

  it.each(MONEY_ROUTES)("%s %s DENIES an operator-scoped key (403)", async (method, url) => {
    keyScopes = JSON.stringify(["operator"]);
    const app = await buildApp();
    const res = await app.inject({ method: method as "POST", url });
    expect(res.statusCode).toBe(403);
    expect(res.json().reached).toBeUndefined();
    expect(res.json().required_scopes).toEqual(["settlement", "admin"]);
    await app.close();
  });

  it.each(MONEY_ROUTES)("%s %s DENIES a legacy wildcard key — \"*\" is not money authority", async (method, url) => {
    keyScopes = JSON.stringify(["*"]);
    const app = await buildApp();
    const res = await app.inject({ method: method as "POST", url });
    expect(res.statusCode).toBe(403);
    expect(res.json().reached).toBeUndefined();
    await app.close();
  });

  it.each(MONEY_ROUTES)("%s %s DENIES a key-less SIWE session", async (method, url) => {
    const app = await buildApp("session");
    const res = await app.inject({ method: method as "POST", url });
    expect(res.statusCode).toBe(403);
    expect(res.json().reached).toBeUndefined();
    await app.close();
  });

  it.each(MONEY_ROUTES)("%s %s ALLOWS an explicit settlement key", async (method, url) => {
    keyScopes = JSON.stringify(["operator", "settlement"]);
    const app = await buildApp();
    const res = await app.inject({ method: method as "POST", url });
    expect(res.statusCode).toBe(200);
    expect(res.json().reached).toBe(true);
    await app.close();
  });

  it.each(MONEY_ROUTES)("%s %s ALLOWS an explicit admin key", async (method, url) => {
    keyScopes = JSON.stringify(["admin"]);
    const app = await buildApp();
    const res = await app.inject({ method: method as "POST", url });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("a governance row cannot WIDEN an IP money write (money writes never consult the table)", async () => {
    dbScopeRows = [
      { method: "POST", routePattern: "/api/ip/settle-royalties", requiredScopes: ["operator"] },
      { method: "POST", routePattern: "/api/ip/**", requiredScopes: ["operator"] },
    ];
    keyScopes = JSON.stringify(["operator"]);
    const app = await buildApp();
    for (const [method, url] of MONEY_ROUTES) {
      const res = await app.inject({ method: method as "POST", url });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    await app.close();
  });

  it("an ENCODED variant of an IP money route is gated exactly like the plain one", async () => {
    keyScopes = JSON.stringify(["operator"]);
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/ip/%73ettle-royalties" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // ── Exact entries, not the prefix: the rest of /api/ip is unchanged ─
  it.each([
    ["POST", "/api/ip/register-capability"],
    ["POST", "/api/ip/set-licensing-terms"],
    ["POST", "/api/ip/0xabc123/dispute"],
    ["GET", "/api/ip/0xabc123/revenue"],
    ["GET", "/api/ip/0xabc123/royalty-distribution"],
  ])("%s %s is NOT a money write (an operator key still reaches it)", async (method, url) => {
    keyScopes = JSON.stringify(["operator"]);
    const app = await buildApp();
    const res = await app.inject({ method: method as "GET" | "POST", url });
    expect(res.statusCode).toBe(200);
    expect(res.json().reached).toBe(true);
    await app.close();
  });
});

describe("F2 — isMoneyWriteRequest (the predicate introspection shares)", () => {
  it("classifies the four IP money routes, template and concrete forms alike", () => {
    expect(isMoneyWriteRequest("POST", "/api/ip/distribute-royalties")).toBe(true);
    expect(isMoneyWriteRequest("POST", "/api/ip/settle-royalties")).toBe(true);
    expect(isMoneyWriteRequest("POST", "/api/ip/:ipId/pay")).toBe(true);
    expect(isMoneyWriteRequest("post", "/api/ip/{ipId}/claim")).toBe(true);
    expect(isMoneyWriteRequest("POST", "/api/ip/0xabc/claim?x=1")).toBe(true);
  });

  it("only for their own method, and never for the rest of /api/ip", () => {
    expect(isMoneyWriteRequest("GET", "/api/ip/:ipId/pay")).toBe(false);
    expect(isMoneyWriteRequest("GET", "/api/ip/settle-royalties")).toBe(false);
    expect(isMoneyWriteRequest("POST", "/api/ip/set-licensing-terms")).toBe(false);
    expect(isMoneyWriteRequest("POST", "/api/ip/register-job-evidence")).toBe(false);
    expect(isMoneyWriteRequest("POST", "/api/ip/:ipId/dispute")).toBe(false);
    // One segment only: a deeper path is not the pay route.
    expect(isMoneyWriteRequest("POST", "/api/ip/a/b/pay")).toBe(false);
  });
});
