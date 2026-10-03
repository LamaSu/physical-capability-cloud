import type { auditLog } from "../schema/index.js";

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;

export interface IAuditLogRepository {
  insert(entry: Omit<AuditLogInsert, "id">): AuditLogRow;
  /**
   * Insert `entry` only if no existing row matches all four `match` fields.
   * Runs as a single IMMEDIATE transaction, so the check-then-insert is
   * atomic even across processes sharing the same SQLite file (#469 round 2
   * R4a) — two callers racing this can never both insert a duplicate.
   * Returns true iff this call inserted the row; false if a matching row
   * already existed. Let errors propagate: the caller (funnel-tracker) must
   * be able to tell "the durable check itself failed" apart from "no row
   * exists yet" — treating a thrown error as "no row" is exactly the bug
   * this fixes.
   */
  insertIfAbsent(
    entry: Omit<AuditLogInsert, "id">,
    match: { eventType: string; resourceType: string; resourceId: string; action: string },
  ): boolean;
  query(opts: {
    eventType?: string;
    actor?: string;
    resourceType?: string;
    resourceId?: string;
    since?: string;
    limit?: number;
  }): AuditLogRow[];
  stats(): { eventType: string; count: number }[];
}
