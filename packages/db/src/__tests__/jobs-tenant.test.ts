/**
 * Wave 4.1.x — JobRepository tenant-scoping tests.
 *
 * Mirrors the registrations-tenant.test.ts shape: opts.tenantId omitted →
 * returns ALL rows; provided → filters by tenant_id. Same additive pattern
 * as machine_registrations from Wave 4.1.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

describe("Wave 4.1.x — JobRepository tenant scoping", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });

    // FK pragma is OFF (per migrate.ts), so we can insert jobs directly
    // without seeding kernels/capabilities first.
    const seed = (id: string, tenantId: string | null, kernelId = "kernel-test", status = "queued") => {
      store.repos.jobs.insert({
        id,
        stepId: `step-${id}`,
        cwmId: `cwm-${id}`,
        capabilityId: "cap-test",
        kernelId,
        status,
        assignedDevices: [],
        progress: 0,
        ...(tenantId !== null ? { tenantId } : {}),
      } as any);
    };

    seed("job-alpha-1", "alpha");
    seed("job-alpha-2", "alpha", "kernel-test", "completed");
    seed("job-beta-1", "beta");
    seed("job-public", null);
  });

  afterEach(() => {
    store.close();
  });

  it("findAll() with no opts returns ALL rows (today's behavior)", () => {
    const all = store.repos.jobs.findAll();
    expect(all.map((j) => j.id).sort()).toEqual([
      "job-alpha-1",
      "job-alpha-2",
      "job-beta-1",
      "job-public",
    ]);
  });

  it("findAll({tenantId: 'alpha'}) returns only alpha rows", () => {
    const rows = store.repos.jobs.findAll({ tenantId: "alpha" });
    expect(rows.map((j) => j.id).sort()).toEqual(["job-alpha-1", "job-alpha-2"]);
  });

  it("findByKernel scopes by tenant when opts provided", () => {
    const alphaOnly = store.repos.jobs.findByKernel("kernel-test", { tenantId: "alpha" });
    expect(alphaOnly).toHaveLength(2);
    const betaOnly = store.repos.jobs.findByKernel("kernel-test", { tenantId: "beta" });
    expect(betaOnly).toHaveLength(1);
    expect(betaOnly[0]?.id).toBe("job-beta-1");
  });

  it("findByStatus scopes by tenant when opts provided", () => {
    const alphaQueued = store.repos.jobs.findByStatus("queued", { tenantId: "alpha" });
    expect(alphaQueued).toHaveLength(1);
    expect(alphaQueued[0]?.id).toBe("job-alpha-1");
  });

  it("findByKernelAndStatus combines kernel + status + tenant filter", () => {
    const alphaCompleted = store.repos.jobs.findByKernelAndStatus("kernel-test", "completed", {
      tenantId: "alpha",
    });
    expect(alphaCompleted).toHaveLength(1);
    expect(alphaCompleted[0]?.id).toBe("job-alpha-2");

    const betaCompleted = store.repos.jobs.findByKernelAndStatus("kernel-test", "completed", {
      tenantId: "beta",
    });
    expect(betaCompleted).toHaveLength(0);
  });

  it("opts.tenantId of an unknown tenant returns zero rows", () => {
    expect(store.repos.jobs.findAll({ tenantId: "ghost" })).toHaveLength(0);
  });
});
