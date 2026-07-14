import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, getRepos, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
// @ts-expect-error — JS audit tool, no d.ts
import { classifyKey, planMigration, applyMigration } from "../../../../scripts/audit/migrate-wildcard-keys.mjs";

/**
 * Wildcard-key migration (audit P0, lane d749deff). Legacy keys minted scopes:["*"]
 * authorize nothing under the fixed scope-checker, so they must be re-scoped before
 * enforce — but NOT blindly: only self-service keys are auto-rescoped; privileged /
 * unknown-source wildcard keys are flagged for manual review, never auto-changed.
 */
describe("wildcard-key migration", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterAll(() => closeStore());

  const scopesOf = (id: string) => JSON.parse(getRepos().apiKeys.findById(id)!.scopes);

  it("migrates self-service -> [operator,requestor]; leaves review + normal keys untouched", () => {
    const ss = provisionApiKey({ operatorId: "ss@x.com", scopes: ["*"], metadata: { source: "landing-page" } }).record!.id;
    const priv = provisionApiKey({ operatorId: "priv@x.com", scopes: ["*"], metadata: { source: "internal-admin" } }).record!.id;
    const normal = provisionApiKey({ operatorId: "norm@x.com", scopes: ["operator"] }).record!.id;

    const plan = planMigration(getRepos().apiKeys.listActive());
    expect(plan.rescope.map((k: { id: string }) => k.id)).toEqual([ss]);
    expect(plan.review.map((k: { id: string }) => k.id)).toEqual([priv]);
    expect(plan.skip).toContain(normal);

    expect(applyMigration(getRepos().apiKeys, plan)).toBe(1);
    expect(scopesOf(ss)).toEqual(["operator", "requestor"]); // migrated
    expect(scopesOf(priv)).toEqual(["*"]); // review — NEVER auto-changed
    expect(scopesOf(normal)).toEqual(["operator"]); // untouched
  });

  it("classifyKey: landing-page->rescope, other/unknown source->review, non-wildcard->skip", () => {
    expect(classifyKey({ scopes: '["*"]', metadata: '{"source":"landing-page"}' }).action).toBe("rescope");
    expect(classifyKey({ scopes: '["*"]', metadata: '{"source":"cli"}' }).action).toBe("review");
    expect(classifyKey({ scopes: '["*"]', metadata: null }).action).toBe("review");
    expect(classifyKey({ scopes: '["operator"]', metadata: null }).action).toBe("skip");
  });
});
