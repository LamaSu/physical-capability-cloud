import type { auditLog } from "../schema/index.js";

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;

export interface IAuditLogRepository {
  insert(entry: Omit<AuditLogInsert, "id">): AuditLogRow;
  /** A filter given several values matches a row equal to any of them. */
  query(opts: {
    eventType?: string | readonly string[];
    actor?: string | readonly string[];
    resourceType?: string | readonly string[];
    since?: string;
    limit?: number;
  }): AuditLogRow[];
  stats(): { eventType: string; count: number }[];
}
