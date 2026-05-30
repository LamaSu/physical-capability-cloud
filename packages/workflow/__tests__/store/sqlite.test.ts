import { describe, it, expect } from "vitest";
import { openSqliteStore } from "../../src/store/sqlite.js";

/**
 * Base-level sanity tests for openSqliteStore():
 *  - opens an in-memory DB
 *  - creates all tables (schema migration)
 *  - each child store is available
 *  - close() releases resources
 *  - basic CRUD against each table (smoke only — deeper tests live per-table)
 */

describe("openSqliteStore — open/close", () => {
  it("opens :memory: and returns a Store with all adapters", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    expect(store.idempotency).toBeDefined();
    expect(store.events).toBeDefined();
    expect(store.steps).toBeDefined();
    expect(store.runs).toBeDefined();
    expect(store.dataLocations).toBeDefined();
    await store.close();
  });

  it("reopen is idempotent (CREATE TABLE IF NOT EXISTS)", async () => {
    const a = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await a.close();
    const b = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await b.close();
  });

  it("close releases the prune timer (no hanging interval)", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 1000 });
    // Should close cleanly even with an interval registered.
    await store.close();
  });

  it("prune-disabled mode accepts pruneIntervalMs=0", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await store.close();
  });
});

describe("openSqliteStore — schema surface smoke", () => {
  it("idempotency claim on a brand-new DB returns 'fresh'", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const claim = await store.idempotency.claim({
      key: "k1",
      scope: "http:POST:/x",
      requestHash: "h1",
      actorId: "a1",
    });
    expect(claim.outcome).toBe("fresh");
    await store.close();
  });

  it("events.append on empty stream starts at sequence 1", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const rec = await store.events.append({
      eventType: "T",
      aggregateType: "A",
      aggregateId: "agg-1",
      actorType: "system",
      actorId: "sys",
      payload: { n: 1 },
    });
    expect(rec.sequence).toBe(1);
    expect(rec.eventOrder).toBeGreaterThanOrEqual(1);
    expect(rec.eventHash).toMatch(/^[0-9a-f]{64}$/);
    await store.close();
  });

  it("runs.create + get round-trip", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await store.runs.create({
      runId: "run-1",
      workflowName: "W",
      workflowVersion: 1,
      runArgsHash: "h",
      runArgs: { a: 1 },
    });
    const row = await store.runs.get("run-1");
    expect(row).toBeDefined();
    expect(row?.runId).toBe("run-1");
    expect(row?.status).toBe("pending");
    await store.close();
  });

  it("steps.put + get + listIds", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await store.runs.create({
      runId: "run-s",
      workflowName: "W",
      workflowVersion: 1,
      runArgsHash: "h",
      runArgs: {},
    });
    await store.steps.put("run-s", "step-1", {
      status: "completed",
      result: '"done"',
      sequence: 1,
      durationMs: 10,
      attempt: 1,
    });
    const got = await store.steps.get("run-s", "step-1");
    expect(got?.status).toBe("completed");
    expect(got?.result).toBe('"done"');
    const ids = await store.steps.listIds("run-s");
    expect(ids).toEqual(["step-1"]);
    await store.close();
  });

  it("dataLocations.register + getByPort", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const loc = await store.dataLocations.register({
      portId: "p1",
      kernelId: "gateway:local",
      scheme: "fs",
      path: "/tmp/out.csv",
      dataType: "primary",
    });
    expect(loc.locationId).toBeDefined();
    expect(loc.available).toBe(false);
    const rows = await store.dataLocations.getByPort("p1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBe(loc.locationId);
    await store.close();
  });
});

describe("openSqliteStore — constraints", () => {
  it("duplicate aggregate sequence rejected by UNIQUE constraint path (indirect)", async () => {
    // The event store assigns sequences monotonically in a single tx. Two concurrent
    // appends serialize through better-sqlite3, so we can't race them in vitest.
    // Smoke: appending two events to same aggregate yields seq 1 then 2, never 1 twice.
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const a = await store.events.append({
      eventType: "T",
      aggregateType: "A",
      aggregateId: "x",
      actorType: "s",
      actorId: "s",
      payload: { i: 1 },
    });
    const b = await store.events.append({
      eventType: "T",
      aggregateType: "A",
      aggregateId: "x",
      actorType: "s",
      actorId: "s",
      payload: { i: 2 },
    });
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(b.prevHash).toBe(a.eventHash);
    await store.close();
  });

  it("different aggregates have independent sequences starting at 1", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const a = await store.events.append({
      eventType: "T",
      aggregateType: "A",
      aggregateId: "1",
      actorType: "s",
      actorId: "s",
      payload: {},
    });
    const b = await store.events.append({
      eventType: "T",
      aggregateType: "A",
      aggregateId: "2",
      actorType: "s",
      actorId: "s",
      payload: {},
    });
    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(1);
    // But eventOrder is global and monotonic.
    expect(b.eventOrder).toBeGreaterThan(a.eventOrder);
    await store.close();
  });
});
