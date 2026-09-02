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
 * This file covers (2) and (3), which live in this middleware. Defect (1) is a
 * provisioning-policy change and is deliberately NOT fixed here — the
 * `wildcard still passes` test below PINS that gap so it cannot be mistaken for
 * closed. Both halves must land for the money path to actually be gated.
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

const { scopeChecker, __resetScopeCacheForTests } = await import(
  "../middleware/scope-checker.js"
);

/** Build an app with the scope-checker mounted and a key pre-attached. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Stand in for api-gate, which sets req.apiKeyId on authenticated requests.
  app.addHook("onRequest", async (req) => {
    (req as unknown as { apiKeyId?: string }).apiKeyId = "key-1";
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

  describe("KNOWN GAP — pinned, not fixed here", () => {
    it("wildcard keys STILL pass the money path (provisioning half is unfixed)", async () => {
      // routes/provision.ts mints scopes:["*"] for every public self-service
      // caller, so this middleware alone does NOT close the exposure. This test
      // documents that deliberately: if provisioning is narrowed and this
      // assertion starts failing, the gap is closed and the test should be
      // updated to expect 403.
      keyScopes = JSON.stringify(["*"]);
      const app = await buildApp();
      const res = await app.inject({ method: "POST", url: "/api/fiat-ramp/payout" });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });
});
