/**
 * Tests for DeviceQueue — mutual exclusion, FIFO ordering, and queue management.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeviceQueue, type QueuedJob, type QueueEvent } from "../opentrons/queue.js";

function makeJob(id: string, durationMs = 5000): Omit<QueuedJob, "enqueuedAt" | "position"> {
  return {
    id,
    submittedBy: "test-agent",
    estimatedDurationMs: durationMs,
    payload: { test: true },
  };
}

describe("DeviceQueue", () => {
  let queue: DeviceQueue;
  let executedJobs: string[];
  let executionPromises: Map<string, { resolve: () => void; reject: (e: Error) => void }>;

  beforeEach(() => {
    executedJobs = [];
    executionPromises = new Map();
    queue = new DeviceQueue(5); // max 5 jobs
    queue.setExecutor(async (job) => {
      executedJobs.push(job.id);
      // Create a controllable promise so we can simulate async execution
      const promise = new Promise<void>((resolve, reject) => {
        executionPromises.set(job.id, { resolve, reject });
      });
      await promise;
    });
  });

  afterEach(() => {
    // Resolve any remaining promises to prevent hanging
    for (const [, p] of executionPromises) {
      p.resolve();
    }
  });

  it("should accept a job when queue is empty", () => {
    const result = queue.enqueue(makeJob("job-1"));
    expect(result.accepted).toBe(true);
    expect(result.position).toBe(0);
    expect(result.jobId).toBe("job-1");
  });

  it("should execute the first job immediately", async () => {
    queue.enqueue(makeJob("job-1"));
    // Give microtask queue a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(executedJobs).toContain("job-1");
  });

  it("should queue second job when device is busy", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    const result2 = queue.enqueue(makeJob("job-2"));
    expect(result2.accepted).toBe(true);
    expect(result2.position).toBe(1); // behind job-1

    // job-2 should NOT be executing yet
    expect(executedJobs).toEqual(["job-1"]);
  });

  it("should execute next job after current completes", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2"));

    // Complete job-1
    executionPromises.get("job-1")!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    // job-2 should now be executing
    expect(executedJobs).toEqual(["job-1", "job-2"]);
  });

  it("should reject when queue is full", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2"));
    queue.enqueue(makeJob("job-3"));
    queue.enqueue(makeJob("job-4"));
    queue.enqueue(makeJob("job-5"));

    // Queue is now full (1 active + 4 pending = 5 max)
    const result = queue.enqueue(makeJob("job-6"));
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("Queue full");
  });

  it("should maintain FIFO order", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2"));
    queue.enqueue(makeJob("job-3"));

    // Complete job-1
    executionPromises.get("job-1")!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    // job-2 should be executing (not job-3)
    expect(executedJobs).toEqual(["job-1", "job-2"]);

    // Complete job-2
    executionPromises.get("job-2")!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    // Now job-3
    expect(executedJobs).toEqual(["job-1", "job-2", "job-3"]);
  });

  it("should cancel a queued job", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2"));
    queue.enqueue(makeJob("job-3"));

    const cancelled = queue.cancel("job-2");
    expect(cancelled).toBe(true);

    // Complete job-1 — job-3 should be next (job-2 was cancelled)
    executionPromises.get("job-1")!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(executedJobs).toEqual(["job-1", "job-3"]);
  });

  it("should not cancel the active job", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    const cancelled = queue.cancel("job-1");
    expect(cancelled).toBe(false); // Can't cancel active job via queue.cancel
  });

  it("should report correct queue status", async () => {
    queue.enqueue(makeJob("job-1", 10000));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2", 5000));
    queue.enqueue(makeJob("job-3", 3000));

    const status = queue.getStatus();
    expect(status.locked).toBe(true);
    expect(status.active?.id).toBe("job-1");
    expect(status.pending).toHaveLength(2);
    expect(status.depth).toBe(3);
  });

  it("should get position of a specific job", async () => {
    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2"));
    queue.enqueue(makeJob("job-3"));

    expect(queue.getPosition("job-1")).toBe(0); // active
    expect(queue.getPosition("job-2")).toBe(1);
    expect(queue.getPosition("job-3")).toBe(2);
    expect(queue.getPosition("job-999")).toBe(-1); // not found
  });

  it("should emit queue events", async () => {
    const events: QueueEvent[] = [];
    queue.on("queue_event", (e: QueueEvent) => events.push(e));

    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((e) => e.type === "job_enqueued")).toBe(true);
    expect(events.some((e) => e.type === "job_started")).toBe(true);

    executionPromises.get("job-1")!.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(events.some((e) => e.type === "job_completed")).toBe(true);
  });

  it("should handle job failure gracefully", async () => {
    const events: QueueEvent[] = [];
    queue.on("queue_event", (e: QueueEvent) => events.push(e));

    queue.enqueue(makeJob("job-1"));
    await new Promise((r) => setTimeout(r, 10));

    queue.enqueue(makeJob("job-2"));

    // Fail job-1
    executionPromises.get("job-1")!.reject(new Error("Robot error"));
    await new Promise((r) => setTimeout(r, 10));

    // Should have emitted failure event
    expect(events.some((e) => e.type === "job_failed")).toBe(true);

    // job-2 should still start (device unlocked after failure)
    expect(executedJobs).toEqual(["job-1", "job-2"]);
  });

  it("should estimate wait time based on queue", async () => {
    queue.enqueue(makeJob("job-1", 10000)); // 10s
    await new Promise((r) => setTimeout(r, 10));

    const result = queue.enqueue(makeJob("job-2", 5000)); // 5s
    // Wait should be roughly 10000ms (remaining of job-1)
    expect(result.estimatedWaitMs).toBeGreaterThan(0);
  });
});
