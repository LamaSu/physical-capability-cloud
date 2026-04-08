/**
 * Drift Detector — pure utility for detecting deviations between
 * what was promised (CWM step parameters) and what actually happened
 * (EvidenceBundle events).
 *
 * This is a pure function module called by ComplianceFacade.
 * It never touches the DB — it only analyzes already-loaded data.
 */

import type { EvidenceEvent, AssuranceTier } from "@pcc/spec";
import type { CWMStep } from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";
import type { DriftAlertDTO } from "./types.js";

// ── Public Interface ──────────────────────────────────────────────────────────

export interface DriftDetectionContext {
  /** The events to analyze — from an EvidenceBundle */
  evidenceEvents: EvidenceEvent[];
  /** The bundle's assurance tier (for sensor_gap checks) */
  assuranceTier: AssuranceTier;
  /** CWM step — provides expected parameters (duration, material, etc.) */
  cwmStep?: CWMStep;
  /** Capability type — drives power range norms */
  capabilityType?: string;
}

/**
 * Run all drift checks against the provided context.
 * Returns an array of DriftAlertDTOs (empty = no drift detected).
 * Never throws — errors are silently skipped to keep compliance checks non-fatal.
 */
export function detectDrifts(ctx: DriftDetectionContext): DriftAlertDTO[] {
  const alerts: DriftAlertDTO[] = [];
  const now = new Date().toISOString();

  const eventsByType = groupByType(ctx.evidenceEvents);

  // 1. duration_mismatch
  try {
    const durationAlerts = checkDurationMismatch(eventsByType, ctx.cwmStep, now);
    alerts.push(...durationAlerts);
  } catch {
    // Non-fatal — drift detection is best-effort
  }

  // 2. power_anomaly
  try {
    const powerAlerts = checkPowerAnomaly(eventsByType, ctx.cwmStep, now);
    alerts.push(...powerAlerts);
  } catch {
    // Non-fatal
  }

  // 3. temperature_excursion
  try {
    const tempAlerts = checkTemperatureExcursion(eventsByType, ctx.cwmStep, now);
    alerts.push(...tempAlerts);
  } catch {
    // Non-fatal
  }

  // 4. sensor_gap
  try {
    const gapAlerts = checkSensorGaps(ctx.evidenceEvents, ctx.assuranceTier, now);
    alerts.push(...gapAlerts);
  } catch {
    // Non-fatal
  }

  return alerts;
}

// ── Duration Mismatch ─────────────────────────────────────────────────────────

function checkDurationMismatch(
  eventsByType: Map<string, EvidenceEvent[]>,
  cwmStep: CWMStep | undefined,
  now: string,
): DriftAlertDTO[] {
  if (!cwmStep?.estimatedDuration) return [];

  const startedEvents = eventsByType.get("execution_started");
  const completedEvents = eventsByType.get("execution_completed");

  if (!startedEvents?.length || !completedEvents?.length) return [];

  const started = startedEvents[0];
  const completed = completedEvents[completedEvents.length - 1];

  const actualMs = new Date(completed.timestamp).getTime() - new Date(started.timestamp).getTime();
  if (actualMs <= 0) return []; // timestamps are bogus — skip rather than false-flag

  const actualSec = actualMs / 1000;
  const expectedSec = cwmStep.estimatedDuration * 60;
  const ratio = actualSec / expectedSec;

  // Absolute bounds from evidence-evaluator.ts conventions
  if (ratio < 0.1) {
    return [{
      type: "duration_mismatch",
      severity: "critical",
      message: `Execution completed in ${formatDuration(actualSec)} but expected ~${formatDuration(expectedSec)}. Job likely did not run (ratio ${ratio.toFixed(2)}).`,
      expectedValue: `${expectedSec.toFixed(0)}s`,
      actualValue: `${actualSec.toFixed(0)}s`,
      timestamp: now,
    }];
  }

  if (ratio < 0.5 || ratio > 2.0) {
    return [{
      type: "duration_mismatch",
      severity: "high",
      message: `Execution duration ${formatDuration(actualSec)} deviates significantly from expected ${formatDuration(expectedSec)} (ratio ${ratio.toFixed(2)}).`,
      expectedValue: `${expectedSec.toFixed(0)}s`,
      actualValue: `${actualSec.toFixed(0)}s`,
      timestamp: now,
    }];
  }

  if (ratio < 0.7 || ratio > 1.5) {
    return [{
      type: "duration_mismatch",
      severity: "medium",
      message: `Execution duration ${formatDuration(actualSec)} differs from expected ${formatDuration(expectedSec)} (ratio ${ratio.toFixed(2)}).`,
      expectedValue: `${expectedSec.toFixed(0)}s`,
      actualValue: `${actualSec.toFixed(0)}s`,
      timestamp: now,
    }];
  }

  if (ratio < 0.85 || ratio > 1.2) {
    return [{
      type: "duration_mismatch",
      severity: "low",
      message: `Execution duration ${formatDuration(actualSec)} slightly differs from expected ${formatDuration(expectedSec)} (ratio ${ratio.toFixed(2)}).`,
      expectedValue: `${expectedSec.toFixed(0)}s`,
      actualValue: `${actualSec.toFixed(0)}s`,
      timestamp: now,
    }];
  }

  return [];
}

// ── Power Anomaly ─────────────────────────────────────────────────────────────

/** Power ranges (W) for capability types — [min, max] normal operating range */
const CAPABILITY_POWER_RANGES: Record<string, [number, number]> = {
  "3d_printing": [50, 500],
  "cnc_milling": [500, 5000],
  "laser_cutting": [200, 3000],
  "lathe": [300, 4000],
  "waterjet": [1000, 7000],
  "pcb_assembly": [50, 300],
  "injection_molding": [2000, 20000],
  "bioassay": [20, 500],
  "default": [50, 10000],
};

function getCapabilityPowerRange(capabilityType?: string): [number, number] {
  if (!capabilityType) return CAPABILITY_POWER_RANGES["default"];
  const lower = capabilityType.toLowerCase().replace(/[-\s]/g, "_");
  return CAPABILITY_POWER_RANGES[lower] ?? CAPABILITY_POWER_RANGES["default"];
}

function checkPowerAnomaly(
  eventsByType: Map<string, EvidenceEvent[]>,
  cwmStep: CWMStep | undefined,
  now: string,
): DriftAlertDTO[] {
  const powerEvents = eventsByType.get("power_profile_summary");
  if (!powerEvents?.length) return [];

  const alerts: DriftAlertDTO[] = [];

  for (const event of powerEvents) {
    const avgWatts = event.payload?.avgWatts as number | undefined;
    if (avgWatts === undefined || avgWatts === null) continue;

    // Absolute sensor fault bounds (from evidence-evaluator.ts)
    if (avgWatts < 0) {
      alerts.push({
        type: "power_anomaly",
        severity: "critical",
        message: `Negative power reading detected (${avgWatts}W) — sensor fault or data corruption.`,
        expectedValue: "≥0W",
        actualValue: `${avgWatts}W`,
        timestamp: event.timestamp,
      });
      continue;
    }

    if (avgWatts > 50000) {
      alerts.push({
        type: "power_anomaly",
        severity: "critical",
        message: `Implausible power reading (${avgWatts}W) — exceeds 50kW threshold.`,
        expectedValue: "≤50000W",
        actualValue: `${avgWatts}W`,
        timestamp: event.timestamp,
      });
      continue;
    }

    // Relative drift vs capability-type norms
    const [expectedMin, expectedMax] = getCapabilityPowerRange(
      cwmStep?.capability ?? undefined,
    );
    const expectedMid = (expectedMin + expectedMax) / 2;
    const ratio = avgWatts / expectedMid;

    if (ratio < 0.1 || ratio > 3.0) {
      alerts.push({
        type: "power_anomaly",
        severity: "high",
        message: `Power draw ${avgWatts.toFixed(0)}W is outside normal range for ${cwmStep?.capability ?? "this capability"} (expected ${expectedMin}–${expectedMax}W, ratio ${ratio.toFixed(2)}).`,
        expectedValue: `${expectedMin}–${expectedMax}W`,
        actualValue: `${avgWatts.toFixed(0)}W`,
        timestamp: event.timestamp,
      });
    } else if (ratio < 0.5 || ratio > 1.5) {
      alerts.push({
        type: "power_anomaly",
        severity: "medium",
        message: `Power draw ${avgWatts.toFixed(0)}W differs moderately from expected range ${expectedMin}–${expectedMax}W (ratio ${ratio.toFixed(2)}).`,
        expectedValue: `${expectedMin}–${expectedMax}W`,
        actualValue: `${avgWatts.toFixed(0)}W`,
        timestamp: event.timestamp,
      });
    } else if (ratio < 0.8 || ratio > 1.2) {
      alerts.push({
        type: "power_anomaly",
        severity: "low",
        message: `Power draw ${avgWatts.toFixed(0)}W slightly outside expected range ${expectedMin}–${expectedMax}W (ratio ${ratio.toFixed(2)}).`,
        expectedValue: `${expectedMin}–${expectedMax}W`,
        actualValue: `${avgWatts.toFixed(0)}W`,
        timestamp: event.timestamp,
      });
    }
  }

  return alerts;
}

// ── Temperature Excursion ─────────────────────────────────────────────────────

/** Material temperature safe bands [min, max] in °C */
const MATERIAL_TEMP_BANDS: Record<string, [number, number]> = {
  pla: [180, 230],
  abs: [220, 260],
  petg: [220, 250],
  nylon: [235, 260],
  tpu: [210, 240],
  // CNC/lathe — ambient cutting temp
  aluminum: [15, 250],
  steel: [15, 500],
  // Lab
  lab: [35, 39],
  bioassay: [35, 39],
  // Default: allow a wide band (will still catch absolute violations)
  default: [0, 500],
};

function getMaterialTempBand(material?: string): [number, number] {
  if (!material) return MATERIAL_TEMP_BANDS["default"];
  const lower = material.toLowerCase().replace(/[-\s]/g, "_");
  // Partial match — "pla_filament" → "pla"
  for (const [key, band] of Object.entries(MATERIAL_TEMP_BANDS)) {
    if (lower.includes(key)) return band;
  }
  return MATERIAL_TEMP_BANDS["default"];
}

function checkTemperatureExcursion(
  eventsByType: Map<string, EvidenceEvent[]>,
  cwmStep: CWMStep | undefined,
  now: string,
): DriftAlertDTO[] {
  const tempEvents = eventsByType.get("temperature_log");
  if (!tempEvents?.length) return [];

  const alerts: DriftAlertDTO[] = [];
  const [bandMin, bandMax] = getMaterialTempBand(cwmStep?.params?.material as string | undefined);

  for (const event of tempEvents) {
    const temp = event.payload?.temperature as number | undefined;
    if (temp === undefined || temp === null) continue;

    // Absolute physical bounds (from evidence-evaluator.ts)
    if (temp < -273.15) {
      alerts.push({
        type: "temperature_excursion",
        severity: "critical",
        message: `Temperature reading ${temp}°C is below absolute zero — sensor fault.`,
        expectedValue: ">-273.15°C",
        actualValue: `${temp}°C`,
        timestamp: event.timestamp,
      });
      continue;
    }

    if (temp > 5000) {
      alerts.push({
        type: "temperature_excursion",
        severity: "critical",
        message: `Temperature reading ${temp}°C exceeds 5000°C — implausible, sensor fault.`,
        expectedValue: "≤5000°C",
        actualValue: `${temp}°C`,
        timestamp: event.timestamp,
      });
      continue;
    }

    // Outside material safe band
    if (temp < bandMin || temp > bandMax) {
      // Compute how far outside the band as percentage of band width
      const bandWidth = bandMax - bandMin;
      const overshoot = temp < bandMin ? bandMin - temp : temp - bandMax;
      const overPercent = bandWidth > 0 ? (overshoot / bandWidth) * 100 : 100;

      const severity: DriftAlertDTO["severity"] =
        overPercent > 50 ? "high" : overPercent > 10 ? "medium" : "low";

      alerts.push({
        type: "temperature_excursion",
        severity,
        message: `Temperature ${temp}°C is outside the safe band [${bandMin}–${bandMax}°C] for ${cwmStep?.params?.material ?? "this material"} (${overPercent.toFixed(0)}% over band).`,
        expectedValue: `${bandMin}–${bandMax}°C`,
        actualValue: `${temp}°C`,
        timestamp: event.timestamp,
      });
    }
  }

  return alerts;
}

// ── Sensor Gap ────────────────────────────────────────────────────────────────

/**
 * Severity rules for missing sensor event groups, by tier.
 * Keyed on the first member of the OR-group (the canonical name).
 */
function sensorGapSeverity(
  missingGroup: string[],
  tier: AssuranceTier,
): DriftAlertDTO["severity"] {
  const canonical = missingGroup[0];

  if (canonical === "execution_completed") return "critical";
  if (canonical === "tee_attestation" && tier >= 3) return "critical";
  if (canonical === "cv_inspection_result" && tier >= 2) return "high";
  if (canonical === "power_profile_summary" && tier >= 1) return "high";
  if (canonical === "gcode_hash_verified") return "high";

  return "medium";
}

function checkSensorGaps(
  events: EvidenceEvent[],
  tier: AssuranceTier,
  now: string,
): DriftAlertDTO[] {
  const tierReqs = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === tier);
  if (!tierReqs) return [];

  const presentTypes = new Set(events.map((e) => e.type));
  const alerts: DriftAlertDTO[] = [];

  for (const group of tierReqs.requiredEventTypes) {
    const groupSatisfied = group.some((t) => presentTypes.has(t as EvidenceEvent["type"]));
    if (!groupSatisfied) {
      const severity = sensorGapSeverity(group, tier);
      const groupStr = group.join(" | ");

      alerts.push({
        type: "sensor_gap",
        severity,
        message: `Tier ${tier} requires at least one of [${groupStr}] but none were found in the evidence bundle.`,
        expectedValue: groupStr,
        actualValue: "missing",
        timestamp: now,
      });
    }
  }

  return alerts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByType(events: EvidenceEvent[]): Map<string, EvidenceEvent[]> {
  const map = new Map<string, EvidenceEvent[]>();
  for (const event of events) {
    const group = map.get(event.type) ?? [];
    group.push(event);
    map.set(event.type, group);
  }
  return map;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
