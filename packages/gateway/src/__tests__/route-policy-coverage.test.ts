import { describe, it, expect } from "vitest";
import {
  // @ts-expect-error — JS audit tool, no d.ts; buildInventory returns the shape below.
  buildInventory,
  // @ts-expect-error — JS audit tool, no d.ts
  UNCLASSIFIED_PENDING_OWNER,
} from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Route-policy COVERAGE GATE (audit P0, lane d749deff).
 *
 * The thing that lets gateway default-deny (fix/audit-p0 scope-checker) ship
 * without silently 403-ing a legitimate route: it enumerates every /api/* route
 * and requires that EVERY private route (mutating or read) is covered by a scope
 * policy — the 11 DEFAULT_SCOPE_REQUIREMENTS plus scripts/audit/route-policy-
 * manifest.json. At full coverage (0 unpoliced) the scope-checker's unmatched-
 * route default can be flipped allow→deny with nothing bricked.
 *
 * A new /api/* route with no policy fails this gate until it gets a manifest rule.
 *
 * PREREQUISITE for enforcement: scope-checker.ts patternToRegex must handle `**`
 * (any-depth) correctly — it currently does NOT (flagged to 9de363c7). The
 * inventory tool models the corrected matcher; without the scope-checker fix,
 * the manifest's multi-segment rules will not actually enforce.
 */
describe("route-policy coverage gate (unblocks default-deny)", () => {
  const inv = buildInventory() as {
    totals: {
      api_routes: number;
      policed: number;
      policed_by_default: number;
      unpoliced_private_mutating: number;
      unpoliced_private_read: number;
      cross_lane_pending: number;
    };
    routes: Array<{ method: string; path: string; bucket: string; file: string }>;
  };
  const unpoliced = (b: string) =>
    inv.routes.filter((r) => r.bucket === b).map((r) => `${r.method} ${r.path}`).sort();
  const has = (method: string, path: string) =>
    inv.routes.some((r) => r.method === method && r.path === path);

  it("FULL coverage: no unpoliced private MUTATING route", () => {
    expect(
      unpoliced("unpoliced_private_mutating"),
      "Unpoliced MUTATING /api/* route(s) — add a rule to scripts/audit/route-policy-manifest.json:",
    ).toEqual([]);
  });

  it("FULL coverage: no unpoliced private READ route", () => {
    expect(
      unpoliced("unpoliced_private_read"),
      "Unpoliced READ /api/* route(s) — add a rule to scripts/audit/route-policy-manifest.json:",
    ).toEqual([]);
  });

  it("inventory scans registrations OUTSIDE routes/ — server.ts + middleware (R3 #4)", () => {
    // The old scan was scoped to routes/ and silently dropped these real routes,
    // so "0 unpoliced" did not actually cover every registered route. Assert the
    // known out-of-routes/ registrations are now present in the inventory.
    const known: Array<[string, string, string]> = [
      ["GET", "/api/health", "server.ts"],
      ["GET", "/api/agents/status", "server.ts"],
      ["GET", "/api/producers/status", "server.ts"],
      ["GET", "/api/auth/nonce", "auth/siwe-auth.ts"],
      ["POST", "/api/auth/verify", "auth/siwe-auth.ts"],
      ["GET", "/api/aegis/stats", "middleware/aegis-gate.ts"],
      ["GET", "/api/x402/stats", "middleware/x402-gate.ts"],
    ];
    for (const [method, path, where] of known) {
      const route = inv.routes.find((r) => r.method === method && r.path === path);
      expect(route, `${method} ${path} (registered in ${where}) missing from inventory`).toBeTruthy();
      expect(route!.file.endsWith(where), `${path} should come from ${where}, got ${route!.file}`).toBe(true);
    }
    // Canary: at least one route sourced from server.ts AND one from middleware/ —
    // proves the scan genuinely spans locations beyond routes/, not just a hardcode.
    expect(inv.routes.some((r) => r.file.endsWith("server.ts")), "no server.ts route scanned").toBe(true);
    expect(inv.routes.some((r) => r.file.includes("/middleware/")), "no middleware route scanned").toBe(true);
  });

  it("a JSDoc example route is NOT mistaken for a real registration (R3 #4)", () => {
    // auth/require-auth.ts documents `app.get("/api/protected", …)` inside a JSDoc
    // block. Comment-stripping must keep it out of the inventory.
    expect(has("GET", "/api/protected"), "/api/protected is a doc example, not a route").toBe(false);
  });

  it("the ONLY unpoliced routes are the documented cross-lane-pending set (R3 #4)", () => {
    // Honesty gate: every private route is policed EXCEPT an explicitly enumerated
    // set owned by another lane (SIWE auth flow → api-gate public / any-auth). A
    // genuinely NEW unclassified route is NOT on this list, so it still lands in an
    // unpoliced bucket and fails the two gates above.
    const pending = inv.routes
      .filter((r) => r.bucket === "cross_lane_pending")
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    const declared = (UNCLASSIFIED_PENDING_OWNER as Array<{ method: string; path: string }>)
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(pending).toEqual(declared);
    // All pending routes are SIWE auth-flow routes (the known cross-lane gap).
    for (const p of pending) expect(p).toMatch(/\/api\/auth\//);
  });

  it("classifier stays faithful to the DEFAULT_SCOPE_REQUIREMENTS snapshot (11)", () => {
    // Anchors the scope-checker.ts default-rules snapshot in the inventory tool.
    // If fix/audit-p0 changes the defaults, re-sync the snapshot and this number.
    expect(inv.totals.policed_by_default).toBe(11);
  });

  it("no money-path route is PUBLIC (escrow/settlement/fiat-ramp/payout/pool/swf/rewards)", () => {
    const moneyPublic = inv.routes
      .filter(
        (r) =>
          r.bucket === "public" &&
          /\/api\/(escrow|settlement|fiat-ramp|payout|pool|swf|rewards)(\/|$)/.test(r.path),
      )
      .map((r) => `${r.method} ${r.path}`);
    expect(moneyPublic, "Money-path routes must never be classified public.").toEqual([]);
  });
});
