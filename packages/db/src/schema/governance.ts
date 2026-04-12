import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** Rate limit policies per endpoint */
export const rateLimitPolicies = sqliteTable("rate_limit_policies", {
  id: text("id").primaryKey(),
  routePattern: text("route_pattern").notNull(),
  costWeight: real("cost_weight").notNull().default(1),
  freeTierLimit: integer("free_tier_limit").notNull().default(100),
  paidTierLimit: integer("paid_tier_limit").notNull().default(10000),
  enterpriseTierLimit: integer("enterprise_tier_limit").notNull().default(100000),
  windowMs: integer("window_ms").notNull().default(3600000), // 1 hour
  burstAllowance: integer("burst_allowance").notNull().default(10),
  description: text("description"),
});

/** DLP redaction rules */
export const dlpRules = sqliteTable("dlp_rules", {
  id: text("id").primaryKey(),
  fieldPath: text("field_path").notNull(),
  resourceType: text("resource_type").notNull(),
  sensitivity: text("sensitivity").notNull(), // "public" | "restricted" | "private" | "secret"
  visibleToRoles: text("visible_to_roles", { mode: "json" }).notNull().$type<string[]>(),
  redactionStrategy: text("redaction_strategy").notNull(), // "remove" | "mask" | "hash" | "regionalize"
  maskPattern: text("mask_pattern"),
  regionPrecision: text("region_precision"),
});

/** Endpoint scope requirements */
export const endpointScopes = sqliteTable("endpoint_scopes", {
  id: text("id").primaryKey(),
  method: text("method").notNull(), // GET | POST | PUT | DELETE | PATCH
  routePattern: text("route_pattern").notNull(),
  requiredScopes: text("required_scopes", { mode: "json" }).notNull().$type<string[]>(),
  description: text("description"),
});
