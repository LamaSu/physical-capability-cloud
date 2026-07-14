import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts
import { validateManifest, seedRoutePolicies, seedRoutePolicyManifest, ruleId } from "../../../../scripts/audit/seed-route-policy.mjs";
import { initStore, getRepos, getStore, closeStore } from "../db.js";
import { schema, eq } from "@pcc/store";

/**
 * Seeder test (audit P0, lane d749deff): the route-policy manifest loads into the
 * endpoint_scopes table that the scope-checker's mergeScopeRequirements reads.
 * Proves round-trip, idempotency, and that the wildcard/unknown-scope guard holds.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "..", "..", "..", "..", "scripts", "audit", "route-policy-manifest.json");

describe("route-policy seeder (manifest -> endpoint_scopes)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const rules: Array<{ method: string; pattern: string; scopes: string[]; note?: string }> = manifest.rules;

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

  it("validateManifest REJECTS an invalid method, unclean pattern, and duplicate scope (finding #8)", () => {
    expect(validateManifest([{ method: "FETCH", pattern: "/api/x/**", scopes: ["operator"] }]))
      .toEqual([expect.stringContaining("invalid method")]);
    expect(validateManifest([{ method: "GET", pattern: "/api/x?y=1", scopes: ["operator"] }]))
      .toEqual([expect.stringContaining("clean /api/ route")]);
    expect(validateManifest([{ method: "GET", pattern: "/nope/x", scopes: ["operator"] }]))
      .toEqual([expect.stringContaining("clean /api/ route")]);
    expect(validateManifest([{ method: "GET", pattern: "/api/x/**", scopes: ["operator", "operator"] }]))
      .toEqual([expect.stringContaining("duplicate scope")]);
  });

  it("seedRoutePolicies REFUSES invalid rules directly — validation can't be bypassed (finding #8)", () => {
    expect(() =>
      seedRoutePolicies(getRepos().governance, [{ method: "GET", pattern: "/api/x/**", scopes: ["*"] }]),
    ).toThrow(/refusing to seed/);
  });

  it("seedRoutePolicyManifest deletes stale rp_ rows in one transaction (R2 #7)", () => {
    const gov = getRepos().governance;
    // A stale manifest-owned row no longer in the current manifest.
    gov.insertEndpointScope({
      id: "rp_stale_row", method: "POST", routePattern: "/api/gone/x", requiredScopes: ["admin"], description: null,
    });
    expect(gov.findEndpointScopeById("rp_stale_row")).toBeTruthy();

    const res = seedRoutePolicyManifest(getStore(), manifest, { schema, eq });
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(gov.findEndpointScopeById("rp_stale_row")).toBeUndefined(); // stale row removed
    const rpRows = gov.findAllEndpointScopes().filter((r: { id: string }) => r.id.startsWith("rp_"));
    expect(rpRows.length).toBe(rules.length); // exactly the manifest, no orphans
  });
});
