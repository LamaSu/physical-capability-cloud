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
   * in a try/catch so audit failures never propagate to the caller.
   */
  log(entry: AuditEntry): void {
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
    } catch {
      // Audit failures must never crash request handling — swallow silently.
    }
  }

  /**
   * Query audit entries with optional filters.
   */
  query(opts: {
    eventType?: string;
    actor?: string;
    resourceType?: string;
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
