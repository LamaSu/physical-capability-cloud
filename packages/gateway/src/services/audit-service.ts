/**
 * AuditService — persistent, append-only audit log backed by SQLite.
 *
 * `log()` is fire-and-forget: it never throws, so an audit failure cannot
 * crash request handling. `logStrict()` is the same write without the
 * swallow, for audit records that must commit together with the change they
 * record: the write goes through the same synchronous better-sqlite3
 * connection as the repositories, so calling it inside a DB transaction makes
 * the change and its audit record commit or roll back as one.
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
      this.logStrict(entry);
    } catch {
      // Audit failures must never crash request handling — swallow silently.
    }
  }

  /**
   * Append an audit entry and throw if the write fails.
   *
   * Use this inside the DB transaction of an authority-bearing change (e.g. an
   * onboarding status transition): a failed audit write then rolls the change
   * back instead of leaving it committed with no audit record.
   */
  logStrict(entry: AuditEntry): void {
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
   * Aggregate counts by eventType for the last 24 hours. With `actor`, only that
   * actor's entries, counted in full (no row limit).
   */
  stats(actor?: string): { eventType: string; count: number }[] {
    try {
      const repos = getRepos();
      return repos.auditLog.stats(actor);
    } catch {
      return [];
    }
  }
}

export const auditService = new AuditService();
