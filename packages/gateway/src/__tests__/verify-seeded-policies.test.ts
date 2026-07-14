import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts
import { seedRoutePolicies, writeManifestMarker, ruleId } from "../../../../scripts/audit/seed-route-policy.mjs";
import { verifySeededPolicies, RoutePolicyInventoryError } from "../policy/verify-seeded-policies.js";
import { initStore, getRepos, closeStore } from "../db.js";

/**
 * Runtime inventory gate (audit P0, lane d749deff). Proves prod can't boot enforce
 * against an unseeded/partial/drifted policy table even when CI proved the manifest
 * JSON is complete.
 */
const MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "audit", "route-policy-manifest.json",
);

describe("verifySeededPolicies (runtime inventory gate)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const rules: Array<{ method: string; pattern: string; scopes: string[] }> = manifest.rules;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterEach(() => closeStore());

  it("passes when the table is fully + correctly seeded (rows + marker)", () => {
    const gov = getRepos().governance;
    seedRoutePolicies(gov, rules);
    writeManifestMarker(gov, rules, manifest.version);
    expect(() => verifySeededPolicies(gov)).not.toThrow();
  });

  it("throws when the manifest was never seeded (no marker row)", () => {
    expect(() => verifySeededPolicies(getRepos().governance)).toThrow(RoutePolicyInventoryError);
    expect(() => verifySeededPolicies(getRepos().governance)).toThrow(/not seeded/);
  });

  it("throws on table DRIFT — a policy row tampered after seeding", () => {
    const gov = getRepos().governance;
    seedRoutePolicies(gov, rules);
    writeManifestMarker(gov, rules, manifest.version);
    // Widen one rule's scopes in the live table → live digest != the seeded digest.
    const escrow = rules.find((r) => r.pattern === "/api/escrow/**")!;
    gov.updateEndpointScope(ruleId(escrow.method, escrow.pattern), {
      requiredScopes: ["operator", "requestor", "admin", "verifier"],
    });
    expect(() => verifySeededPolicies(gov)).toThrow(/drift/);
  });
});
