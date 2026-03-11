import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";
import { kernelDevices } from "./kernels.js";
import { capabilities } from "./capabilities.js";

/** Batch manifest for shared instruments */
export const batchManifests = sqliteTable("batch_manifests", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  deviceId: text("device_id").notNull().references(() => kernelDevices.id),
  capabilityId: text("capability_id").notNull().references(() => capabilities.id),
  status: text("status").notNull(), // "assembling" | "sealed" | "running" | "completed" | "failed" | "partial"
  sealedAt: text("sealed_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  runConfig: text("run_config", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  methodId: text("method_id"),
});

/** Maps one user's sample to a physical position in the batch instrument */
export const sampleSlots = sqliteTable("sample_slots", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => batchManifests.id),
  position: text("position").notNull(),
  jobId: text("job_id").notNull(),
  stepId: text("step_id").notNull(),
  userId: text("user_id").notNull(),
  sampleLabel: text("sample_label").notNull(),
  sampleType: text("sample_type"), // "unknown" | "standard" | "blank" | ...
  status: text("status").notNull(), // "pending" | "queued" | "injecting" | ...
  acquisitionStart: text("acquisition_start"),
  acquisitionEnd: text("acquisition_end"),
  resultHash: text("result_hash"),
  resultRef: text("result_ref"),
});

/** Batch lifecycle event */
export const batchEvents = sqliteTable("batch_events", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull().references(() => batchManifests.id),
  timestamp: text("timestamp").notNull(),
  type: text("type").notNull(), // BatchEvent type
  slotId: text("slot_id"),
  payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
});
