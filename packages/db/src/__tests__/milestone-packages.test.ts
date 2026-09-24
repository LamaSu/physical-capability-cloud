/**
 * Tests for the MilestonePackage persistence layer (§8.4-B / §2.3).
 *
 * Covers: insert/findById round-trip (incl. the body + receiptBody JSON columns
 * round-tripping as objects), findByJobMilestone (idempotent re-finalize lookup),
 * the UNIQUE(job_id, milestone_index) rule, and that the migration creates the
 * table + its indexes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createStore,
  sql,
  type Store,
  type MilestonePackageInsert,
} from "../index.js";

function makeRow(
  overrides: Partial<MilestonePackageInsert> = {},
): MilestonePackageInsert {
  return {
    packageId: "fmp-job-1-0",
    jobId: "job-1",
    milestoneIndex: 0,
    sessionId: "sess-1",
    evidenceRoot: "sha256:root",
    packageHash: "sha256:pkg",
    receiptId: "fmprcpt-job-1-0",
    body: { packageId: "fmp-job-1-0", acceptedCheckpointHashes: ["h1", "h2"] },
    receiptBody: { receiptId: "fmprcpt-job-1-0", packageHash: "sha256:pkg" },
    acceptedAt: 1_800_000_000,
    createdAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("MilestonePackageRepository", () => {
  let store: Store;
  beforeEach(() => {
    store = createStore({ seed: false });
  });
  afterEach(() => {
    store.close();
  });

  it("insert + findById round-trip (JSON columns parse to objects)", () => {
    const inserted = store.repos.milestonePackages.insert(makeRow());
    expect(inserted?.packageId).toBe("fmp-job-1-0");
    const found = store.repos.milestonePackages.findById("fmp-job-1-0");
    expect(found?.jobId).toBe("job-1");
    expect(found?.evidenceRoot).toBe("sha256:root");
    expect(found?.packageHash).toBe("sha256:pkg");
    expect(found?.receiptId).toBe("fmprcpt-job-1-0");
    expect(found?.acceptedAt).toBe(1_800_000_000);
    // JSON columns round-trip as parsed objects, not strings.
    const body = found?.body as { acceptedCheckpointHashes: string[] };
    expect(body.acceptedCheckpointHashes).toEqual(["h1", "h2"]);
    const receipt = found?.receiptBody as { packageHash: string };
    expect(receipt.packageHash).toBe("sha256:pkg");
  });

  it("findByJobMilestone returns the finalized package for a (job, milestone)", () => {
    store.repos.milestonePackages.insert(makeRow());
    expect(store.repos.milestonePackages.findByJobMilestone("job-1", 0)?.packageId).toBe("fmp-job-1-0");
    expect(store.repos.milestonePackages.findByJobMilestone("job-1", 9)).toBeUndefined();
  });

  it("enforces UNIQUE(job_id, milestone_index): a second package for the same (job, milestone) is rejected", () => {
    store.repos.milestonePackages.insert(makeRow());
    // Same (job, milestone) under a different packageId → unique violation.
    expect(() =>
      store.repos.milestonePackages.insert(makeRow({ packageId: "fmp-job-1-0-dup" })),
    ).toThrow();
    // A different milestone in the same job inserts fine.
    expect(
      store.repos.milestonePackages.insert(
        makeRow({ packageId: "fmp-job-1-1", milestoneIndex: 1 }),
      )?.milestoneIndex,
    ).toBe(1);
  });

  it("migration creates the milestone_packages table + its indexes", () => {
    const tables = store.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name='milestone_packages'`,
    ) as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("milestone_packages");

    const indexes = store.db.all(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='milestone_packages' AND name NOT LIKE 'sqlite_%'`,
    ) as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("milestone_packages_job_idx");
    expect(names).toContain("milestone_packages_job_milestone_unique");
  });
});
