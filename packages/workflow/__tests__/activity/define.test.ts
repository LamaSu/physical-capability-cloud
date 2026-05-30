import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Activity, defineActivity } from "../../src/activity/define.js";
import { openSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/types.js";

/**
 * defineActivity integration — exercises the full flow against a real SQLite store.
 * Sleep is mocked to zero so retries are instantaneous; jitter rand is pinned
 * to keep the backoff math deterministic.
 */

const ZERO_SLEEP = async () => {};
const CONST_RAND = () => 0.5;

describe("defineActivity — validation & construction", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("requires a name", () => {
    expect(() =>
      defineActivity({
        name: "",
        store,
        handler: async () => 1,
      } as never),
    ).toThrow(/name is required/);
  });

  it("requires a store", () => {
    expect(() =>
      defineActivity({
        name: "x",
        store: undefined as never,
        handler: async () => 1,
      }),
    ).toThrow(/store is required/);
  });

  it("returns an ActivityDefinition with name + merged retryPolicy", () => {
    const def = defineActivity({
      name: "echo",
      store,
      handler: async (input: [number]) => input[0],
    });
    expect(def.name).toBe("echo");
    expect(def.retryPolicy.maximumAttempts).toBe(5); // default
  });

  it("Activity.define alias returns same shape", () => {
    const def = Activity.define({
      name: "echo",
      store,
      handler: async (input: [number]) => input[0],
    });
    expect(def.name).toBe("echo");
  });
});

describe("defineActivity — happy path + idempotency", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("invoke() runs the handler exactly once for a fresh key", async () => {
    let calls = 0;
    const def = defineActivity({
      name: "count",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      handler: async (_input: [number]) => {
        calls++;
        return calls;
      },
    });
    const r1 = await def.invoke({
      workflowRunId: "run-1",
      activityId: "a-1",
      input: [42],
      actorId: "actor",
    });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value).toBe(1);
    expect(calls).toBe(1);
  });

  it("second invoke with same input returns cached result without re-running handler", async () => {
    let calls = 0;
    const def = defineActivity({
      name: "memo",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      handler: async (_input: [number]) => {
        calls++;
        return calls;
      },
    });
    await def.invoke({ workflowRunId: "r", activityId: "a", input: [1], actorId: "x" });
    const r2 = await def.invoke({ workflowRunId: "r", activityId: "a", input: [1], actorId: "x" });
    expect(calls).toBe(1);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toBe(1); // replay of cached JSON result
  });

  it("different args => different activity key => handler runs again", async () => {
    let calls = 0;
    const def = defineActivity({
      name: "memo2",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      handler: async (input: [number]) => {
        calls++;
        return input[0];
      },
    });
    await def.invoke({ workflowRunId: "r", activityId: "a", input: [1], actorId: "x" });
    await def.invoke({ workflowRunId: "r", activityId: "a", input: [2], actorId: "x" });
    expect(calls).toBe(2);
  });
});

describe("defineActivity — retry behavior", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("retries transient errors up to maximumAttempts and returns Result.ok on success", async () => {
    let attempts = 0;
    const def = defineActivity({
      name: "flaky",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      retryPolicy: { maximumAttempts: 5 },
      handler: async (_input: [number]) => {
        attempts++;
        if (attempts < 3) throw new Error("TransientError: network");
        return attempts;
      },
    });
    const r = await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [0],
      actorId: "x",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3);
    expect(attempts).toBe(3);
  });

  it("returns Result.err after exhausting retries", async () => {
    let attempts = 0;
    const def = defineActivity({
      name: "always-fails",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      retryPolicy: { maximumAttempts: 3 },
      handler: async (_input: [number]) => {
        attempts++;
        throw new Error("HardError");
      },
    });
    const r = await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [0],
      actorId: "x",
    });
    expect(r.ok).toBe(false);
    expect(attempts).toBe(3);
  });

  it("honors nonRetryableErrorPatterns — skips retries entirely", async () => {
    let attempts = 0;
    const def = defineActivity({
      name: "non-retry",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      retryPolicy: {
        maximumAttempts: 10,
        nonRetryableErrorPatterns: ["ValidationError"],
      },
      handler: async (_input: [number]) => {
        attempts++;
        throw new Error("ValidationError: bad input");
      },
    });
    const r = await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [0],
      actorId: "x",
    });
    expect(r.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("after permanent failure, replay returns the cached failure immediately", async () => {
    let attempts = 0;
    const def = defineActivity({
      name: "perm-fail",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      retryPolicy: { maximumAttempts: 2 },
      handler: async (_input: [number]) => {
        attempts++;
        throw new Error("Boom");
      },
    });
    await def.invoke({ workflowRunId: "r", activityId: "a", input: [0], actorId: "x" });
    const reAttempts = attempts;
    const r2 = await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [0],
      actorId: "x",
    });
    expect(r2.ok).toBe(false);
    // Handler is NOT re-entered; cached failure returns.
    expect(attempts).toBe(reAttempts);
  });
});

describe("defineActivity — mismatch & client keys", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("mismatched request hash with same client key returns IdempotencyMismatchError", async () => {
    let calls = 0;
    const def = defineActivity({
      name: "mm",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      handler: async (_input: readonly unknown[]) => {
        calls++;
        return calls;
      },
    });
    await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [1],
      actorId: "x",
      clientKey: "cli-1",
      httpMethod: "POST",
      httpPath: "/x",
    });
    const r = await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [2], // different args
      actorId: "x",
      clientKey: "cli-1", // same client key
      httpMethod: "POST",
      httpPath: "/x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/Mismatch/);
  });

  it("the handler sees the ActivityContext with the derived idempotencyKey", async () => {
    let seenKey = "";
    let seenAttempt = -1;
    const def = defineActivity({
      name: "ctx-check",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      handler: async (_input: [number], ctx) => {
        seenKey = ctx.idempotencyKey;
        seenAttempt = ctx.attempt;
        return 1;
      },
    });
    await def.invoke({
      workflowRunId: "r",
      activityId: "a",
      input: [1],
      actorId: "x",
    });
    expect(seenKey).toMatch(/^[0-9a-f]{64}$/);
    expect(seenAttempt).toBe(1);
  });
});
