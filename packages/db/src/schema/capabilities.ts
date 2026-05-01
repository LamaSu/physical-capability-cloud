import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
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
  /**
   * Week 11 (W2 + W7 B persistence): per-capability settlement mode.
   * Values: "centralized" | "onchain". NULL means use the schema-level
   * default ("centralized" via `resolveSettlementMode`).
   */
  settlementMode: text("settlement_mode").$type<"centralized" | "onchain">(),
  /**
   * Week 11 (W7 B persistence): per-capability default for the approval
   * gate. NULL means "do not fire from this layer" (the gate hierarchy
   * treats undefined as a falsy short-circuit).
   *
   * Stored as INTEGER 0/1 to match SQLite's boolean idiom — Drizzle
   * surfaces it as `boolean | null` thanks to `mode: "boolean"`.
   */
  requiresApproval: integer("requires_approval", { mode: "boolean" }),
  /**
   * Week 11 (W7 B persistence): per-capability monetary threshold (USD).
   * NULL means no threshold gate. Stored as REAL because SQLite has no
   * NUMERIC; the precision-conscious caller is the gate hierarchy in
   * `centralized-settle.ts` which floors to cents anyway.
   */
  approvalThresholdUsd: real("approval_threshold_usd"),
});
