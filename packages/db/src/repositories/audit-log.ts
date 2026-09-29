import { eq, and, gte, sql } from "drizzle-orm";
import { auditLog } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IAuditLogRepository } from "../interfaces/IAuditLogRepository.js";

export type AuditLogInsert = typeof auditLog.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;

export class AuditLogRepository implements IAuditLogRepository {
  constructor(private db: StoreDB) {}

  insert(entry: Omit<AuditLogInsert, "id">): AuditLogRow {
    return this.db.insert(auditLog).values(entry).returning().get();
  }

  query(opts: {
    eventType?: string;
    actor?: string;
    resourceType?: string;
    resourceId?: string;
    since?: string;
    limit?: number;
  }): AuditLogRow[] {
    const conditions = [];

    if (opts.eventType) {
      conditions.push(eq(auditLog.eventType, opts.eventType));
    }
    if (opts.actor) {
      conditions.push(eq(auditLog.actor, opts.actor));
    }
    if (opts.resourceType) {
      conditions.push(eq(auditLog.resourceType, opts.resourceType));
    }
    if (opts.resourceId) {
      conditions.push(eq(auditLog.resourceId, opts.resourceId));
    }
    if (opts.since) {
      conditions.push(gte(auditLog.timestamp, opts.since));
    }

    const limit = opts.limit ?? 100;

    const q = this.db
      .select()
      .from(auditLog)
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(limit);

    if (conditions.length > 0) {
      return q.where(and(...conditions)).all();
    }
    return q.all();
  }

  /** Aggregate counts by eventType for the last 24 hours. */
  stats(actor?: string): { eventType: string; count: number }[] {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // With an actor, the COUNT covers every one of that actor's entries in the window
    // (the gateway's scoped stats used to count a 1000-row query and call it 24h).
    const window = actor !== undefined ? and(gte(auditLog.timestamp, since), eq(auditLog.actor, actor)) : gte(auditLog.timestamp, since);
    const rows = this.db
      .select({
        eventType: auditLog.eventType,
        count: sql<number>`count(*)`,
      })
      .from(auditLog)
      .where(window)
      .groupBy(auditLog.eventType)
      .all();
    return rows.map((r) => ({ eventType: r.eventType, count: Number(r.count) }));
  }
}
