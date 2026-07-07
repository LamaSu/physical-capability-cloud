/**
 * F8 — jobs.assurance_tier round-trip.
 *
 * The jobs table historically had no assurance-tier column, so every JobDTO
 * hardcoded tier 0. This verifies the additive column persists and reads
 * back, and that legacy-style inserts (no tier) read back as null.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";

describe("F8 — JobRepository assurance_tier round-trip", () => {
  let store: Store;

  beforeEach(() => {
    store = createStore({ seed: false });
  });

  afterEach(() => {
    store.close();
  });

  const baseJob = (id: string) => ({
    id,
    stepId: `step-${id}`,
    cwmId: `cwm-${id}`,
    capabilityId: "cap-test",
    kernelId: "kernel-test",
    status: "queued",
    assignedDevices: [] as string[],
    progress: 0,
  });

  it("persists and reads back the assurance tier", () => {
    store.repos.jobs.insert({ ...baseJob("job-t2"), assuranceTier: 2 });
    const row = store.repos.jobs.findById("job-t2");
    expect(row?.assuranceTier).toBe(2);
  });

  it("tier 0 persists as 0 (not conflated with null)", () => {
    store.repos.jobs.insert({ ...baseJob("job-t0"), assuranceTier: 0 });
    const row = store.repos.jobs.findById("job-t0");
    expect(row?.assuranceTier).toBe(0);
  });

  it("legacy insert without a tier reads back null", () => {
    store.repos.jobs.insert(baseJob("job-legacy"));
    const row = store.repos.jobs.findById("job-legacy");
    expect(row?.assuranceTier).toBeNull();
  });

  it("update() can backfill the tier on an existing row", () => {
    store.repos.jobs.insert(baseJob("job-backfill"));
    store.repos.jobs.update("job-backfill", { assuranceTier: 3 });
    expect(store.repos.jobs.findById("job-backfill")?.assuranceTier).toBe(3);
  });
});
