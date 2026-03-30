/**
 * Tests for assurance tier enforcement in the job pipeline.
 *
 * The JobRunner uses EvidenceEmitter.checkTierRequirements() to determine
 * whether evidence meets the requirements for the requested assurance tier.
 * This test file verifies tier checks and their interaction with job outcomes.
 *
 * Tests use the EvidenceEmitter directly (unit tests), plus a mock-based
 * integration test for the JobRunner tier gating behavior.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Sentry from "@sentry/node";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";
import type { MachineAdapter, SensorAdapter, CameraAdapter } from "../adapters/types.js";
import type { EvidenceEvent, EvidenceSource, SHA256 } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Mock Sentry to avoid real network calls
// ---------------------------------------------------------------------------

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-tier-test";

function makeSource(deviceId = "dev-001"): EvidenceSource {
  return { deviceId, deviceType: "controller", kernelId: KERNEL_ID };
}

function makeEvent(type: string, overrides: Partial<Omit<EvidenceEvent, "id" | "hash">> = {}): Omit<EvidenceEvent, "id" | "hash"> {
  return {
    type: type as EvidenceEvent["type"],
    timestamp: new Date().toISOString(),
    source: makeSource(),
    payload: {},
    ...overrides,
  };
}

/**
 * Build a mock MachineAdapter that:
 *   - succeeds all commands
 *   - emits the given events when execute("load_gcode") is called
 *     (so they are captured BEFORE waitForCompletion races with addEvent microtasks)
 *   - returns progress=100 immediately on getProgress()
 *
 * Note: events are emitted during load_gcode (not start) to ensure they are
 * captured by the evidence emitter before finalizeBundle is called. This avoids
 * the fire-and-forget race in handleEvidence (addEvent is not awaited in the cb).
 */
function makeMockMachine(eventsToEmit: Array<Omit<EvidenceEvent, "id" | "hash">> = []): MachineAdapter {
  const listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  return {
    id: "dev-mock-001",
    type: "fdm" as const,
    source: makeSource(),
    getStatus: vi.fn().mockResolvedValue("idle"),
    // Return 100 on second call so waitForCompletion exits after one tick
    getProgress: vi.fn().mockResolvedValue(100),
    execute: vi.fn().mockImplementation(async (cmd: { type: string }) => {
      if (cmd.type === "load_gcode") {
        // Emit all events during load_gcode so addEvent microtasks settle
        // before waitForCompletion polls getProgress.
        // handleEvidence fires addEvent().catch() which invokes hashEvent()
        // (Web Crypto API async). We wait long enough for all hashing to complete.
        for (const ev of eventsToEmit) {
          for (const cb of listeners) cb(ev);
        }
        // Wait for Web Crypto hashing microtasks to settle (hashEvent uses crypto.subtle)
        await new Promise((r) => setTimeout(r, 50));
      }
      return { success: true, message: "ok" };
    }),
    onEvidence: vi.fn().mockImplementation((cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) => {
      listeners.push(cb);
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSensor(eventsToEmit: Array<Omit<EvidenceEvent, "id" | "hash">> = []): SensorAdapter {
  const listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  return {
    id: "sensor-mock-001",
    type: "power_monitor" as const,
    source: makeSource("sensor-001"),
    startRecording: vi.fn().mockResolvedValue(undefined),
    stopRecording: vi.fn().mockResolvedValue({
      type: "power_profile_summary",
      timestamp: new Date().toISOString(),
      source: makeSource("sensor-001"),
      payload: { avgWatts: 90, peakWatts: 200 },
    }),
    getCurrentReading: vi.fn().mockResolvedValue({ watts: 90 }),
    onEvidence: vi.fn().mockImplementation((cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) => {
      for (const ev of eventsToEmit) {
        cb(ev);
      }
      listeners.push(cb);
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockCamera(): CameraAdapter {
  const listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  return {
    id: "camera-mock-001",
    source: makeSource("camera-001"),
    captureSnapshot: vi.fn().mockImplementation(async () => {
      for (const cb of listeners) {
        cb({
          type: "camera_snapshot",
          timestamp: new Date().toISOString(),
          source: makeSource("camera-001"),
          payload: { imageHash: "sha256:cam001" },
        });
      }
      return { imageHash: "sha256:cam001", storageRef: "mock://cam001" };
    }),
    runInspection: vi.fn().mockImplementation(async () => {
      for (const cb of listeners) {
        cb({
          type: "camera_snapshot",
          timestamp: new Date().toISOString(),
          source: makeSource("camera-001"),
          payload: { imageHash: "sha256:cam_inspect" },
        });
      }
      return { passed: true, confidence: 0.95, findings: [], imageHash: "sha256:cam_inspect" };
    }),
    onEvidence: vi.fn().mockImplementation((cb: (e: Omit<EvidenceEvent, "id" | "hash">) => void) => {
      listeners.push(cb);
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// EvidenceEmitter.checkTierRequirements unit tests
// ---------------------------------------------------------------------------

describe("EvidenceEmitter — checkTierRequirements", () => {
  let emitter: EvidenceEmitter;

  beforeEach(() => {
    emitter = new EvidenceEmitter(KERNEL_ID);
  });

  describe("Tier 0", () => {
    it("meets tier 0 requirements with gcode_hash_verified + execution_completed", () => {
      // Tier 0 requires: gcode_hash_verified, execution_completed, min 2 events
      const events = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
      ] as unknown as EvidenceEvent[];
      const result = emitter.checkTierRequirements(events, 0);
      expect(result.met).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it("does not meet tier 0 with no events (minimumEvents=2 not satisfied)", () => {
      const result = emitter.checkTierRequirements([], 0);
      // Tier 0 requires gcode_hash_verified + execution_completed (min 2)
      expect(result.met).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    });

    it("does not meet tier 0 with only execution_completed (missing gcode_hash_verified)", () => {
      const events = [makeEvent("execution_completed")] as unknown as EvidenceEvent[];
      const result = emitter.checkTierRequirements(events, 0);
      expect(result.met).toBe(false);
    });
  });

  describe("Tier 1", () => {
    it("meets tier 1 requirements with gcode_hash_verified + execution_completed + power_profile_summary", () => {
      // Tier 1: all tier 0 events + power_profile_summary, min 3 events
      const events = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
        makeEvent("power_profile_summary"),
      ] as unknown as EvidenceEvent[];

      const result = emitter.checkTierRequirements(events, 1);
      expect(result.met).toBe(true);
    });

    it("does not meet tier 1 when missing power_profile_summary", () => {
      const events = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
      ] as unknown as EvidenceEvent[];
      const result = emitter.checkTierRequirements(events, 1);
      expect(result.met).toBe(false);
      expect(result.missing.some((m) => m.includes("power_profile_summary"))).toBe(true);
    });

    it("does not meet tier 1 with single gcode_received event (wrong type, missing events)", () => {
      const events = [makeEvent("gcode_received")] as unknown as EvidenceEvent[];
      const result = emitter.checkTierRequirements(events, 1);
      expect(result.met).toBe(false);
      expect(Array.isArray(result.missing)).toBe(true);
    });
  });

  describe("Tier 2", () => {
    it("meets tier 2 with camera_snapshot + gcode_hash_verified + execution_completed + power_profile_summary", () => {
      // Tier 2: all tier 1 events + camera_snapshot or cv_inspection_result, min 4 events
      const events = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
        makeEvent("power_profile_summary"),
        makeEvent("camera_snapshot"),
      ] as unknown as EvidenceEvent[];

      const result = emitter.checkTierRequirements(events, 2);
      expect(result.met).toBe(true);
    });

    it("meets tier 2 with cv_inspection_result instead of camera_snapshot", () => {
      const events = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
        makeEvent("power_profile_summary"),
        makeEvent("cv_inspection_result"),
      ] as unknown as EvidenceEvent[];

      const result = emitter.checkTierRequirements(events, 2);
      expect(result.met).toBe(true);
    });

    it("reports missing events when tier 2 requirements are not met (no camera)", () => {
      const events = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
        makeEvent("power_profile_summary"),
      ] as unknown as EvidenceEvent[];
      const result = emitter.checkTierRequirements(events, 2);
      expect(result.met).toBe(false);
      expect(result.missing.some((m) => m.includes("cv_inspection_result") || m.includes("camera_snapshot"))).toBe(true);
    });

    it("reports missing events for a single arbitrary event (many missing)", () => {
      const events = [makeEvent("execution_started")] as unknown as EvidenceEvent[];
      const result = emitter.checkTierRequirements(events, 2);
      expect(result.met).toBe(false);
      expect(result.missing.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// JobRunner tier behavior tests (integration-style with mocks)
// ---------------------------------------------------------------------------

describe("JobRunner — tier gating", () => {
  let emitter: EvidenceEmitter;

  beforeEach(() => {
    emitter = new EvidenceEmitter(KERNEL_ID);
    vi.clearAllMocks();
  });

  describe("Tier 0 job", () => {
    it("succeeds with gcode_hash_verified + execution_completed events", async () => {
      // Tier 0: requires gcode_hash_verified + execution_completed (min 2 events)
      const machineEvents = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
      ];

      const machine = makeMockMachine(machineEvents);
      const runner = new JobRunner(machine, [], null, emitter);

      const result = await runner.run({
        jobId: "job-tier0-001",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 0,
      });

      expect(result.success).toBe(true);
      expect(result.bundleId).toBeDefined();
    });

    it("does not start sensors for tier 0", async () => {
      const machineEvents = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
      ];

      const machine = makeMockMachine(machineEvents);
      const sensor = makeMockSensor();
      const runner = new JobRunner(machine, [sensor], null, emitter);

      await runner.run({
        jobId: "job-tier0-nosensors",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 0,
      });

      // Sensor startRecording should NOT be called for tier 0
      expect(sensor.startRecording).not.toHaveBeenCalled();
    });
  });

  describe("Tier 1 job", () => {
    it("succeeds with sensor data (tier 1 events: gcode_hash_verified + execution_completed + power_profile_summary)", async () => {
      const machineEvents = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
        makeEvent("power_profile_summary"),
      ];

      const machine = makeMockMachine(machineEvents);
      const sensor = makeMockSensor();
      const runner = new JobRunner(machine, [sensor], null, emitter);

      const result = await runner.run({
        jobId: "job-tier1-001",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 1,
      });

      expect(result.success).toBe(true);
      // Sensors should have been started and stopped
      expect(sensor.startRecording).toHaveBeenCalledWith("job-tier1-001");
      expect(sensor.stopRecording).toHaveBeenCalled();
    });

    it("still succeeds with minimal events even when tier check warns (advisory not gating)", async () => {
      // Tier 1 with only gcode_hash_verified + execution_completed (missing power_profile_summary)
      // Job runner warns but doesn't fail — tier check is advisory
      const machineEvents = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
      ];

      const machine = makeMockMachine(machineEvents);
      const runner = new JobRunner(machine, [], null, emitter);

      const result = await runner.run({
        jobId: "job-tier1-warn",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 1,
      });

      // Job still succeeds — tier check is advisory, not gating
      expect(result.success).toBe(true);
    });
  });

  describe("Tier 2 job", () => {
    it("succeeds with CV inspection + sensor data (all tier 2 events)", async () => {
      const machineEvents = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
        makeEvent("power_profile_summary"),
        makeEvent("camera_snapshot"),
      ];

      const machine = makeMockMachine(machineEvents);
      const sensor = makeMockSensor();
      const camera = makeMockCamera();
      const runner = new JobRunner(machine, [sensor], camera, emitter);

      const result = await runner.run({
        jobId: "job-tier2-001",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 2,
      });

      expect(result.success).toBe(true);
      // Camera should have been used for before-snapshot and inspection
      expect(camera.captureSnapshot).toHaveBeenCalled();
      expect(camera.runInspection).toHaveBeenCalled();
      // Sensors should have been started and stopped
      expect(sensor.startRecording).toHaveBeenCalled();
      expect(sensor.stopRecording).toHaveBeenCalled();
    });

    it("fails job when tier 2 requirements are not met (hard enforcement for tier >= 2)", async () => {
      // Tier 2 job, no camera → tier check is a HARD FAILURE for tier >= 2
      // (cv_inspection_result or camera_snapshot is required)
      const machineEvents = [
        makeEvent("gcode_hash_verified"),
        makeEvent("execution_completed"),
      ];

      const machine = makeMockMachine(machineEvents);
      const sensor = makeMockSensor();
      const runner = new JobRunner(machine, [sensor], null, emitter); // no camera

      const result = await runner.run({
        jobId: "job-tier2-nocam",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 2,
      });

      // Job fails — tier 2 requirements are enforced as a hard gate
      expect(result.success).toBe(false);
      expect(result.error).toContain("Tier 2 requirements not met");
    });
  });

  describe("JobRunner error handling", () => {
    it("returns success: false when machine fails to load G-code", async () => {
      const machine: MachineAdapter = {
        id: "dev-error",
        type: "fdm" as const,
        source: makeSource(),
        getStatus: vi.fn().mockResolvedValue("idle"),
        getProgress: vi.fn().mockResolvedValue(0),
        execute: vi.fn().mockResolvedValue({ success: false, message: "Load failed" }),
        onEvidence: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
      };

      const runner = new JobRunner(machine, [], null, emitter);

      const result = await runner.run({
        jobId: "job-load-fail",
        stepId: "step-1",
        gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
        assuranceTier: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to load G-code");
    });
  });
});
