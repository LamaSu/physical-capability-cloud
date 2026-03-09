import { describe, it, expect } from "vitest";
import { BatchTracker } from "../batch-tracker.js";
import type { BatchEvent, SHA256, Address } from "@pcc/spec";

describe("BatchTracker", () => {
  function createTracker() {
    return new BatchTracker();
  }

  const testSlot = {
    position: "A1",
    jobId: "job-001",
    stepId: "step-001",
    userId: "0x1234567890abcdef1234567890abcdef12345678" as Address,
    sampleLabel: "Sample Alpha",
    sampleType: "sample" as const,
  };

  it("creates a batch in assembling state", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", { method: "test" });
    expect(batch.id).toMatch(/^batch_/);
    expect(batch.status).toBe("assembling");
    expect(batch.slots).toHaveLength(0);
  });

  it("adds sample slots to assembling batch", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    const slot = tracker.addSample(batch.id, testSlot);
    expect(slot.id).toMatch(/^samp_/);
    expect(slot.status).toBe("pending");
    expect(slot.position).toBe("A1");

    const updated = tracker.getBatch(batch.id)!;
    expect(updated.slots).toHaveLength(1);
  });

  it("rejects adding samples to sealed batch", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(batch.id, testSlot);
    tracker.seal(batch.id);
    expect(() => tracker.addSample(batch.id, { ...testSlot, position: "A2" }))
      .toThrow("Cannot add samples");
  });

  it("seals batch and transitions to sealed", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(batch.id, testSlot);
    tracker.seal(batch.id);
    expect(tracker.getBatch(batch.id)!.status).toBe("sealed");
    expect(tracker.getBatch(batch.id)!.sealedAt).toBeDefined();
  });

  it("rejects sealing empty batch", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    expect(() => tracker.seal(batch.id)).toThrow("Cannot seal empty batch");
  });

  it("starts batch and queues all slots", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(batch.id, testSlot);
    tracker.addSample(batch.id, { ...testSlot, position: "A2", sampleLabel: "Beta" });
    tracker.seal(batch.id);
    tracker.start(batch.id);

    const updated = tracker.getBatch(batch.id)!;
    expect(updated.status).toBe("running");
    expect(updated.startedAt).toBeDefined();
    expect(updated.slots.every((s) => s.status === "queued")).toBe(true);
  });

  it("rejects starting non-sealed batch", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(batch.id, testSlot);
    expect(() => tracker.start(batch.id)).toThrow("Cannot start batch");
  });

  it("updates slot status through lifecycle", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    const slot = tracker.addSample(batch.id, testSlot);
    tracker.seal(batch.id);
    tracker.start(batch.id);

    tracker.updateSlotStatus(batch.id, slot.id, "injecting");
    expect(tracker.getBatch(batch.id)!.slots[0].status).toBe("injecting");

    tracker.updateSlotStatus(batch.id, slot.id, "acquiring");
    const s = tracker.getBatch(batch.id)!.slots[0];
    expect(s.status).toBe("acquiring");
    expect(s.acquisitionStart).toBeDefined();
  });

  it("completes slot with result hash", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    const slot = tracker.addSample(batch.id, testSlot);
    tracker.seal(batch.id);
    tracker.start(batch.id);

    const hash = "sha256:abc123def456" as SHA256;
    tracker.completeSlot(batch.id, slot.id, hash, "results/test.json");

    const s = tracker.getBatch(batch.id)!.slots[0];
    expect(s.status).toBe("completed");
    expect(s.resultHash).toBe(hash);
    expect(s.resultRef).toBe("results/test.json");
  });

  it("completes entire batch", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    const slot = tracker.addSample(batch.id, testSlot);
    tracker.seal(batch.id);
    tracker.start(batch.id);
    tracker.completeSlot(batch.id, slot.id, "sha256:abc" as SHA256, "ref");
    tracker.completeBatch(batch.id);

    expect(tracker.getBatch(batch.id)!.status).toBe("completed");
    expect(tracker.getBatch(batch.id)!.completedAt).toBeDefined();
  });

  it("marks batch as partial when some slots failed", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    const s1 = tracker.addSample(batch.id, testSlot);
    const s2 = tracker.addSample(batch.id, { ...testSlot, position: "A2", sampleLabel: "Beta" });
    tracker.seal(batch.id);
    tracker.start(batch.id);
    tracker.completeSlot(batch.id, s1.id, "sha256:abc" as SHA256, "ref");
    tracker.updateSlotStatus(batch.id, s2.id, "failed");
    tracker.completeBatch(batch.id);

    expect(tracker.getBatch(batch.id)!.status).toBe("partial");
  });

  it("demuxes slots by job", () => {
    const tracker = createTracker();
    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(batch.id, { ...testSlot, jobId: "job-001" });
    tracker.addSample(batch.id, { ...testSlot, position: "A2", jobId: "job-002", sampleLabel: "Beta" });
    tracker.addSample(batch.id, { ...testSlot, position: "A3", jobId: "job-001", sampleLabel: "Gamma" });

    const job1Slots = tracker.getSlotsForJob(batch.id, "job-001");
    expect(job1Slots).toHaveLength(2);

    const job2Slots = tracker.getSlotsForJob(batch.id, "job-002");
    expect(job2Slots).toHaveLength(1);
  });

  it("finds batches containing a job", () => {
    const tracker = createTracker();
    const b1 = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(b1.id, { ...testSlot, jobId: "job-001" });
    const b2 = tracker.createBatch("kernel-1", "dev-2", "cap-2", {});
    tracker.addSample(b2.id, { ...testSlot, jobId: "job-002", position: "B1" });

    expect(tracker.getBatchesForJob("job-001")).toHaveLength(1);
    expect(tracker.getBatchesForJob("job-002")).toHaveLength(1);
    expect(tracker.getBatchesForJob("job-999")).toHaveLength(0);
  });

  it("emits batch lifecycle events", () => {
    const tracker = createTracker();
    const events: BatchEvent[] = [];
    tracker.onBatchEvent((e) => events.push(e));

    const batch = tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    tracker.addSample(batch.id, testSlot);
    tracker.seal(batch.id);
    tracker.start(batch.id);

    const types = events.map((e) => e.type);
    expect(types).toContain("batch_created");
    expect(types).toContain("sample_added");
    expect(types).toContain("batch_sealed");
    expect(types).toContain("batch_started");
  });

  it("getAllBatches filters by status and kernelId", () => {
    const tracker = createTracker();
    tracker.createBatch("kernel-1", "dev-1", "cap-1", {});
    const b2 = tracker.createBatch("kernel-2", "dev-2", "cap-2", {});
    tracker.addSample(b2.id, testSlot);
    tracker.seal(b2.id);

    expect(tracker.getAllBatches()).toHaveLength(2);
    expect(tracker.getAllBatches({ kernelId: "kernel-1" })).toHaveLength(1);
    expect(tracker.getAllBatches({ status: "sealed" })).toHaveLength(1);
  });

  it("throws on unknown batch ID", () => {
    const tracker = createTracker();
    expect(() => tracker.seal("nonexistent")).toThrow("not found");
  });
});
