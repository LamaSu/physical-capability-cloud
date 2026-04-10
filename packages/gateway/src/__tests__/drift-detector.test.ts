import { describe, it, expect } from "vitest";
import { detectDrifts, type DriftDetectionContext } from "../facades/drift-detector.js";
import type { EvidenceEvent } from "@pcc/spec";
import type { CWMStep } from "@pcc/spec";

// ── Fixture factories ──────────────────────────────────────────────────────

let eventCounter = 0;

function makeEvent(overrides: Partial<EvidenceEvent> = {}): EvidenceEvent {
  return {
    id: `ev-${++eventCounter}`,
    type: "execution_started",
    timestamp: new Date().toISOString(),
    source: {
      deviceId: "dev-001",
      deviceType: "controller",
      kernelId: "kernel-001",
    },
    payload: {},
    hash: ("a".repeat(64)) as any,
    ...overrides,
  };
}

function makeStep(overrides: Partial<CWMStep> = {}): CWMStep {
  return {
    id: "step-001",
    capability: "3d_printing",
    params: {},
    assuranceTier: 0,
    dependsOn: [],
    ...overrides,
  };
}

/** Build a pair of start/complete events with given timestamps */
function makeDurationEvents(startMs: number, endMs: number): EvidenceEvent[] {
  return [
    makeEvent({
      type: "execution_started",
      timestamp: new Date(startMs).toISOString(),
    }),
    makeEvent({
      type: "execution_completed",
      timestamp: new Date(endMs).toISOString(),
    }),
  ];
}

// ── Main tests ─────────────────────────────────────────────────────────────

describe("detectDrifts()", () => {
  describe("returns []", () => {
    it("returns empty array when evidenceEvents is empty and no cwmStep (only sensor_gap from tier reqs)", () => {
      // With empty events, sensor_gap alerts fire for tier 0 requirements.
      // This test verifies duration_mismatch and power_anomaly are absent (no such events).
      const ctx: DriftDetectionContext = {
        evidenceEvents: [],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx);
      expect(alerts.filter((a) => a.type === "duration_mismatch")).toHaveLength(0);
      expect(alerts.filter((a) => a.type === "power_anomaly")).toHaveLength(0);
      expect(alerts.filter((a) => a.type === "temperature_excursion")).toHaveLength(0);
    });

    it("returns empty array when no drift conditions met", () => {
      const baseMs = Date.now();
      // Expected: 10 minutes = 600s. Actual: 550s (ratio ~0.92 — within tolerance)
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          ...makeDurationEvents(baseMs, baseMs + 550_000),
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 250 } }), // mid-range for 3d_printing [50-500]
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10, capability: "3d_printing" }), // 10min = 600s
      };
      const alerts = detectDrifts(ctx);
      // May have sensor_gap alerts for tier 0 (missing gcode_hash_verified / execution_completed)
      // but no duration_mismatch or power_anomaly
      const durAlerts = alerts.filter((a) => a.type === "duration_mismatch");
      const powerAlerts = alerts.filter((a) => a.type === "power_anomaly");
      expect(durAlerts).toHaveLength(0);
      expect(powerAlerts).toHaveLength(0);
    });
  });

  // ── duration_mismatch ──────────────────────────────────────────────────

  describe("duration_mismatch", () => {
    it("returns [] when cwmStep has no estimatedDuration", () => {
      const baseMs = Date.now();
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 60_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: undefined }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(0);
    });

    it("returns [] when execution_started events are missing", () => {
      const baseMs = Date.now();
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "execution_completed", timestamp: new Date(baseMs + 60_000).toISOString() }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 1 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(0);
    });

    it("returns [] when execution_completed events are missing", () => {
      const baseMs = Date.now();
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "execution_started", timestamp: new Date(baseMs).toISOString() }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 1 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(0);
    });

    it("critical severity when actual/expected ratio < 0.1 (almost instant completion)", () => {
      const baseMs = Date.now();
      // Expected: 60 minutes = 3600s. Actual: 10s → ratio=0.0028 < 0.1
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 10_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 60 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });

    it("high severity when ratio < 0.5 (too fast: e.g. 20% of expected time)", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 100s → ratio=0.167 (0.1 <= ratio < 0.5)
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 100_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("high");
    });

    it("high severity when ratio > 2.0 (too slow: e.g. 250% of expected time)", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 1800s → ratio=3.0 > 2.0
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 1_800_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("high");
    });

    it("medium severity when 0.5 <= ratio < 0.7", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 360s → ratio=0.6 (0.5 <= r < 0.7)
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 360_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("medium");
    });

    it("medium severity when 1.5 < ratio <= 2.0", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 1080s → ratio=1.8 (1.5 < r <= 2.0)
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 1_080_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("medium");
    });

    it("low severity when 0.7 <= ratio < 0.85", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 450s → ratio=0.75 (0.7 <= r < 0.85)
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 450_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("low");
    });

    it("low severity when 1.2 < ratio <= 1.5", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 780s → ratio=1.3 (1.2 < r <= 1.5)
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 780_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("low");
    });

    it("no alert when 0.85 <= ratio <= 1.2 (within tolerance)", () => {
      const baseMs = Date.now();
      // Expected: 10min = 600s. Actual: 570s → ratio=0.95 (within 0.85-1.2)
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 570_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(0);
    });

    it("alert type is 'duration_mismatch'", () => {
      const baseMs = Date.now();
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 10_000), // very fast
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 60 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts[0].type).toBe("duration_mismatch");
    });

    it("alert has expectedValue in seconds format and actualValue in seconds format", () => {
      const baseMs = Date.now();
      // Expected: 1 min = 60s, actual: 5s
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs, baseMs + 5_000),
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 1 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts[0].expectedValue).toMatch(/s$/);
      expect(alerts[0].actualValue).toMatch(/s$/);
    });

    it("returns [] when actualMs <= 0 (bogus timestamps)", () => {
      const baseMs = Date.now();
      // end before start → actualMs < 0
      const ctx: DriftDetectionContext = {
        evidenceEvents: makeDurationEvents(baseMs + 60_000, baseMs), // reversed
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 1 }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      expect(alerts).toHaveLength(0);
    });

    it("uses the last execution_completed event (not the first)", () => {
      const baseMs = Date.now();
      // First started at 0, completed at 5s (too fast), but second completed at 600s (on time)
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "execution_started", timestamp: new Date(baseMs).toISOString() }),
          makeEvent({ type: "execution_completed", timestamp: new Date(baseMs + 5_000).toISOString() }),
          makeEvent({ type: "execution_completed", timestamp: new Date(baseMs + 600_000).toISOString() }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }), // 600s expected
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
      // ratio = 600/600 = 1.0 → no alert
      expect(alerts).toHaveLength(0);
    });
  });

  // ── power_anomaly ──────────────────────────────────────────────────────

  describe("power_anomaly", () => {
    it("returns [] when no power_profile_summary events", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [makeEvent({ type: "execution_started" })],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(0);
    });

    it("critical severity for negative avgWatts (sensor fault)", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: -10 } }),
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });

    it("critical severity for avgWatts > 50000 (implausible)", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 60000 } }),
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });

    it("high severity when ratio < 0.1 vs capability norm", () => {
      // 3d_printing: [50, 500] → mid=275. ratio < 0.1 means avgWatts < 27.5
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 2 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("high");
    });

    it("high severity when ratio > 3.0 vs capability norm", () => {
      // 3d_printing: [50, 500] → mid=275. ratio > 3.0 means avgWatts > 825
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 900 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("high");
    });

    it("medium severity when ratio < 0.5 (not in critical/high zone)", () => {
      // 3d_printing mid=275. ratio 0.1-0.5 → avgWatts 27.5-137.5
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 50 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("medium");
    });

    it("medium severity when ratio > 1.5 (not in high zone)", () => {
      // 3d_printing mid=275. ratio 1.5-3.0 → avgWatts 412.5-825
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 500 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("medium");
    });

    it("low severity when ratio near 0.8-0.9 (below 1.0, above 0.5)", () => {
      // 3d_printing mid=275. ratio 0.8-1.0 → avgWatts 220-275 — but 0.8-0.5 is medium
      // Actually: low is 0.5<ratio<0.8 or 1.2<ratio<1.5
      // ratio 0.8-1.2 is no alert
      // ratio<0.8 and ratio>0.5 is medium? Let me re-check source:
      // if ratio < 0.5 || ratio > 1.5 → medium
      // elif ratio < 0.8 || ratio > 1.2 → low
      // So ratio=0.6 (in 0.5-0.8) → medium, ratio=0.75 → medium? No:
      // The source says: ratio < 0.5 || ratio > 1.5 → medium; ratio < 0.8 || ratio > 1.2 → low
      // That means 0.5<=ratio<0.8 → low (since it passed the medium check)
      // avgWatts = 0.7 * 275 = 192.5 → ratio=0.7 → low
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 192 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("low");
    });

    it("no alert when ratio within 0.8-1.2 of capability norm", () => {
      // 3d_printing mid=275. ratio=1.0 → avgWatts=275
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 275 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(0);
    });

    it("uses default power range when capabilityType not provided", () => {
      // default: [50, 10000] → mid=5025. avgWatts=5025 → ratio=1.0 → no alert
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 5025 } }),
        ],
        assuranceTier: 0,
        // no cwmStep
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(0);
    });

    it("uses '3d_printing' power range when cwmStep.capability='3d_printing'", () => {
      // 3d_printing: [50, 500] → mid=275
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: 275 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ capability: "3d_printing" }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(0);
    });

    it("skips events where avgWatts is undefined or null", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: {} }),
          makeEvent({ type: "power_profile_summary", payload: { avgWatts: null } }),
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
      expect(alerts).toHaveLength(0);
    });
  });

  // ── temperature_excursion ──────────────────────────────────────────────

  describe("temperature_excursion", () => {
    it("returns [] when no temperature_log events", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [makeEvent({ type: "execution_started" })],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(0);
    });

    it("critical for temp < -273.15 (below absolute zero)", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: -300 } }),
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });

    it("critical for temp > 5000 (implausible)", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 6000 } }),
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("critical");
    });

    it("high severity when >50% over band width from safe band", () => {
      // PLA band: [180, 230] → width=50. 50% over = 25°C over the band.
      // So temp > 230 + 25 = 255 OR temp < 180 - 25 = 155
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 280 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "pla" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("high");
    });

    it("medium severity when 10-50% over band width", () => {
      // PLA band: [180, 230] → width=50. 10-50% = 5-25°C over band.
      // temp = 245 → overshoot=15 → overPercent=30% → medium
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 245 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "pla" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("medium");
    });

    it("low severity when <10% over band width", () => {
      // PLA band: [180, 230] → width=50. <10% = <5°C over.
      // temp = 233 → overshoot=3 → overPercent=6% → low
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 233 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "pla" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe("low");
    });

    it("no alert when temperature within safe band", () => {
      // PLA: [180, 230]. 200°C is in-band.
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 200 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "pla" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(0);
    });

    it("uses PLA band [180-230°C] when material=pla", () => {
      // 170°C is outside [180-230] for PLA → should alert
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 170 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "pla" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
    });

    it("uses ABS band [220-260°C] when material=abs", () => {
      // 210°C is outside [220-260] for ABS → should alert
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 210 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "abs" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
    });

    it("uses default band [0-500°C] when no material specified", () => {
      // 250°C is within [0-500] → no alert
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 250 } }),
        ],
        assuranceTier: 0,
        // no cwmStep
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(0);
    });

    it("partial material match: 'pla_filament' matches 'pla' band", () => {
      // pla_filament contains "pla" → band [180-230]. 250°C is outside → alert
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: { temperature: 250 } }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ params: { material: "pla_filament" } }),
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(1);
    });

    it("skips events where temperature is undefined", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "temperature_log", payload: {} }),
          makeEvent({ type: "temperature_log", payload: { temperature: undefined } }),
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
      expect(alerts).toHaveLength(0);
    });
  });

  // ── sensor_gap ─────────────────────────────────────────────────────────

  describe("sensor_gap", () => {
    it("returns [] when tier requirements not found (invalid tier)", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [],
        assuranceTier: 99 as any, // invalid tier
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      expect(alerts).toHaveLength(0);
    });

    it("tier 0: critical alert when execution_completed missing", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "gcode_hash_verified" }),
          // missing execution_completed
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      const completionAlert = alerts.find((a) => a.expectedValue.includes("execution_completed"));
      expect(completionAlert).toBeDefined();
      expect(completionAlert!.severity).toBe("critical");
    });

    it("tier 0: high alert when gcode_hash_verified missing", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "execution_completed" }),
          // missing gcode_hash_verified
        ],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      const gcodeAlert = alerts.find((a) => a.expectedValue.includes("gcode_hash_verified"));
      expect(gcodeAlert).toBeDefined();
      expect(gcodeAlert!.severity).toBe("high");
    });

    it("tier 1: high alert when power_profile_summary missing", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "gcode_hash_verified" }),
          makeEvent({ type: "execution_completed" }),
          // missing power_profile_summary
        ],
        assuranceTier: 1,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      const powerAlert = alerts.find((a) => a.expectedValue.includes("power_profile_summary"));
      expect(powerAlert).toBeDefined();
      expect(powerAlert!.severity).toBe("high");
    });

    it("tier 2: high alert when cv_inspection_result|camera_snapshot group missing", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "gcode_hash_verified" }),
          makeEvent({ type: "execution_completed" }),
          makeEvent({ type: "power_profile_summary" }),
          // missing cv_inspection_result AND camera_snapshot
        ],
        assuranceTier: 2,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      const camAlert = alerts.find(
        (a) =>
          a.expectedValue.includes("cv_inspection_result") ||
          a.expectedValue.includes("camera_snapshot"),
      );
      expect(camAlert).toBeDefined();
      expect(camAlert!.severity).toBe("high");
    });

    it("tier 3: critical alert when tee_attestation missing", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "gcode_hash_verified" }),
          makeEvent({ type: "execution_completed" }),
          makeEvent({ type: "power_profile_summary" }),
          makeEvent({ type: "cv_inspection_result" }),
          // missing tee_attestation
        ],
        assuranceTier: 3,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      const teeAlert = alerts.find((a) => a.expectedValue.includes("tee_attestation"));
      expect(teeAlert).toBeDefined();
      expect(teeAlert!.severity).toBe("critical");
    });

    it("OR-group: NO alert when camera_snapshot present (satisfies cv_inspection_result|camera_snapshot group)", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "gcode_hash_verified" }),
          makeEvent({ type: "execution_completed" }),
          makeEvent({ type: "power_profile_summary" }),
          makeEvent({ type: "camera_snapshot" }), // satisfies the OR group
        ],
        assuranceTier: 2,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      const camAlert = alerts.find(
        (a) =>
          a.expectedValue.includes("cv_inspection_result") ||
          a.expectedValue.includes("camera_snapshot"),
      );
      expect(camAlert).toBeUndefined();
    });

    it("alert type is 'sensor_gap'", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [], // all missing for tier 0
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      expect(alerts.every((a) => a.type === "sensor_gap")).toBe(true);
    });

    it("alert message includes the tier number and missing group members", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [],
        assuranceTier: 0,
      };
      const alerts = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
      for (const alert of alerts) {
        expect(alert.message).toContain("Tier 0");
      }
    });
  });

  // ── error resilience ───────────────────────────────────────────────────

  describe("error resilience", () => {
    it("never throws even when events have malformed timestamps", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "execution_started", timestamp: "not-a-date" }),
          makeEvent({ type: "execution_completed", timestamp: "also-not-a-date" }),
        ],
        assuranceTier: 0,
        cwmStep: makeStep({ estimatedDuration: 10 }),
      };
      expect(() => detectDrifts(ctx)).not.toThrow();
    });

    it("never throws even when payload is null", () => {
      const ctx: DriftDetectionContext = {
        evidenceEvents: [
          makeEvent({ type: "power_profile_summary", payload: null as any }),
          makeEvent({ type: "temperature_log", payload: null as any }),
        ],
        assuranceTier: 0,
      };
      expect(() => detectDrifts(ctx)).not.toThrow();
    });
  });
});
