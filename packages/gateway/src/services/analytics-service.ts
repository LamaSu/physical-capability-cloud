// packages/gateway/src/services/analytics-service.ts
//
// Analytics service — listens to the event bus and maintains materialized views.
//
// Design:
// - Subscribes to all events via getEventBus().onEvent().
// - Persists each event to analytics_events for audit trail.
// - Incrementally updates materialized views for dashboards.
// - All failures are silently swallowed — analytics must never crash the system.
//
// Usage:
//   import { getAnalyticsService } from "../services/analytics-service.js";
//   // Service auto-inits on first call; no further setup needed.

import { getRepos } from "../db.js";
import { getEventBus } from "./event-bus.js";

import type { AnalyticsEvent, MaterializedViewType } from "@pcc/spec";

// ── Service ────────────────────────────────────────────────────────────────

export class AnalyticsService {
  private initialized = false;

  /** Start listening to events and updating materialized views */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    getEventBus().onEvent((event) => {
      this.handleEvent(event);
    });
  }

  /** Handle a single analytics event — persist to DB + update relevant views */
  private handleEvent(event: AnalyticsEvent): void {
    try {
      const repos = getRepos();

      // 1. Persist the event to analytics_events table
      repos.analytics.insertEvent({
        id: event.id,
        eventType: event.eventType,
        category: event.category,
        timestamp: event.timestamp,
        actorId: event.actorId,
        actorType: event.actorType,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        payload: event.payload,
        hash: event.hash,
        previousHash: event.previousHash ?? null,
      });

      // 2. Incrementally update relevant materialized views
      if (event.category === "job") {
        this.updateOperatorDashboard(event);
        this.updateNetworkDashboard(event);
      }
      if (event.category === "settlement") {
        this.updateSettlementAnalytics(event);
      }
    } catch {
      // Analytics failures must never crash the system
    }
  }

  /** Update operator dashboard materialized view */
  private updateOperatorDashboard(event: AnalyticsEvent): void {
    // Simplified: just recompute the whole view.
    // At scale, this should be incremental.
    try {
      const repos = getRepos();
      const operatorId = event.actorId;

      // Count operator's jobs by status.
      // This is a placeholder — real implementation queries the jobs table.
      repos.analytics.upsertMaterializedView({
        id: `operator_dashboard_${operatorId}`,
        viewType: "operator_dashboard",
        scopeKey: operatorId,
        data: { lastEventType: event.eventType, lastEventAt: event.timestamp },
        computedAt: new Date().toISOString(),
        eventCount: 1,
        periodStart: event.timestamp,
        periodEnd: event.timestamp,
      });
    } catch { /* non-fatal */ }
  }

  /** Update network-wide dashboard */
  private updateNetworkDashboard(event: AnalyticsEvent): void {
    try {
      const repos = getRepos();
      repos.analytics.upsertMaterializedView({
        id: "network_dashboard",
        viewType: "network_dashboard",
        scopeKey: "network",
        data: { lastEventType: event.eventType, lastEventAt: event.timestamp },
        computedAt: new Date().toISOString(),
        eventCount: 1,
        periodStart: event.timestamp,
        periodEnd: event.timestamp,
      });
    } catch { /* non-fatal */ }
  }

  /** Update settlement analytics */
  private updateSettlementAnalytics(event: AnalyticsEvent): void {
    try {
      const repos = getRepos();
      repos.analytics.upsertMaterializedView({
        id: "settlement_analytics",
        viewType: "settlement_analytics",
        scopeKey: "network",
        data: { lastEventType: event.eventType, lastEventAt: event.timestamp },
        computedAt: new Date().toISOString(),
        eventCount: 1,
        periodStart: event.timestamp,
        periodEnd: event.timestamp,
      });
    } catch { /* non-fatal */ }
  }

  /** Query a materialized view */
  queryView(viewType: MaterializedViewType, scopeKey: string) {
    const repos = getRepos();
    return repos.analytics.findMaterializedViewByScope(viewType, scopeKey);
  }

  /** List all materialized views */
  listViews() {
    const repos = getRepos();
    return repos.analytics.findAllMaterializedViews();
  }

  /** Query analytics events by actor */
  getEventsByActor(actorId: string) {
    const repos = getRepos();
    return repos.analytics.findEventsByActor(actorId);
  }

  /** Query analytics events by resource */
  getEventsByResource(resourceType: string, resourceId: string) {
    const repos = getRepos();
    return repos.analytics.findEventsByResource(resourceType, resourceId);
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let _analyticsService: AnalyticsService | null = null;

export function getAnalyticsService(): AnalyticsService {
  if (!_analyticsService) {
    _analyticsService = new AnalyticsService();
    _analyticsService.init();
  }
  return _analyticsService;
}

export function resetAnalyticsService(): void {
  _analyticsService = null;
}
