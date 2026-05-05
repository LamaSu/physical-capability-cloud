/**
 * Wave 4.1.x — Evidence + Capabilities tenant-scoping repo tests.
 *
 * Same additive-opts pattern as machine_registrations + jobs:
 *   - omitted opts → returns all rows (today's behavior)
 *   - opts.tenantId set → filters tenant_id = <string>
 *
 * Companion to existing repo tests (registrations-tenant, jobs-tenant).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

describe("Wave 4.1.x — EvidenceBundleRepository tenant scoping", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });
    // FK pragma is OFF in migrate.ts so we don't need real kernel/job/cap rows.
    const seed = (id: string, jobId: string, kernelId: string, tenantId: string | null) =>
      store.repos.evidence.insert({
        id,
        jobId,
        stepId: `step-${id}`,
        kernelId,
        assuranceTier: 1,
        bundleHash: `0x${id}`,
        kernelSignature: { signer: "ks", algorithm: "ed25519", value: "v" },
        tenantId,
        createdAt: new Date().toISOString(),
      } as any);

    seed("e-alpha-1", "job-1", "k-1", "alpha");
    seed("e-alpha-2", "job-1", "k-2", "alpha");
    seed("e-beta-1", "job-2", "k-1", "beta");
    seed("e-public-1", "job-3", "k-1", null);
  });

  afterEach(() => {
    store.close();
  });

  it("findAll() with no opts returns ALL rows (today's behavior)", () => {
    expect(store.repos.evidence.findAll()).toHaveLength(4);
  });

  it("findAll({tenantId: 'alpha'}) returns only alpha rows", () => {
    const rows = store.repos.evidence.findAll({ tenantId: "alpha" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === "alpha")).toBe(true);
  });

  it("findByJob scopes by tenant when opts provided", () => {
    expect(store.repos.evidence.findByJob("job-1")).toHaveLength(2);
    expect(store.repos.evidence.findByJob("job-1", { tenantId: "alpha" })).toHaveLength(2);
    expect(store.repos.evidence.findByJob("job-2", { tenantId: "alpha" })).toHaveLength(0);
  });

  it("findByKernel scopes by tenant when opts provided", () => {
    expect(store.repos.evidence.findByKernel("k-1")).toHaveLength(3);
    expect(store.repos.evidence.findByKernel("k-1", { tenantId: "alpha" })).toHaveLength(1);
    expect(store.repos.evidence.findByKernel("k-1", { tenantId: "beta" })).toHaveLength(1);
  });

  it("opts.tenantId of an unknown tenant returns zero rows", () => {
    expect(store.repos.evidence.findAll({ tenantId: "ghost" })).toHaveLength(0);
  });
});

describe("Wave 4.1.x — CapabilityRepository tenant scoping", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });
    const seed = (id: string, kernelId: string, type: string, name: string, tenantId: string | null) =>
      store.repos.capabilities.insert({
        id,
        kernelId,
        type,
        name,
        materials: ["PLA"] as any,
        assuranceTiers: [1] as any,
        pricing: { currency: "USDC", baseCost: "0", minimum: "0" } as any,
        availability: {} as any,
        location: { lat: 0, lng: 0 } as any,
        queueDepth: 0,
        tenantId,
      } as any);

    seed("cap-alpha-fdm", "k-1", "fdm", "Alpha FDM 1", "alpha");
    seed("cap-alpha-cnc", "k-1", "cnc", "Alpha CNC 1", "alpha");
    seed("cap-beta-fdm", "k-2", "fdm", "Beta FDM 1", "beta");
    seed("cap-public-fdm", "k-3", "fdm", "Public FDM", null);
  });

  afterEach(() => {
    store.close();
  });

  it("findAll() with no opts returns ALL rows (today's behavior)", () => {
    expect(store.repos.capabilities.findAll()).toHaveLength(4);
  });

  it("findAll({tenantId: 'alpha'}) returns only alpha rows", () => {
    const rows = store.repos.capabilities.findAll({ tenantId: "alpha" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tenantId === "alpha")).toBe(true);
  });

  it("findByKernel scopes by tenant when opts provided", () => {
    expect(store.repos.capabilities.findByKernel("k-1")).toHaveLength(2);
    expect(store.repos.capabilities.findByKernel("k-1", { tenantId: "alpha" })).toHaveLength(2);
    expect(store.repos.capabilities.findByKernel("k-1", { tenantId: "beta" })).toHaveLength(0);
  });

  it("findByType combines type + tenant filter", () => {
    expect(store.repos.capabilities.findByType("fdm")).toHaveLength(3);
    expect(store.repos.capabilities.findByType("fdm", { tenantId: "alpha" })).toHaveLength(1);
    expect(store.repos.capabilities.findByType("cnc", { tenantId: "alpha" })).toHaveLength(1);
    expect(store.repos.capabilities.findByType("cnc", { tenantId: "beta" })).toHaveLength(0);
  });

  it("search combines LIKE + tenant filter", () => {
    expect(store.repos.capabilities.search("FDM")).toHaveLength(3);
    expect(store.repos.capabilities.search("FDM", { tenantId: "alpha" })).toHaveLength(1);
    expect(store.repos.capabilities.search("Alpha")).toHaveLength(2);
    expect(store.repos.capabilities.search("Alpha", { tenantId: "beta" })).toHaveLength(0);
  });
});
