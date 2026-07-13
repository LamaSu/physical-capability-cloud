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
}
