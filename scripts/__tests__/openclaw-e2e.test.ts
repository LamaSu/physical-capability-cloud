/**
 * Tests for the OpenClaw Print-and-Deliver E2E Simulation.
 *
 * Validates that:
 *   - All 3 variations complete without errors
 *   - Telemetry events are emitted in correct phase order
 *   - Evidence bundles have valid SHA-256 hashes (64-hex-char format)
 *   - Workflow DAG ordering is respected (print before deliver)
 *   - Variation-specific behavior works (pricing, challenge resolution)
 *
 * Run standalone:
 *   npx vitest run scripts/__tests__/openclaw-e2e.test.ts
 * Or via the scripts vitest config:
 *   npx vitest run --config scripts/vitest.config.ts
 */

import { describe, it, expect } from "vitest";
import { runOpenClawE2E, type E2EResult, type TelemetryEvent } from "../openclaw-print-deliver-e2e.js";

// ── SHA-256 format validator ─────────────────────────────────────────────────

/** Matches the `sha256:<64 hex chars>` format used by @pcc/spec's sha256() */
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function isValidBundleHash(hash: string): boolean {
  return SHA256_RE.test(hash);
}

// ── Shared test helpers ──────────────────────────────────────────────────────

function assertBasicShape(result: E2EResult, expectedVariation: 1 | 2 | 3): void {
  expect(result.jobId).toMatch(/^job_/);
  expect(result.variation).toBe(expectedVariation);
  expect(result.durationMs).toBeGreaterThan(0);
  expect(result.totalPrice).toBeGreaterThan(0);
}

function assertBundleIntegrity(result: E2EResult): void {
  // Print bundle
  expect(result.printBundle).toBeDefined();
  expect(result.printBundle.id).toMatch(/^bun_/);
  expect(isValidBundleHash(result.printBundle.bundleHash)).toBe(true);
  expect(result.printBundle.events.length).toBeGreaterThanOrEqual(5);

  // Delivery bundle
  expect(result.deliverBundle).toBeDefined();
  expect(result.deliverBundle.id).toMatch(/^bun_/);
  expect(isValidBundleHash(result.deliverBundle.bundleHash)).toBe(true);
  expect(result.deliverBundle.events.length).toBeGreaterThanOrEqual(5);

  // Hashes must match the exported convenience fields
  expect(result.printHash).toBe(result.printBundle.bundleHash);
  expect(result.deliverHash).toBe(result.deliverBundle.bundleHash);
}

function assertTelemetryOrder(result: E2EResult): void {
  const events = result.telemetry.all();

  // Must have emitted events
  expect(events.length).toBeGreaterThan(10);

  // isOrdered() checks that key pipeline segments happen in correct order:
  // discovery -> escrow -> print_evidence -> delivery_complete -> settlement
  expect(result.telemetry.isOrdered()).toBe(true);

  // Must have at least one completion per major pipeline segment
  const completedPhases = new Set(
    events.filter((e) => e.status === "completed").map((e) => e.phase),
  );

  const requiredPhases = [
    "discovery",
    "quote_response",
    "contract_build",
    "escrow_fund",
    "evidence_capture",
    "verification_result",
    "delivery_complete",
    "settlement_complete",
  ] as const;

  for (const phase of requiredPhases) {
    expect(completedPhases.has(phase)).toBe(true);
  }
}

function assertWorkflowDagOrder(result: E2EResult): void {
  const events = result.telemetry.all();

  // Print evidence must be captured BEFORE delivery evidence
  const printEvidence = events.find(
    (e) => e.phase === "evidence_capture" && e.status === "completed",
  );
  const deliveryComplete = events.find(
    (e) => e.phase === "delivery_complete" && e.status === "completed",
  );

  expect(printEvidence).toBeDefined();
  expect(deliveryComplete).toBeDefined();

  const printTime = new Date(printEvidence!.timestamp).getTime();
  const deliverTime = new Date(deliveryComplete!.timestamp).getTime();

  expect(printTime).toBeLessThanOrEqual(deliverTime);
}

function assertSettlement(result: E2EResult): void {
  const events = result.telemetry.all();
  const settlementEvent = events.find(
    (e) => e.phase === "settlement_complete" && e.status === "completed",
  );

  expect(settlementEvent).toBeDefined();
  const meta = settlementEvent!.metadata;

  expect(meta.printPayout).toBeGreaterThan(0);
  expect(meta.deliveryPayout).toBeGreaterThan(0);
  expect(meta.totalPayout).toBeGreaterThan(0);
  expect(Number(meta.totalPayout)).toBeLessThanOrEqual(result.totalPrice);
}

// ════════════════════════════════════════════════════════════════════════════
// Test Suites
// ════════════════════════════════════════════════════════════════════════════

describe("OpenClaw E2E — Variation 1: Standard", () => {
  let result: E2EResult;

  it("runs without errors", async () => {
    result = await runOpenClawE2E(1);
    expect(result).toBeDefined();
  }, 30_000);

  it("returns correct variation metadata", () => {
    assertBasicShape(result, 1);
  });

  it("produces valid evidence bundles with SHA-256 hashes", () => {
    assertBundleIntegrity(result);
  });

  it("emits telemetry events in correct phase order", () => {
    assertTelemetryOrder(result);
  });

  it("respects workflow DAG order: print before deliver", () => {
    assertWorkflowDagOrder(result);
  });

  it("settles both milestones", () => {
    assertSettlement(result);
  });

  it("uses standard pricing: 10 pages at $0.25 = $2.50 + $8.00 delivery", () => {
    expect(result.totalPrice).toBeCloseTo(10.50, 2);
  });

  it("has no failed telemetry events", () => {
    const counts = result.telemetry.countByStatus();
    expect(counts.failed).toBe(0);
  });

  it("print bundle has 8 evidence events", () => {
    expect(result.printBundle.events.length).toBe(8);
  });

  it("delivery bundle has 7 evidence events", () => {
    expect(result.deliverBundle.events.length).toBe(7);
  });

  it("print and delivery bundles have distinct hashes", () => {
    expect(result.printHash).not.toBe(result.deliverHash);
  });
});

describe("OpenClaw E2E — Variation 2: Rush", () => {
  let result: E2EResult;

  it("runs without errors", async () => {
    result = await runOpenClawE2E(2);
    expect(result).toBeDefined();
  }, 30_000);

  it("returns correct variation metadata", () => {
    assertBasicShape(result, 2);
  });

  it("produces valid evidence bundles", () => {
    assertBundleIntegrity(result);
  });

  it("emits telemetry events in correct order", () => {
    assertTelemetryOrder(result);
  });

  it("respects workflow DAG order", () => {
    assertWorkflowDagOrder(result);
  });

  it("settles both milestones", () => {
    assertSettlement(result);
  });

  it("uses rush pricing: 50 pages at $0.20 = $10.00 + $15.00 express = $25.00", () => {
    expect(result.totalPrice).toBeCloseTo(25.00, 2);
  });

  it("has no failed telemetry events", () => {
    const counts = result.telemetry.countByStatus();
    expect(counts.failed).toBe(0);
  });

  it("print bundle records 50 pages", () => {
    const printEvCapture = result.telemetry
      .all()
      .find((e) => e.phase === "evidence_capture" && e.status === "completed");
    expect(printEvCapture?.metadata.pagesProduced).toBe(50);
  });

  it("express courier has shorter ETA reflected in telemetry", () => {
    const dispatchEv = result.telemetry
      .all()
      .find((e) => e.phase === "delivery_dispatch" && e.status === "completed");
    expect(dispatchEv?.metadata.etaMinutes).toBe(12);
  });

  it("has higher quality score (0.98) for rush printer", () => {
    const printEvCapture = result.telemetry
      .all()
      .find((e) => e.phase === "evidence_capture" && e.status === "completed");
    expect(printEvCapture?.metadata.qualityScore).toBe(0.98);
  });
});

describe("OpenClaw E2E — Variation 3: Challenge", () => {
  let result: E2EResult;

  it("runs without errors", async () => {
    result = await runOpenClawE2E(3);
    expect(result).toBeDefined();
  }, 30_000);

  it("returns correct variation metadata", () => {
    assertBasicShape(result, 3);
  });

  it("produces valid evidence bundles", () => {
    assertBundleIntegrity(result);
  });

  it("emits telemetry events in correct order", () => {
    assertTelemetryOrder(result);
  });

  it("respects workflow DAG order", () => {
    assertWorkflowDagOrder(result);
  });

  it("settles both milestones", () => {
    assertSettlement(result);
  });

  it("uses long-distance pricing: 5 pages at $0.30 = $1.50 + $42.00 = $43.50", () => {
    expect(result.totalPrice).toBeCloseTo(43.50, 2);
  });

  it("emits a challenge resolution telemetry event", () => {
    const arbiterEvent = result.telemetry
      .all()
      .find(
        (e) =>
          e.phase === "verification_request" &&
          e.status === "completed" &&
          e.source === "arbiter",
      );
    expect(arbiterEvent).toBeDefined();
    expect(arbiterEvent?.metadata.challengeResolved).toBe(true);
    expect(arbiterEvent?.metadata.arbiterDecision).toBe("confirmed_valid");
  });

  it("applies 5% arbiter fee to delivery payout", () => {
    const settlementEv = result.telemetry
      .all()
      .find((e) => e.phase === "settlement_complete" && e.status === "completed");
    // deliveryPayout should be 42.00 * 0.95 = 39.90
    expect(Number(settlementEv?.metadata.deliveryPayout)).toBeCloseTo(39.90, 1);
  });

  it("uses a van vehicle type for long-distance delivery", () => {
    const dispatchEv = result.telemetry
      .all()
      .find((e) => e.phase === "delivery_dispatch" && e.status === "completed");
    expect(dispatchEv?.metadata.vehicleType).toBe("van");
  });

  it("records 120-minute ETA for interstate courier", () => {
    const dispatchEv = result.telemetry
      .all()
      .find((e) => e.phase === "delivery_dispatch" && e.status === "completed");
    expect(dispatchEv?.metadata.etaMinutes).toBe(120);
  });
});

// ── Cross-variation properties ────────────────────────────────────────────────

describe("OpenClaw E2E — Cross-variation properties", () => {
  it("all variations produce distinct job IDs", async () => {
    const [r1, r2, r3] = await Promise.all([
      runOpenClawE2E(1),
      runOpenClawE2E(2),
      runOpenClawE2E(3),
    ]);
    const jobIds = new Set([r1.jobId, r2.jobId, r3.jobId]);
    expect(jobIds.size).toBe(3);
  }, 60_000);

  it("all variations produce distinct bundle hashes", async () => {
    const [r1, r2, r3] = await Promise.all([
      runOpenClawE2E(1),
      runOpenClawE2E(2),
      runOpenClawE2E(3),
    ]);
    const hashes = [r1.printHash, r2.printHash, r3.printHash];
    const uniqueHashes = new Set(hashes);
    // Different pages/content should produce different hashes
    expect(uniqueHashes.size).toBe(3);
  }, 60_000);

  it("variation 2 (rush) costs more than variation 1 (standard)", async () => {
    const [r1, r2] = await Promise.all([runOpenClawE2E(1), runOpenClawE2E(2)]);
    expect(r2.totalPrice).toBeGreaterThan(r1.totalPrice);
  }, 60_000);

  it("variation 3 (challenge) costs more than variation 1 (standard)", async () => {
    const [r1, r3] = await Promise.all([runOpenClawE2E(1), runOpenClawE2E(3)]);
    expect(r3.totalPrice).toBeGreaterThan(r1.totalPrice);
  }, 60_000);
});
