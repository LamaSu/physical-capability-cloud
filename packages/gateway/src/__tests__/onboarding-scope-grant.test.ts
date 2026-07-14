import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, getRepos, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import {
  grantVerifiedOnboardingScopes,
  grantAdminScopes,
  validateOnboardingGrant,
  validateAdminGrant,
  ScopeGrantError,
  type ScopeGrantAudit,
} from "../auth/onboarding-scope-grant.js";

/**
 * Scope grants (audit P0, lane d749deff). A scopeless key is elevated only through
 * an audited grant: verified-onboarding may grant operator/requestor; admin may
 * grant any real role. Neither may ever grant a wildcard, and every grant is
 * recorded (the audit sink is required).
 */
describe("scope grants (verified-onboarding + admin)", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterAll(() => closeStore());

  let n = 0;
  const audits: ScopeGrantAudit[] = [];
  const audit = (e: ScopeGrantAudit) => audits.push(e);
  const keys = () => getRepos().apiKeys;
  const freshScopelessKey = () => provisionApiKey({ operatorId: `onb-${++n}@x.com`, scopes: [] }).record!.id;
  const scopesOf = (id: string) => JSON.parse(getRepos().apiKeys.findById(id)!.scopes);

  it("verified onboarding: elevates a scopeless key to operator+requestor, and AUDITS it", () => {
    audits.length = 0;
    const id = freshScopelessKey();
    expect(scopesOf(id)).toEqual([]);
    grantVerifiedOnboardingScopes(keys(), id, audit);
    expect(scopesOf(id)).toEqual(["operator", "requestor"]);
    expect(audits).toEqual([
      { keyId: id, scopes: ["operator", "requestor"], via: "verified-onboarding", grantedBy: "system:verified-onboarding" },
    ]);
  });

  it("verified onboarding: REFUSES wildcard/admin/verifier/unknown/empty — key untouched, no audit", () => {
    audits.length = 0;
    const id = freshScopelessKey();
    for (const bad of [["*"], ["admin"], ["verifier"], ["superuser"], []]) {
      expect(() => grantVerifiedOnboardingScopes(keys(), id, audit, bad)).toThrow(ScopeGrantError);
    }
    expect(scopesOf(id)).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("admin grant: may assign a privileged role (verifier/auditor), audited as via:admin", () => {
    audits.length = 0;
    const id = freshScopelessKey();
    grantAdminScopes(keys(), id, ["verifier", "auditor"], audit, "admin-op@x.com");
    expect(scopesOf(id)).toEqual(["verifier", "auditor"]);
    expect(audits[0]).toMatchObject({ keyId: id, via: "admin", grantedBy: "admin-op@x.com" });
  });

  it("admin grant: still REFUSES a wildcard", () => {
    const id = freshScopelessKey();
    expect(() => grantAdminScopes(keys(), id, ["*"], audit, "admin-op@x.com")).toThrow(/wildcard/);
    expect(scopesOf(id)).toEqual([]);
  });

  it("throws when the key is missing", () => {
    expect(() => grantVerifiedOnboardingScopes(keys(), "nonexistent-key", audit)).toThrow(/not found or revoked/);
  });

  it("throws when the key is REVOKED (updateScopes is active-only)", () => {
    const id = freshScopelessKey();
    keys().revoke(id);
    expect(() => grantVerifiedOnboardingScopes(keys(), id, audit)).toThrow(/not found or revoked/);
  });

  it("validators flag each problem", () => {
    expect(validateOnboardingGrant(["operator", "requestor"])).toEqual([]);
    expect(validateOnboardingGrant(["admin"])).toEqual([expect.stringContaining("not grantable")]);
    expect(validateAdminGrant(["verifier"])).toEqual([]);
    expect(validateAdminGrant(["*"])).toEqual([expect.stringContaining("wildcard")]);
  });
});
