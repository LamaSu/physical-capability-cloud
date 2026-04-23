/**
 * Evidence Evaluator — pure evidence evaluation logic extracted from MockMiner.
 *
 * This module contains the core evidence evaluation logic shared by the UMA
 * and Chainlink oracle adapters in mock mode. It replicates the deterministic
 * checks from MockMiner.forward() without the quality-based noise or
 * miner-specific infrastructure.
 */

import type { EvidenceBundle, EvidenceEventType } from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";

export interface EvaluationResult {
  score: number; // 0.0-1.0
  tierCompliant: boolean;
  defects: string[];
}

/**
 * Evaluate an evidence bundle against a required tier.
 * Runs all deterministic checks (hash, tier, events, sensor plausibility,
 * timestamp ordering). No random noise — this is a pure function for
 * reproducible oracle evaluation.
 */
export function evaluateEvidence(
  bundleHash: string,
  bundleData: string,
  requiredTier: number,
): EvaluationResult {
  const defects: string[] = [];

  let bundle: EvidenceBundle;
  try {
    bundle = JSON.parse(bundleData) as EvidenceBundle;
  } catch {
    return {
      score: 0,
      tierCompliant: false,
      defects: ["invalid_evidence_data"],
    };
  }

  // 1. Hash integrity check (critical — always detected)
  const hashValid = bundle.bundleHash === bundleHash;
  if (!hashValid) {
    defects.push("bundle_hash_mismatch");
  }

  // 2. Tier compliance check (critical — always detected)
  const tierCompliant = checkTierCompliance(bundle, requiredTier) && hashValid;
  if (!tierCompliant && hashValid) {
    defects.push(`tier_${requiredTier}_requirements_not_met`);
  }

  // 3. Event count validation (critical — always detected)
  if (bundle.events.length === 0) {
    defects.push("empty_evidence_bundle");
  }

  // 4. Sensor data plausibility
  defects.push(...checkSensorPlausibility(bundle));

  // 5. Timestamp ordering
  defects.push(...checkTimestampOrdering(bundle));

  // Compute score
  const score = defects.length === 0 ? 1.0 : Math.max(0, 1.0 - defects.length * 0.2);

  return {
    score: Math.round(score * 1000) / 1000,
    tierCompliant,
    defects,
  };
}

/** Check that the bundle contains required evidence types for the tier */
function checkTierCompliance(bundle: EvidenceBundle, requiredTier: number): boolean {
  const tierReq = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === requiredTier);
  if (!tierReq) return true; // Unknown tier — pass by default

  const eventTypes = new Set(bundle.events.map((e) => e.type));

  for (const group of tierReq.requiredEventTypes) {
    const found = group.some((t) => eventTypes.has(t as EvidenceEventType));
    if (!found) return false;
  }

  if (bundle.events.length < tierReq.minimumEvents) return false;

  return true;
}

/** Validate sensor data ranges for plausibility */
function checkSensorPlausibility(bundle: EvidenceBundle): string[] {
  const defects: string[] = [];

  for (const event of bundle.events) {
    if (event.type === "power_profile_summary") {
      const avgWatts = (event.payload as Record<string, unknown>).avgWatts;
      if (typeof avgWatts === "number") {
        if (avgWatts < 0) defects.push("negative_power_reading");
        if (avgWatts > 50000) defects.push("implausible_power_reading");
      }
      const durationSeconds = (event.payload as Record<string, unknown>).durationSeconds;
      if (typeof durationSeconds === "number" && durationSeconds < 0) {
        defects.push("negative_duration");
      }
    }

    if (event.type === "temperature_log") {
      const temp = (event.payload as Record<string, unknown>).temperature;
      if (typeof temp === "number") {
        if (temp < -273.15) defects.push("below_absolute_zero");
        if (temp > 5000) defects.push("implausible_temperature");
      }
    }
  }

  return defects;
}

/** Check that event timestamps are in non-decreasing order */
function checkTimestampOrdering(bundle: EvidenceBundle): string[] {
  const timestamps = bundle.events.map((e) => new Date(e.timestamp).getTime());

  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] < timestamps[i - 1]) {
      return ["timestamp_ordering_violation"];
    }
  }

  return [];
}
