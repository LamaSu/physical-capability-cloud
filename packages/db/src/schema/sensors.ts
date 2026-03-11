import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";
import { kernelDevices } from "./kernels.js";

/** Channel metadata — declared once when a device is provisioned */
export const sensorChannelDescriptors = sqliteTable("sensor_channel_descriptors", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  deviceId: text("device_id").notNull().references(() => kernelDevices.id),
  label: text("label").notNull(),
  dataType: text("data_type").notNull(), // SensorDataType
  unit: text("unit").notNull(), // PhysicalUnit
  sampleRateHz: real("sample_rate_hz").notNull(),
  range: text("range", { mode: "json" }).$type<{ min: number; max: number }>(),
  resolution: real("resolution"),
  retentionPolicy: text("retention_policy").notNull(), // "full" | "downsample_1s" | ...
  evidenceGrade: integer("evidence_grade", { mode: "boolean" }).notNull(),
});

/** Downsampled aggregate for historical storage */
export const sensorAggregates = sqliteTable("sensor_aggregates", {
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  deviceId: text("device_id").notNull().references(() => kernelDevices.id),
  windowStart: text("window_start").notNull(),
  windowEnd: text("window_end").notNull(),
  count: integer("count").notNull(),
  min: real("min").notNull(),
  max: real("max").notNull(),
  mean: real("mean").notNull(),
  stddev: real("stddev"),
  unit: text("unit").notNull(),
  jobId: text("job_id"),
  batchId: text("batch_id"),
});

/** Anomaly detected in a sensor stream */
export const sensorAnomalies = sqliteTable("sensor_anomalies", {
  id: text("id").primaryKey(),
  timestamp: text("timestamp").notNull(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  deviceId: text("device_id").notNull().references(() => kernelDevices.id),
  channel: text("channel").notNull(),
  type: text("type").notNull(), // "threshold_exceeded" | "rate_of_change" | "flatline" | "pattern_mismatch"
  severity: text("severity").notNull(), // "info" | "warning" | "critical"
  value: real("value").notNull(),
  threshold: real("threshold").notNull(),
  message: text("message").notNull(),
  jobId: text("job_id"),
});
