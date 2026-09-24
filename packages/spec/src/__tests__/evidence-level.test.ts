import { describe, it, expect } from "vitest";
import {
  DEVICE_REPORTED_EVENT_TYPES,
  EVIDENCE_LEVELS,
  EXECUTION_EVENT_TYPES,
  INSPECTION_EVENT_TYPES,
  NO_OUTCOME_LEVEL_EVENT_TYPES,
  SUBMITTED_EVENT_TYPES,
  evidenceLevelOf,
  evidenceLevelOfBundle,
  evidenceLevelRank,
  executingDeviceIds,
  meetsEvidenceLevel,
  type EvidenceLevel,
} from "../evidence/evidence-level.js";
import { EVIDENCE_EVENT_TYPES, type EvidenceEvent, type EvidenceEventType } from "../types/evidence.js";

const KERNEL = "kernel-print-1";
const PRINTER = "printer-hp-1";
const CAMERA = "camera-inspect-1";

let seq = 0;
function ev(
  type: EvidenceEventType,
  deviceId: string | undefined,
  payload: Record<string, unknown> = {},
  extraSource: Record<string, unknown> = {},
): EvidenceEvent {
  seq += 1;
  return {
    id: `ev-${seq}`,
    type,
    timestamp: "2026-09-24T12:00:00.000Z",
    source: {
      ...(deviceId !== undefined ? { deviceId } : {}),
      deviceType: "controller",
      kernelId: KERNEL,
      ...extraSource,
    } as EvidenceEvent["source"],
    payload,
    hash: `sha256:${"0".repeat(64)}` as EvidenceEvent["hash"],
  };
}

describe("evidence levels — order", () => {
  it("is submitted < device_reported < inspected_output", () => {
    expect(EVIDENCE_LEVELS).toEqual(["submitted", "device_reported", "inspected_output"]);
    expect(evidenceLevelRank("submitted")).toBeLessThan(evidenceLevelRank("device_reported"));
    expect(evidenceLevelRank("device_reported")).toBeLessThan(evidenceLevelRank("inspected_output"));
  });

  it("a stronger level meets a weaker requirement, never the reverse, and null meets nothing", () => {
    const cases: Array<[EvidenceLevel | null, EvidenceLevel, boolean]> = [
      ["inspected_output", "device_reported", true],
      ["device_reported", "device_reported", true],
      ["device_reported", "inspected_output", false],
      ["submitted", "device_reported", false],
      [null, "submitted", false],
    ];
    for (const [reached, required, expected] of cases) {
      expect(meetsEvidenceLevel(reached, required), `${reached} vs ${required}`).toBe(expected);
    }
  });
});

describe("evidence levels — every event type is ruled on exactly once", () => {
  const ruled = [
    ...SUBMITTED_EVENT_TYPES,
    ...DEVICE_REPORTED_EVENT_TYPES,
    ...INSPECTION_EVENT_TYPES,
    ...NO_OUTCOME_LEVEL_EVENT_TYPES,
  ];

  it("covers the whole closed vocabulary, so a new type needs a ruling", () => {
    expect([...ruled].sort()).toEqual([...EVIDENCE_EVENT_TYPES].sort());
  });

  it("puts no type in two classes", () => {
    expect(new Set(ruled).size).toBe(ruled.length);
  });

  it("lists only vocabulary members as execution events", () => {
    for (const t of EXECUTION_EVENT_TYPES) expect(EVIDENCE_EVENT_TYPES).toContain(t);
  });
});

describe("evidence levels — the pcc-node shapes (PR #343)", () => {
  it("an accepted-only job is submitted, never device_reported", () => {
    const events = [
      ev("execution_started", PRINTER),
      ev("execution_progress", PRINTER, { level: "submitted", result: { submitted: true } }),
    ];
    expect(evidenceLevelOfBundle(events)).toBe("submitted");
    expect(meetsEvidenceLevel(evidenceLevelOfBundle(events), "device_reported")).toBe(false);
  });

  it("a device-reported completion is device_reported", () => {
    const events = [ev("execution_started", PRINTER), ev("execution_completed", PRINTER)];
    expect(evidenceLevelOfBundle(events)).toBe("device_reported");
  });

  it("a failed job proves no level", () => {
    expect(evidenceLevelOfBundle([ev("execution_started", PRINTER), ev("execution_failed", PRINTER)])).toBeNull();
  });
});

describe("evidence levels — inspection needs an independent observer", () => {
  it("a camera that did not execute the job inspects the output", () => {
    const events = [
      ev("execution_started", PRINTER),
      ev("execution_completed", PRINTER),
      ev("cv_inspection_result", CAMERA, { passed: true }),
    ];
    expect(evidenceLevelOfBundle(events)).toBe("inspected_output");
  });

  it("the executing device measuring its own output is only reporting", () => {
    const events = [
      ev("execution_completed", PRINTER),
      ev("cv_inspection_result", PRINTER, { passed: true }),
    ];
    expect(evidenceLevelOfBundle(events)).toBe("device_reported");
  });

  it("an instrument reporting its own run is device_reported; another instrument's measurement is inspected_output", () => {
    const own = [ev("method_loaded", "reader-1"), ev("instrument_result", "reader-1", { od600: 0.42 })];
    expect(evidenceLevelOfBundle(own)).toBe("device_reported");
    const independent = [...own, ev("instrument_result", "reader-2", { od600: 0.41 })];
    expect(evidenceLevelOfBundle(independent)).toBe("inspected_output");
  });

  it("an inspection with no executing device named cannot show independence", () => {
    expect(evidenceLevelOfBundle([ev("photo_comparison_result", CAMERA, { match: true })])).toBe(
      "device_reported",
    );
  });

  it("a failed inspection is still inspected_output evidence (the level is strength, not verdict)", () => {
    const events = [ev("execution_completed", PRINTER), ev("cv_inspection_result", CAMERA, { passed: false })];
    expect(evidenceLevelOfBundle(events)).toBe("inspected_output");
  });

  it("judges independence against every executing device in the events passed", () => {
    // Two bundles for one job: the printer's and the camera's.
    const printerBundle = [ev("execution_completed", PRINTER)];
    const cameraBundle = [ev("cv_inspection_result", CAMERA, { passed: true })];
    expect(evidenceLevelOfBundle(cameraBundle)).toBe("device_reported");
    expect(evidenceLevelOfBundle([...printerBundle, ...cameraBundle])).toBe("inspected_output");
  });
});

describe("evidence levels — fail closed", () => {
  it("fabricated events prove no level, by source.simulated or payload.mock", () => {
    const simulatedCamera = ev("cv_inspection_result", CAMERA, { passed: true }, { simulated: true });
    const mockCompletion = ev("execution_completed", PRINTER, { mock: true });
    expect(evidenceLevelOfBundle([mockCompletion, simulatedCamera])).toBeNull();
    expect(
      evidenceLevelOfBundle([ev("execution_completed", PRINTER), simulatedCamera]),
    ).toBe("device_reported");
  });

  it("a fabricated execution event does not make an inspection look independent", () => {
    const fakeExecutor = ev("execution_completed", "printer-ghost", { mock: true });
    const cameraOnly = ev("cv_inspection_result", CAMERA, { passed: true });
    expect(executingDeviceIds([fakeExecutor, cameraOnly]).size).toBe(0);
    expect(evidenceLevelOfBundle([fakeExecutor, cameraOnly])).toBe("device_reported");
  });

  it("an event with no device attribution proves no level", () => {
    for (const deviceId of [undefined, ""]) {
      expect(evidenceLevelOf(ev("execution_completed", deviceId), new Set([PRINTER]))).toBeNull();
    }
  });

  it("printer_job_verified (a log-stream summary with no success field) proves no level", () => {
    const events = [
      ev("printer_log_captured", PRINTER),
      ev("printer_job_verified", PRINTER, { chainLength: 12, summary: "completed with 12 log entries" }),
    ];
    expect(evidenceLevelOfBundle(events)).toBeNull();
  });

  it("telemetry and raw captures alone prove no level", () => {
    const events = [
      ev("power_profile_summary", PRINTER),
      ev("temperature_log", PRINTER),
      ev("camera_snapshot", CAMERA),
      ev("photo_captured", CAMERA),
      ev("log_hash_chain_entry", PRINTER),
    ];
    expect(evidenceLevelOfBundle(events)).toBeNull();
  });

  it("an empty bundle proves no level", () => {
    expect(evidenceLevelOfBundle([])).toBeNull();
  });
});
