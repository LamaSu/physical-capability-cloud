/**
 * Universal sensor types — ingest data from ANY device on ANY process.
 *
 * SensorReading is the atomic unit; SensorChannelDescriptor declares metadata;
 * SensorAggregate stores downsampled history; ProcessLogEntry captures structured logs.
 */

import type { Id, SHA256, Timestamp } from "./common.js";

/** Extensible physical unit union (same open pattern as CapabilityType) */
export type PhysicalUnit =
  // Temperature
  | "degC" | "degF" | "K"
  // Pressure
  | "Pa" | "kPa" | "bar" | "psi"
  // Electrical
  | "W" | "kW" | "V" | "A" | "mA"
  // Force / Torque
  | "N" | "kN" | "Nm"
  // Flow
  | "mL/min" | "L/min"
  // Vibration
  | "m/s2" | "mm/s"
  // Optical / Spectral
  | "nm" | "AU" | "mAU" | "counts"
  // Dimensional
  | "mm" | "um" | "in"
  // Mass
  | "kg" | "mg"
  // Time / Frequency
  | "s" | "ms" | "Hz" | "rpm"
  // Concentration
  | "pH" | "ppm" | "ppb" | "mol/L"
  // Dimensionless
  | "percent" | "ratio" | "bool"
  // Open extension
  | (string & {});

/** Data shape for a sensor channel */
export type SensorDataType =
  | "scalar" | "vector" | "spectrum" | "image"
  | "waveform" | "boolean" | "string" | "matrix"
  | "histogram" | (string & {});

/** Possible values a sensor reading can carry */
export type SensorValue =
  | number | number[] | number[][] | string
  | { bins: number[]; counts: number[] }
  | Record<string, unknown>;

/** Atomic unit of sensor data */
export interface SensorReading {
  id: Id;
  timestamp: Timestamp;
  /** 0-999999 for sub-ms precision */
  nanoOffset?: number;
  kernelId: Id;
  deviceId: Id;
  /** e.g. "nozzle_temp", "uv_absorbance", "ph_level" */
  channel: string;
  dataType: SensorDataType;
  unit: PhysicalUnit;
  value: SensorValue;
  /** 0.0-1.0 data quality indicator */
  quality?: number;
  jobId?: Id;
  stepId?: Id;
  batchId?: Id;
  sampleId?: Id;
  tags?: Record<string, string>;
}

/** Channel metadata — declared once when a device is provisioned */
export interface SensorChannelDescriptor {
  channel: string;
  label: string;
  dataType: SensorDataType;
  unit: PhysicalUnit;
  sampleRateHz: number;
  range?: { min: number; max: number };
  resolution?: number;
  retentionPolicy: "full" | "downsample_1s" | "downsample_10s" | "downsample_1min" | "summary_only";
  /** Include this channel in evidence bundles? */
  evidenceGrade: boolean;
}

/** Downsampled aggregate for historical storage */
export interface SensorAggregate {
  channel: string;
  kernelId: Id;
  deviceId: Id;
  windowStart: Timestamp;
  windowEnd: Timestamp;
  count: number;
  min: number;
  max: number;
  mean: number;
  stddev?: number;
  unit: PhysicalUnit;
  jobId?: Id;
  batchId?: Id;
}

/** Anomaly detected in a sensor stream */
export interface SensorAnomaly {
  id: Id;
  timestamp: Timestamp;
  kernelId: Id;
  deviceId: Id;
  channel: string;
  type: "threshold_exceeded" | "rate_of_change" | "flatline" | "pattern_mismatch";
  severity: "info" | "warning" | "critical";
  value: number;
  threshold: number;
  message: string;
  jobId?: Id;
}

/** Structured process log entry */
export interface ProcessLogEntry {
  id: Id;
  timestamp: Timestamp;
  kernelId: Id;
  deviceId: Id;
  jobId: Id;
  stepId?: Id;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  /** e.g. "layer_print", "gradient_elution", "fed_batch" */
  phase: string;
  /** 0-100 */
  phaseProgress: number;
  message: string;
  data: Record<string, unknown>;
  /** Ordering within job */
  sequence: number;
  hash: SHA256;
}

/** Topic for streaming subscriptions */
export interface StreamTopic {
  type: "job" | "kernel" | "device" | "batch" | "global";
  id: string;
}
