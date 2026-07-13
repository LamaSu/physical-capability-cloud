import { and, eq } from "drizzle-orm";
import { milestonePackages } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  MilestonePackageInsert,
  IMilestonePackageRepository,
} from "../interfaces/IMilestonePackageRepository.js";

/**
 * Persistence for milestone packages (§8.4-B / §2.3). Pure data access — the
 * assemble→verify→persist→receipt transactional invariant lives in the gateway
 * service services/milestone-package-store.ts (not yet wired; step 6). This
 * class only reads and writes rows.
 *
 * `insert` uses `.returning().get()` so the store can construct the package
 * response FROM the persisted row. `findByJobMilestone` relies on the UNIQUE
 * (job_id, milestone_index) index → at most one row (idempotent re-finalize).
 */
export class MilestonePackageRepository implements IMilestonePackageRepository {
  constructor(private db: StoreDB) {}

  insert(record: MilestonePackageInsert) {
    return this.db.insert(milestonePackages).values(record).returning().get();
  }

  findById(packageId: string) {
    return this.db
      .select()
      .from(milestonePackages)
      .where(eq(milestonePackages.packageId, packageId))
      .get();
  }

  findByJobMilestone(jobId: string, milestoneIndex: number) {
    return this.db
      .select()
      .from(milestonePackages)
      .where(
        and(
          eq(milestonePackages.jobId, jobId),
          eq(milestonePackages.milestoneIndex, milestoneIndex),
        ),
      )
      .get();
  }
}
