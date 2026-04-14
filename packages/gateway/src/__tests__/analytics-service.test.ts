/**
 * Tests for AnalyticsService — event-bus subscriber that persists
 * analytics events and maintains materialized views.
 *
 * Uses in-memory SQLite via initStore({ seed: false }).
 * Both resetAnalyticsService() and resetEventBus() are called in beforeEach
 * to start each test with a clean singleton + clean chain.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initStore, closeStore, getRepos } from "../db.js";
import { getEventBus, resetEventBus } from "../services/event-bus.js";
import { getAnalyticsService, resetAnalyticsService } from "../services/analytics-service.js";

// ── Setup/Teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: false });
  resetAnalyticsService();
  resetEventBus();
});

afterEach(() => {
  resetAnalyticsService();
  resetEventBus();
  closeStore();
  delete process.env.PCC_DB_PATH;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function publishEvent(overrides: Partial<Parameters<ReturnType<typeof getEventBus>["publish"]>[0]> = {}) {
  return getEventBus().publish({
    eventType: "job.completed",
    category: "job",
    actorId: "operator-001",
    actorType: "operator",
    resourceType: "job",
    resourceId: "job-001",
    ...overrides,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AnalyticsService", () => {
  // ── getAnalyticsService() — init ──────────────────────────────────────────

  describe("getAnalyticsService() — initialization", () => {
    it("returns an AnalyticsService instance", () => {
      const svc = getAnalyticsService();
      expect(svc).toBeDefined();
      expect(typeof svc.init).toBe("function");
    });

    it("returns the same singleton on repeated calls", () => {
      const a = getAnalyticsService();
      const b = getAnalyticsService();
      expect(a).toBe(b);
    });

    it("subscribes to event bus on first call (subsequent init() calls are no-ops)", () => {
      const svc = getAnalyticsService();
      // Calling init() a second time must not throw
      expect(() => svc.init()).not.toThrow();
    });
  });

  // ── event persistence ─────────────────────────────────────────────────────

  describe("event persistence — analytics_events table", () => {
    it("persists a published event to the analytics_events table", async () => {
      getAnalyticsService(); // subscribe to bus
      const event = publishEvent();

      // Give the synchronous event handler a tick to run
      await Promise.resolve();

      const rows = getRepos().analytics.findEventsByActor("operator-001");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].id).toBe(event.id);
    });

    it("persists multiple events from the same actor", async () => {
      getAnalyticsService();
      publishEvent({ resourceId: "job-001" });
      publishEvent({ resourceId: "job-002" });
      await Promise.resolve();

      const rows = getRepos().analytics.findEventsByActor("operator-001");
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    it("persists events with the correct hash", async () => {
      getAnalyticsService();
      const event = publishEvent();
      await Promise.resolve();

      const rows = getRepos().analytics.findEventsByActor("operator-001");
      expect(rows[0].hash).toBe(event.hash);
    });

    it("persists events with the correct eventType", async () => {
      getAnalyticsService();
      publishEvent({ eventType: "job.submitted", category: "job" });
      await Promise.resolve();

      const rows = getRepos().analytics.findEventsByResource("job", "job-001");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].eventType).toBe("job.submitted");
    });
  });

  // ── materialized views — job category ─────────────────────────────────────

  describe("materialized views — job category events", () => {
    it("creates an operator_dashboard view after a job event", async () => {
      getAnalyticsService();
      publishEvent({ category: "job", actorId: "op-abc" });
      await Promise.resolve();

      const view = getRepos().analytics.findMaterializedViewByScope("operator_dashboard", "op-abc");
      expect(view).toBeDefined();
      expect(view?.viewType).toBe("operator_dashboard");
    });

    it("creates a network_dashboard view after a job event", async () => {
      getAnalyticsService();
      publishEvent({ category: "job" });
      await Promise.resolve();

      const view = getRepos().analytics.findMaterializedViewByScope("network_dashboard", "network");
      expect(view).toBeDefined();
      expect(view?.viewType).toBe("network_dashboard");
    });

    it("does not create operator_dashboard for settlement category events", async () => {
      getAnalyticsService();
      publishEvent({ category: "settlement", actorId: "settle-actor" });
      await Promise.resolve();

      // settlement events do not trigger operator_dashboard, only settlement_analytics
      const opView = getRepos().analytics.findMaterializedViewByScope("operator_dashboard", "settle-actor");
      expect(opView).toBeUndefined();
    });
  });

  // ── materialized views — settlement category ──────────────────────────────

  describe("materialized views — settlement category events", () => {
    it("creates a settlement_analytics view after a settlement event", async () => {
      getAnalyticsService();
      publishEvent({ category: "settlement", eventType: "escrow.funded" });
      await Promise.resolve();

      const view = getRepos().analytics.findMaterializedViewByScope("settlement_analytics", "network");
      expect(view).toBeDefined();
      expect(view?.viewType).toBe("settlement_analytics");
    });
  });

  // ── queryView() ───────────────────────────────────────────────────────────

  describe("queryView()", () => {
    it("returns undefined when no view exists for a given scope", () => {
      const svc = getAnalyticsService();
      const view = svc.queryView("operator_dashboard", "nonexistent-actor");
      expect(view).toBeUndefined();
    });

    it("returns a stored view after it has been created by an event", async () => {
      const svc = getAnalyticsService();
      publishEvent({ category: "job", actorId: "op-xyz" });
      await Promise.resolve();

      const view = svc.queryView("operator_dashboard", "op-xyz");
      expect(view).toBeDefined();
      expect(view?.scopeKey).toBe("op-xyz");
    });

    it("view data contains lastEventType", async () => {
      const svc = getAnalyticsService();
      publishEvent({ category: "job", eventType: "job.completed", actorId: "op-datacheck" });
      await Promise.resolve();

      const view = svc.queryView("operator_dashboard", "op-datacheck");
      expect(view?.data).toMatchObject({ lastEventType: "job.completed" });
    });
  });

  // ── non-fatal error behaviour ─────────────────────────────────────────────

  describe("non-fatal — analytics must not crash the system", () => {
    it("does not throw when the store is closed and an event is published", () => {
      getAnalyticsService(); // subscribe
      closeStore(); // break DB access

      expect(() => {
        publishEvent(); // triggers handleEvent which calls getRepos() → throws internally
      }).not.toThrow();

      // Re-open for afterEach cleanup
      initStore({ seed: false });
    });
  });

  // ── resetAnalyticsService() ───────────────────────────────────────────────

  describe("resetAnalyticsService()", () => {
    it("clears the singleton so the next call returns a new instance", () => {
      const before = getAnalyticsService();
      resetAnalyticsService();
      const after = getAnalyticsService();
      expect(before).not.toBe(after);
    });

    it("does not throw when called before any singleton is created", () => {
      resetAnalyticsService(); // already reset in beforeEach; must be idempotent
      expect(() => resetAnalyticsService()).not.toThrow();
    });
  });

  // ── getEventsByActor() / getEventsByResource() ────────────────────────────

  describe("getEventsByActor() and getEventsByResource()", () => {
    it("getEventsByActor returns events for the specified actor", async () => {
      getAnalyticsService();
      publishEvent({ actorId: "actor-findme", resourceId: "r-001" });
      await Promise.resolve();

      const svc = getAnalyticsService();
      const rows = svc.getEventsByActor("actor-findme");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].actorId).toBe("actor-findme");
    });

    it("getEventsByResource returns events for the specified resource", async () => {
      getAnalyticsService();
      publishEvent({ resourceType: "escrow", resourceId: "esc-007" });
      await Promise.resolve();

      const svc = getAnalyticsService();
      const rows = svc.getEventsByResource("escrow", "esc-007");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].resourceId).toBe("esc-007");
    });

    it("getEventsByActor returns empty array for unknown actor", () => {
      getAnalyticsService();
      const svc = getAnalyticsService();
      const rows = svc.getEventsByActor("totally-unknown-actor");
      expect(rows).toEqual([]);
    });
  });

  // ── listViews() ───────────────────────────────────────────────────────────

  describe("listViews()", () => {
    it("returns an empty array when no views have been created", () => {
      const svc = getAnalyticsService();
      const views = svc.listViews();
      expect(Array.isArray(views)).toBe(true);
      expect(views).toHaveLength(0);
    });

    it("returns all materialized views after events are processed", async () => {
      const svc = getAnalyticsService();
      publishEvent({ category: "job", actorId: "list-test-actor" });
      await Promise.resolve();

      const views = svc.listViews();
      expect(views.length).toBeGreaterThan(0);
    });
  });
});
