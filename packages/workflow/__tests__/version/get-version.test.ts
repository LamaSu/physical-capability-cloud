import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";
import { getVersion } from "../../src/version/get-version.js";

/**
 * getVersion() — marker-based versioning (Temporal-style patched() pattern).
 * See design §10.
 */

describe("getVersion — fresh run", () => {
  let store: Store;
  const runId = "run-v-1";

  beforeEach(async () => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await store.runs.create({
      runId,
      workflowName: "Wf",
      workflowVersion: 1,
      runArgsHash: "h",
      runArgs: {},
    });
    // Leave status 'pending' → treated as fresh.
  });
  afterEach(async () => {
    await store.close();
  });

  it("first call emits a VersionMarker and returns currentValue", async () => {
    const v = await getVersion({
      store,
      runId,
      key: "use-new-charge-flow",
      defaultValue: 0,
      currentValue: 1,
    });
    expect(v).toBe(1);
    const stream = await store.events.readStream("Workflow", runId);
    expect(stream.length).toBe(1);
    expect(stream[0]!.eventType).toBe("VersionMarker");
    expect(stream[0]!.payload).toMatchObject({
      key: "use-new-charge-flow",
      value: 1,
    });
  });

  it("second call with the SAME key returns the recorded value (idempotent)", async () => {
    await getVersion({
      store,
      runId,
      key: "k",
      defaultValue: 0,
      currentValue: 1,
    });
    const v2 = await getVersion({
      store,
      runId,
      key: "k",
      defaultValue: 0,
      currentValue: 99, // would be 99 on fresh; but marker exists
    });
    expect(v2).toBe(1);
  });

  it("different keys get independent markers", async () => {
    const a = await getVersion({
      store,
      runId,
      key: "feat-a",
      defaultValue: 0,
      currentValue: 2,
    });
    const b = await getVersion({
      store,
      runId,
      key: "feat-b",
      defaultValue: 0,
      currentValue: 5,
    });
    expect(a).toBe(2);
    expect(b).toBe(5);
    const stream = await store.events.readStream("Workflow", runId);
    expect(stream.length).toBe(2);
  });
});

describe("getVersion — replay path", () => {
  let store: Store;
  const runId = "run-replay-1";

  beforeEach(async () => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    await store.runs.create({
      runId,
      workflowName: "Wf",
      workflowVersion: 1,
      runArgsHash: "h",
      runArgs: {},
    });
    // Simulate a v1 run mid-flight: status=running + existing step results + step index advanced.
    await store.runs.updateStatus(runId, "running", {
      currentStepIndex: 2,
    });
    await store.steps.put(runId, "step-1", {
      status: "completed",
      result: "1",
      sequence: 1,
      durationMs: 1,
      attempt: 1,
    });
    await store.steps.put(runId, "step-2", {
      status: "completed",
      result: "2",
      sequence: 2,
      durationMs: 1,
      attempt: 1,
    });
  });
  afterEach(async () => {
    await store.close();
  });

  it("on replay without a prior marker, returns defaultValue and does NOT emit a marker", async () => {
    const v = await getVersion({
      store,
      runId,
      key: "new-decision",
      defaultValue: 0,
      currentValue: 1,
    });
    expect(v).toBe(0);
    const stream = await store.events.readStream("Workflow", runId);
    expect(stream.find((e) => e.eventType === "VersionMarker")).toBeUndefined();
  });

  it("on replay with an existing marker event, returns the recorded value", async () => {
    // Pre-seed a marker event
    await store.events.append({
      eventType: "VersionMarker",
      aggregateType: "Workflow",
      aggregateId: runId,
      actorType: "workflow",
      actorId: runId,
      payload: { key: "k", value: 7 },
    });
    const v = await getVersion({
      store,
      runId,
      key: "k",
      defaultValue: 0,
      currentValue: 9,
    });
    expect(v).toBe(7);
  });
});

describe("getVersion — unknown run", () => {
  it("falls back to currentValue (fresh behavior) when the run row is missing", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const v = await getVersion({
      store,
      runId: "missing-run",
      key: "k",
      defaultValue: 0,
      currentValue: 3,
    });
    expect(v).toBe(3);
    await store.close();
  });
});

describe("getVersion — integer value edge cases", () => {
  it("negative defaultValue is passed through on replay", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const runId = "r-neg";
    await store.runs.create({
      runId,
      workflowName: "Wf",
      workflowVersion: 1,
      runArgsHash: "h",
      runArgs: {},
    });
    await store.runs.updateStatus(runId, "running", { currentStepIndex: 3 });
    await store.steps.put(runId, "s", {
      status: "completed",
      result: "1",
      sequence: 1,
      durationMs: 1,
      attempt: 1,
    });
    const v = await getVersion({
      store,
      runId,
      key: "k",
      defaultValue: -1,
      currentValue: 1,
    });
    expect(v).toBe(-1);
    await store.close();
  });
});
