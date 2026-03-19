import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SiLAAdapter } from "../sila-adapter.js";
import type { EvidenceEvent } from "@pcc/spec";
import type { AssayRunConfig, LiquidHandlingEvent } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeAdapter(overrides: Partial<{ deviceId: string; kernelId: string; mock: boolean }> = {}) {
  return new SiLAAdapter({
    deviceId: overrides.deviceId ?? "hamilton-star-01",
    kernelId: overrides.kernelId ?? "kernel-lab-001",
    mock: overrides.mock ?? true,
  });
}

function make96WellConfig(overrides: Partial<AssayRunConfig> = {}): AssayRunConfig {
  return {
    assayName: "ELISA-IgG",
    protocolId: "proto-elisa-001",
    plateFormat: 96,
    sampleCount: 48,
    replicates: 2,
    qcCriteria: { maxCV: 10, minR2: 0.9, minZPrime: 0.4 },
    ...overrides,
  };
}

function make384WellConfig(overrides: Partial<AssayRunConfig> = {}): AssayRunConfig {
  return {
    assayName: "HTS-Compound-Screen",
    protocolId: "proto-hts-001",
    plateFormat: 384,
    sampleCount: 192,
    replicates: 2,
    qcCriteria: { maxCV: 15, minR2: 0.85, minZPrime: 0.3 },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SiLAAdapter", () => {
  let adapter: SiLAAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  afterEach(async () => {
    await adapter.dispose();
  });

  // ── Construction / Status ────────────────────────────────────────

  it("creates a device with correct config", async () => {
    const device = await adapter.getStatus();
    expect(device.id).toBe("hamilton-star-01");
    expect(device.type).toBe("liquid_handler");
    expect(device.status).toBe("idle");
    expect(device.features.length).toBeGreaterThan(0);
    expect(device.silaServerUrl).toBeDefined();
  });

  it("returns device info with firmware and serial", async () => {
    const device = await adapter.getStatus();
    expect(device.firmwareVersion).toBe("SiLA2-Adapter-1.0.0");
    expect(device.serialNumber).toBeDefined();
    expect(device.name).toBe("hamilton-star-01");
  });

  it("has correct evidence source metadata", () => {
    expect(adapter.source.deviceId).toBe("hamilton-star-01");
    expect(adapter.source.deviceType).toBe("instrument");
    expect(adapter.source.kernelId).toBe("kernel-lab-001");
  });

  // ── Capabilities ─────────────────────────────────────────────────

  it("returns correct capability types", async () => {
    const caps = await adapter.getCapabilities();
    expect(caps.length).toBeGreaterThanOrEqual(3);

    const types = caps.map(c => c.capabilityType);
    expect(types).toContain("elisa_plate_setup");
    expect(types).toContain("serial_dilution");
    expect(types).toContain("cherry_picking");
  });

  it("capabilities include volume ranges and precision", async () => {
    const caps = await adapter.getCapabilities();
    for (const cap of caps) {
      expect(cap.volumeRange.min_uL).toBeGreaterThan(0);
      expect(cap.volumeRange.max_uL).toBeGreaterThan(cap.volumeRange.min_uL);
      expect(cap.precision_cv).toBeGreaterThan(0);
      expect(cap.precision_cv).toBeLessThan(10);
      expect(cap.plateFormats.length).toBeGreaterThan(0);
      expect(cap.compliance.length).toBeGreaterThan(0);
      expect(cap.instrument).toBe("hamilton-star-01");
    }
  });

  // ── 96-well Assay ────────────────────────────────────────────────

  it("executeAssay produces events for every well (96-well)", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    const config = make96WellConfig();
    const result = await adapter.executeAssay(config);

    expect(result.runId).toBeDefined();
    expect(result.assayName).toBe("ELISA-IgG");
    expect(result.completedAt).toBeDefined();
    expect(result.errors).toHaveLength(0);

    // We expect at least 1 start + 1 completion + instrument events
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it("96-well plate generates 192+ liquid handling events", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    const config = make96WellConfig();
    const result = await adapter.executeAssay(config);

    // 48 samples * 2 replicates = 96 wells, each with aspirate + dispense = 192 events
    expect(result.totalEvents).toBeGreaterThanOrEqual(192);

    // Filter instrument_result events
    const instrumentEvents = events.filter(e => e.type === "instrument_result");
    expect(instrumentEvents.length).toBeGreaterThanOrEqual(192);
  });

  it("events include volume, pressure, channel, and well position", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    await adapter.executeAssay(make96WellConfig());

    const instrumentEvents = events.filter(e => e.type === "instrument_result");
    expect(instrumentEvents.length).toBeGreaterThan(0);

    const first = instrumentEvents[0]!.payload;
    expect(first.volume_uL).toBeDefined();
    expect(typeof first.volume_uL).toBe("number");
    expect(first.pressure_kPa).toBeDefined();
    expect(typeof first.pressure_kPa).toBe("number");
    expect(first.channel).toBeDefined();
    expect(typeof first.channel).toBe("number");
    expect(first.well).toBeDefined();
    expect(typeof first.well).toBe("string");
  });

  it("assay result includes QC metrics (CV%, R-squared, Z-prime)", async () => {
    const result = await adapter.executeAssay(make96WellConfig());

    expect(result.qcMetrics).toBeDefined();
    expect(typeof result.qcMetrics.cv_percent).toBe("number");
    expect(typeof result.qcMetrics.r_squared).toBe("number");
    expect(typeof result.qcMetrics.z_prime).toBe("number");

    // QC metric value ranges
    expect(result.qcMetrics.cv_percent).toBeGreaterThanOrEqual(2);
    expect(result.qcMetrics.cv_percent).toBeLessThanOrEqual(8);
    expect(result.qcMetrics.r_squared).toBeGreaterThanOrEqual(0.95);
    expect(result.qcMetrics.r_squared).toBeLessThanOrEqual(1.0);
    expect(result.qcMetrics.z_prime).toBeGreaterThanOrEqual(0.5);
    expect(result.qcMetrics.z_prime).toBeLessThanOrEqual(0.9);
  });

  // ── 384-well Assay ───────────────────────────────────────────────

  it("384-well plate produces more events than 96-well", async () => {
    const events96: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    const adapter96 = makeAdapter({ deviceId: "dev-96" });
    adapter96.onEvidence(ev => events96.push(ev));

    const events384: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    const adapter384 = makeAdapter({ deviceId: "dev-384" });
    adapter384.onEvidence(ev => events384.push(ev));

    const result96 = await adapter96.executeAssay(make96WellConfig());
    const result384 = await adapter384.executeAssay(make384WellConfig());

    expect(result384.totalEvents).toBeGreaterThan(result96.totalEvents);

    await adapter96.dispose();
    await adapter384.dispose();
  });

  it("different plate formats produce different well positions", async () => {
    const events384: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    const a384 = makeAdapter({ deviceId: "dev-384b" });
    a384.onEvidence(ev => events384.push(ev));

    await a384.executeAssay(make384WellConfig());

    // 384-well has 24 columns, so some wells should have column > 12
    const wells = events384
      .filter(e => e.type === "instrument_result")
      .map(e => e.payload.well as string);

    // Extract column numbers from well positions
    const colNumbers = wells.map(w => parseInt(w.replace(/^[A-Z]+/, ""), 10));
    const maxCol = Math.max(...colNumbers);
    expect(maxCol).toBeGreaterThan(12); // 384-well has 24 columns

    await a384.dispose();
  });

  // ── Calibration ──────────────────────────────────────────────────

  it("calibration evidence includes gravimetric data", async () => {
    const events = await adapter.collectCalibrationEvidence();

    expect(events.length).toBe(8); // 8 channels

    for (const event of events) {
      expect(event.type).toBe("calibration_record");
      expect(event.source.deviceId).toBe("hamilton-star-01");

      const p = event.payload;
      expect(p.channel).toBeDefined();
      expect(typeof p.targetVolume_uL).toBe("number");
      expect(typeof p.measuredWeight_mg).toBe("number");
      expect(typeof p.measuredVolume_uL).toBe("number");
      expect(typeof p.error_percent).toBe("number");
      expect(typeof p.temperature_C).toBe("number");
      expect(typeof p.replicates).toBe("number");
      expect(typeof p.passed).toBe("boolean");
    }
  });

  it("calibration events are also emitted to evidence listeners", async () => {
    const listenerEvents: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => listenerEvents.push(ev));

    await adapter.collectCalibrationEvidence();

    // 1 start event + 8 channel events
    const calibEvents = listenerEvents.filter(e => e.type === "calibration_record");
    expect(calibEvents.length).toBeGreaterThanOrEqual(8);
  });

  // ── Failed Assay ─────────────────────────────────────────────────

  it("failed assay produces error events", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    const result = await adapter.executeFailingAssay(make96WellConfig());

    expect(result.passedQC).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Liquid level detection failure");

    const errorEvents = events.filter(e => e.type === "execution_failed");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]!.payload.error).toContain("Liquid level detection failure");
  });

  it("failed assay sets device status to error", async () => {
    await adapter.executeFailingAssay(make96WellConfig());
    const device = await adapter.getStatus();
    expect(device.status).toBe("error");
  });

  // ── Evidence event ordering ──────────────────────────────────────

  it("evidence events are timestamped in order", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    await adapter.executeAssay(make96WellConfig());

    // All timestamps should be in non-decreasing order
    for (let i = 1; i < events.length; i++) {
      const prev = new Date(events[i - 1]!.timestamp).getTime();
      const curr = new Date(events[i]!.timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  // ── Volume precision ─────────────────────────────────────────────

  it("volume precision is within mock CV spec (~2%)", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    await adapter.executeAssay(make96WellConfig());

    const volumes = events
      .filter(e => e.type === "instrument_result")
      .map(e => e.payload.volume_uL as number)
      .filter(v => v > 0);

    expect(volumes.length).toBeGreaterThan(0);

    // All volumes should be in a reasonable range (target is ~100-150 uL)
    for (const v of volumes) {
      expect(v).toBeGreaterThan(50);  // not wildly off
      expect(v).toBeLessThan(250);    // not wildly off
    }

    // Compute CV of volumes
    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const variance = volumes.reduce((a, v) => a + (v - mean) ** 2, 0) / volumes.length;
    const cv = (Math.sqrt(variance) / mean) * 100;

    // Mock CV is ~2% plus random target variation, so overall CV < 30%
    expect(cv).toBeLessThan(30);
  });

  // ── Dispose / cleanup ────────────────────────────────────────────

  it("throws after dispose", async () => {
    await adapter.dispose();
    await expect(adapter.executeAssay(make96WellConfig()))
      .rejects.toThrow("disposed");
  });

  it("dispose sets status to offline", async () => {
    await adapter.dispose();
    const device = await adapter.getStatus();
    expect(device.status).toBe("offline");
  });

  // ── Plate data ───────────────────────────────────────────────────

  it("plate data has entries for each processed well", async () => {
    const result = await adapter.executeAssay(make96WellConfig());

    const wellCount = Object.keys(result.plateData).length;
    // 48 samples * 2 replicates = 96 wells
    expect(wellCount).toBe(96);

    // All values should be positive numbers
    for (const [well, value] of Object.entries(result.plateData)) {
      expect(well).toMatch(/^[A-Z]\d+$/);
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  // ── Execution lifecycle events ───────────────────────────────────

  it("emits execution_started and execution_completed events", async () => {
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence(ev => events.push(ev));

    await adapter.executeAssay(make96WellConfig());

    const starts = events.filter(e => e.type === "execution_started");
    const completions = events.filter(e => e.type === "execution_completed");

    expect(starts.length).toBe(1);
    expect(completions.length).toBe(1);

    expect(starts[0]!.payload.assayName).toBe("ELISA-IgG");
    expect(completions[0]!.payload.passedQC).toBeDefined();
    expect(completions[0]!.payload.qcMetrics).toBeDefined();
  });
});
