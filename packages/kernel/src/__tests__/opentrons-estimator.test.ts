/**
 * Tests for ProtocolEstimator — time, consumable, and cost estimation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProtocolEstimator, type JobHistoryEntry } from "../opentrons/estimator.js";
import type { ProtocolTemplate, ProtocolStep } from "@pcc/spec";

function makeStep(overrides: Partial<ProtocolStep> & { id: string; action: string }): ProtocolStep {
  return {
    capabilityType: "liquid-handler",
    label: overrides.action,
    params: {},
    estimatedDurationMs: 5000,
    producesEvidence: true,
    dependsOn: [],
    ...overrides,
  };
}

function makeTemplate(steps: ProtocolStep[]): ProtocolTemplate {
  return {
    id: "tmpl-test",
    name: "Test Protocol",
    description: "A test",
    version: "1.0",
    authorId: "test",
    authorName: "Test",
    status: "published",
    tags: [],
    requiredCapabilities: ["liquid-handler"],
    steps,
    transfers: [],
    parameters: [],
    defaultValues: {},
    estimatedTotalDurationMs: steps.reduce((s, st) => s + st.estimatedDurationMs, 0),
    forkCount: 0,
    runCount: 0,
    createdAt: new Date().toISOString(),
  };
}

const PRICING = { baseCost: "5.00", perMinute: "0.50", minimum: "10.00", currency: "USDC" };

describe("ProtocolEstimator", () => {
  let estimator: ProtocolEstimator;

  beforeEach(() => {
    estimator = new ProtocolEstimator();
  });

  // ── Time Estimation ─────────────────────────────────────────

  it("should estimate time for a simple transfer", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "transfer", params: { volume: 100 } }),
    ]);

    const result = estimator.estimateTime(template, {});
    expect(result.executionMs).toBeGreaterThan(0);
    expect(result.stepBreakdown).toHaveLength(1);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("should scale mix time by repetitions", () => {
    const mix3 = makeTemplate([
      makeStep({ id: "s1", action: "mix", params: { repetitions: 3, volume: 100 } }),
    ]);
    const mix10 = makeTemplate([
      makeStep({ id: "s1", action: "mix", params: { repetitions: 10, volume: 100 } }),
    ]);

    const time3 = estimator.estimateTime(mix3, {});
    const time10 = estimator.estimateTime(mix10, {});

    // 10 reps should take roughly 3.3x as long as 3 reps
    expect(time10.executionMs).toBeGreaterThan(time3.executionMs * 2);
  });

  it("should include delay time", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "delay", params: { seconds: 60 } }),
    ]);

    const result = estimator.estimateTime(template, {});
    // Should include at least 60 seconds
    expect(result.executionMs).toBeGreaterThanOrEqual(60_000);
  });

  it("should estimate thermocycler ramp + hold time", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "thermocycler_set_temperature", params: { temperature: 95, holdTimeSeconds: 30 } }),
    ]);

    const result = estimator.estimateTime(template, {});
    // Ramp from 22°C to 95°C + 30s hold
    expect(result.executionMs).toBeGreaterThan(30_000);
  });

  it("should scale distribute time by destination count", () => {
    const dist3 = makeTemplate([
      makeStep({ id: "s1", action: "distribute", params: { volume: 20, destWells: ["A1", "A2", "A3"] } }),
    ]);
    const dist8 = makeTemplate([
      makeStep({ id: "s1", action: "distribute", params: { volume: 20, destWells: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"] } }),
    ]);

    const time3 = estimator.estimateTime(dist3, {});
    const time8 = estimator.estimateTime(dist8, {});

    expect(time8.executionMs).toBeGreaterThan(time3.executionMs);
  });

  it("should add 10% buffer for deck movements", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "aspirate", params: { volume: 100 } }),
      makeStep({ id: "s2", action: "dispense", params: { volume: 100 } }),
    ]);

    const result = estimator.estimateTime(template, {});
    // Base time is aspirate(3000) + dispense(2500) = 5500, with 10% = 6050
    expect(result.executionMs).toBeGreaterThan(5500);
  });

  it("should use historical data when available", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "transfer", params: {} }),
    ]);

    // Record 3+ historical runs
    for (let i = 0; i < 5; i++) {
      estimator.recordCompletion({
        jobId: `job-${i}`,
        templateId: "tmpl-test",
        actionProfile: "transfer",
        stepCount: 1,
        actualDurationMs: 120_000, // 2 minutes actual
        estimatedDurationMs: 0,
        completedAt: new Date().toISOString(),
        success: true,
      });
    }

    const result = estimator.estimateTime(template, {});
    expect(result.stepBreakdown[0].basis).toBe("historical");
    expect(result.confidence).toBeGreaterThan(0.8);
    // Should use ~120s average
    expect(Math.abs(result.executionMs - 120_000)).toBeLessThan(1000);
  });

  // ── Consumable Estimation ───────────────────────────────────

  it("should count tip changes for transfers", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "transfer", params: { volume: 100 } }),
      makeStep({ id: "s2", action: "transfer", params: { volume: 50 } }),
      makeStep({ id: "s3", action: "transfer", params: { volume: 25 } }),
    ]);

    const result = estimator.estimateConsumables(template, {});
    expect(result.tipChanges).toBe(3); // default new_tip="always"
  });

  it("should sum aspirate and dispense volumes", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "aspirate", params: { volume: 100, slot: "1", well: "A1" } }),
      makeStep({ id: "s2", action: "dispense", params: { volume: 100, slot: "2", well: "A1" } }),
      makeStep({ id: "s3", action: "aspirate", params: { volume: 50, slot: "1", well: "A2" } }),
      makeStep({ id: "s4", action: "dispense", params: { volume: 50, slot: "2", well: "A2" } }),
    ]);

    const result = estimator.estimateConsumables(template, {});
    expect(result.totalAspirateUl).toBe(150);
    expect(result.totalDispenseUl).toBe(150);
    expect(result.sourceWells).toBe(2);
    expect(result.destWells).toBe(2);
  });

  it("should track reagent volume by source slot", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "aspirate", params: { volume: 200, slot: "3", well: "A1" } }),
      makeStep({ id: "s2", action: "aspirate", params: { volume: 100, slot: "3", well: "A2" } }),
      makeStep({ id: "s3", action: "aspirate", params: { volume: 50, slot: "5", well: "A1" } }),
    ]);

    const result = estimator.estimateConsumables(template, {});
    expect(result.reagentBySlot["3"]).toBe(300);
    expect(result.reagentBySlot["5"]).toBe(50);
  });

  it("should detect module warmup requirement", () => {
    const withModule = makeTemplate([
      makeStep({ id: "s1", action: "thermocycler_set_temperature", params: { temperature: 95 } }),
    ]);
    const without = makeTemplate([
      makeStep({ id: "s1", action: "transfer", params: { volume: 100 } }),
    ]);

    expect(estimator.estimateConsumables(withModule, {}).requiresModuleWarmup).toBe(true);
    expect(estimator.estimateConsumables(without, {}).requiresModuleWarmup).toBe(false);
  });

  it("should scale distribute volumes by destination count", () => {
    const template = makeTemplate([
      makeStep({
        id: "s1",
        action: "distribute",
        params: { volume: 20, sourceSlot: "1", sourceWell: "A1", destWells: ["A1", "A2", "A3", "A4"] },
      }),
    ]);

    const result = estimator.estimateConsumables(template, {});
    expect(result.totalAspirateUl).toBe(80); // 20 × 4
    expect(result.totalDispenseUl).toBe(80);
    expect(result.tipChanges).toBe(1);
  });

  // ── Cost Estimation ─────────────────────────────────────────

  it("should calculate cost from execution time", () => {
    const result = estimator.estimateCost(30 * 60_000, PRICING);
    // baseCost(5) + 30min × 0.50 = 20
    expect(result.totalCost).toBe(20);
    expect(result.currency).toBe("USDC");
  });

  it("should enforce minimum cost", () => {
    const result = estimator.estimateCost(1 * 60_000, PRICING);
    // baseCost(5) + 1min × 0.50 = 5.50, but minimum is 10
    expect(result.totalCost).toBe(10);
  });

  it("should provide cost breakdown", () => {
    const result = estimator.estimateCost(60 * 60_000, PRICING);
    expect(result.breakdown.length).toBeGreaterThanOrEqual(2);
    expect(result.breakdown[0].label).toBe("Base cost");
  });

  // ── Full Estimation ─────────────────────────────────────────

  it("should build full estimate with queue wait", () => {
    const template = makeTemplate([
      makeStep({ id: "s1", action: "transfer", params: { volume: 100 } }),
    ]);

    const result = estimator.estimateFull(template, {}, PRICING, 5 * 60_000);

    expect(result.queueWaitMs).toBe(5 * 60_000);
    expect(result.totalTimeMs).toBe(result.queueWaitMs + result.time.executionMs);
    expect(result.estimatedStart).toBeTruthy();
    expect(result.estimatedCompletion).toBeTruthy();
    expect(result.consumables.tipChanges).toBeGreaterThanOrEqual(0);
    expect(result.cost.totalCost).toBeGreaterThan(0);
  });
});
