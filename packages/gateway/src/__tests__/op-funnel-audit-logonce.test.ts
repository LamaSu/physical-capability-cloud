/**
 * op-funnel-audit-logonce.test.ts — #469 round-2 (R4a): recordOperatorStage's
 * durable write now goes through auditService.logOnce(), an atomic
 * check-then-insert (IAuditLogRepository.insertIfAbsent), instead of a
 * separate query-then-log that could read a thrown DB error as "no row" and
 * write a duplicate stage row on a restart.
 *
 * Uses the REAL store + REAL audit service (not the mocked audit-service.js
 * that operator-funnel.test.ts uses for its unit tests), so the actual
 * SQLite transaction path is exercised end-to-end.
 */
import { describe, it, expect, afterEach } from "vitest";
import { initStore, closeStore, getRepos } from "../db.js";
import {
  recordOperatorStage,
  __resetOperatorFunnelState,
  OPERATOR_FUNNEL_AUDIT_EVENT,
} from "../services/funnel-tracker.js";

describe("#469 round-2 R4a: recordOperatorStage durable idempotency (real store)", () => {
  afterEach(() => {
    closeStore();
    __resetOperatorFunnelState();
    delete process.env.PCC_FUNNEL_ENABLED;
    delete process.env.PCC_DB_PATH;
  });

  it("a restart (in-memory dedup cleared) writes no duplicate row — the audit log is the source of truth", () => {
    process.env.PCC_FUNNEL_ENABLED = "true";
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    const repos = getRepos();

    expect(recordOperatorStage("kernel-r4-restart", "kernel_created")).toBe(true);
    __resetOperatorFunnelState(); // simulate a restart: in-memory dedup cleared, the row persists in the DB

    expect(recordOperatorStage("kernel-r4-restart", "kernel_created")).toBe(false);

    const rows = repos.auditLog
      .query({ eventType: OPERATOR_FUNNEL_AUDIT_EVENT, resourceId: "kernel-r4-restart" })
      .filter((r) => r.action === "kernel_created");
    expect(rows).toHaveLength(1);
  });

  it("a thrown durable check/insert returns false, writes nothing, and does not mark — a later retry still records exactly one row", () => {
    process.env.PCC_FUNNEL_ENABLED = "true";
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    const repos = getRepos();

    const realInsertIfAbsent = repos.auditLog.insertIfAbsent.bind(repos.auditLog);
    (repos.auditLog as unknown as { insertIfAbsent: () => never }).insertIfAbsent = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };

    const result = recordOperatorStage("kernel-r4-fail", "kernel_created");

    (repos.auditLog as unknown as { insertIfAbsent: typeof realInsertIfAbsent }).insertIfAbsent =
      realInsertIfAbsent;

    // The durable check/insert failed outright: must return false, write
    // nothing, and — critically — NOT mark the (kernelId, stage) as seen, so
    // a later retry (e.g. the request handler firing again, or a re-queued
    // event) can still record it. Treating the throw as "no row exists" is
    // the exact bug this fixes (it used to let a restart duplicate the row).
    expect(result).toBe(false);
    const rowsAfterFailure = repos.auditLog
      .query({ eventType: OPERATOR_FUNNEL_AUDIT_EVENT, resourceId: "kernel-r4-fail" })
      .filter((r) => r.action === "kernel_created");
    expect(rowsAfterFailure).toHaveLength(0);

    expect(recordOperatorStage("kernel-r4-fail", "kernel_created")).toBe(true);
    const rowsAfterRetry = repos.auditLog
      .query({ eventType: OPERATOR_FUNNEL_AUDIT_EVENT, resourceId: "kernel-r4-fail" })
      .filter((r) => r.action === "kernel_created");
    expect(rowsAfterRetry).toHaveLength(1);
  });

  it("two 'instances' racing the same (kernelId, stage) write exactly one row (insertIfAbsent is atomic)", () => {
    process.env.PCC_FUNNEL_ENABLED = "true";
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    const repos = getRepos();

    // Simulate two gateway instances that both pass the in-memory dedup
    // check (e.g. two processes, each with its own empty in-memory map) and
    // both reach the durable write for the same (kernelId, stage).
    __resetOperatorFunnelState();
    const first = recordOperatorStage("kernel-r4-race", "device_registered");
    __resetOperatorFunnelState();
    const second = recordOperatorStage("kernel-r4-race", "device_registered");

    expect([first, second].filter(Boolean)).toHaveLength(1);
    const rows = repos.auditLog
      .query({ eventType: OPERATOR_FUNNEL_AUDIT_EVENT, resourceId: "kernel-r4-race" })
      .filter((r) => r.action === "device_registered");
    expect(rows).toHaveLength(1);
  });
});
