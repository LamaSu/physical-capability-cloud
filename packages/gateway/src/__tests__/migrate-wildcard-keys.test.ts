import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, getRepos, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
// @ts-expect-error — JS audit tool, no d.ts
import { classifyKey, planMigration, applyMigration } from "../../../../scripts/audit/migrate-wildcard-keys.mjs";

/**
 * Wildcard-key migration (audit P0, lane d749deff; review finding #1).
 *
 * Legacy keys minted scopes:["*"] authorize nothing under the fixed scope-checker.
 * They must be re-scoped before enforce — but source metadata alone (landing-page)
 * does NOT prove verified onboarding, so it must NEVER trigger an auto-grant.
 * Only an authoritative verified-onboarding predicate may auto-migrate; everything
 * else is manual review. Apply is TOCTOU-safe.
 */
describe("wildcard-key migration", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterAll(() => closeStore());

  const scopesOf = (id: string) => JSON.parse(getRepos().apiKeys.findById(id)!.scopes);
  const active = (...ops: string[]) =>
    getRepos().apiKeys.listActive().filter((r) => ops.includes(r.operatorId));

  it("default (no predicate): NEVER auto-grants — every wildcard key goes to manual review", () => {
    const ss = provisionApiKey({ operatorId: "ss@x.com", scopes: ["*"], metadata: { source: "landing-page" } }).record!.id;
    const priv = provisionApiKey({ operatorId: "priv@x.com", scopes: ["*"], metadata: { source: "internal-admin" } }).record!.id;
    const normal = provisionApiKey({ operatorId: "norm@x.com", scopes: ["operator"] }).record!.id;

    const plan = planMigration(active("ss@x.com", "priv@x.com", "norm@x.com"));
    expect(plan.rescope).toEqual([]); // landing-page source does NOT auto-grant
    expect(plan.review.map((k: { id: string }) => k.id).sort()).toEqual([ss, priv].sort());
    expect(plan.skip).toContain(normal);
  });

  it("auto-rescopes ONLY keys an authoritative verified-onboarding predicate approves", () => {
    const ss = provisionApiKey({ operatorId: "ss2@x.com", scopes: ["*"], metadata: { source: "landing-page" } }).record!.id;
    const priv = provisionApiKey({ operatorId: "priv2@x.com", scopes: ["*"] }).record!.id;

    const verified = (row: { operatorId: string }) => row.operatorId === "ss2@x.com"; // e.g. joins an approved registration
    const plan = planMigration(active("ss2@x.com", "priv2@x.com"), verified);
    expect(plan.rescope.map((k: { id: string }) => k.id)).toEqual([ss]);
    expect(plan.review.map((k: { id: string }) => k.id)).toEqual([priv]);

    expect(applyMigration(getRepos().apiKeys, plan)).toEqual({ changed: 1, skipped: 0 });
    expect(scopesOf(ss)).toEqual(["operator", "requestor"]);
    expect(scopesOf(priv)).toEqual(["*"]); // not verified → untouched
  });

  it("apply is TOCTOU-safe: a key changed after planning is skipped, not applied", () => {
    const k = provisionApiKey({ operatorId: "toctou@x.com", scopes: ["*"], metadata: { source: "landing-page" } }).record!.id;
    const plan = planMigration(active("toctou@x.com"), () => true);
    expect(plan.rescope.map((x: { id: string }) => x.id)).toEqual([k]);

    // Concurrent change between plan and apply: the key is no longer wildcard.
    getRepos().apiKeys.updateScopes(k, ["operator"]);
    expect(applyMigration(getRepos().apiKeys, plan)).toEqual({ changed: 0, skipped: 1 });
    expect(scopesOf(k)).toEqual(["operator"]); // migration left it alone
  });

  it("classifyKey: no predicate->review, predicate true->rescope, non-wildcard->skip", () => {
    expect(classifyKey({ scopes: '["*"]', metadata: '{"source":"landing-page"}' }).action).toBe("review");
    expect(classifyKey({ scopes: '["*"]', metadata: null }, () => true).action).toBe("rescope");
    expect(classifyKey({ scopes: '["operator"]', metadata: null }).action).toBe("skip");
  });
});
