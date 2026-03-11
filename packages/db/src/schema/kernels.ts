import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** Shop Kernel — the trust boundary for a physical site */
export const shopKernels = sqliteTable("shop_kernels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  operatorAddress: text("operator_address").notNull(),
  location: text("location", { mode: "json" }).notNull().$type<{ lat: number; lng: number }>(),
  physicalAddress: text("physical_address").notNull(),
  maxAssuranceTier: integer("max_assurance_tier").notNull(),
  publicKey: text("public_key").notNull(),
  reputation: integer("reputation").notNull().default(0),
  totalJobsCompleted: integer("total_jobs_completed").notNull().default(0),
  status: text("status").notNull(), // "online" | "offline" | "maintenance" | "suspended"
  registeredAt: text("registered_at").notNull(),
  lastHeartbeat: text("last_heartbeat").notNull(),
  version: text("version").notNull(),
});

/** A device registered within a kernel */
export const kernelDevices = sqliteTable("kernel_devices", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  type: text("type").notNull(), // "machine" | "sensor" | "camera" | "robot" | "tee"
  model: text("model").notNull(),
  firmware: text("firmware").notNull(),
  status: text("status").notNull(), // "idle" | "busy" | "error" | "offline" | "maintenance"
  contributesToCapabilities: text("contributes_to_capabilities", { mode: "json" }).notNull().$type<string[]>(),
  lastUpdated: text("last_updated").notNull(),
});
