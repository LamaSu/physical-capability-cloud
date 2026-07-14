import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, getRepos, getStore, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import {
  createScopeGrantService,
  validateOnboardingGrant,
  validateAdminGrant,
  ScopeGrantError,
  __unsafeInternalsForTests,
  type ScopeGrantAudit,
  type ScopeGrantDeps,
} from "../auth/onboarding-scope-grant.js";

// R3 #5: the DI grant functions are only reachable through the explicit test seam.
const { grantVerifiedOnboardingScopes, grantAdminScopes } = __unsafeInternalsForTests;

/**
 * Scope grants (audit P0, lane d749deff; review findings #1/#3). A scopeless key
 * is elevated only through an ATOMIC audited grant — grant + durable audit commit
 * or roll back together, and neither authority may ever grant a wildcard.
 */
describe("scope grants (atomic, audited)", () => {
  beforeAll(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
  });
  afterAll(() => closeStore());

  let n = 0;
  const keys = () => getRepos().apiKeys;
  const scopesOf = (id: string) => JSON.parse(getRepos().apiKeys.findById(id)!.scopes);
  const freshScopelessKey = () => provisionApiKey({ operatorId: `onb-${++n}@x.com`, scopes: [] }).record!.id;
  const grantEvents = () => getRepos().auditLog.query({ eventType: "auth.scope_granted" });

  // Real transaction + a durable audit recorder that inserts into audit_log.
  const durableDeps = (): ScopeGrantDeps => ({
    runInTransaction: (fn) => getStore().db.transaction(() => fn()),
    apiKeys: keys(),
    audit: {
      record: (e: ScopeGrantAudit) =>
        getRepos().auditLog.insert({
          timestamp: new Date().toISOString(),
          eventType: "auth.scope_granted",
          actor: e.grantedBy,
          resourceType: "api_key",
          resourceId: e.keyId,
          action: "grant",
          metadata: { scopes: e.scopes, via: e.via },
        }),
    },
  });

  it("verified onboarding: elevates a scopeless key, writing a durable audit row", () => {
    const before = grantEvents().length;
    const id = freshScopelessKey();
    grantVerifiedOnboardingScopes(durableDeps(), id);
    expect(scopesOf(id)).toEqual(["operator", "requestor"]);
    expect(grantEvents().length).toBe(before + 1);
    expect(grantEvents().find((e) => e.resourceId === id)).toMatchObject({ action: "grant" });
  });

  it("ATOMIC: if the audit insert throws, the scope update ROLLS BACK (no grant, no record)", () => {
    const before = grantEvents().length;
    const id = freshScopelessKey();
    const deps: ScopeGrantDeps = {
      runInTransaction: (fn) => getStore().db.transaction(() => fn()),
      apiKeys: keys(),
      audit: { record: () => { throw new Error("audit sink down"); } },
    };
    expect(() => grantVerifiedOnboardingScopes(deps, id)).toThrow(/audit sink down/);
    expect(scopesOf(id)).toEqual([]); // rolled back — NOT granted
    expect(grantEvents().length).toBe(before); // no audit row either
  });

  it("verified onboarding: REFUSES wildcard/admin/verifier/unknown/empty — no update, no audit", () => {
    const before = grantEvents().length;
    const id = freshScopelessKey();
    for (const bad of [["*"], ["admin"], ["verifier"], ["superuser"], []]) {
      expect(() => grantVerifiedOnboardingScopes(durableDeps(), id, bad)).toThrow(ScopeGrantError);
    }
    expect(scopesOf(id)).toEqual([]);
    expect(grantEvents().length).toBe(before);
  });

  it("admin grant: may assign a privileged role (verifier/auditor), audited via:admin", () => {
    const id = freshScopelessKey();
    grantAdminScopes(durableDeps(), id, ["verifier", "auditor"], "admin-op@x.com");
    expect(scopesOf(id)).toEqual(["verifier", "auditor"]);
    expect(grantEvents().find((e) => e.resourceId === id)).toMatchObject({ actor: "admin-op@x.com" });
  });

  it("admin grant: still REFUSES a wildcard", () => {
    const id = freshScopelessKey();
    expect(() => grantAdminScopes(durableDeps(), id, ["*"], "admin-op@x.com")).toThrow(/wildcard/);
    expect(scopesOf(id)).toEqual([]);
  });

  it("throws (and does not audit) when the key is missing or revoked", () => {
    const before = grantEvents().length;
    expect(() => grantVerifiedOnboardingScopes(durableDeps(), "nonexistent-key")).toThrow(/not found or revoked/);
    const id = freshScopelessKey();
    keys().revoke(id);
    expect(() => grantVerifiedOnboardingScopes(durableDeps(), id)).toThrow(/not found or revoked/);
    expect(grantEvents().length).toBe(before);
  });

  it("createScopeGrantService: store-bound factory grants atomically + audits (R2 #2)", () => {
    const before = grantEvents().length;
    const svc = createScopeGrantService(getStore());
    const id = freshScopelessKey();
    svc.grantVerifiedOnboardingScopes(id);
    expect(scopesOf(id)).toEqual(["operator", "requestor"]);
    expect(grantEvents().length).toBe(before + 1);
    const id2 = freshScopelessKey();
    svc.grantAdminScopes(id2, ["verifier"], "admin@x.com");
    expect(scopesOf(id2)).toEqual(["verifier"]);
    expect(grantEvents().find((e) => e.resourceId === id2)).toMatchObject({ actor: "admin@x.com" });
  });

  it("validators flag each problem", () => {
    expect(validateOnboardingGrant(["operator", "requestor"])).toEqual([]);
    expect(validateOnboardingGrant(["admin"])).toEqual([expect.stringContaining("not grantable")]);
    expect(validateAdminGrant(["verifier"])).toEqual([]);
    expect(validateAdminGrant(["*"])).toEqual([expect.stringContaining("wildcard")]);
  });
});
