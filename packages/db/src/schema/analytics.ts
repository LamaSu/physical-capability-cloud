import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/** Structured analytics events (upgrade from audit_log) */
export const analyticsEvents = sqliteTable("analytics_events", {
  id: text("id").primaryKey(),
  eventType: text("event_type").notNull(),
  category: text("category").notNull(),
  timestamp: text("timestamp").notNull(),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  payload: text("payload", { mode: "json" }),
  hash: text("hash").notNull(),
  previousHash: text("previous_hash"),
});

/** Pre-computed materialized views */
export const materializedViews = sqliteTable("materialized_views", {
  id: text("id").primaryKey(),
  viewType: text("view_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  data: text("data", { mode: "json" }).notNull(),
  computedAt: text("computed_at").notNull(),
  eventCount: integer("event_count").notNull().default(0),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
});

/** Compliance templates (stored rules per regulation) */
export const complianceTemplates = sqliteTable("compliance_templates", {
  id: text("id").primaryKey(),
  regulationId: text("regulation_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  version: text("version").notNull(),
  industries: text("industries", { mode: "json" }).notNull().$type<string[]>(),
  jurisdictions: text("jurisdictions", { mode: "json" }).notNull().$type<string[]>(),
  applicableCapabilityTypes: text("applicable_capability_types", { mode: "json" }).notNull().$type<string[]>(),
  rules: text("rules", { mode: "json" }).notNull(),
  minimumAssuranceTier: integer("minimum_assurance_tier").notNull().default(0),
  retentionPeriodDays: integer("retention_period_days").notNull().default(365),
  authorId: text("author_id"),
  status: text("status").notNull().default("draft"),
  supersededBy: text("superseded_by"),
  effectiveDate: text("effective_date").notNull(),
  sunsetDate: text("sunset_date"),
  usageCount: integer("usage_count").notNull().default(0),
  rating: integer("rating"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** Compliance profiles (operator's selected templates) */
export const complianceProfiles = sqliteTable("compliance_profiles", {
  id: text("id").primaryKey(),
  kernelId: text("kernel_id").notNull(),
  templateIds: text("template_ids", { mode: "json" }).notNull().$type<string[]>(),
  industry: text("industry").notNull(),
  jurisdictions: text("jurisdictions", { mode: "json" }).notNull().$type<string[]>(),
  overrides: text("overrides", { mode: "json" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});
