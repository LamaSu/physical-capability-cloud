import type { StoreDB } from "../connection.js";
import {
  sensorChannelDescriptors,
  sensorAggregates,
  sensorAnomalies,
} from "../schema/index.js";

/**
 * Seeds sensor data: channel descriptors, aggregates, and anomalies.
 * Uses biolab kernel devices (HPLC, centrifuge) and NYC FDM printer.
 */
export function seedSensors(db: StoreDB): void {
  // ── Sensor Channel Descriptors ────────────────────────────────────

  db.insert(sensorChannelDescriptors)
    .values([
      {
        id: "sch_nozzle_temp",
        channel: "nozzle_temp",
        kernelId: "kernel-nyc",
        deviceId: "dev-fdm-prusa-mk4",
        label: "Nozzle Temperature",
        dataType: "number",
        unit: "degC",
        sampleRateHz: 1.0,
        range: { min: 0, max: 300 },
        resolution: 0.1,
        retentionPolicy: "full",
        evidenceGrade: true,
      },
      {
        id: "sch_bed_temp",
        channel: "bed_temp",
        kernelId: "kernel-nyc",
        deviceId: "dev-fdm-prusa-mk4",
        label: "Bed Temperature",
        dataType: "number",
        unit: "degC",
        sampleRateHz: 0.5,
        range: { min: 0, max: 120 },
        resolution: 0.1,
        retentionPolicy: "downsample_1s",
        evidenceGrade: true,
      },
      {
        id: "sch_uv_absorbance",
        channel: "uv_absorbance",
        kernelId: "kernel-biolab-01",
        deviceId: "dev-hplc",
        label: "UV Absorbance (280nm)",
        dataType: "number",
        unit: "AU",
        sampleRateHz: 10.0,
        range: { min: -0.01, max: 4.0 },
        resolution: 0.001,
        retentionPolicy: "full",
        evidenceGrade: true,
      },
      {
        id: "sch_column_pressure",
        channel: "column_pressure",
        kernelId: "kernel-biolab-01",
        deviceId: "dev-hplc",
        label: "Column Back-Pressure",
        dataType: "number",
        unit: "bar",
        sampleRateHz: 2.0,
        range: { min: 0, max: 600 },
        resolution: 0.5,
        retentionPolicy: "downsample_1s",
        evidenceGrade: false,
      },
    ])
    .run();

  // ── Sensor Aggregates ─────────────────────────────────────────────

  db.insert(sensorAggregates)
    .values([
      {
        id: "sagg_nozzle_001",
        channel: "nozzle_temp",
        kernelId: "kernel-nyc",
        deviceId: "dev-fdm-prusa-mk4",
        windowStart: "2026-03-10T08:00:00Z",
        windowEnd: "2026-03-10T08:05:00Z",
        count: 300,
        min: 209.3,
        max: 211.7,
        mean: 210.5,
        stddev: 0.42,
        unit: "degC",
        jobId: "job-001",
      },
      {
        id: "sagg_bed_001",
        channel: "bed_temp",
        kernelId: "kernel-nyc",
        deviceId: "dev-fdm-prusa-mk4",
        windowStart: "2026-03-10T08:00:00Z",
        windowEnd: "2026-03-10T08:05:00Z",
        count: 150,
        min: 59.8,
        max: 60.3,
        mean: 60.0,
        stddev: 0.11,
        unit: "degC",
        jobId: "job-001",
      },
      {
        id: "sagg_uv_001",
        channel: "uv_absorbance",
        kernelId: "kernel-biolab-01",
        deviceId: "dev-hplc",
        windowStart: "2026-03-10T08:30:00Z",
        windowEnd: "2026-03-10T08:35:00Z",
        count: 3000,
        min: 0.002,
        max: 1.842,
        mean: 0.345,
        stddev: 0.51,
        unit: "AU",
        jobId: "job-bio-42",
      },
    ])
    .run();

  // ── Sensor Anomalies ──────────────────────────────────────────────

  db.insert(sensorAnomalies)
    .values([
      {
        id: "sanom_001",
        timestamp: "2026-03-10T08:42:17Z",
        kernelId: "kernel-nyc",
        deviceId: "dev-fdm-prusa-mk4",
        channel: "nozzle_temp",
        type: "threshold_exceeded",
        severity: "warning",
        value: 218.4,
        threshold: 215.0,
        message: "Nozzle temperature exceeded upper threshold (215C) during layer 47. Possible partial clog.",
        jobId: "job-001",
      },
      {
        id: "sanom_002",
        timestamp: "2026-03-10T08:51:03Z",
        kernelId: "kernel-biolab-01",
        deviceId: "dev-hplc",
        channel: "column_pressure",
        type: "rate_of_change",
        severity: "info",
        value: 245.0,
        threshold: 200.0,
        message: "Column pressure rising faster than expected. Monitor for column degradation.",
        jobId: "job-bio-42",
      },
    ])
    .run();
}
