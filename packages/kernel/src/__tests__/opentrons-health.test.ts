/**
 * Tests for OperatorHealthTracker — reliability, consumables, calibration, scheduling.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OperatorHealthTracker, type CompletionRecord } from "../opentrons/health.js";

function makeCompletion(overrides: Partial<CompletionRecord> = {}): CompletionRecord {
  return {
    jobId: `job-${Math.random().toString(36).slice(2, 8)}`,
    templateId: "tmpl-1",
    submittedBy: "agent-1",
    enqueuedAt: new Date(Date.now() - 120_000).toISOString(),
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
    actualDurationMs: 60_000,
    queueWaitMs: 60_000,
    success: true,
    tipsUsed: 5,
    volumeTransferredUl: 500,
    assuranceTier: 1,
    ...overrides,
  };
}

describe("OperatorHealthTracker", () => {
  let tracker: OperatorHealthTracker;

  beforeEach(() => {
    tracker = new OperatorHealthTracker();
  });

  // ── Reliability ─────────────────────────────────────────────

  it("should compute 100% success rate with all successful jobs", () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordCompletion(makeCompletion({ success: true }));
    }
    const r = tracker.getReliability();
    expect(r.successRate).toBe(1);
    expect(r.totalJobsCompleted).toBe(10);
    expect(r.totalJobsFailed).toBe(0);
  });

  it("should compute success rate with mixed results", () => {
    for (let i = 0; i < 8; i++) {
      tracker.recordCompletion(makeCompletion({ success: true }));
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordCompletion(makeCompletion({ success: false, errorMessage: "Robot error" }));
    }
    const r = tracker.getReliability();
    expect(r.successRate).toBe(0.8);
    expect(r.totalJobsCompleted).toBe(8);
    expect(r.totalJobsFailed).toBe(2);
  });

  it("should track last error", () => {
    tracker.recordCompletion(makeCompletion({ success: true }));
    tracker.recordCompletion(makeCompletion({
      success: false,
      errorMessage: "Tip fell off",
      completedAt: "2026-03-24T10:00:00Z",
    }));

    const r = tracker.getReliability();
    expect(r.lastErrorAt).toBe("2026-03-24T10:00:00Z");
    expect(r.lastErrorMessage).toBe("Tip fell off");
  });

  it("should compute average duration from successful jobs only", () => {
    tracker.recordCompletion(makeCompletion({ success: true, actualDurationMs: 30_000 }));
    tracker.recordCompletion(makeCompletion({ success: true, actualDurationMs: 90_000 }));
    tracker.recordCompletion(makeCompletion({ success: false, actualDurationMs: 5_000 }));

    const r = tracker.getReliability();
    expect(r.avgJobDurationMs).toBe(60_000); // (30k + 90k) / 2
  });

  it("should compute average queue wait", () => {
    tracker.recordCompletion(makeCompletion({ queueWaitMs: 10_000 }));
    tracker.recordCompletion(makeCompletion({ queueWaitMs: 30_000 }));

    const r = tracker.getReliability();
    expect(r.avgQueueWaitMs).toBe(20_000);
  });

  // ── Uptime ──────────────────────────────────────────────────

  it("should compute uptime from heartbeats", () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordHeartbeat(true);
    }
    // 100% uptime
    expect(tracker.getUptime(60_000)).toBe(1);
  });

  it("should reflect downtime in uptime calculation", () => {
    for (let i = 0; i < 8; i++) {
      tracker.recordHeartbeat(true);
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordHeartbeat(false);
    }
    expect(tracker.getUptime(60_000)).toBe(0.8);
  });

  // ── Consumables ─────────────────────────────────────────────

  it("should track tip depletion", () => {
    const initial = tracker.getConsumables();
    expect(initial.tipsRemaining).toBe(96 * 4); // 4 racks

    tracker.recordCompletion(makeCompletion({ tipsUsed: 96 }));
    const after = tracker.getConsumables();
    expect(after.tipsRemaining).toBe(96 * 3);
  });

  it("should flag refill needed when low", () => {
    // Use up almost all tips
    tracker.recordCompletion(makeCompletion({ tipsUsed: 96 * 4 - 50 }));
    const c = tracker.getConsumables();
    expect(c.tipsRemaining).toBe(50);
    expect(c.needsRefill).toBe(true); // less than 96
  });

  it("should record refills", () => {
    tracker.recordCompletion(makeCompletion({ tipsUsed: 200 }));
    tracker.recordRefill(96); // add one rack
    const c = tracker.getConsumables();
    expect(c.tipsRemaining).toBe(96 * 4 - 200 + 96);
    expect(c.lastRefillAt).toBeTruthy();
  });

  it("should track reagent levels", () => {
    tracker.setReagentLevel("3", 15000); // 15mL
    tracker.setReagentLevel("5", 5000);  // 5mL
    const c = tracker.getConsumables();
    expect(c.reagentLevels["3"]).toBe(15000);
    expect(c.reagentLevels["5"]).toBe(5000);
  });

  // ── Calibration ─────────────────────────────────────────────

  it("should report calibration status", () => {
    tracker.recordCalibration();
    const cal = tracker.getCalibration();
    expect(cal.calibrationCurrent).toBe(true);
    expect(cal.lastCalibratedAt).toBeTruthy();
    expect(cal.calibrationDueAt).toBeTruthy();
  });

  it("should report calibration not current if never calibrated", () => {
    const cal = tracker.getCalibration();
    expect(cal.calibrationCurrent).toBe(false);
    expect(cal.lastCalibratedAt).toBeNull();
  });

  // ── Scheduling ──────────────────────────────────────────────

  it("should compute peak hours from completions", () => {
    const scheduling = tracker.getScheduling();
    expect(scheduling.peakHours).toBeDefined();
    expect(scheduling.timezone).toBe("UTC");
  });

  it("should have availability windows for all 7 days", () => {
    const scheduling = tracker.getScheduling();
    for (let d = 0; d < 7; d++) {
      expect(scheduling.availabilityWindows[d]).toBeDefined();
      expect(scheduling.availabilityWindows[d].length).toBeGreaterThan(0);
    }
  });

  // ── History Conversion ──────────────────────────────────────

  it("should convert completion to history entry", () => {
    const record = makeCompletion({ actualDurationMs: 45_000 });
    const entry = tracker.toHistoryEntry(record, "transfer,mix", 2);

    expect(entry.jobId).toBe(record.jobId);
    expect(entry.actionProfile).toBe("transfer,mix");
    expect(entry.stepCount).toBe(2);
    expect(entry.actualDurationMs).toBe(45_000);
  });
});
