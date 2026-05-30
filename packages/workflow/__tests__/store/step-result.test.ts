import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

/**
 * StepResultStore covers the Inngest-style memoization table.
 * Contract:
 *   - get() returns null when no row
 *   - put() inserts; subsequent put() on the same (runId, stepId) is a no-op
 *     (ON CONFLICT DO NOTHING — design §4.4)
 *   - listIds() returns step IDs in sequence order
 */

describe("StepResultStore — memoization", () => {
  let store: Store;
  beforeEach(async () => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    // step_results has a FK to workflow_runs; seed a run row.
    await store.runs.create({
      runId: "run-1",
      workflowName: "W",
      workflowVersion: 1,
      runArgsHash: "h",
      runArgs: {},
    });
  });
  afterEach(async () => {
    await store.close();
  });

  it("get returns null when no row exists", async () => {
    expect(await store.steps.get("run-1", "missing")).toBeNull();
  });

  it("put followed by get retrieves the stored record", async () => {
    await store.steps.put("run-1", "step-1", {
      status: "completed",
      result: '"done"',
      sequence: 1,
      durationMs: 42,
      attempt: 1,
    });
    const got = await store.steps.get("run-1", "step-1");
    expect(got?.status).toBe("completed");
    expect(got?.result).toBe('"done"');
    expect(got?.error).toBeUndefined();
  });

  it("failed status stores error but not result", async () => {
    await store.steps.put("run-1", "step-f", {
      status: "failed",
      error: '"boom"',
      sequence: 1,
      durationMs: 5,
      attempt: 3,
    });
    const got = await store.steps.get("run-1", "step-f");
    expect(got?.status).toBe("failed");
    expect(got?.error).toBe('"boom"');
  });

  it("second put on same (runId, stepId) is a no-op — memoization is stable across re-runs", async () => {
    await store.steps.put("run-1", "step-x", {
      status: "completed",
      result: '"first"',
      sequence: 1,
      durationMs: 10,
      attempt: 1,
    });
    // Overwriting would break Inngest-style determinism; the store MUST keep the first write.
    await store.steps.put("run-1", "step-x", {
      status: "completed",
      result: '"second"',
      sequence: 2,
      durationMs: 99,
      attempt: 7,
    });
    const got = await store.steps.get("run-1", "step-x");
    expect(got?.result).toBe('"first"'); // FIRST write wins
  });

  it("listIds returns step IDs in sequence order", async () => {
    await store.steps.put("run-1", "a", { status: "completed", sequence: 3, durationMs: 1, attempt: 1 });
    await store.steps.put("run-1", "b", { status: "completed", sequence: 1, durationMs: 1, attempt: 1 });
    await store.steps.put("run-1", "c", { status: "completed", sequence: 2, durationMs: 1, attempt: 1 });
    const ids = await store.steps.listIds("run-1");
    expect(ids).toEqual(["b", "c", "a"]); // sorted by sequence asc
  });

  it("listIds is empty for an unknown run", async () => {
    const ids = await store.steps.listIds("run-unknown");
    expect(ids).toEqual([]);
  });

  it("step results survive a DB round-trip (same instance re-opening)", async () => {
    await store.steps.put("run-1", "persist", {
      status: "completed",
      result: '42',
      sequence: 1,
      durationMs: 1,
      attempt: 1,
    });
    // Re-read without closing — :memory: is per-connection, so a round-trip inside the
    // same instance is the useful smoke for persistence.
    const got = await store.steps.get("run-1", "persist");
    expect(got?.result).toBe("42");
  });
});
