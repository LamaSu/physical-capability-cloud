/**
 * AuditService — persistent, append-only audit log backed by SQLite.
 *
 * All writes are fire-and-forget: they never block request handling and
 * never throw errors that could crash the server.
 *
 * Every entry is stored under the closed observability schema (N107b, the PR steward's ruling of
 * 10/03): the actor, the resource id and the address are keyed hashes, the user agent is a coarse
 * class, the event type, resource type and action are closed names, and the metadata is rebuilt
 * under the closed rules (observability/closed-schema.ts). A query by actor hashes the actor the
 * same way, so an entry is still found by who wrote it.
 */

import { getRepos } from "../db.js";
import { closedText, closeValue, keyedHash, uaClass } from "../observability/closed-schema.js";

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
        eventType: closedText(entry.eventType),
        actor: entry.actor != null ? keyedHash(entry.actor) : null,
        resourceType: entry.resourceType != null ? closedText(entry.resourceType) : null,
        resourceId: entry.resourceId != null ? keyedHash(entry.resourceId) : null,
        action: closedText(entry.action),
        metadata: entry.metadata ? ((closeValue(entry.metadata, "metadata", 1) ?? null) as Record<string, unknown> | null) : null,
        ip: entry.ip ? keyedHash(entry.ip) : null,
        userAgent: entry.userAgent ? uaClass(entry.userAgent) : null,
      });
    } catch {
      // Audit failures must never crash request handling — swallow silently.
    }
  }

  /**
   * Query audit entries with optional filters. An actor filter is hashed as the writer hashes it.
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
      const rows = repos.auditLog.query({
        ...opts,
        ...(opts.eventType !== undefined ? { eventType: closedText(opts.eventType) } : {}),
        ...(opts.resourceType !== undefined ? { resourceType: closedText(opts.resourceType) } : {}),
        ...(opts.actor !== undefined ? { actor: keyedHash(opts.actor) } : {}),
      });
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
