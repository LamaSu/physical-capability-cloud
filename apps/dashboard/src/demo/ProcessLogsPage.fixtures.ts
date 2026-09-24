/**
 * Demo fixtures for the Process Logs page (pages/ProcessLogsPage.tsx).
 *
 * Sample values, not PCC state. The page renders them only in demo mode
 * (lib/demo-mode.ts), under a DemoBanner. Before implementer-charlie moved them
 * here, the page generated these lines on every load and showed them as the
 * log history of kernel "kernel-nyc", which no machine ever wrote.
 */

import type { ProcessLogEntry } from "@pcc/spec";

const PHASES = ["layer_print", "gradient_elution", "heating", "cooling", "inspection", "calibration"];
const LEVELS: ProcessLogEntry["level"][] = ["info", "info", "info", "debug", "warn", "info", "info", "trace"];
const MESSAGES = [
  "Layer completed successfully",
  "Temperature target reached",
  "Gradient step 3/10 — 45% B",
  "Power consumption within expected range",
  "Vibration level slightly elevated",
  "Camera snapshot captured",
  "Waiting for bed temperature stabilization",
  "G-code line 4521 executed",
  "Extrusion rate adjusted to 105%",
  "Retraction detected at Z=12.4mm",
];

/** `count` sample log lines, two seconds apart, the last one two seconds before `now`. */
export function demoProcessLogs(count: number, now: number = Date.now()): ProcessLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `plog_${i}`,
    timestamp: new Date(now - (count - i) * 2000).toISOString(),
    kernelId: "kernel-nyc",
    deviceId: "dev-001",
    jobId: i % 3 === 0 ? "job-001" : i % 3 === 1 ? "job-002" : "job-003",
    stepId: "step-1",
    level: LEVELS[i % LEVELS.length],
    phase: PHASES[i % PHASES.length],
    phaseProgress: Math.min(100, Math.floor((i / count) * 100)),
    message: MESSAGES[i % MESSAGES.length],
    data: {},
    sequence: i,
    hash: `sha256:${"0".repeat(64)}` as const,
  }));
}
