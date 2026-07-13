import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts; buildInventory returns the shape below.
import { buildInventory } from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Route-policy COVERAGE GATE (audit P0, lane d749deff).
 *
 * The thing that lets gateway default-deny (fix/audit-p0 scope-checker) ship
 * without silently bricking a legitimate route: it enumerates every /api/* route
 * and fails if a private MUTATING route has no scope policy. It's a RATCHET —
 * the known gap (route-policy-baseline.json) may only shrink. Adding a scope
 * policy moves a route to "policed" and it drops off the baseline; adding a new
 * unpoliced mutating route fails CI until it gets a policy.
 *
 * Goal state: baseline == [] → every private mutating route is policed → the
 * scope-checker's unmatched-route default can be flipped allow→deny safely.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, "..", "..", "..", "..", "scripts", "audit", "route-policy-baseline.json");

describe("route-policy coverage gate (unblocks default-deny)", () => {
  const inv = buildInventory() as {
    totals: { policed: number; unpoliced_private_mutating: number };
    routes: Array<{ method: string; path: string; bucket: string; mutating: boolean }>;
  };
  const currentMutating = inv.routes
    .filter((r) => r.bucket === "unpoliced_private_mutating")
    .map((r) => `${r.method} ${r.path}`);
  const baseline: string[] = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).routes;
  const baselineSet = new Set(baseline);

  it("no NEW unpoliced private mutating route (ratchet against the baseline)", () => {
    const novel = currentMutating.filter((k) => !baselineSet.has(k)).sort();
    expect(
      novel,
      `New unpoliced MUTATING /api/* route(s) with NO scope policy. Add a scope rule ` +
        `(fix/audit-p0 scope-checker/governance) or — only if it is legitimately covered — ` +
        `regenerate scripts/audit/route-policy-baseline.json:\n${novel.join("\n")}`,
    ).toEqual([]);
  });

  it("the coverage gap only shrinks (mutating count <= baseline)", () => {
    expect(inv.totals.unpoliced_private_mutating).toBeLessThanOrEqual(baseline.length);
  });

  it("classifier stays faithful to the scope snapshot (exactly 11 default-policed)", () => {
    // Anchors the DEFAULT_SCOPE_REQUIREMENTS snapshot in the inventory tool.
    // If fix/audit-p0 changes the default scope rules, re-sync the snapshot and
    // this number together.
    expect(inv.totals.policed).toBe(11);
  });

  it("no money-path route is PUBLIC (escrow/settlement/fiat-ramp/payout/pool/swf/rewards)", () => {
    const moneyPublic = inv.routes.filter(
      (r) =>
        r.bucket === "public" &&
        /\/api\/(escrow|settlement|fiat-ramp|payout|pool|swf|rewards)(\/|$)/.test(r.path),
    );
    expect(
      moneyPublic.map((r) => `${r.method} ${r.path}`),
      "Money-path routes must never be classified public (auth-gate them in api-gate).",
    ).toEqual([]);
  });
});
