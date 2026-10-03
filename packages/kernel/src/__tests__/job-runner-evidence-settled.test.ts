/**
 * JobRunner records every evidence event an adapter emits before the tier
 * check runs, and before the bundle is finalized.
 *
 * Found during LO-SE-1 round 2 (implementer report, 10/03): handleEvidence
 * called evidenceEmitter.addEvent without awaiting it, and addEvent hashes the
 * event asynchronously (crypto.subtle) before storing it. So an event emitted
 * just before step 8, such as step 7's cv_inspection_result, could be missing
 * from the tier check and from the signed bundle. The existing tests hid this
 * with a 50 ms pause inside load_gcode.
 */

import { describe, it, expect, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource, SHA256 } from "@pcc/spec";

import type { CameraAdapter, MachineAdapter } from "../adapters/types.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";
import { lose1Capture } from "./lose1-capture-fixture.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

type Emitted = Omit<EvidenceEvent, "id" | "hash">;
const KERNEL_ID = "kernel-settled-test";
const source = (deviceId: string, deviceType: EvidenceSource["deviceType"]): EvidenceSource => ({ deviceId, deviceType, kernelId: KERNEL_ID });

/** A machine that emits the Tier 1 events during load_gcode, WITHOUT pausing for them to be recorded. */
function machine(events: Emitted[]): MachineAdapter {
  const listeners: Array<(e: Emitted) => void> = [];
  return {
    id: "machine-settled",
    type: "fdm" as const,
    source: source("machine-settled", "controller"),
    getStatus: async () => "idle",
    getProgress: async () => 100,
    execute: async (cmd: { type: string }) => {
      if (cmd.type === "load_gcode") for (const e of events) for (const cb of listeners) cb(e);
      return { success: true, message: "ok" };
    },
    onEvidence: (cb) => {
      listeners.push(cb);
    },
    // It emits only inside load_gcode: nothing is left once a command returns.
    quiesceEvidence: async () => {},
    dispose: async () => {},
  } as MachineAdapter;
}

/** A camera that emits its inspection event at step 7, the step right before the tier check. */
function lateCamera(): CameraAdapter & { emitted: Emitted[] } {
  const listeners: Array<(e: Emitted) => void> = [];
  const emitted: Emitted[] = [];
  const src = source("camera-settled", "camera");
  return {
    id: "camera-settled",
    source: src,
    emitted,
    async captureSnapshot() {
      return { imageHash: "sha256:none", storageRef: "none" };
    },
    async runInspection(_referenceHash?: string, context?: { jobId?: string }) {
      // A complete LO-SE-1 capture for the job it was asked for: since #489 only one counts.
      const event = lose1Capture("cv_inspection_result", src.deviceId, src.kernelId, String(context?.jobId)) as Emitted;
      emitted.push(event);
      for (const cb of listeners) cb(event);
      return { passed: true, confidence: 100, findings: [], imageHash: "sha256:none" };
    },
    onEvidence: (cb) => {
      listeners.push(cb);
    },
    // It emits only inside runInspection: nothing is left once that returns.
    quiesceEvidence: async () => {},
    dispose: async () => {},
  };
}

const at = () => new Date().toISOString();
const TIER1: Emitted[] = [
  { type: "gcode_hash_verified", timestamp: at(), source: source("machine-settled", "controller"), payload: { gcodeHash: "sha256:00" } },
  { type: "execution_completed", timestamp: at(), source: source("machine-settled", "controller"), payload: { durationMs: 1 } },
  { type: "power_profile_summary", timestamp: at(), source: source("machine-settled", "power_monitor"), payload: { avgWatts: 90 } },
];

describe("JobRunner: every emitted event is recorded before the tier check and the bundle", () => {
  it("an inspection emitted at step 7 reaches the tier check and the finalized bundle", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const camera = lateCamera();
    let bundleEvents: string[] = [];
    emitter.onBundle((bundle) => {
      bundleEvents = bundle.events.map((e) => e.type);
    });
    const result = await new JobRunner(machine(TIER1), [], camera, emitter).run({
      jobId: "job-settled-1",
      stepId: "step-1",
      gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
      assuranceTier: 2,
    });
    expect(camera.emitted).toHaveLength(1);
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(bundleEvents).toContain("cv_inspection_result");
  });

  it("the machine's Tier 1 events count without any pause after they are emitted", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    let bundleEvents: string[] = [];
    emitter.onBundle((bundle) => {
      bundleEvents = bundle.events.map((e) => e.type);
    });
    const result = await new JobRunner(machine(TIER1), [], null, emitter).run({
      jobId: "job-settled-2",
      stepId: "step-1",
      gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
      assuranceTier: 1,
    });
    expect(result.success).toBe(true);
    expect(bundleEvents).toEqual(["gcode_hash_verified", "execution_completed", "power_profile_summary"]);
  });
});
