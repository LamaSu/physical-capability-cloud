import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** Capability templates stored as data (not hardcoded TypeScript) */
export const capabilityTemplateStore = sqliteTable("capability_template_store", {
  id: text("id").primaryKey(),
  capabilityType: text("capability_type").notNull(),
  version: text("version").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  /** Full CapabilityTemplate as JSON */
  templateData: text("template_data", { mode: "json" }).notNull(),
  authorId: text("author_id"),
  status: text("status").notNull().default("draft"), // "draft" | "active" | "deprecated"
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  usageCount: integer("usage_count").notNull().default(0),
  forkCount: integer("fork_count").notNull().default(0),
  rating: real("rating"),
  ratingCount: integer("rating_count").notNull().default(0),
  forkedFrom: text("forked_from"),
  isVerified: integer("is_verified", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** Machine profiles stored as data */
export const machineProfileStore = sqliteTable("machine_profile_store", {
  id: text("id").primaryKey(),
  capabilityType: text("capability_type").notNull(),
  machineName: text("machine_name").notNull(),
  kernelId: text("kernel_id"),
  /** Full MachineProfile as JSON */
  profileData: text("profile_data", { mode: "json" }).notNull(),
  authorId: text("author_id"),
  status: text("status").notNull().default("draft"),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  usageCount: integer("usage_count").notNull().default(0),
  rating: real("rating"),
  ratingCount: integer("rating_count").notNull().default(0),
  isVerified: integer("is_verified", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** Verification templates — per-capability-type verification requirements */
export const verificationTemplates = sqliteTable("verification_templates", {
  id: text("id").primaryKey(),
  capabilityType: text("capability_type").notNull(),
  version: text("version").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  /** Verification requirements as JSON */
  requirements: text("requirements", { mode: "json" }).notNull(),
  authorId: text("author_id"),
  status: text("status").notNull().default("draft"),
  usageCount: integer("usage_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** Query templates for the NL interface */
export const queryTemplates = sqliteTable("query_templates", {
  id: text("id").primaryKey(),
  intent: text("intent").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  version: text("version").notNull(),
  sqlTemplate: text("sql_template").notNull(),
  dataSources: text("data_sources", { mode: "json" }).notNull().$type<string[]>(),
  params: text("params", { mode: "json" }).notNull(),
  responseTemplate: text("response_template").notNull(),
  exampleQueries: text("example_queries", { mode: "json" }).notNull().$type<string[]>(),
  authorId: text("author_id"),
  usageCount: integer("usage_count").notNull().default(0),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at"),
});

/** Template ratings */
export const templateRatings = sqliteTable("template_ratings", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull(),
  templateType: text("template_type").notNull(), // "capability" | "machine" | "verification" | "query" | "compliance"
  raterId: text("rater_id").notNull(),
  score: integer("score").notNull(), // 1-5
  comment: text("comment"),
  createdAt: text("created_at").notNull(),
});

/**
 * CSD usage attribution — backs CsdRegistry.recordUsage / getUsage.
 *
 * One row per CSD canonical URL. count tracks total adoptions; recentAdopters
 * stores the deduped list of the last 50 agent IDs (newest at end), serialized
 * as a JSON string[]. lastUsedAt is an ISO-8601 timestamp.
 *
 * Distinct from capability_template_store (which carries CapabilityTemplate
 * marketplace metadata + its own usageCount/recentAdopters): CSDs are the
 * FHIR-style schemas, templates are concrete instances. PR #118 introduced
 * registry.usage as an in-memory Map; this table makes those counters survive
 * gateway restart, opt-in via PCC_CSD_PERSIST=true.
 */
export const csdUsage = sqliteTable("csd_usage", {
  /** Canonical CSD URL — pcc://capabilities/<slug>/<version> */
  url: text("url").primaryKey(),
  /** Total adoptions (every recordUsage call increments). */
  count: integer("count").notNull().default(0),
  /** JSON string[] of agent IDs, deduped, capped at 50 (newest at end). */
  recentAdopters: text("recent_adopters", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** ISO-8601 timestamp of the last recordUsage call. */
  lastUsedAt: text("last_used_at"),
});
