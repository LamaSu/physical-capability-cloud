/**
 * Money-path authorization tests for the scope-checker middleware.
 *
 * Context (coord #615): scope enforcement on the money path was ABSENT, not
 * weak. Three independent defects compounded:
 *
 *   1. `routes/provision.ts` mints every self-service key with scopes:["*"],
 *      and the wildcard short-circuits all rule matching.
 *   2. `scope-checker` had NO requirement covering /api/escrow/* or
 *      /api/fiat-ramp/*, and an unmatched route was ALLOWED — so any
 *      authenticated key could fund/release/dispute an escrow or trigger a
 *      fiat withdrawal/payout.
 *   3. `getCallerScopes` fell back to ["*"] when a key's scopes column was
 *      malformed — a security control failing OPEN to wildcard.
 *
 * This file covers (2) and (3), which live in this middleware. Defect (1) was
 * closed in two halves: provisioning no longer mints "*" (auth/api-key-auth.ts
 * refuses it outright), and — for the wildcard keys that ALREADY exist — this
 * middleware no longer treats "*" as money or admin authority (WP-A A1,
 * MUST-CLOSE 7). The test that used to PIN "wildcard still passes the money
 * path" is inverted below (see "legacy wildcard is NOT money/admin authority").
 *
 * The load-bearing assertions are the negative ones: a caller without the
 * required scope must never reach the route handler.
 *
 * ── UPDATED: money routes now require `settlement`, not `operator` ─
 * This file previously asserted "ALLOWS escrow funding to an operator-scoped
 * key", which was correct for the rules as they then stood. The rules have
 * DELIBERATELY changed: `operator` (what every self-service signup receives) no
 * longer satisfies a money route; funds movement requires the separately-granted
 * `settlement` scope. The old assertion is therefore inverted below into an
 * explicit DENY case rather than deleted — the previously-passing behaviour is
 * exactly the exposure being closed, so it is worth pinning in its new form.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// ── Mock the repo layer the middleware reads ──────────────────────
let keyScopes: string;
/** Rows the governance table returns. Empty → hardcoded defaults are used. */
let dbScopeRows: Array<{ method: string; routePattern: string; requiredScopes: string[] }> = [];

vi.mock("../db.js", () => ({
  getRepos: () => ({
    governance: { findAllEndpointScopes: () => dbScopeRows },
    apiKeys: { findById: () => ({ id: "key-1", scopes: keyScopes }) },
  }),
}));

const { scopeChecker, __resetScopeCacheForTests, parseScopeColumn } = await import(
  "../middleware/scope-checker.js"
);

/**
 * Build an app with the scope-checker mounted and a key pre-attached.
 *
 * `principal: "session"` stands in for a SIWE session instead: api-gate sets
 * only `req.userId` for a session, never `req.apiKeyId`.
 */
async function buildApp(
  principal: "key" | "session" = "key",
): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand in for api-gate, which sets req.apiKeyId on authenticated requests.
  app.addHook("onRequest", async (req) => {
    if (principal === "key") {
      (req as unknown as { apiKeyId?: string }).apiKeyId = "key-1";
    } else {
      (req as unknown as { userId?: string }).userId =
        "0x2222222222222222222222222222222222222222";
    }
  });
  await app.register(scopeChecker);

  const ok = async () => ({ reached: true });
  app.post("/api/escrow/chain/:address/fund", ok);
  app.post("/api/escrow/some-future-route", ok);
  app.post("/api/fiat-ramp/offramp/withdraw", ok);
  app.post("/api/fiat-ramp/payout", ok);
  app.get("/api/escrow", ok);
  app.get("/api/capabilities/types", ok);
  app.post("/api/contributors/schedule", ok);
  // Registered so the "settlement does not satisfy an operator route" negative
  // control proves a 403 FROM THE SCOPE CHECK, not an incidental 404.
  app.post("/api/kernels/register", ok);
  // Nested admin route — proves "/api/admin/**" covers more than one segment.
  app.get("/api/admin/keys/wildcard-audit", ok);
  // Money-path routes that do not exist yet, registered so the floor's coverage
  // of the settlement prefix and of a bare money root is provable rather than
  // an incidental 404.
  app.post("/api/settlement/units/:unitId/close", ok);
  app.post("/api/escrow", ok);
  // WP-A additions: a money-path READ with a param (A2), a money DELETE (A1),
  // a fiat-ramp SETUP route (A4), a non-GET admin route and the one
  // admin-secret-gated public admin route (A3), and a table-gated non-money
  // read (A1: the wildcard keeps it).
  app.get("/api/escrow/:id", ok);
  app.delete("/api/escrow/:id", ok);
  app.post("/api/fiat-ramp/cdp/wallet", ok);
  app.post("/api/admin/demand/rebuild", ok);
  app.get("/api/admin/feedback", ok);
  app.get("/api/audit/stats", ok);
  await app.ready();
  return app;
}

describe("scope-checker — money-path authorization", () => {
  beforeEach(() => {
    keyScopes = JSON.stringify(["contributor:read", "contributor:write"]);
    dbScopeRows = [];
    // The rule cache is module-level with a 5-minute TTL. Without this, a test
    // that changes dbScopeRows asserts against rules a previous test loaded.
    __resetScopeCacheForTests();
  });

  // ── A persisted rule must not be able to WEAKEN the money path ────
  //
  // refreshScopeCache REPLACES the hardcoded defaults wholesale as soon as the
  // endpointScopes table has any rows. A single stale row — an escrow rule
  // still naming `operator`, written before the settlement split — would
  // therefore silently restore the old, weaker authorization with nothing in
  // the code to say so. Caught by cross-family review of PR #309; MONEY_PATH_FLOOR
  // is applied over DB rules to make that impossible.
  describe("DB-persisted rules cannot loosen the money path", () => {
    it("IGNORES a stale DB rule that grants escrow writes to operator", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/escrow/**", requiredScopes: ["operator", "admin"] },
        { method: "POST", routePattern: "/api/kernels/*", requiredScopes: ["operator", "admin"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("still honours a DB rule on a NON-money route (the table is not ignored)", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/kernels/*", requiredScopes: ["template_author"] },
      ];
      keyScopes = JSON.stringify(["template_author"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/kernels/register" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    // Second-opinion sol review via bridge 1c0cff0a (#1526). The floor was
    // appended AFTER the surviving rules, and isMoneyPath() only filters
    // patterns that START with a money prefix — so a BROAD rule like
    // "/api/**" survived the filter, tied the floor on wildcard count (2 vs 2),
    // and won on stable-sort insertion order. The "immutable" floor was not.
    it("IGNORES a broad DB rule that would otherwise shadow the money floor", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/**", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("IGNORES a broad DB rule on fiat-ramp too", async () => {
      dbScopeRows = [
        { method: "*", routePattern: "/api/**", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    // The admin namespace has the same property: a security rule whose presence
    // depends on the DB happening to be empty is not a rule.
    it("keeps /api/admin/** gated even when governance rows exist", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/kernels/*", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a settlement key still passes the money path when DB rows exist", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/kernels/*", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["settlement"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  // ── /api/settlement/** is a money prefix and needs floor rules ────
  //
  // It is listed in MONEY_PATH_PREFIXES (so writes there default-deny) but had
  // NO floor rules, meaning a settlement write was denied to EVERYONE —
  // including an admin or settlement key. No such route exists today, so this
  // was latent; adding one would have shipped it dead on arrival.
  describe("settlement writes are gated, not bricked", () => {
    it("DENIES a settlement write to an operator key", async () => {
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/settlement/units/u1/close" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("ALLOWS a settlement write to a settlement key", async () => {
      keyScopes = JSON.stringify(["settlement"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/settlement/units/u1/close" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    // Pattern "/api/escrow/**" compiles to ^/api/escrow/.*$ which does NOT match
    // the bare root, while isMoneyPath() treats the root as money — so a root
    // money write was denied even to admin.
    it("ALLOWS a settlement-scoped write to a money-path ROOT", async () => {
      keyScopes = JSON.stringify(["settlement"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/escrow" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  // ── Nested admin routes are actually covered by the admin rule ────
  describe("admin namespace is gated at every depth", () => {
    it("DENIES a nested admin route to a non-admin key", async () => {
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("ALLOWS a nested admin route to an admin key", async () => {
      keyScopes = JSON.stringify(["admin"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("funds movement is gated", () => {
    it("DENIES escrow funding to a key without operator/admin scope", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("insufficient_scope");
      // Never reached the handler.
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("DENIES fiat off-ramp withdrawal to an under-scoped key", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/offramp/withdraw" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("DENIES enterprise payout to an under-scoped key", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    // INVERTED, deliberately (was: "ALLOWS escrow funding to an operator-scoped
    // key"). `operator` is what every self-service signup receives, so letting
    // it move funds meant completing a signup form bought funds-movement
    // authority. Now it does not.
    it("DENIES escrow funding to an operator-scoped key — operator is NOT money authority", async () => {
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      expect(res.json().required_scopes).toContain("settlement");
      await app.close();
    });

    it("DENIES fiat payout to an operator-scoped key", async () => {
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("ALLOWS escrow funding to a settlement-scoped key", async () => {
      keyScopes = JSON.stringify(["operator", "settlement"]);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });

    it("ALLOWS fiat payout to a settlement-scoped key", async () => {
      keyScopes = JSON.stringify(["settlement"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });

    it("still ALLOWS admin at the money path (settlement is not the only key)", async () => {
      keyScopes = JSON.stringify(["admin"]);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    // NEGATIVE CONTROL on the grant itself: `settlement` must buy the money
    // path and NOTHING more. If it ever starts satisfying an operator-only
    // route, the split has collapsed back into a second superuser scope.
    it("settlement alone does NOT satisfy an operator-only route", async () => {
      keyScopes = JSON.stringify(["settlement"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/kernels/register" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });
  });

  describe("money path is DEFAULT-DENY", () => {
    it("DENIES an unlisted money-path route rather than defaulting it open", async () => {
      keyScopes = JSON.stringify(["contributor:read"]);
      const app = await buildApp();
      // No requirement names this route specifically; under the old
      // open-by-default behaviour it was reachable by any authenticated key.
      const res = await app.inject({ method: "POST", url: "/api/escrow/some-future-route" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });
  });

  describe("no regression outside the money path", () => {
    it("still ALLOWS a non-money route with no requirement (contributor keys keep working)", async () => {
      keyScopes = JSON.stringify([
        "contributor:read",
        "contributor:write",
        "schedule:read",
        "schedule:publish",
      ]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/contributors/schedule" });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });

    it("still ALLOWS unrelated reads with no requirement", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("leaves money-path READS ungated (only movement is restricted)", async () => {
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/escrow" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  describe("malformed scopes fail CLOSED, not open to wildcard", () => {
    it("DENIES the money path when the scopes column is unparseable", async () => {
      // Previously this returned ["*"] and granted everything.
      keyScopes = "{not json at all";
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    // R6: parseScopeColumn is now THE parser (this hook, the DLP redactor,
    // agent introspection, identity delegation), so its contract is pinned.
    it("parseScopeColumn accepts ONLY a JSON array of strings", () => {
      expect(parseScopeColumn(JSON.stringify(["operator", "settlement"]))).toEqual(["operator", "settlement"]);
      expect(parseScopeColumn(JSON.stringify(["*"]))).toEqual(["*"]);
      expect(parseScopeColumn("[]")).toEqual([]);
      for (const bad of ["settlement", "operator,admin", JSON.stringify("admin"), JSON.stringify([42, "admin"]),
        JSON.stringify({ admin: true }), "42", "null", "{not json", ""]) {
        expect(parseScopeColumn(bad), bad).toEqual([]);
      }
      expect(parseScopeColumn(null)).toEqual([]);
      expect(parseScopeColumn(undefined)).toEqual([]);
    });
  });

  describe("plugin encapsulation (the defect that made the whole layer inert)", () => {
    it("applies its hook to routes registered on the PARENT app", async () => {
      // scopeChecker must carry Symbol.for("skip-override"). Without it Fastify
      // isolates the onRequest hook to the plugin's own scope, and since no
      // routes are registered inside it the hook fires for NOTHING — every scope
      // rule in the table silently stops being enforced. Identical to the
      // apiGate defect fixed in T1.5 (see apigate-encapsulation.test.ts).
      expect(
        (scopeChecker as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")],
      ).toBe(true);

      // Behavioural proof: the route below is on the parent app, not inside the
      // plugin. If the hook were encapsulated this would return 200.
      keyScopes = JSON.stringify(["contributor:read"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ── WP-A A1 (MUST-CLOSE 7): "*" is not money or admin authority ───
  //
  // UPDATED, deliberately. This block used to be "KNOWN GAP — pinned, not fixed
  // here" and asserted that a wildcard key STILL got 200 at POST
  // /api/fiat-ramp/payout. That was the unsafe behaviour — 80/80 live prod keys
  // are ["*"], so every live key could move money. Old: expect 200. New: expect
  // 403. Why: the gap is now closed in this middleware — a money write needs an
  // EXPLICIT money scope and /api/admin/** an explicit `admin` scope; "*" keeps
  // every other route so existing integrations keep working.
  describe("legacy wildcard is NOT money/admin authority (A1)", () => {
    it("DENIES a wildcard key at fiat payout (was the pinned KNOWN GAP: 200)", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      expect(res.json().required_scopes).toContain("settlement");
      expect(res.json().required_scopes).not.toContain("*");
      await app.close();
    });

    it("DENIES a wildcard key at escrow funding", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      await app.close();
    });

    it("DENIES a wildcard key a money DELETE (admin-only on the floor)", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "DELETE", url: "/api/escrow/e1" });
      expect(res.statusCode).toBe(403);
      expect(res.json().required_scopes).toEqual(["admin"]);
      await app.close();
    });

    it("DENIES a wildcard key an unlisted money-path write (default-deny still applies)", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/escrow/some-future-route" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("DENIES a wildcard key the admin namespace (GET and non-GET)", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const get = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(get.statusCode).toBe(403);
      expect(get.json().required_scopes).toEqual(["admin"]);
      const post = await app.inject({ method: "POST", url: "/api/admin/demand/rebuild" });
      expect(post.statusCode).toBe(403);
      await app.close();
    });

    it("says why in the refusal, so an integrator knows to ask for a re-issued key", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.json().message).toMatch(/wildcard/i);
      await app.close();
    });

    // Positive controls — the wildcard KEEPS everything that is not a money
    // write or the admin namespace (existing integrations must keep working).
    it("still ALLOWS a wildcard key on non-money routes, table-gated ones included", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      expect((await app.inject({ method: "POST", url: "/api/kernels/register" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/contributors/schedule" })).statusCode).toBe(200);
      // GET /api/audit/* is table-gated to [auditor, admin]; the wildcard keeps it.
      expect((await app.inject({ method: "GET", url: "/api/audit/stats" })).statusCode).toBe(200);
      await app.close();
    });

    it("still ALLOWS a wildcard key money-path READS and fiat-ramp SETUP", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      expect((await app.inject({ method: "GET", url: "/api/escrow" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/escrow/e1" })).statusCode).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/wallet" })).statusCode,
      ).toBe(200);
      await app.close();
    });

    it("an EXPLICIT scope alongside the wildcard is honoured", async () => {
      keyScopes = JSON.stringify(["*", "settlement"]);
      let app = await buildApp();
      expect((await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" })).statusCode).toBe(200);
      await app.close();

      keyScopes = JSON.stringify(["*", "admin"]);
      app = await buildApp();
      expect(
        (await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" })).statusCode,
      ).toBe(200);
      await app.close();
    });

    it("a DB rule cannot hand the wildcard money authority back", async () => {
      dbScopeRows = [
        { method: "*", routePattern: "/api/**", requiredScopes: ["*"] },
        { method: "POST", routePattern: "/api/fiat-ramp/payout", requiredScopes: ["*"] },
      ];
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a percent-encoded money path does not revive the wildcard", async () => {
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/%70ayout" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });

  // ── WP-A A2 (astra HIGH): governance money-READ rules survive ─────
  //
  // withNonNegotiable() used to drop EVERY governance row whose pattern was a
  // money path, although the floor covers WRITES only — so a read rule like
  // GET /api/escrow/** -> [auditor, admin] silently vanished and any key read.
  describe("governance money-path READ rules are kept (A2)", () => {
    it("DENIES an operator key a money-path read the governance table restricts", async () => {
      dbScopeRows = [
        { method: "GET", routePattern: "/api/escrow/**", requiredScopes: ["auditor", "admin"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/escrow/123" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      expect(res.json().required_scopes).toEqual(["auditor", "admin"]);
      await app.close();
    });

    it("ALLOWS the scope the read rule names", async () => {
      dbScopeRows = [
        { method: "GET", routePattern: "/api/escrow/**", requiredScopes: ["auditor", "admin"] },
      ];
      keyScopes = JSON.stringify(["auditor"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/escrow/123" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("keeps the READ half of a '*'-method money rule", async () => {
      dbScopeRows = [
        { method: "*", routePattern: "/api/escrow/**", requiredScopes: ["auditor", "admin"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/escrow/123" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    // The other half of the requirement: keeping read rules must not let ANY
    // table rule widen a money WRITE.
    it("a '*'-method or write rule on a money path still cannot widen a money WRITE", async () => {
      dbScopeRows = [
        { method: "*", routePattern: "/api/escrow/**", requiredScopes: ["operator"] },
        { method: "POST", routePattern: "/api/escrow/**", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      // The read half applies (operator may read) ...
      expect((await app.inject({ method: "GET", url: "/api/escrow/123" })).statusCode).toBe(200);
      // ... the write half never does.
      const write = await app.inject({
        method: "POST",
        url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund",
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().required_scopes).toContain("settlement");
      await app.close();
    });
  });

  // ── WP-A A3 (astra MED): the admin requirement is independent of ──
  // pattern precedence, and a session cannot enter the admin namespace.
  describe("admin namespace is enforced in the hook, not by table precedence (A3)", () => {
    it("a MORE SPECIFIC DB rule cannot open an admin route to an operator key", async () => {
      // One wildcard beats `/api/admin/**` (two) in the precedence sort — this
      // used to return 200.
      dbScopeRows = [
        { method: "GET", routePattern: "/api/*/keys/wildcard-audit", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(res.statusCode).toBe(403);
      expect(res.json().reached).toBeUndefined();
      expect(res.json().required_scopes).toEqual(["admin"]);
      await app.close();
    });

    it("an exact DB rule on the admin route cannot open it either", async () => {
      dbScopeRows = [
        { method: "GET", routePattern: "/api/admin/keys/wildcard-audit", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("DENIES a SIWE-session principal (no API key) on /api/admin/**", async () => {
      const app = await buildApp("session");
      const get = await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" });
      expect(get.statusCode).toBe(403);
      expect(get.json().reached).toBeUndefined();
      expect(get.json().required_scopes).toEqual(["admin"]);
      const post = await app.inject({ method: "POST", url: "/api/admin/demand/rebuild" });
      expect(post.statusCode).toBe(403);
      await app.close();
    });

    it("a percent-encoded admin path is still the admin namespace", async () => {
      const app = await buildApp("session");
      const res = await app.inject({ method: "GET", url: "/api/%61dmin/keys/wildcard-audit" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    // Regression guards on what must NOT change.
    it("a session still reaches ordinary non-money routes (unchanged)", async () => {
      const app = await buildApp("session");
      expect((await app.inject({ method: "POST", url: "/api/kernels/register" })).statusCode).toBe(200);
      await app.close();
    });

    it("the admin-SECRET-gated public export (GET /api/admin/feedback) is not scope-gated", async () => {
      // api-gate leaves this path public and the route checks X-Admin-Token
      // itself; api-gate never attaches a key there, so requiring a scope would
      // make it unreachable for everyone.
      const app = await buildApp("session");
      expect((await app.inject({ method: "GET", url: "/api/admin/feedback" })).statusCode).toBe(200);
      await app.close();
    });

    it("an explicit admin key still reaches every admin route", async () => {
      dbScopeRows = [
        { method: "GET", routePattern: "/api/*/keys/wildcard-audit", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["admin"]);
      const app = await buildApp();
      expect(
        (await app.inject({ method: "GET", url: "/api/admin/keys/wildcard-audit" })).statusCode,
      ).toBe(200);
      expect((await app.inject({ method: "POST", url: "/api/admin/demand/rebuild" })).statusCode).toBe(200);
      await app.close();
    });
  });

  // ── WP-A A4 (astra MED): setup routes do not regress when the ─────
  // governance table has rows.
  describe("fiat-ramp SETUP resolves against its own rule set (A4)", () => {
    it("an operator key passes setup with an UNRELATED governance row present", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/kernels/*", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/wallet" });
      expect(res.statusCode).toBe(200);
      expect(res.json().reached).toBe(true);
      await app.close();
    });

    it("... while a true money write is still denied to that operator key", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/kernels/*", requiredScopes: ["operator"] },
      ];
      keyScopes = JSON.stringify(["operator"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("a DB rule cannot WIDEN setup to a key without operator/admin", async () => {
      dbScopeRows = [
        { method: "POST", routePattern: "/api/fiat-ramp/cdp/wallet", requiredScopes: ["contributor:read"] },
      ];
      keyScopes = JSON.stringify(["contributor:read"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/cdp/wallet" });
      expect(res.statusCode).toBe(403);
      expect(res.json().required_scopes).toEqual(["operator", "admin"]);
      await app.close();
    });

    it("a NON-setup method on a setup path is an ordinary money write", async () => {
      const app = await buildApp("session");
      // No key + DELETE under /api/fiat-ramp/ → money write → refused.
      const res = await app.inject({ method: "DELETE", url: "/api/fiat-ramp/cdp/wallet" });
      expect(res.statusCode).toBe(403);
      await app.close();
    });
  });
});
