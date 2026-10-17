import { sql } from "drizzle-orm";
import { sqliteTable, text, index, check } from "drizzle-orm/sqlite-core";
import { jobs } from "./jobs.js";

/** A separate interlock; holding work never changes its lifecycle status. */
export const jobHolds = sqliteTable("job_holds", {
  jobId: text("job_id").primaryKey().references(() => jobs.id),
  kernelId: text("kernel_id").notNull(),
  reason: text("reason").notNull().$type<"emergency_stop">(),
  heldAt: text("held_at").notNull(),
}, (table) => ({
  kernelIdx: index("job_holds_kernel_idx").on(table.kernelId),
  reasonCheck: check("job_holds_reason_check", sql`${table.reason} = 'emergency_stop'`),
}));
