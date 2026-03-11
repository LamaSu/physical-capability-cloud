/**
 * Mock data generators for SSE streaming.
 *
 * Each generator produces realistic data conforming to @pcc/spec types.
 * Used by producers to populate StreamHub topics during development.
 */

import type {
  SensorReading,
  SensorChannelDescriptor,
  SensorAnomaly,
  BatchEvent,
  ProcessLogEntry,
  PhysicalUnit,
  SensorDataType,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

// ── Constants ────────────────────────────────────────────────────

const KERNEL_ID = "kernel-nyc";
const DEVICE_IDS = ["dev-fdm-001", "dev-hplc-002", "dev-cnc-003"];
const JOB_IDS = ["job-001", "job-002", "job-003"];
const BATCH_ID = "batch-001";

// ── Channel Descriptors ──────────────────────────────────────────

export const MOCK_CHANNEL_DESCRIPTORS: SensorChannelDescriptor[] = [
  {
    channel: "nozzle_temp",
    label: "Nozzle Temperature",
    dataType: "scalar",
    unit: "degC",
    sampleRateHz: 1,
    range: { min: 180, max: 260 },
    retentionPolicy: "full",
    evidenceGrade: true,
  },
  {
    channel: "bed_temp",
    label: "Bed Temperature",
    dataType: "scalar",
    unit: "degC",
    sampleRateHz: 1,
    range: { min: 40, max: 110 },
    retentionPolicy: "full",
    evidenceGrade: true,
  },
  {
    channel: "chamber_pressure",
    label: "Chamber Pressure",
    dataType: "scalar",
    unit: "kPa",
    sampleRateHz: 0.5,
    range: { min: 95, max: 115 },
    retentionPolicy: "downsample_1s",
    evidenceGrade: false,
  },
  {
    channel: "power_draw",
    label: "Power Draw",
    dataType: "scalar",
    unit: "W",
    sampleRateHz: 2,
    range: { min: 0, max: 500 },
    retentionPolicy: "downsample_10s",
    evidenceGrade: true,
  },
  {
    channel: "vibration_x",
    label: "Vibration X-Axis",
    dataType: "scalar",
    unit: "m/s2",
    sampleRateHz: 5,
    range: { min: 0, max: 20 },
    retentionPolicy: "downsample_1s",
    evidenceGrade: false,
  },
  {
    channel: "uv_absorbance",
    label: "UV Absorbance (254nm)",
    dataType: "scalar",
    unit: "mAU",
    sampleRateHz: 10,
    range: { min: -5, max: 2000 },
    retentionPolicy: "full",
    evidenceGrade: true,
  },
];

// ── Sensor Reading Generator ─────────────────────────────────────

/** Internal tick counter for waveform generation */
let sensorTick = 0;

/** Generate a single sensor reading for a given channel */
export function generateSensorReading(channel: string): SensorReading {
  sensorTick++;
  const now = new Date().toISOString();
  const desc = MOCK_CHANNEL_DESCRIPTORS.find((d) => d.channel === channel);
  const deviceId = DEVICE_IDS[0];

  let value: number;
  let unit: PhysicalUnit = desc?.unit ?? "degC";
  let dataType: SensorDataType = desc?.dataType ?? "scalar";

  switch (channel) {
    case "nozzle_temp":
      // Sine wave around 215 degC with small noise
      value = 215 + 5 * Math.sin(sensorTick * 0.05) + (Math.random() - 0.5) * 2;
      break;
    case "bed_temp":
      // Stable around 60 degC with drift
      value = 60 + 2 * Math.sin(sensorTick * 0.02) + (Math.random() - 0.5) * 0.5;
      break;
    case "chamber_pressure":
      // Slow ramp up then plateau
      value = 101.3 + 3 * Math.sin(sensorTick * 0.01) + (Math.random() - 0.5) * 0.8;
      break;
    case "power_draw":
      // Stepped pattern (layer changes) with noise
      value = 180 + 40 * Math.sin(sensorTick * 0.03) + (Math.random() - 0.5) * 15;
      break;
    case "vibration_x":
      // Spiky vibration with occasional peaks
      value = 2.5 + Math.abs(Math.sin(sensorTick * 0.15)) * 3 + (Math.random() - 0.5) * 1.5;
      if (sensorTick % 47 === 0) value += 8; // occasional spike
      break;
    case "uv_absorbance":
      // Chromatographic peak: Gaussian peaks at intervals
      {
        const peakCenter = 60;
        const period = 120;
        const phase = sensorTick % period;
        const gaussian = 800 * Math.exp(-0.5 * ((phase - peakCenter) / 8) ** 2);
        value = gaussian + 5 + (Math.random() - 0.5) * 3;
      }
      break;
    default:
      value = 50 + Math.random() * 10;
      break;
  }

  return {
    id: ids.reading(),
    timestamp: now,
    kernelId: KERNEL_ID,
    deviceId,
    channel,
    dataType,
    unit,
    value,
    quality: 0.95 + Math.random() * 0.05,
    jobId: JOB_IDS[sensorTick % JOB_IDS.length],
  };
}

/** Generate a sensor anomaly */
export function generateSensorAnomaly(channel: string): SensorAnomaly {
  const desc = MOCK_CHANNEL_DESCRIPTORS.find((d) => d.channel === channel);
  const types: SensorAnomaly["type"][] = ["threshold_exceeded", "rate_of_change", "flatline"];
  const severities: SensorAnomaly["severity"][] = ["info", "warning", "critical"];
  const selectedType = types[Math.floor(Math.random() * types.length)];
  const severity = severities[Math.floor(Math.random() * severities.length)];

  return {
    id: ids.anomaly(),
    timestamp: new Date().toISOString(),
    kernelId: KERNEL_ID,
    deviceId: DEVICE_IDS[0],
    channel,
    type: selectedType,
    severity,
    value: desc?.range ? desc.range.max + 10 : 999,
    threshold: desc?.range?.max ?? 100,
    message: `${channel} ${selectedType}: value exceeds safe operating range`,
  };
}

// ── Batch Event Generator ────────────────────────────────────────

const SLOT_POSITIONS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2"];
let batchSlotIndex = 0;
let batchPhase: "assembling" | "sealed" | "running" | "completing" = "assembling";
let batchSlotPhaseIndex = 0;

const BATCH_SLOT_STATUSES: Array<BatchEvent["type"]> = [
  "sample_injection_start",
  "sample_acquisition_start",
  "sample_result_available",
  "sample_completed",
];

/** Generate the next batch event in a realistic sequence */
export function generateBatchEvent(): BatchEvent {
  const now = new Date().toISOString();
  let type: BatchEvent["type"];
  let payload: Record<string, unknown> = {};
  let slotId: string | undefined;

  switch (batchPhase) {
    case "assembling":
      if (batchSlotIndex < SLOT_POSITIONS.length) {
        type = "sample_added";
        slotId = `samp_slot_${batchSlotIndex}`;
        payload = {
          position: SLOT_POSITIONS[batchSlotIndex],
          sampleLabel: `Sample-${SLOT_POSITIONS[batchSlotIndex]}`,
        };
        batchSlotIndex++;
      } else {
        type = "batch_sealed";
        payload = { slotCount: SLOT_POSITIONS.length };
        batchPhase = "sealed";
      }
      break;
    case "sealed":
      type = "batch_started";
      batchPhase = "running";
      batchSlotIndex = 0;
      batchSlotPhaseIndex = 0;
      break;
    case "running":
      slotId = `samp_slot_${batchSlotIndex}`;
      type = BATCH_SLOT_STATUSES[batchSlotPhaseIndex];
      payload = {
        position: SLOT_POSITIONS[batchSlotIndex],
        slotIndex: batchSlotIndex,
      };
      batchSlotPhaseIndex++;
      if (batchSlotPhaseIndex >= BATCH_SLOT_STATUSES.length) {
        batchSlotPhaseIndex = 0;
        batchSlotIndex++;
        if (batchSlotIndex >= SLOT_POSITIONS.length) {
          batchPhase = "completing";
        }
      }
      break;
    case "completing":
      type = "batch_completed";
      payload = {
        completed: SLOT_POSITIONS.length,
        failed: 0,
      };
      // Reset cycle
      batchPhase = "assembling";
      batchSlotIndex = 0;
      batchSlotPhaseIndex = 0;
      break;
  }

  return {
    id: ids.evidence(),
    batchId: BATCH_ID,
    timestamp: now,
    type,
    slotId,
    payload,
  };
}

/** Reset batch generator state (for clean restarts) */
export function resetBatchGenerator(): void {
  batchSlotIndex = 0;
  batchPhase = "assembling";
  batchSlotPhaseIndex = 0;
}

// ── Protocol Run Event Generator ─────────────────────────────────

const MOCK_RUN_ID = "prun-mock-001";
const MOCK_STEPS = ["prstep-prep", "prstep-print", "prstep-cure", "prstep-inspect"];
let protocolStepIndex = 0;
let protocolPhase: "starting" | "stepping" | "completing" = "starting";

export interface MockProtocolEvent {
  id: string;
  runId: string;
  timestamp: string;
  type: string;
  stepId?: string;
  transferId?: string;
  payload: Record<string, unknown>;
}

/** Generate the next protocol run event */
export function generateProtocolEvent(): MockProtocolEvent {
  const now = new Date().toISOString();
  let type: string;
  let stepId: string | undefined;
  let payload: Record<string, unknown> = {};

  switch (protocolPhase) {
    case "starting":
      type = "protocol_run_started";
      payload = { runId: MOCK_RUN_ID };
      protocolPhase = "stepping";
      protocolStepIndex = 0;
      break;
    case "stepping":
      stepId = MOCK_STEPS[protocolStepIndex];
      // Alternate between started and completed
      if (protocolStepIndex % 2 === 0 || protocolStepIndex >= MOCK_STEPS.length) {
        type = "protocol_step_started";
        payload = { stepId, action: `step_action_${protocolStepIndex}` };
      } else {
        type = "protocol_step_completed";
        payload = { stepId, durationMs: 1000 + Math.floor(Math.random() * 5000) };
      }
      protocolStepIndex++;
      if (protocolStepIndex >= MOCK_STEPS.length * 2) {
        protocolPhase = "completing";
      }
      break;
    case "completing":
      type = "protocol_run_completed";
      payload = {
        totalSteps: MOCK_STEPS.length,
        totalDurationMs: 12000 + Math.floor(Math.random() * 8000),
      };
      // Reset cycle
      protocolPhase = "starting";
      protocolStepIndex = 0;
      break;
  }

  return {
    id: ids.protocolEvent(),
    runId: MOCK_RUN_ID,
    timestamp: now,
    type,
    stepId,
    payload,
  };
}

/** Reset protocol generator state */
export function resetProtocolGenerator(): void {
  protocolStepIndex = 0;
  protocolPhase = "starting";
}

// ── Process Log Generator ────────────────────────────────────────

const LOG_PHASES = [
  "layer_print", "gradient_elution", "heating", "cooling",
  "inspection", "calibration", "extrusion", "retraction",
];

const LOG_MESSAGES: Record<string, string[]> = {
  layer_print: [
    "Layer completed at Z=12.4mm",
    "Infill pattern started: gyroid",
    "Layer adhesion check: nominal",
    "Support material deposited",
    "Layer time: 45s (target: 42s)",
  ],
  gradient_elution: [
    "Gradient step 3/10 — 45% B",
    "Flow rate stable at 1.0 mL/min",
    "Column pressure: 2850 psi",
    "Mobile phase transition complete",
    "Baseline drift within spec",
  ],
  heating: [
    "Target temperature reached: 215 degC",
    "Ramp rate: 2.1 degC/s",
    "Thermal equilibrium achieved",
    "PID output stabilized at 47%",
  ],
  cooling: [
    "Cooling cycle initiated",
    "Fan speed: 85%",
    "Temperature dropping: -1.8 degC/s",
    "Cool-down phase: 60% complete",
  ],
  inspection: [
    "Camera snapshot captured",
    "Dimensional check: within tolerance",
    "Surface roughness: Ra 0.8um",
    "Visual inspection passed",
  ],
  calibration: [
    "Zero offset calibrated",
    "Gain factor updated: 1.0023",
    "Reference standard verified",
    "Calibration curve R2=0.9998",
  ],
  extrusion: [
    "Extrusion rate adjusted to 105%",
    "Filament diameter: 1.74mm",
    "Pressure drop nominal",
    "Material flow stable",
  ],
  retraction: [
    "Retraction detected at Z=12.4mm",
    "Wipe sequence complete",
    "Prime sequence initiated",
    "Travel move completed",
  ],
};

const LOG_LEVELS: ProcessLogEntry["level"][] = [
  "info", "info", "info", "info", "debug", "info", "warn", "info", "trace", "info",
];

let logSequence = 0;
let logPhaseProgress: Record<string, number> = {};

/** Generate a single process log entry */
export function generateProcessLog(): ProcessLogEntry {
  logSequence++;
  const now = new Date().toISOString();
  const phase = LOG_PHASES[logSequence % LOG_PHASES.length];
  const messages = LOG_MESSAGES[phase] ?? ["Processing..."];
  const message = messages[logSequence % messages.length];
  const level = LOG_LEVELS[logSequence % LOG_LEVELS.length];
  const jobId = JOB_IDS[logSequence % JOB_IDS.length];

  // Advance phase progress
  if (!logPhaseProgress[phase]) logPhaseProgress[phase] = 0;
  logPhaseProgress[phase] = Math.min(100, logPhaseProgress[phase] + Math.floor(Math.random() * 8) + 1);
  if (logPhaseProgress[phase] >= 100) logPhaseProgress[phase] = 0; // reset

  // Generate a deterministic hash for the log entry
  const hashInput = `${logSequence}:${now}:${message}`;
  let hashHex = "";
  for (let i = 0; i < 64; i++) {
    hashHex += ((logSequence * 7 + i * 13) % 16).toString(16);
  }

  return {
    id: ids.processLog(),
    timestamp: now,
    kernelId: KERNEL_ID,
    deviceId: DEVICE_IDS[logSequence % DEVICE_IDS.length],
    jobId,
    stepId: `step-${(logSequence % 5) + 1}`,
    level,
    phase,
    phaseProgress: logPhaseProgress[phase],
    message,
    data: {
      tick: logSequence,
    },
    sequence: logSequence,
    hash: `sha256:${hashHex}` as `sha256:${string}`,
  };
}

/** Reset log generator state */
export function resetLogGenerator(): void {
  logSequence = 0;
  logPhaseProgress = {};
}
