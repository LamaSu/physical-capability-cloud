import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { shopKernels } from "./kernels.js";

/** A capability exposed by a Shop Kernel */
export const capabilities = sqliteTable("capabilities", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull().references(() => shopKernels.id),
  type: text("type").notNull(), // CapabilityType — open string union
  name: text("name").notNull(),
  description: text("description"),
  materials: text("materials", { mode: "json" }).notNull().$type<string[]>(),
  tolerances: text("tolerances", { mode: "json" }).$type<{
    linear?: string;
    surface?: string;
    positional?: string;
  }>(),
  envelope: text("envelope", { mode: "json" }).$type<{
    x: number;
    y: number;
    z: number;
    unit: "mm" | "in";
  }>(),
  assuranceTiers: text("assurance_tiers", { mode: "json" }).notNull().$type<number[]>(),
  pricing: text("pricing", { mode: "json" }).notNull().$type<{
    currency: string;
    baseCost: string;
    perMinute?: string;
    perGram?: string;
    perCm3?: string;
    minimum: string;
  }>(),
  availability: text("availability", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  location: text("location", { mode: "json" }).notNull().$type<{ lat: number; lng: number }>(),
  queueDepth: integer("queue_depth").notNull().default(0),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  /** Wave 4.1.x — tenant scoping. Nullable; null = public discovery surface
   *  (today's behavior). Buyers/marketplace queries pass `tenantOpts(req)`. */
  tenantId: text("tenant_id"),
  /** Human-node SLA — accept/deadline windows + presence + scheduling mode.
   *  Nullable; set only for human-operator capabilities (machine caps leave it null). */
  sla: text("sla", { mode: "json" }).$type<{
    acceptanceWindowSec: number;
    completionDeadlineSec: number;
    presence?: "available" | "busy" | "offline";
    mode?: "on-demand" | "scheduled" | "recurring";
    onTimeout?: string;
    onDeadlineMiss?: string;
  }>(),
});
