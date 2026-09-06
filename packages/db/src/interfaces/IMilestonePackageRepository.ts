import type { milestonePackages } from "../schema/index.js";

export type MilestonePackageRow = typeof milestonePackages.$inferSelect;
export type MilestonePackageInsert = typeof milestonePackages.$inferInsert;

export interface IMilestonePackageRepository {
  insert(record: MilestonePackageInsert): MilestonePackageRow | undefined;
  findById(packageId: string): MilestonePackageRow | undefined;
  /**
   * The finalized package for a (job, milestone), if any — the idempotent
   * re-finalize lookup (permissionless triggers must be idempotent, §2.3-6).
   */
  findByJobMilestone(jobId: string, milestoneIndex: number): MilestonePackageRow | undefined;
  /**
   * The finalized package whose canonical bytes hash to `packageHash` — the
   * content-addressed lookup backing `GET /api/evidence/:packageHash` (the
   * oracle's fetch-and-rehash target when settlement anchored on a package,
   * §2.4). Accepts `sha256:<hex>` / `0x<hex>` / bare-hex forms; unknown or
   * malformed input → undefined (fail closed).
   */
  findByPackageHash(packageHash: string): MilestonePackageRow | undefined;
}
