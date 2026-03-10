import { describe, it, expect } from "vitest";
import { AutomationTracker } from "../automation-tracker.js";

// ── Helpers ──────────────────────────────────────────────────────────

const KERNEL = "kernel_test1";
const AGENT = "tagent_robot1";

// ── Tests ────────────────────────────────────────────────────────────

describe("AutomationTracker", () => {
  it("registers a transfer pair with initial status", () => {
    const tracker = new AutomationTracker();
    const status = tracker.register(KERNEL, "nodeA", "nodeB", AGENT);

    expect(status.id).toMatch(/^astat_/);
    expect(status.kernelId).toBe(KERNEL);
    expect(status.fromNodeId).toBe("nodeA");
    expect(status.toNodeId).toBe("nodeB");
    expect(status.transferAgentId).toBe(AGENT);
    expect(status.currentLevel).toBe("manual");
    expect(status.episodeCount).toBe(0);
    expect(status.minEpisodesForTraining).toBe(10);
    expect(status.advanceThreshold).toBe(0.85);
  });

  it("records episodes and increments count", () => {
    const tracker = new AutomationTracker();
    tracker.register(KERNEL, "nodeA", "nodeB", AGENT);

    const s1 = tracker.recordEpisode("nodeA", "nodeB", "ep_001");
    expect(s1.episodeCount).toBe(1);
    expect(s1.lastEpisodeAt).toBeDefined();

    const s2 = tracker.recordEpisode("nodeA", "nodeB", "ep_002");
    expect(s2.episodeCount).toBe(2);

    tracker.recordEpisode("nodeA", "nodeB");
    const s3 = tracker.getStatus("nodeA", "nodeB")!;
    expect(s3.episodeCount).toBe(3);
  });

  it("updates VLA model info", () => {
    const tracker = new AutomationTracker();
    tracker.register(KERNEL, "nodeA", "nodeB", AGENT);

    const status = tracker.updateVLAModel("nodeA", "nodeB", "model_001", "GR00T N1.6", 0.92);

    expect(status.vlaModelId).toBe("model_001");
    expect(status.vlaModelName).toBe("GR00T N1.6");
    expect(status.vlaSuccessRate).toBe(0.92);
    expect(status.lastTrainedAt).toBeDefined();
  });

  it("checkAdvancement returns false when below threshold", () => {
    const tracker = new AutomationTracker();
    tracker.register(KERNEL, "nodeA", "nodeB", AGENT);

    // Record some episodes but not enough
    for (let i = 0; i < 5; i++) {
      tracker.recordEpisode("nodeA", "nodeB");
    }
    tracker.updateVLAModel("nodeA", "nodeB", "m1", "SmolVLA", 0.90);

    const check = tracker.checkAdvancement("nodeA", "nodeB");
    // 5 < 10 episodes minimum → should not advance
    expect(check.shouldAdvance).toBe(false);
    expect(check.nextLevel).toBe("teleoperated");
    expect(check.currentRate).toBe(0.90);
  });

  it("checkAdvancement returns true when above threshold and enough episodes", () => {
    const tracker = new AutomationTracker();
    tracker.register(KERNEL, "nodeA", "nodeB", AGENT);

    // Record enough episodes
    for (let i = 0; i < 10; i++) {
      tracker.recordEpisode("nodeA", "nodeB");
    }
    tracker.updateVLAModel("nodeA", "nodeB", "m1", "SmolVLA", 0.90);

    const check = tracker.checkAdvancement("nodeA", "nodeB");
    expect(check.shouldAdvance).toBe(true);
    expect(check.nextLevel).toBe("teleoperated");
    expect(check.currentRate).toBe(0.90);
  });

  it("advances level through the full progression", () => {
    const tracker = new AutomationTracker();
    tracker.register(KERNEL, "nodeA", "nodeB", AGENT);

    // manual → teleoperated
    const s1 = tracker.advanceLevel("nodeA", "nodeB");
    expect(s1.currentLevel).toBe("teleoperated");

    // teleoperated → pilot_operated
    const s2 = tracker.advanceLevel("nodeA", "nodeB");
    expect(s2.currentLevel).toBe("pilot_operated");

    // pilot_operated → vla_assisted
    const s3 = tracker.advanceLevel("nodeA", "nodeB");
    expect(s3.currentLevel).toBe("vla_assisted");

    // vla_assisted → fully_autonomous
    const s4 = tracker.advanceLevel("nodeA", "nodeB");
    expect(s4.currentLevel).toBe("fully_autonomous");
  });

  it("getAllStatuses filters by kernel", () => {
    const tracker = new AutomationTracker();
    tracker.register("kernel_A", "n1", "n2", AGENT);
    tracker.register("kernel_A", "n2", "n3", AGENT);
    tracker.register("kernel_B", "n4", "n5", AGENT);

    const allA = tracker.getAllStatuses("kernel_A");
    expect(allA).toHaveLength(2);
    expect(allA.every((s) => s.kernelId === "kernel_A")).toBe(true);

    const allB = tracker.getAllStatuses("kernel_B");
    expect(allB).toHaveLength(1);

    const all = tracker.getAllStatuses();
    expect(all).toHaveLength(3);
  });

  it("cannot advance past fully_autonomous", () => {
    const tracker = new AutomationTracker();
    tracker.register(KERNEL, "nodeA", "nodeB", AGENT, "fully_autonomous");

    expect(() => tracker.advanceLevel("nodeA", "nodeB")).toThrow(
      /already at maximum automation level/,
    );
  });
});
