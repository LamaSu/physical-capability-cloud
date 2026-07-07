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

// ── E2 (HIGH): the retry policy must actually engage for transient errors, and
// an exhausted transient failure must NOT poison the on-chain key for 30 days —
// the failed row is reclaimable in minutes. A permanent (nonRetryable) error
// still fails once and stays cached within its window.
describe("defineActivity — E2: transient retries + short failed-TTL", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0, failedTtlMs: 5 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("a retryable-named error RETRIES up to maximumAttempts, then the failed row is reclaimable in ms", async () => {
    let attempts = 0;
    const def = defineActivity({
      name: "onchain-flaky",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      // Mirrors the real escrow activities: FacadeError is permanent, everything
      // else (incl. our TransientChainError) is retryable.
      retryPolicy: { maximumAttempts: 3, nonRetryableErrorPatterns: ["FacadeError"] },
      deriveKey: () => ({ key: "k-transient", scope: "onchain:escrow" }),
      handler: async (_input: [number]) => {
        attempts++;
        const e = new Error("HTTP request failed"); // transient RPC blip
        e.name = "TransientChainError";
        throw e;
      },
    });
    const r = await def.invoke({ workflowRunId: "r", activityId: "a", input: [0], actorId: "x" });
    expect(r.ok).toBe(false);
    expect(attempts).toBe(3); // the retry policy ENGAGED (was dead code before E2)

    // The exhausted-transient failure is NOT a 30-day brick — after the short
    // failed-TTL elapses, the same key is reclaimable as a fresh attempt.
    await new Promise((res) => setTimeout(res, 25));
    const reclaim = await store.idempotency.claim({
      key: "k-transient",
      scope: "onchain:escrow",
      requestHash: JSON.stringify([0]),
      actorId: "x",
    });
    expect(reclaim.outcome).toBe("fresh");
  });

  it("a permanent (FacadeError) failure does NOT retry and stays cached within its window", async () => {
    const permStore = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0, failedTtlMs: 60_000 });
    let attempts = 0;
    const def = defineActivity({
      name: "onchain-perm",
      store: permStore,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      retryPolicy: { maximumAttempts: 5, nonRetryableErrorPatterns: ["FacadeError"] },
      deriveKey: () => ({ key: "k-perm", scope: "onchain:escrow" }),
      handler: async (_input: [number]) => {
        attempts++;
        const e = new Error("milestone not evidenced");
        e.name = "FacadeError";
        throw e;
      },
    });
    const r = await def.invoke({ workflowRunId: "r", activityId: "a", input: [0], actorId: "x" });
    expect(r.ok).toBe(false);
    expect(attempts).toBe(1); // permanent → no retries, no gas-wasting resends

    const again = await permStore.idempotency.claim({
      key: "k-perm",
      scope: "onchain:escrow",
      requestHash: JSON.stringify([0]),
      actorId: "x",
    });
    expect(again.outcome).toBe("cached");
    expect(again.row?.status).toBe("failed");
    await permStore.close();
  });
});

// ── W1 (HIGH): after a stuck-row reclaim, the reclaim-LOSER's complete() throws
// "not in 'processing'". The OLD code treated that as a handler failure and
// re-ran the side effect (re-sending the on-chain tx up to maximumAttempts
// times). The fix: the loser returns the WINNER's cached result and does NOT
// re-run. This test reproduces the exact slow-A / reclaiming-B race.
describe("defineActivity — W1: reclaim-loser does not re-send its side effect", () => {
  it("A hangs, B reclaims + completes; A's complete()-conflict returns B's result without re-running", async () => {
    const store = openSqliteStore({
      path: ":memory:",
      pruneIntervalMs: 0,
      stuckProcessingOnchainMs: 0, // B instantly reclaims A's aged processing row
    });

    let sideEffectRuns = 0;
    let handlerCall = 0;
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((res) => (signalFirstStarted = res));
    const firstGate = new Promise<void>((res) => (releaseFirst = res));

    const def = defineActivity({
      name: "onchain-w1",
      store,
      sleep: ZERO_SLEEP,
      rand: CONST_RAND,
      retryPolicy: { maximumAttempts: 5, nonRetryableErrorPatterns: ["FacadeError"] },
      // Same key + scope for both callers (they are duplicate requests).
      deriveKey: () => ({ key: "k-w1", scope: "onchain:escrow" }),
      handler: async (_input: [number]) => {
        const call = ++handlerCall;
        sideEffectRuns++;
        if (call === 1) {
          // Runner A: hang mid-side-effect so its row stays 'processing'.
          signalFirstStarted();
          await firstGate;
          return "result-A";
        }
        // Runner B: completes immediately.
        return "result-B";
      },
    });

    // A starts and hangs inside the handler (row = processing).
    const aPromise = def.invoke({ workflowRunId: "r", activityId: "a", input: [0], actorId: "x" });
    await firstStarted;
    await new Promise((res) => setTimeout(res, 3)); // age processing_started_at past the 0ms stuck window

    // B arrives (duplicate), reclaims the stuck row, runs, completes.
    const bResult = await def.invoke({ workflowRunId: "r", activityId: "a", input: [0], actorId: "x" });
    expect(bResult.ok).toBe(true);
    if (bResult.ok) expect(bResult.value).toBe("result-B");

    // Release A → its handler returns → A.complete() CONFLICTS (row completed by B).
    releaseFirst();
    const aResult = await aPromise;

    // W1 core: A did NOT re-run after the conflict. Side effect ran exactly
    // twice (A once + B once), NOT 6× (the old amplifier).
    expect(sideEffectRuns).toBe(2);
    // A returns the winner's (B's) cached result — not an error, not a resend.
    expect(aResult.ok).toBe(true);
    if (aResult.ok) expect(aResult.value).toBe("result-B");

    await store.close();
  });
});
