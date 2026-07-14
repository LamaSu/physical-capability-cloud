import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts
import { validateManifest, seedRoutePolicies, ruleId } from "../../../../scripts/audit/seed-route-policy.mjs";
import { initStore, getRepos, closeStore } from "../db.js";

/**
 * Seeder test (audit P0, lane d749deff): the route-policy manifest loads into the
 * endpoint_scopes table that the scope-checker's mergeScopeRequirements reads.
 * Proves round-trip, idempotency, and that the wildcard/unknown-scope guard holds.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "..", "..", "..", "..", "scripts", "audit", "route-policy-manifest.json");

describe("route-policy seeder (manifest -> endpoint_scopes)", () => {
  const rules: Array<{ method: string; pattern: string; scopes: string[]; note?: string }> =
    JSON.parse(readFileSync(MANIFEST, "utf8")).rules;

  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    seedRoutePolicies(getRepos().governance, rules);
  });
  afterAll(() => closeStore());

  it("the shipped manifest is valid (no wildcard or unknown scopes)", () => {
    expect(validateManifest(rules)).toEqual([]);
  });

  it("every rule is seeded into endpoint_scopes", () => {
    expect(getRepos().governance.findAllEndpointScopes().length).toBe(rules.length);
  });

  it("re-seeding is idempotent (all updates, no new inserts, same count)", () => {
    const gov = getRepos().governance;
    const res = seedRoutePolicies(gov, rules);
    expect(res.inserted).toBe(0);
    expect(res.updated).toBe(rules.length);
    expect(gov.findAllEndpointScopes().length).toBe(rules.length);
  });

  it("a seeded row round-trips method + routePattern + requiredScopes", () => {
    const escrow = rules.find((r) => r.pattern === "/api/escrow/**")!;
    const row = getRepos().governance.findEndpointScopeById(ruleId(escrow.method, escrow.pattern));
    expect(row).toBeTruthy();
    expect(row!.method).toBe(escrow.method);
    expect(row!.routePattern).toBe("/api/escrow/**");
    expect(row!.requiredScopes).toEqual(escrow.scopes);
  });

  it("validateManifest REJECTS a wildcard scope and an unknown scope", () => {
    expect(validateManifest([{ method: "*", pattern: "/api/x/**", scopes: ["*"] }])).toEqual([
      expect.stringContaining("wildcard"),
    ]);
    expect(validateManifest([{ method: "*", pattern: "/api/x/**", scopes: ["superuser"] }])).toEqual([
      expect.stringContaining("unknown scope"),
    ]);
  });
});
