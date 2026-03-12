/**
 * MockMiner — simulates a Bittensor subnet miner for evidence verification.
 *
 * Each miner has a quality level that determines how accurately it verifies
 * evidence. High-quality miners catch more defects and produce more accurate
 * scores; low-quality miners may miss issues or report false positives.
 *
 * This mirrors what a real Bittensor miner would do: receive a synapse,
 * process the evidence, and return verification results.
 */

import type { EvidenceBundle, EvidenceEventType } from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS } from "@pcc/spec";
import type { EvidenceVerifySynapse, MinerInfo } from "./types.js";

/** Quality level affects how accurately a miner verifies evidence */
export type MinerQuality = "excellent" | "good" | "mediocre" | "poor";

const QUALITY_SCORES: Record<MinerQuality, { accuracy: number; speedMultiplier: number }> = {
  excellent: { accuracy: 0.95, speedMultiplier: 1.0 },
  good: { accuracy: 0.80, speedMultiplier: 0.8 },
  mediocre: { accuracy: 0.55, speedMultiplier: 0.6 },
  poor: { accuracy: 0.30, speedMultiplier: 0.4 },
};

export class MockMiner {
  readonly uid: number;
  readonly hotkey: string;
  readonly quality: MinerQuality;
  private stake: number;
  private trust: number;
  private incentive: number;
  private totalVerifications: number = 0;

  constructor(uid: number, quality: MinerQuality = "good", stake: number = 1000) {
    this.uid = uid;
    this.hotkey = `5${uid.toString(16).padStart(47, "0")}`;
    this.quality = quality;
    this.stake = stake;
    this.trust = QUALITY_SCORES[quality].accuracy;
    this.incentive = 0;
  }

  /**
   * Process an evidence verification synapse.
   * Mirrors the forward() method of a real Bittensor miner.
   */
  async forward(synapse: EvidenceVerifySynapse): Promise<EvidenceVerifySynapse> {
    const startTime = Date.now();
    const result = { ...synapse };
    // Critical defects are always reported (deterministic checks)
    const criticalDefects: string[] = [];
    // Soft defects are subject to quality-based noise
    const softDefects: string[] = [];

    try {
      const bundle: EvidenceBundle = JSON.parse(synapse.evidenceData);
      const qualityConfig = QUALITY_SCORES[this.quality];

      // 1. Hash integrity check (critical — always detected)
      const hashValid = this.checkHashIntegrity(bundle, synapse.evidenceHash);
      if (!hashValid) {
        criticalDefects.push("bundle_hash_mismatch");
      }

      // 2. Tier compliance check (critical — always detected)
      const tierCompliant = this.checkTierCompliance(bundle, synapse.requiredTier);
      if (!tierCompliant) {
        criticalDefects.push(`tier_${synapse.requiredTier}_requirements_not_met`);
      }

      // 3. Event count validation (critical — always detected)
      if (bundle.events.length === 0) {
        criticalDefects.push("empty_evidence_bundle");
      }

      // 4. Sensor data plausibility (soft — quality-dependent)
      const sensorDefects = this.checkSensorPlausibility(bundle);
      softDefects.push(...sensorDefects);

      // 5. Timestamp ordering (soft — quality-dependent)
      const timestampDefects = this.checkTimestampOrdering(bundle);
      softDefects.push(...timestampDefects);

      // Quality-based noise only applies to soft defects
      const filteredSoftDefects = this.applyQualityNoise(softDefects, qualityConfig.accuracy);
      const allDefects = [...criticalDefects, ...filteredSoftDefects];

      // Compute verification score
      const baseScore = allDefects.length === 0 ? 1.0 : Math.max(0, 1.0 - allDefects.length * 0.2);
      const noiseRange = 1.0 - qualityConfig.accuracy;
      const noise = (Math.random() - 0.5) * noiseRange * 0.2;
      const finalScore = Math.max(0, Math.min(1, baseScore + noise));

      result.verificationScore = Math.round(finalScore * 1000) / 1000;
      result.tierCompliant = tierCompliant && hashValid;
      result.defectsFound = allDefects;
    } catch {
      // Failed to parse evidence data
      result.verificationScore = 0;
      result.tierCompliant = false;
      result.defectsFound = ["invalid_evidence_data"];
    }

    // Simulate processing time based on quality
    const baseTime = 50 + Math.random() * 100;
    result.processingTimeMs = Math.round(baseTime / QUALITY_SCORES[this.quality].speedMultiplier);

    this.totalVerifications++;
    return result;
  }

  /** Check that the bundle hash matches the provided evidence hash */
  private checkHashIntegrity(bundle: EvidenceBundle, expectedHash: string): boolean {
    return bundle.bundleHash === expectedHash;
  }

  /** Check that the bundle contains required evidence types for the tier */
  private checkTierCompliance(bundle: EvidenceBundle, requiredTier: number): boolean {
    const tierReq = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === requiredTier);
    if (!tierReq) return true; // Unknown tier, pass by default

    const eventTypes = new Set(bundle.events.map((e) => e.type));

    for (const group of tierReq.requiredEventTypes) {
      const found = group.some((t) => eventTypes.has(t as EvidenceEventType));
      if (!found) return false;
    }

    if (bundle.events.length < tierReq.minimumEvents) return false;

    return true;
  }

  /** Validate sensor data ranges for plausibility */
  private checkSensorPlausibility(bundle: EvidenceBundle): string[] {
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
  private checkTimestampOrdering(bundle: EvidenceBundle): string[] {
    const defects: string[] = [];
    const timestamps = bundle.events.map((e) => new Date(e.timestamp).getTime());

    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        defects.push("timestamp_ordering_violation");
        break; // One defect is enough
      }
    }

    return defects;
  }

  /**
   * Apply quality-based noise to defect detection.
   * Poor miners miss real defects; mediocre miners sometimes add false positives.
   */
  private applyQualityNoise(defects: string[], accuracy: number): string[] {
    const result: string[] = [];

    for (const defect of defects) {
      // Higher accuracy = more likely to detect real defects
      if (Math.random() < accuracy) {
        result.push(defect);
      }
    }

    // Poor miners may add false positives
    if (accuracy < 0.5 && Math.random() > accuracy) {
      result.push("false_positive_anomaly");
    }

    return result;
  }

  /** Get miner info for the metagraph */
  getInfo(): MinerInfo {
    return {
      uid: this.uid,
      hotkey: this.hotkey,
      stake: this.stake,
      trust: this.trust,
      incentive: this.incentive,
      lastUpdate: Date.now(),
    };
  }

  /** Update trust and incentive scores (called by validator) */
  updateScores(trust: number, incentive: number): void {
    this.trust = Math.max(0, Math.min(1, trust));
    this.incentive = Math.max(0, Math.min(1, incentive));
  }

  getTotalVerifications(): number {
    return this.totalVerifications;
  }
}
