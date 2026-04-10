import type { auditLog } from "../schema/index.js";

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;

export interface IAuditLogRepository {
  insert(entry: Omit<AuditLogInsert, "id">): AuditLogRow;
  query(opts: {
    eventType?: string;
    actor?: string;
    resourceType?: string;
    since?: string;
    limit?: number;
  }): AuditLogRow[];
  stats(): { eventType: string; count: number }[];
}
