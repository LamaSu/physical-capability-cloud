import { describe, it, expect } from "vitest";
import { SampleTracker } from "../sample-tracker.js";

describe("SampleTracker", () => {
  it("creates a sample with correct initial state", () => {
    const tracker = new SampleTracker();
    const sample = tracker.createSample("job_1", "Sample A", "plate", "node_staging");

    expect(sample.id).toMatch(/^samp_/);
    expect(sample.jobId).toBe("job_1");
    expect(sample.label).toBe("Sample A");
    expect(sample.labwareType).toBe("plate");
    expect(sample.currentNodeId).toBe("node_staging");
    expect(sample.status).toBe("created");
    expect(sample.history).toHaveLength(0);
    expect(sample.createdAt).toBeDefined();
  });

  it("moves a sample and updates currentNodeId and history", () => {
    const tracker = new SampleTracker();
    const sample = tracker.createSample("job_1", "S1", "vial", "A");

    const movement = tracker.moveSample(sample.id, "B", "robot_arm");

    const updated = tracker.getSample(sample.id)!;
    expect(updated.currentNodeId).toBe("B");
    expect(updated.history).toHaveLength(1);
    expect(movement.fromNodeId).toBe("A");
    expect(movement.toNodeId).toBe("B");
    expect(movement.mechanism).toBe("robot_arm");
    expect(movement.id).toMatch(/^smov_/);
  });

  it("records full movement history across 3 moves", () => {
    const tracker = new SampleTracker();
    const sample = tracker.createSample("job_1", "S1", "tube", "A");

    tracker.moveSample(sample.id, "B", "conveyor");
    tracker.moveSample(sample.id, "C", "robot_arm");
    tracker.moveSample(sample.id, "D", "pneumatic");

    const updated = tracker.getSample(sample.id)!;
    expect(updated.currentNodeId).toBe("D");
    expect(updated.history).toHaveLength(3);

    expect(updated.history[0].fromNodeId).toBe("A");
    expect(updated.history[0].toNodeId).toBe("B");
    expect(updated.history[1].fromNodeId).toBe("B");
    expect(updated.history[1].toNodeId).toBe("C");
    expect(updated.history[2].fromNodeId).toBe("C");
    expect(updated.history[2].toNodeId).toBe("D");
  });

  it("getSamplesAtNode filters by current node", () => {
    const tracker = new SampleTracker();
    tracker.createSample("job_1", "S1", "plate", "A");
    tracker.createSample("job_1", "S2", "plate", "B");
    tracker.createSample("job_2", "S3", "plate", "A");

    const atA = tracker.getSamplesAtNode("A");
    expect(atA).toHaveLength(2);
    expect(atA.map((s) => s.label).sort()).toEqual(["S1", "S3"]);

    const atB = tracker.getSamplesAtNode("B");
    expect(atB).toHaveLength(1);
    expect(atB[0].label).toBe("S2");
  });

  it("getSamplesForJob filters by jobId", () => {
    const tracker = new SampleTracker();
    tracker.createSample("job_1", "S1", "plate", "A");
    tracker.createSample("job_1", "S2", "plate", "B");
    tracker.createSample("job_2", "S3", "plate", "A");

    const job1 = tracker.getSamplesForJob("job_1");
    expect(job1).toHaveLength(2);

    const job2 = tracker.getSamplesForJob("job_2");
    expect(job2).toHaveLength(1);
    expect(job2[0].label).toBe("S3");
  });

  it("supports status transitions: created -> processing -> idle -> completed", () => {
    const tracker = new SampleTracker();
    const sample = tracker.createSample("job_1", "S1", "plate", "A");
    expect(sample.status).toBe("created");

    tracker.startProcessing(sample.id);
    expect(tracker.getSample(sample.id)!.status).toBe("processing");

    tracker.completeProcessing(sample.id);
    expect(tracker.getSample(sample.id)!.status).toBe("idle");

    tracker.completeSample(sample.id);
    expect(tracker.getSample(sample.id)!.status).toBe("completed");
  });

  it("onMove fires callback when sample moves", () => {
    const tracker = new SampleTracker();
    const sample = tracker.createSample("job_1", "S1", "plate", "A");

    const movements: string[] = [];
    tracker.onMove((movement, s) => {
      movements.push(`${movement.fromNodeId}->${movement.toNodeId}`);
    });

    tracker.moveSample(sample.id, "B", "robot_arm");
    tracker.moveSample(sample.id, "C", "conveyor");

    expect(movements).toEqual(["A->B", "B->C"]);
  });

  it("unsubscribe stops callbacks from firing", () => {
    const tracker = new SampleTracker();
    const sample = tracker.createSample("job_1", "S1", "plate", "A");

    const movements: string[] = [];
    const unsub = tracker.onMove((movement) => {
      movements.push(movement.toNodeId);
    });

    tracker.moveSample(sample.id, "B", "robot_arm");
    expect(movements).toEqual(["B"]);

    unsub();

    tracker.moveSample(sample.id, "C", "conveyor");
    // Should NOT have received the second callback
    expect(movements).toEqual(["B"]);
  });
});
