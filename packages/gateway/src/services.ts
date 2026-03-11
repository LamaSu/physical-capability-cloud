/**
 * Shared service singletons for gateway routes.
 *
 * These instances are created once and shared across all route handlers.
 * In production these would be constructed with real kernel connections;
 * here they start with demo seed data.
 */

import { SensorPipeline, BatchTracker, EncryptionService } from "@pcc/kernel";
import { CommitmentService, NoirProofService } from "@pcc/verifier";
import type { SensorChannelDescriptor } from "@pcc/spec";
import { streamHub } from "./sse/stream-hub.js";

// ── Sensor Pipeline ─────────────────────────────────────────────────

export const sensorPipeline = new SensorPipeline({ bufferCapacity: 2000 });

const defaultChannels: SensorChannelDescriptor[] = [
  {
    channel: "nozzle_temp",
    label: "Nozzle Temperature",
    dataType: "scalar",
    unit: "degC",
    sampleRateHz: 1,
    range: { min: 150, max: 280 },
    resolution: 0.1,
    retentionPolicy: "downsample_1s",
    evidenceGrade: true,
  },
  {
    channel: "bed_temp",
    label: "Bed Temperature",
    dataType: "scalar",
    unit: "degC",
    sampleRateHz: 0.5,
    range: { min: 20, max: 120 },
    resolution: 0.1,
    retentionPolicy: "downsample_10s",
    evidenceGrade: true,
  },
  {
    channel: "power_draw",
    label: "Power Draw",
    dataType: "scalar",
    unit: "W",
    sampleRateHz: 2,
    range: { min: 0, max: 500 },
    resolution: 1,
    retentionPolicy: "full",
    evidenceGrade: true,
  },
  {
    channel: "uv_absorbance",
    label: "UV Absorbance (254nm)",
    dataType: "scalar",
    unit: "mAU",
    sampleRateHz: 10,
    range: { min: -50, max: 2000 },
    resolution: 0.01,
    retentionPolicy: "full",
    evidenceGrade: true,
  },
  {
    channel: "column_pressure",
    label: "Column Pressure",
    dataType: "scalar",
    unit: "bar",
    sampleRateHz: 1,
    range: { min: 0, max: 400 },
    resolution: 0.1,
    retentionPolicy: "downsample_1s",
    evidenceGrade: true,
  },
];

for (const ch of defaultChannels) {
  sensorPipeline.registerChannel(ch);
}

// Forward sensor readings to StreamHub
sensorPipeline.onReading((reading) => {
  const topics: import("@pcc/spec").StreamTopic[] = [
    { type: "kernel", id: reading.kernelId },
    { type: "device", id: reading.deviceId },
  ];
  if (reading.jobId) topics.push({ type: "job", id: reading.jobId });
  if (reading.batchId) topics.push({ type: "batch", id: reading.batchId });

  streamHub.publish(topics, {
    id: reading.id,
    type: "sensor_reading",
    timestamp: reading.timestamp,
    topic: topics[0],
    payload: reading,
  });
});

sensorPipeline.onAnomaly((anomaly) => {
  streamHub.publish(
    [{ type: "kernel", id: anomaly.kernelId }, { type: "device", id: anomaly.deviceId }],
    {
      id: anomaly.id,
      type: "sensor_anomaly",
      timestamp: anomaly.timestamp,
      topic: { type: "kernel", id: anomaly.kernelId },
      payload: anomaly,
    },
  );
});

// ── Batch Tracker ───────────────────────────────────────────────────

export const batchTracker = new BatchTracker();

// Forward batch events to StreamHub
batchTracker.onBatchEvent((event) => {
  streamHub.publish(
    [{ type: "batch", id: event.batchId }],
    {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      topic: { type: "batch", id: event.batchId },
      payload: event,
    },
  );
});

// Seed demo batch
const demoBatch = batchTracker.createBatch("kernel-sf", "dev-hplc-01", "cap-hplc", {
  method: "HPLC_RP_C18_gradient_30min",
  columnTemp: 25,
});
batchTracker.addSample(demoBatch.id, {
  position: "A1",
  jobId: "job-010",
  stepId: "step-1",
  userId: "0x1234567890abcdef1234567890abcdef12345678",
  sampleLabel: "Sample Alpha",
  sampleType: "sample",
});
batchTracker.addSample(demoBatch.id, {
  position: "A2",
  jobId: "job-011",
  stepId: "step-1",
  userId: "0xabcdef1234567890abcdef1234567890abcdef12",
  sampleLabel: "Sample Beta",
  sampleType: "sample",
});
batchTracker.addSample(demoBatch.id, {
  position: "A3",
  jobId: "job-012",
  stepId: "step-1",
  userId: "0x9876543210fedcba9876543210fedcba98765432",
  sampleLabel: "Sample Gamma",
  sampleType: "sample",
});
batchTracker.seal(demoBatch.id);
batchTracker.start(demoBatch.id);
// Complete first slot
const firstSlot = batchTracker.getBatch(demoBatch.id)!.slots[0];
batchTracker.updateSlotStatus(demoBatch.id, firstSlot.id, "acquiring");
batchTracker.completeSlot(demoBatch.id, firstSlot.id, "sha256:abc123def456" as any, "results/batch/A1.json");
// Second slot acquiring
const secondSlot = batchTracker.getBatch(demoBatch.id)!.slots[1];
batchTracker.updateSlotStatus(demoBatch.id, secondSlot.id, "acquiring");

// ── Encryption Service ──────────────────────────────────────────────

export const encryptionService = new EncryptionService();

// ── ZK Services ─────────────────────────────────────────────────────

export const commitmentService = new CommitmentService();
export const zkProofService = new NoirProofService();
