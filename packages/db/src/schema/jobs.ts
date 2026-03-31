import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";
import { capabilities } from "./capabilities.js";

/** A job as seen by the kernel */
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  stepId: text("step_id").notNull(),
  cwmId: text("cwm_id").notNull(),
  capabilityId: text("capability_id").notNull().references(() => capabilities.id),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  status: text("status").notNull(), // "queued" | "preparing" | "executing" | "collecting_evidence" | "awaiting_pickup" | "completed" | "failed" | "cancelled"
  assignedDevices: text("assigned_devices", { mode: "json" }).notNull().$type<string[]>(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  progress: integer("progress").notNull().default(0),
  evidenceBundleId: text("evidence_bundle_id"),
  parameters: text("parameters", { mode: "json" }).$type<Record<string, unknown>>(),
});
