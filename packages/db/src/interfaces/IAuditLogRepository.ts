import type { auditLog } from "../schema/index.js";

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;

export interface IAuditLogRepository {
  insert(entry: Omit<AuditLogInsert, "id">): AuditLogRow;
  /**
   * Newest first (descending id). Every given filter must match; an omitted
   * (or empty-string) filter is not applied. `limit` defaults to 100.
   */
  query(opts: {
    eventType?: string;
    actor?: string;
    resourceType?: string;
    /** Only rows about this resource (e.g. one registration id). */
    resourceId?: string;
    since?: string;
    limit?: number;
  }): AuditLogRow[];
  /** Counts by eventType over the last 24 hours; with `actor`, only that actor's entries. */
  stats(actor?: string): { eventType: string; count: number }[];
}
