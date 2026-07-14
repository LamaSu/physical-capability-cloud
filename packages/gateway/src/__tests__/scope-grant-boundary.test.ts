import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Scope-grant import boundary (review R3 #5).
 *
 * The atomic-audit invariant is only guaranteed when grants go through
 * createScopeGrantService (which binds a real transaction + durable audit). The DI
 * functions that accept an arbitrary ScopeGrantDeps are un-exported and reachable
 * only via __unsafeInternalsForTests. This test enforces that boundary mechanically:
 * NON-TEST gateway source must not import the seam — so a route can't assemble a
 * no-op transaction/recorder and grant scopes without a durable audit trail.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("scope-grant import boundary (R3 #5)", () => {
  const files = walk(SRC);

  it("no non-test source imports the __unsafeInternalsForTests seam", () => {
    const offenders = files
      .filter((f) => /__unsafeInternalsForTests/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
      // the module that DECLARES the seam is allowed to name it.
      .filter((rel) => rel !== "auth/onboarding-scope-grant.ts");
    expect(
      offenders,
      "route/production code must reach grants only via createScopeGrantService",
    ).toEqual([]);
  });

  it("no non-test source imports the DI grant functions by name from the module", () => {
    // The functions are un-exported, so a named import would already fail to compile;
    // this also catches a re-export attempt or a future accidental export.
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return (
        /onboarding-scope-grant/.test(src) &&
        /\b(grantVerifiedOnboardingScopes|grantAdminScopes|doGrant)\b/.test(src) &&
        // createScopeGrantService is the allowed public entry point.
        !/createScopeGrantService/.test(src.replace(/grant(Verified|Admin)\w*/g, ""))
      );
    });
    // The only file that may reference the DI names is the module itself.
    const external = offenders
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))
      .filter((rel) => rel !== "auth/onboarding-scope-grant.ts");
    expect(external, "DI grant functions must not be referenced outside their module").toEqual([]);
  });
});
