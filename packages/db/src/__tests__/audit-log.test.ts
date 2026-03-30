import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "../index.js";
import { AuditLogRepository } from "../repositories/audit-log.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AuditLogRepository", () => {
  let store: Store;
  let repo: AuditLogRepository;

  beforeEach(() => {
    // Fresh in-memory DB per test, no seed data needed
    store = createStore({ seed: false });
    repo = store.repos.auditLog;
  });

  afterEach(() => {
    store.close();
  });

  // ── insert + basic retrieval ───────────────────────────────────────────────

  describe("insert", () => {
    it("inserts a minimal audit entry and returns a row with id", () => {
      const row = repo.insert({
        timestamp: new Date().toISOString(),
        eventType: "job.submitted",
        action: "create",
      });
      expect(row.id).toBeDefined();
      expect(typeof row.id).toBe("number");
      expect(row.eventType).toBe("job.submitted");
      expect(row.action).toBe("create");
    });

    it("inserts a full audit entry with all optional fields", () => {
      const ts = new Date().toISOString();
      const row = repo.insert({
        timestamp: ts,
        eventType: "escrow.funded",
        actor: "0xDeadBeef",
        resourceType: "escrow",
        resourceId: "esc-001",
        action: "fund",
        metadata: { amount: "100.00", token: "USDC" },
        ip: "127.0.0.1",
        userAgent: "test-agent/1.0",
      });
      expect(row.actor).toBe("0xDeadBeef");
      expect(row.resourceType).toBe("escrow");
      expect(row.resourceId).toBe("esc-001");
      expect(row.ip).toBe("127.0.0.1");
      expect(row.userAgent).toBe("test-agent/1.0");
      expect(row.metadata).toEqual({ amount: "100.00", token: "USDC" });
    });

    it("stores null for omitted optional fields", () => {
      const row = repo.insert({
        timestamp: new Date().toISOString(),
        eventType: "operator.registered",
        action: "create",
        actor: null,
        resourceType: null,
        resourceId: null,
        metadata: null,
        ip: null,
        userAgent: null,
      });
      expect(row.actor).toBeNull();
      expect(row.resourceType).toBeNull();
      expect(row.metadata).toBeNull();
    });
  });

  // ── query round-trip ──────────────────────────────────────────────────────

  describe("query", () => {
    beforeEach(() => {
      const now = new Date();
      const ts = (offsetMs = 0) =>
        new Date(now.getTime() + offsetMs).toISOString();

      repo.insert({ timestamp: ts(0), eventType: "job.submitted", actor: "alice", resourceType: "job", action: "create" });
      repo.insert({ timestamp: ts(1), eventType: "escrow.funded", actor: "bob", resourceType: "escrow", action: "fund" });
      repo.insert({ timestamp: ts(2), eventType: "job.submitted", actor: "alice", resourceType: "job", action: "create" });
      repo.insert({ timestamp: ts(3), eventType: "evidence.archived", actor: "charlie", resourceType: "evidence", action: "archive" });
      repo.insert({ timestamp: ts(4), eventType: "job.completed", actor: "alice", resourceType: "job", action: "update" });
    });

    it("returns all rows when no filters are given", () => {
      const rows = repo.query({});
      expect(rows.length).toBe(5);
    });

    it("filters by eventType", () => {
      const rows = repo.query({ eventType: "job.submitted" });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.eventType === "job.submitted")).toBe(true);
    });

    it("filters by actor", () => {
      const rows = repo.query({ actor: "alice" });
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.actor === "alice")).toBe(true);
    });

    it("filters by resourceType", () => {
      const rows = repo.query({ resourceType: "escrow" });
      expect(rows.length).toBe(1);
      expect(rows[0].eventType).toBe("escrow.funded");
    });

    it("filters by since (ISO timestamp)", () => {
      const now = new Date();
      // Insert a clearly future entry
      const futureTs = new Date(now.getTime() + 100_000).toISOString();
      repo.insert({ timestamp: futureTs, eventType: "future.event", action: "create" });

      // Query for only the future entry
      const cutoff = new Date(now.getTime() + 50_000).toISOString();
      const rows = repo.query({ since: cutoff });
      expect(rows.length).toBe(1);
      expect(rows[0].eventType).toBe("future.event");
    });

    it("respects limit", () => {
      const rows = repo.query({ limit: 2 });
      expect(rows.length).toBe(2);
    });

    it("defaults limit to 100 when not specified", () => {
      // Insert 110 entries to verify the default cap
      for (let i = 0; i < 110; i++) {
        repo.insert({ timestamp: new Date().toISOString(), eventType: "bulk.event", action: "create" });
      }
      const rows = repo.query({});
      // 5 from beforeEach + 110 = 115 total, but default limit is 100
      expect(rows.length).toBe(100);
    });

    it("returns results in descending id order", () => {
      const rows = repo.query({});
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].id).toBeGreaterThan(rows[i].id);
      }
    });

    it("combines eventType and actor filters", () => {
      const rows = repo.query({ eventType: "job.submitted", actor: "alice" });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.eventType === "job.submitted" && r.actor === "alice")).toBe(true);
    });
  });

  // ── metadata JSON storage / retrieval ─────────────────────────────────────

  describe("metadata JSON", () => {
    it("stores and retrieves complex metadata objects", () => {
      const meta = {
        nested: { value: 42 },
        list: [1, 2, 3],
        flag: true,
        label: "test",
      };
      const row = repo.insert({
        timestamp: new Date().toISOString(),
        eventType: "test.metadata",
        action: "create",
        metadata: meta,
      });
      expect(row.metadata).toEqual(meta);
    });

    it("round-trips metadata through query()", () => {
      const meta = { txHash: "0xabc123", amount: "50.00" };
      repo.insert({
        timestamp: new Date().toISOString(),
        eventType: "settlement.complete",
        action: "complete",
        metadata: meta,
      });
      const rows = repo.query({ eventType: "settlement.complete" });
      expect(rows[0].metadata).toEqual(meta);
    });
  });

  // ── stats() ───────────────────────────────────────────────────────────────

  describe("stats()", () => {
    it("returns empty array when no entries exist", () => {
      expect(repo.stats()).toEqual([]);
    });

    it("aggregates counts by eventType for entries within last 24 hours", () => {
      const recent = new Date().toISOString();
      repo.insert({ timestamp: recent, eventType: "job.submitted", action: "create" });
      repo.insert({ timestamp: recent, eventType: "job.submitted", action: "create" });
      repo.insert({ timestamp: recent, eventType: "job.submitted", action: "create" });
      repo.insert({ timestamp: recent, eventType: "escrow.funded", action: "fund" });

      const stats = repo.stats();
      const jobStats = stats.find((s) => s.eventType === "job.submitted");
      const escrowStats = stats.find((s) => s.eventType === "escrow.funded");
      expect(jobStats).toBeDefined();
      expect(jobStats!.count).toBe(3);
      expect(escrowStats).toBeDefined();
      expect(escrowStats!.count).toBe(1);
    });

    it("excludes entries older than 24 hours from stats", () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      repo.insert({ timestamp: old, eventType: "old.event", action: "create" });
      repo.insert({ timestamp: recent, eventType: "recent.event", action: "create" });

      const stats = repo.stats();
      const oldStats = stats.find((s) => s.eventType === "old.event");
      const recentStats = stats.find((s) => s.eventType === "recent.event");
      expect(oldStats).toBeUndefined();
      expect(recentStats).toBeDefined();
      expect(recentStats!.count).toBe(1);
    });

    it("returns counts as numbers (not strings)", () => {
      repo.insert({
        timestamp: new Date().toISOString(),
        eventType: "type.check",
        action: "create",
      });
      const stats = repo.stats();
      expect(typeof stats[0].count).toBe("number");
    });
  });

  // ── table creation via migration ──────────────────────────────────────────

  describe("migration", () => {
    it("the audit_log table is created by createStore", () => {
      // If the table didn't exist, the insert in other tests would throw.
      // Do an explicit insert + query to prove the table exists.
      expect(() => {
        repo.insert({
          timestamp: new Date().toISOString(),
          eventType: "migration.check",
          action: "probe",
        });
      }).not.toThrow();

      const rows = repo.query({ eventType: "migration.check" });
      expect(rows.length).toBe(1);
    });
  });
});
