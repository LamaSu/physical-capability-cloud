/**
 * Tests for the P2 global signer-serialization lock (contracts/signer-lock.ts).
 *
 * Two load-bearing properties:
 *   1. Concurrent callers run strictly one-at-a-time, FIFO — so two
 *      createJobFromSession jobs can never hold the same signer nonce window.
 *   2. A rejecting sequence does NOT wedge the queue (failure isolation) — a
 *      single failed tx-sequence must not deadlock every future signer write.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { withSignerLock, __resetSignerLockForTests } from "../contracts/signer-lock.js";

describe("withSignerLock — serialize the hot signer across concurrent jobs", () => {
  beforeEach(() => __resetSignerLockForTests());

  it("runs concurrent calls strictly one-at-a-time, in FIFO order", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (id: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // yield to expose overlap if broken
      order.push(id);
      active--;
      return id;
    };

    const results = await Promise.all([
      withSignerLock(task(1)),
      withSignerLock(task(2)),
      withSignerLock(task(3)),
    ]);

    expect(maxActive).toBe(1); // never two sequences in flight at once
    expect(order).toEqual([1, 2, 3]); // FIFO
    expect(results).toEqual([1, 2, 3]); // each caller receives its own result
  });

  it("does not wedge the queue when a sequence rejects (failure isolation)", async () => {
    const order: string[] = [];
    const ok = (id: string) => async () => {
      order.push(id);
      return id;
    };
    const boom = async () => {
      order.push("boom");
      throw new Error("tx failed");
    };

    const p1 = withSignerLock(ok("a"));
    const p2 = withSignerLock(boom);
    const p3 = withSignerLock(ok("b"));

    await expect(p1).resolves.toBe("a");
    await expect(p2).rejects.toThrow("tx failed"); // rejection reaches ITS caller
    await expect(p3).resolves.toBe("b"); // queue advances past the failure
    expect(order).toEqual(["a", "boom", "b"]);
  });

  it("makes a later fast caller wait for an in-flight slow one", async () => {
    const order: number[] = [];
    const job = (id: number, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(id);
      return id;
    };

    const p1 = withSignerLock(job(1, 25)); // slow, enqueued first
    const p2 = withSignerLock(job(2, 1)); // fast, enqueued while p1 runs
    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]); // p2 waited despite being far faster
  });
});
