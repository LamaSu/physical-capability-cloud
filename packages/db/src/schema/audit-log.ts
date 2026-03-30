import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: text("timestamp").notNull(), // ISO string
  eventType: text("event_type").notNull(), // e.g. "job.submitted", "escrow.funded", "operator.registered", "evidence.archived"
  actor: text("actor"), // wallet address, API key ID, or agent DID
  resourceType: text("resource_type"), // "job", "kernel", "escrow", "registration", "evidence"
  resourceId: text("resource_id"), // the specific ID
  action: text("action").notNull(), // "create", "update", "delete", "fund", "approve", "reject", etc
  metadata: text("metadata", { mode: "json" }), // JSON blob with event-specific data
  ip: text("ip"), // request IP
  userAgent: text("user_agent"), // request user-agent
});
