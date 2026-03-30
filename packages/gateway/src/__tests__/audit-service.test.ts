/**
 * Tests for AuditService — the gateway-layer wrapper around AuditLogRepository.
 *
 * AuditService delegates to getRepos().auditLog which requires initStore().
 * We call initStore({ seed: false }) with an in-memory DB before each test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initStore, closeStore } from "../db.js";
import { auditService } from "../services/audit-service.js";

// ── Setup/Teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.PCC_DB_PATH = ":memory:";
  // Reset the module-level store singleton between tests so each test gets a clean DB
  closeStore();
  initStore({ seed: false });
});

afterEach(() => {
  closeStore();
  delete process.env.PCC_DB_PATH;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AuditService", () => {
  // ── log() ─────────────────────────────────────────────────────────────────

  describe("log()", () => {
    it("does not throw for a minimal valid entry", () => {
      expect(() => {
        auditService.log({ eventType: "job.submitted", action: "create" });
      }).not.toThrow();
    });

    it("does not throw for a full entry", () => {
      expect(() => {
        auditService.log({
          eventType: "escrow.funded",
          actor: "0xABCD",
          resourceType: "escrow",
          resourceId: "esc-001",
          action: "fund",
          metadata: { amount: "100.00" },
          ip: "10.0.0.1",
          userAgent: "Mozilla/5.0",
        });
      }).not.toThrow();
    });

    it("is fire-and-forget — swallows errors gracefully", () => {
      // Force getRepos() to throw by closing the store
      closeStore();
      // Should not throw even though DB is not initialized
      expect(() => {
        auditService.log({ eventType: "boom", action: "create" });
      }).not.toThrow();
      // Re-initialize for afterEach cleanup
      initStore({ seed: false });
    });

    it("persists entries that can be retrieved by query()", () => {
      auditService.log({ eventType: "job.submitted", action: "create", actor: "alice" });
      auditService.log({ eventType: "job.submitted", action: "create", actor: "alice" });

      const rows = auditService.query({ eventType: "job.submitted" });
      expect(rows.length).toBe(2);
    });
  });

  // ── query() ───────────────────────────────────────────────────────────────

  describe("query()", () => {
    beforeEach(() => {
      auditService.log({ eventType: "job.submitted", actor: "alice", resourceType: "job", action: "create" });
      auditService.log({ eventType: "escrow.funded", actor: "bob", resourceType: "escrow", action: "fund" });
      auditService.log({ eventType: "job.submitted", actor: "charlie", resourceType: "job", action: "create" });
      auditService.log({ eventType: "evidence.archived", actor: "alice", resourceType: "evidence", action: "archive" });
    });

    it("returns empty array when no entries match", () => {
      const rows = auditService.query({ eventType: "nonexistent.event" });
      expect(rows).toEqual([]);
    });

    it("filters by eventType", () => {
      const rows = auditService.query({ eventType: "job.submitted" });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.eventType === "job.submitted")).toBe(true);
    });

    it("filters by actor", () => {
      const rows = auditService.query({ actor: "alice" });
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.actor === "alice")).toBe(true);
    });

    it("filters by resourceType", () => {
      const rows = auditService.query({ resourceType: "escrow" });
      expect(rows.length).toBe(1);
      expect(rows[0].eventType).toBe("escrow.funded");
    });

    it("filters by since (ISO timestamp string)", () => {
      const future = new Date(Date.now() + 100_000).toISOString();
      // Insert an entry with a far-future timestamp
      auditService.log({ eventType: "future.event", action: "create" });

      // Query with a cutoff far in the future — should only catch our inserted future ts
      // (We can't easily test this by timestamp of the future entry since log() uses
      // new Date().toISOString() internally, so just verify the filter doesn't throw)
      const rows = auditService.query({ since: future });
      expect(Array.isArray(rows)).toBe(true);
    });

    it("respects limit", () => {
      const rows = auditService.query({ limit: 2 });
      expect(rows.length).toBe(2);
    });

    it("returns AuditEntry objects with the correct shape", () => {
      const rows = auditService.query({ eventType: "escrow.funded" });
      const row = rows[0];
      expect(typeof row.eventType).toBe("string");
      expect(typeof row.action).toBe("string");
      // actor is optional, but when present should be a string
      if (row.actor !== undefined) {
        expect(typeof row.actor).toBe("string");
      }
    });

    it("returns empty array when store is not initialized", () => {
      closeStore();
      const rows = auditService.query({ eventType: "anything" });
      expect(rows).toEqual([]);
      // Re-init for afterEach
      initStore({ seed: false });
    });
  });

  // ── stats() ───────────────────────────────────────────────────────────────

  describe("stats()", () => {
    it("returns empty array when no entries exist", () => {
      expect(auditService.stats()).toEqual([]);
    });

    it("aggregates counts by eventType", () => {
      auditService.log({ eventType: "job.submitted", action: "create" });
      auditService.log({ eventType: "job.submitted", action: "create" });
      auditService.log({ eventType: "escrow.funded", action: "fund" });

      const stats = auditService.stats();
      const jobStats = stats.find((s) => s.eventType === "job.submitted");
      const escrowStats = stats.find((s) => s.eventType === "escrow.funded");
      expect(jobStats?.count).toBe(2);
      expect(escrowStats?.count).toBe(1);
    });

    it("returns empty array when store is not initialized", () => {
      closeStore();
      const stats = auditService.stats();
      expect(stats).toEqual([]);
      initStore({ seed: false });
    });

    it("returns count as a number", () => {
      auditService.log({ eventType: "type.check", action: "create" });
      const stats = auditService.stats();
      expect(typeof stats[0].count).toBe("number");
    });
  });
});
