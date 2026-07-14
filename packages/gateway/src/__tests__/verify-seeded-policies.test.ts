import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts
import { seedRoutePolicies, writeManifestMarker, ruleId, manifestDigest, MANIFEST_MARKER_ID } from "../../../../scripts/audit/seed-route-policy.mjs";
import { verifySeededPolicies } from "../policy/verify-seeded-policies.js";
import { initStore, getRepos, closeStore } from "../db.js";

/**
 * Runtime inventory gate (audit P0, lane d749deff; review finding #2). The trust
 * root is the build-checked-in digest constant, so a stale/partial/tampered table
 * — even one whose marker was recomputed to self-certify — fails closed.
 */
const MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "audit", "route-policy-manifest.json",
);

describe("verifySeededPolicies (runtime inventory gate)", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const rules: Array<{ method: string; pattern: string; scopes: string[] }> = manifest.rules;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gov: any;

  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    gov = getRepos().governance;
    seedRoutePolicies(gov, rules);
    writeManifestMarker(gov, rules, manifest.version);
  });
  afterEach(() => closeStore());

  const setMarker = (obj: unknown) =>
    gov.updateEndpointScope(MANIFEST_MARKER_ID, { description: JSON.stringify(obj) });
  const escrowId = () => {
    const e = rules.find((r) => r.pattern === "/api/escrow/**")!;
    return ruleId(e.method, e.pattern);
  };

  it("passes on a clean, complete seed", () => {
    expect(() => verifySeededPolicies(gov)).not.toThrow();
  });

  it("throws when never seeded (rows but no marker)", () => {
    closeStore();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    const g = getRepos().governance;
    seedRoutePolicies(g, rules); // rows, but NO marker written
    expect(() => verifySeededPolicies(g)).toThrow(/not seeded/);
  });

  it("throws when the marker has only {version} (count/digest missing)", () => {
    setMarker({ version: 1 });
    expect(() => verifySeededPolicies(gov)).toThrow(/count missing/);
  });

  it("throws when the marker digest is removed", () => {
    setMarker({ version: 1, count: rules.length });
    expect(() => verifySeededPolicies(gov)).toThrow(/digest missing/);
  });

  it("throws on a higher unrecognized manifest version", () => {
    setMarker({ version: 2, count: rules.length, digest: manifestDigest(rules) });
    expect(() => verifySeededPolicies(gov)).toThrow(/version 2 != expected 1/);
  });

  it("throws on COORDINATED tamper (row changed + marker digest recomputed to self-certify)", () => {
    gov.updateEndpointScope(escrowId(), { requiredScopes: ["operator", "requestor", "admin", "verifier"] });
    const live = gov
      .findAllEndpointScopes()
      .filter((r: { id: string; method: string }) => r.id !== MANIFEST_MARKER_ID && r.method !== "MARKER")
      .map((r: { method: string; routePattern: string; requiredScopes: string[] }) => ({
        method: r.method, pattern: r.routePattern, scopes: r.requiredScopes,
      }));
    // Attacker rewrites the marker to match the tampered rows — still fails, because
    // the recomputed digest != the BUILD-trusted constant.
    setMarker({ version: 1, count: live.length, digest: manifestDigest(live) });
    expect(() => verifySeededPolicies(gov)).toThrow(/build-trusted/);
  });

  it("throws on an extra row (even with the marker count bumped)", () => {
    gov.insertEndpointScope({ id: "extra", method: "POST", routePattern: "/api/extra/x", requiredScopes: ["admin"], description: null });
    setMarker({ version: 1, count: rules.length + 1, digest: manifestDigest(rules) });
    expect(() => verifySeededPolicies(gov)).toThrow(/count .* != expected|live rows/);
  });

  it("throws on a WILDCARD scope injected into a row", () => {
    gov.updateEndpointScope(escrowId(), { requiredScopes: ["*"] });
    expect(() => verifySeededPolicies(gov)).toThrow(/wildcard/);
  });

  it("throws on an UNKNOWN scope injected into a row", () => {
    gov.updateEndpointScope(escrowId(), { requiredScopes: ["superuser"] });
    expect(() => verifySeededPolicies(gov)).toThrow(/unknown scope/);
  });

  it("throws on an INVALID HTTP method in a row", () => {
    gov.updateEndpointScope(escrowId(), { method: "BOGUS" });
    expect(() => verifySeededPolicies(gov)).toThrow(/invalid method/);
  });

  it("throws on a TAMPERED marker (valid description, but inert shape rewritten to a real policy)", () => {
    // Attacker keeps the signed-off {version,count,digest} description but turns the
    // marker into an active policy for a protected route — excluded from the digest
    // here, but loaded by the runtime scope cache. Full-row validation must catch it.
    gov.updateEndpointScope(MANIFEST_MARKER_ID, {
      method: "POST",
      routePattern: "/api/onboard/registrations/*/approve",
      requiredScopes: ["operator", "admin"],
    });
    expect(() => verifySeededPolicies(gov)).toThrow(/marker row has been tampered/);
  });

  it("regen guard: the generated constants match the current manifest", async () => {
    // Fails if the manifest is edited without re-running `--emit-constants`.
    const c = await import("../policy/manifest-digest.generated.js");
    expect(c.EXPECTED_MANIFEST_VERSION).toBe(manifest.version);
    expect(c.EXPECTED_MANIFEST_COUNT).toBe(rules.length);
    expect(c.EXPECTED_MANIFEST_DIGEST).toBe(manifestDigest(rules));
  });
});
