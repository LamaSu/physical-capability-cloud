import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts
import { validateManifest, seedRoutePolicyManifest, ruleId, MANIFEST_OWNED_PREFIX, MANIFEST_MARKER_ID, __unsafeInternalsForTests } from "../../../../scripts/audit/seed-route-policy.mjs";
// R3 #6: seedRoutePolicies is a non-transactional partial-seed primitive, test-only.
const { seedRoutePolicies } = __unsafeInternalsForTests;
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

  // ── R3 #6: version validation, prefix reservation, and rollback failure injection ──

  it("seedRoutePolicyManifest REJECTS a non-positive-integer version (R3 #6)", () => {
    for (const bad of [0, -1, 1.5, undefined, "1", null]) {
      expect(() => seedRoutePolicyManifest(getStore(), { version: bad, rules }, { schema, eq }),
        `version ${JSON.stringify(bad)} must be rejected`).toThrow(/positive integer/);
    }
  });

  it("only rp_ (manifest-owned) rows are swept — foreign rows survive a seed (R3 #6)", () => {
    const gov = getRepos().governance;
    expect(MANIFEST_OWNED_PREFIX).toBe("rp_");
    // A row owned by another subsystem (not rp_*) must never be deleted by seeding.
    gov.insertEndpointScope({ id: "custom_keep_me", method: "GET", routePattern: "/api/other/x", requiredScopes: ["admin"], description: null });
    seedRoutePolicyManifest(getStore(), manifest, { schema, eq });
    expect(gov.findEndpointScopeById("custom_keep_me"), "non-rp_ row must survive seeding").toBeTruthy();
    gov.updateEndpointScope("custom_keep_me", { requiredScopes: ["admin"] }); // leave it clean for other tests
  });

  // Wrap the real store so ONE governance method fails, keeping the real
  // db.transaction (better-sqlite3, rolls back on throw) — proves atomicity.
  function storeWithFailingGov(method: string, shouldFail: (n: number, args: unknown[]) => boolean) {
    const store = getStore();
    const realGov = store.repos.governance as Record<string, unknown>;
    let n = 0;
    const gov = new Proxy(realGov, {
      get(t, p) {
        if (p === method) return (...a: unknown[]) => { if (shouldFail(++n, a)) throw new Error(`injected ${method} failure`); return (t[p as string] as (...x: unknown[]) => unknown)(...a); };
        const v = t[p as string];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { db: store.db, repos: { ...store.repos, governance: gov } };
  }

  const snapshot = () => getRepos().governance.findAllEndpointScopes()
    .map((r: { id: string; method: string; routePattern: string; requiredScopes: unknown }) =>
      `${r.id}|${r.method}|${r.routePattern}|${JSON.stringify(r.requiredScopes)}`)
    .sort();

  it("rollback: a mid-seed UPSERT failure leaves the table byte-identical (R3 #6)", () => {
    const gov = getRepos().governance;
    seedRoutePolicyManifest(getStore(), manifest, { schema, eq }); // clean baseline
    gov.insertEndpointScope({ id: "rp_rollback_a", method: "POST", routePattern: "/api/gone/a", requiredScopes: ["admin"], description: null });
    const before = snapshot();

    // Fail on the 5th updateEndpointScope (deep inside the rule upsert loop).
    const failing = storeWithFailingGov("updateEndpointScope", (n) => n >= 5);
    expect(() => seedRoutePolicyManifest(failing, manifest, { schema, eq })).toThrow(/injected updateEndpointScope/);

    // Whole transaction rolled back: the stale rp_ row was NOT deleted, no partial
    // updates, marker unchanged — identical to before.
    expect(snapshot()).toEqual(before);
    expect(gov.findEndpointScopeById("rp_rollback_a"), "stale row must survive a failed seed").toBeTruthy();
    seedRoutePolicyManifest(getStore(), manifest, { schema, eq }); // clean up the stale row
  });

  it("rollback: a MARKER-write failure rolls back the rule upserts + stale deletion (R3 #6)", () => {
    const gov = getRepos().governance;
    seedRoutePolicyManifest(getStore(), manifest, { schema, eq }); // clean baseline (marker exists)
    gov.insertEndpointScope({ id: "rp_rollback_b", method: "POST", routePattern: "/api/gone/b", requiredScopes: ["admin"], description: null });
    const before = snapshot();

    // Marker write is the last op; it updates the existing marker row. Fail ONLY that.
    const failing = storeWithFailingGov("updateEndpointScope", (_n, a) => a[0] === MANIFEST_MARKER_ID);
    expect(() => seedRoutePolicyManifest(failing, manifest, { schema, eq })).toThrow(/injected updateEndpointScope/);

    // The stale row's deletion (which happened before the marker write) is rolled back.
    expect(snapshot()).toEqual(before);
    expect(gov.findEndpointScopeById("rp_rollback_b")).toBeTruthy();
    seedRoutePolicyManifest(getStore(), manifest, { schema, eq }); // clean up
  });

  it("boundary: no gateway production source imports the partial-seed seam (R3 #6)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
    const walk = (d: string): string[] => readdirSync(d).flatMap((name) => {
      if (name === "__tests__" || name === "node_modules") return [];
      const p = join(d, name);
      if (statSync(p).isDirectory()) return walk(p);
      return name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts") ? [p] : [];
    });
    const offenders = walk(SRC)
      .filter((f) => /seed-route-policy/.test(readFileSync(f, "utf8")) && /__unsafeInternalsForTests|writeManifestMarker|seedRoutePolicies\b/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));
    expect(offenders, "gateway production code must seed only via seedRoutePolicyManifest").toEqual([]);
  });
});
