import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const featureSwitches = sqliteTable("feature_switches", {
  name: text("name").primaryKey(),
  enabled: integer("enabled").notNull(),
  updatedAt: text("updated_at").notNull(),
  updatedBy: text("updated_by"),
}, (table) => [check("feature_switches_enabled", sql`${table.enabled} IN (0, 1)`)]);
