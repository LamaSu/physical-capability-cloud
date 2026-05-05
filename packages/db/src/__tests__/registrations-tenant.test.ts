/**
 * Wave 4.1 — RegistrationRepository tenant-scoping tests.
 *
 * Repo-layer behavior, no gateway involved. Verifies the tri-state semantics
 * of the optional `TenantScopeOpts.tenantId`:
 *   - omitted   → returns ALL rows
 *   - string    → filters tenant_id = <string>
 *   - null      → filters tenant_id IS NULL (anonymous public-discovery rows)
 *
 * Companion to packages/gateway/src/__tests__/tenant-isolation.test.ts which
 * exercises the route-layer feature flag (TENANT_ENFORCE).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

describe("Wave 4.1 — RegistrationRepository tenant scoping", () => {
  let store: Store;

  beforeEach(() => {
    // Unseeded — we control the rows precisely.
    store = createStore({ seed: false });

    const seed = (id: string, tenantId: string | null, compliance?: string[]) => {
      store.repos.registrations.insert({
        id,
        name: `reg-${id}`,
        category: "fdm",
        manufacturer: "Acme",
        model: "X1",
        photos: [],
        capabilities: [] as any,
        spaceRequirements: {} as any,
        pricing: { baseCost: "0", minimum: "0", currency: "USDC" } as any,
        operator: {
          walletAddress: tenantId ?? "0x0",
          displayName: "Op",
          certifications: [],
          trainingAcknowledgments: {},
        } as any,
        complianceRegulations: compliance,
        tenantId: tenantId ?? undefined,
        status: "submitted",
        createdAt: new Date().toISOString(),
      });
    };

    // 2 alpha rows, 1 beta row, 1 anonymous (null) row.
    seed("reg-alpha-1", "alpha", ["ISO-9001:2015"]);
    seed("reg-alpha-2", "alpha");
    seed("reg-beta-1", "beta", ["ISO-9001:2015"]);
    seed("reg-anon-1", null, ["ISO-9001:2015"]);
  });

  afterEach(() => {
    store.close();
  });

  it("findAll({ tenantId: 'alpha' }) returns only alpha rows", () => {
    const alphaRows = store.repos.registrations.findAll({ tenantId: "alpha" });
    expect(alphaRows.map((r) => r.id).sort()).toEqual(["reg-alpha-1", "reg-alpha-2"]);
  });

  it("findAll() with no opts returns ALL rows (today's behavior preserved)", () => {
    const all = store.repos.registrations.findAll();
    expect(all.map((r) => r.id).sort()).toEqual([
      "reg-alpha-1",
      "reg-alpha-2",
      "reg-anon-1",
      "reg-beta-1",
    ]);
  });

  it("findAll({ tenantId: null }) returns rows whose tenant_id IS NULL (anonymous)", () => {
    const anon = store.repos.registrations.findAll({ tenantId: null });
    expect(anon.map((r) => r.id)).toEqual(["reg-anon-1"]);
  });

  it("findByCompliance('ISO-9001:2015', { tenantId: 'alpha' }) is the AND of compliance + tenant filter", () => {
    // Alpha has 1 ISO row; beta has 1; anon has 1. Tenant=alpha must yield only the alpha row.
    const matches = store.repos.registrations.findByCompliance("ISO-9001:2015", { tenantId: "alpha" });
    expect(matches.map((r) => r.id)).toEqual(["reg-alpha-1"]);

    // Sanity: without the tenant filter, all 3 ISO rows surface.
    const all = store.repos.registrations.findByCompliance("ISO-9001:2015");
    expect(all.map((r) => r.id).sort()).toEqual(["reg-alpha-1", "reg-anon-1", "reg-beta-1"]);
  });
});
