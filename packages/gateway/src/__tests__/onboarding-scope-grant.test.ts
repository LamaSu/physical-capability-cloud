import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, getRepos, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import {
  grantVerifiedOnboardingScopes,
  validateOnboardingGrant,
  ScopeGrantError,
} from "../auth/onboarding-scope-grant.js";

/**
 * Verified-onboarding scope grant (audit P0, lane d749deff). A scopeless key is
 * elevated to least-privilege operator/requestor after a verified onboarding
 * step — and can NEVER gain a wildcard or a privileged role through this path.
 */
describe("verified-onboarding scope grant", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterAll(() => closeStore());

  let n = 0;
  const freshScopelessKey = () => {
    const { record } = provisionApiKey({ operatorId: `onb-${++n}@example.com`, scopes: [] });
    return record!.id;
  };
  const scopesOf = (id: string) => JSON.parse(getRepos().apiKeys.findById(id)!.scopes);

  it("elevates a scopeless key to operator+requestor by default", () => {
    const id = freshScopelessKey();
    expect(scopesOf(id)).toEqual([]);
    grantVerifiedOnboardingScopes(getRepos().apiKeys, id);
    expect(scopesOf(id)).toEqual(["operator", "requestor"]);
  });

  it("grants an explicit least-privilege subset", () => {
    const id = freshScopelessKey();
    grantVerifiedOnboardingScopes(getRepos().apiKeys, id, ["operator"]);
    expect(scopesOf(id)).toEqual(["operator"]);
  });

  it("REFUSES wildcard / admin / verifier / unknown / empty — key stays scopeless", () => {
    const id = freshScopelessKey();
    const gov = getRepos().apiKeys;
    expect(() => grantVerifiedOnboardingScopes(gov, id, ["*"])).toThrow(ScopeGrantError);
    expect(() => grantVerifiedOnboardingScopes(gov, id, ["admin"])).toThrow(/not grantable/);
    expect(() => grantVerifiedOnboardingScopes(gov, id, ["verifier"])).toThrow(/not grantable/);
    expect(() => grantVerifiedOnboardingScopes(gov, id, ["superuser"])).toThrow(/not grantable/);
    expect(() => grantVerifiedOnboardingScopes(gov, id, [])).toThrow(/non-empty/);
    expect(scopesOf(id)).toEqual([]); // every refusal left the key untouched
  });

  it("throws when the key is missing or revoked", () => {
    expect(() =>
      grantVerifiedOnboardingScopes(getRepos().apiKeys, "nonexistent-key", ["operator"]),
    ).toThrow(/not found or revoked/);
  });

  it("validateOnboardingGrant flags each problem", () => {
    expect(validateOnboardingGrant(["operator", "requestor"])).toEqual([]);
    expect(validateOnboardingGrant(["*"])).toEqual([expect.stringContaining("wildcard")]);
    expect(validateOnboardingGrant(["admin"])).toEqual([expect.stringContaining("not grantable")]);
    expect(validateOnboardingGrant([])).toEqual([expect.stringContaining("non-empty")]);
  });
});
