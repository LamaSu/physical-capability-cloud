import { describe, it, expect } from "vitest";
// @ts-expect-error — JS audit tool, no d.ts; buildInventory returns the shape below.
import { buildInventory } from "../../../../scripts/audit/route-policy-inventory.mjs";

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
      policed: number;
      policed_by_default: number;
      unpoliced_private_mutating: number;
      unpoliced_private_read: number;
    };
    routes: Array<{ method: string; path: string; bucket: string }>;
  };
  const unpoliced = (b: string) =>
    inv.routes.filter((r) => r.bucket === b).map((r) => `${r.method} ${r.path}`).sort();

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
