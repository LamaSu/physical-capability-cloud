/**
 * AuditService — persistent, append-only audit log backed by SQLite.
 *
 * All writes are fire-and-forget: they never block request handling and
 * never throw errors that could crash the server.
 */

import { getRepos } from "../db.js";

export interface AuditEntry {
  eventType: string;
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

class AuditService {
  /**
   * Append an audit entry to the database.
   *
   * Fire-and-forget: this method is synchronous (SQLite is sync) but wrapped
   * in a try/catch so audit failures never propagate to the caller. Returns
   * whether the row was written, for callers that must know (the operator
   * funnel marks a stage recorded only after its durable row exists).
   */
  log(entry: AuditEntry): boolean {
    try {
      const repos = getRepos();
      repos.auditLog.insert({
        timestamp: new Date().toISOString(),
        eventType: entry.eventType,
        actor: entry.actor ?? null,
        resourceType: entry.resourceType ?? null,
        resourceId: entry.resourceId ?? null,
        action: entry.action,
        metadata: entry.metadata ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      });
      return true;
    } catch {
      // Audit failures must never crash request handling — swallow silently.
      return false;
    }
  }

  /**
   * Like log(), but an atomic check-then-insert on (eventType, resourceType,
   * resourceId, action): if a matching row already exists, this is a no-op
   * returning "exists" rather than writing a duplicate. Backed by
   * IAuditLogRepository.insertIfAbsent, a single IMMEDIATE transaction, so
   * two callers (or two gateway instances) racing this can never both
   * insert (#469 round 2 R4a).
   *
   * "failed" means the durable check/insert itself errored (e.g. the DB was
   * locked) — callers must NOT treat that the same as "exists": a thrown
   * error reading as "no row exists" is exactly the bug this method exists
   * to prevent. "failed" should leave the caller's own dedup state
   * unmarked, so a later retry can still record the row.
   */
  logOnce(entry: AuditEntry & { resourceType: string; resourceId: string }): "written" | "exists" | "failed" {
    try {
      const repos = getRepos();
      const inserted = repos.auditLog.insertIfAbsent(
        {
          timestamp: new Date().toISOString(),
          eventType: entry.eventType,
          actor: entry.actor ?? null,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          action: entry.action,
          metadata: entry.metadata ?? null,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
        {
          eventType: entry.eventType,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId,
          action: entry.action,
        },
      );
      return inserted ? "written" : "exists";
    } catch {
      // Durable failures must never crash request handling — swallow silently.
      return "failed";
    }
  }

  /**
   * Query audit entries with optional filters.
   */
  query(opts: {
    eventType?: string;
    actor?: string;
    resourceType?: string;
    resourceId?: string;
    since?: string;
    limit?: number;
  }): AuditEntry[] {
    try {
      const repos = getRepos();
      const rows = repos.auditLog.query(opts);
      return rows.map((r) => ({
        eventType: r.eventType,
        actor: r.actor ?? undefined,
        resourceType: r.resourceType ?? undefined,
        resourceId: r.resourceId ?? undefined,
        action: r.action,
        metadata: r.metadata as Record<string, unknown> | undefined,
        ip: r.ip ?? undefined,
        userAgent: r.userAgent ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Aggregate counts by eventType for the last 24 hours.
   */
  stats(): { eventType: string; count: number }[] {
    try {
      const repos = getRepos();
      return repos.auditLog.stats();
    } catch {
      return [];
    }
  }
}

export const auditService = new AuditService();
