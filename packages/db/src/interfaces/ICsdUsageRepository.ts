import type { CsdUsage, CsdUsageRepository as ICsdUsageRepository } from "@pcc/spec";
import type { csdUsage } from "../schema/templates.js";

export type CsdUsageRow = typeof csdUsage.$inferSelect;
export type CsdUsageInsert = typeof csdUsage.$inferInsert;

/**
 * Persistent storage for CsdRegistry.recordUsage / getUsage.
 *
 * The @pcc/spec package defines the contract (CsdUsageRepository) so the
 * registry doesn't depend on @pcc/store. This re-export lets gateway code
 * import the interface from a single place (`@pcc/store`) while the actual
 * type lives in @pcc/spec.
 */
export type { ICsdUsageRepository };
export type { CsdUsage };
