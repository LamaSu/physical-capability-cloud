/**
 * QualityScoringSubnet — Bittensor subnet for ML-based evidence quality scoring.
 *
 * Miners compete on scoring evidence quality using ML-like heuristics. Better
 * miners produce more accurate quality assessments and detect subtle anomalies
 * like flatline readings, sensor drift, and implausible values.
 *
 * Yuma Consensus on scores: miners that agree with the stake-weighted median
 * receive higher weights over time.
 */

import type { MinerInfo, SubnetMetrics } from "./types.js";
import { type MinerQuality } from "./mock-miner.js";

// ── Synapse ──────────────────────────────────────────────────────────

export interface QualityScoreDimensions {
  completeness: number;  // 0-1 (all expected fields present)
  consistency: number;   // 0-1 (values internally consistent)
  precision: number;     // 0-1 (sensor data precision / resolution)
  timeliness: number;    // 0-1 (evidence freshness)
}

export interface QualityScoringSynapse {
  bundleHash: string;
  bundleData: string;    // JSON-serialized evidence bundle or opaque data blob
  capabilityType: string;
  // --- Response (filled by miners) ---
  qualityScore?: number;
  dimensions?: QualityScoreDimensions;
  anomalies?: string[];
  processingTimeMs?: number;
}

// ── Result ───────────────────────────────────────────────────────────

export interface QualityScoringResult {
  /** Consensus quality score (0-1) */
  qualityScore: number;
  /** Consensus dimension scores */
  dimensions: QualityScoreDimensions;
  /** Anomalies reported by high-weight miners */
  anomalies: string[];
  /** Number of miners that participated */
  minerCount: number;
  /** Time taken for the full round (ms) */
  totalTimeMs: number;
}

// ── Scoring Miner ────────────────────────────────────────────────────

const QUALITY_ACCURACY: Record<MinerQuality, number> = {
  excellent: 0.95,
  good: 0.80,
  mediocre: 0.55,
  poor: 0.30,
};

class ScoringMiner {
  readonly uid: number;
  readonly hotkey: string;
  readonly quality: MinerQuality;
  readonly stake: number;
  private trust: number;
  private incentive: number = 0;

  constructor(uid: number, quality: MinerQuality = "good", stake: number = 1000) {
    this.uid = uid;
    this.hotkey = `5Q${uid.toString(16).padStart(46, "0")}`;
    this.quality = quality;
    this.stake = stake;
    this.trust = QUALITY_ACCURACY[quality];
  }

  async forward(synapse: QualityScoringSynapse): Promise<QualityScoringSynapse> {
    const start = Date.now();
    const result = { ...synapse };
    const accuracy = QUALITY_ACCURACY[this.quality];
    const noise = (1 - accuracy) * 0.3;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(synapse.bundleData) as Record<string, unknown>;
    } catch {
      // bundleData is opaque — score conservatively
    }

    const dimensions = this.scoreDimensions(parsed, synapse.capabilityType, accuracy);
    const anomalies = this.detectAnomalies(parsed, accuracy);

    // Add quality-proportional noise to each dimension
    const applyNoise = (v: number) => Math.max(0, Math.min(1, v + (Math.random() - 0.5) * noise));
    const noisyDims: QualityScoreDimensions = {
      completeness: applyNoise(dimensions.completeness),
      consistency: applyNoise(dimensions.consistency),
      precision: applyNoise(dimensions.precision),
      timeliness: applyNoise(dimensions.timeliness),
    };

    const baseScore =
      0.3 * noisyDims.completeness +
      0.3 * noisyDims.consistency +
      0.2 * noisyDims.precision +
      0.2 * noisyDims.timeliness;

    result.qualityScore = Math.round(Math.max(0, Math.min(1, baseScore)) * 1000) / 1000;
    result.dimensions = {
      completeness: Math.round(noisyDims.completeness * 1000) / 1000,
      consistency: Math.round(noisyDims.consistency * 1000) / 1000,
      precision: Math.round(noisyDims.precision * 1000) / 1000,
      timeliness: Math.round(noisyDims.timeliness * 1000) / 1000,
    };
    result.anomalies = anomalies;
    result.processingTimeMs = Math.round(Date.now() - start + 10 + Math.random() * 60);
    return result;
  }

  private scoreDimensions(
    parsed: Record<string, unknown> | null,
    _capabilityType: string,
    accuracy: number,
  ): QualityScoreDimensions {
    if (!parsed) {
      // Unparseable bundle — low scores across the board
      return { completeness: 0.1, consistency: 0.1, precision: 0.1, timeliness: 0.1 };
    }

    const events = Array.isArray(parsed.events) ? (parsed.events as unknown[]) : [];

    // Completeness: presence of key fields
    const requiredFields = ["id", "jobId", "kernelId", "assuranceTier", "events", "bundleHash"];
    const presentFields = requiredFields.filter((f) => f in parsed);
    const completeness = presentFields.length / requiredFields.length;

    // Consistency: timestamps in order, event count matches
    let consistency = 1.0;
    if (events.length === 0) {
      consistency = 0.0;
    } else {
      const timestamps = events.map((e) => {
        const ev = e as Record<string, unknown>;
        return ev.timestamp ? new Date(ev.timestamp as string).getTime() : 0;
      });
      let outOfOrder = false;
      for (let i = 1; i < timestamps.length; i++) {
        if (timestamps[i] < timestamps[i - 1]) { outOfOrder = true; break; }
      }
      if (outOfOrder) consistency -= 0.4;
      // Check each event has required fields
      const eventFields = ["id", "type", "timestamp", "source", "payload", "hash"];
      const eventScores = events.map((e) => {
        const ev = e as Record<string, unknown>;
        return eventFields.filter((f) => f in ev).length / eventFields.length;
      });
      const avgEventScore = eventScores.reduce((s, v) => s + v, 0) / eventScores.length;
      consistency = Math.max(0, Math.min(1, consistency * avgEventScore));
    }

    // Precision: check numeric sensor readings have reasonable resolution
    let precision = 0.8; // default — assume OK
    let sensorCount = 0;
    for (const e of events) {
      const ev = e as Record<string, unknown>;
      const payload = ev.payload as Record<string, unknown> | undefined;
      if (!payload) continue;
      for (const val of Object.values(payload)) {
        if (typeof val === "number") {
          sensorCount++;
          // Flatline check: if val is exactly 0 or a suspicious round number, flag lower precision
          if (val === 0) precision -= 0.1 / Math.max(1, sensorCount);
        }
      }
    }

    // Timeliness: how recent is the bundle? Within 24h = 1.0, older = degraded
    const createdAt = parsed.createdAt as string | undefined;
    let timeliness = 0.8;
    if (createdAt) {
      const ageMs = Date.now() - new Date(createdAt).getTime();
      const ageHours = ageMs / (1000 * 60 * 60);
      timeliness = Math.max(0, 1 - ageHours / 24);
      if (timeliness < 0.01) timeliness = 0.8; // future/test dates — treat as fresh
    }

    // Apply accuracy-based quality floor
    const floor = (1 - accuracy) * 0.1;
    return {
      completeness: Math.max(floor, Math.min(1, completeness)),
      consistency: Math.max(floor, Math.min(1, consistency)),
      precision: Math.max(floor, Math.min(1, precision)),
      timeliness: Math.max(floor, Math.min(1, timeliness)),
    };
  }

  private detectAnomalies(parsed: Record<string, unknown> | null, accuracy: number): string[] {
    const anomalies: string[] = [];
    if (!parsed) return anomalies;

    const events = Array.isArray(parsed.events) ? (parsed.events as unknown[]) : [];

    // Check each event for anomalies
    for (const e of events) {
      const ev = e as Record<string, unknown>;
      const payload = ev.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      const type = ev.type as string | undefined;

      // Power readings
      if (type === "power_profile_summary") {
        const avgWatts = payload.avgWatts as number | undefined;
        if (typeof avgWatts === "number") {
          if (avgWatts < 0) anomalies.push("negative_power_reading");
          if (avgWatts === 0 && accuracy > 0.7) anomalies.push("flatline_power_reading");
          if (avgWatts > 50000) anomalies.push("implausible_power_reading");
        }
        const dur = payload.durationSeconds as number | undefined;
        if (typeof dur === "number" && dur < 0) anomalies.push("negative_duration");
      }

      // Temperature
      if (type === "temperature_log") {
        const temp = payload.temperature as number | undefined;
        if (typeof temp === "number") {
          if (temp < -273.15) anomalies.push("below_absolute_zero");
          if (temp > 5000) anomalies.push("implausible_temperature");
        }
      }
    }

    // Sensor drift detection — only excellent miners catch subtle drift
    if (accuracy >= 0.9 && events.length >= 3) {
      const powerReadings: number[] = [];
      for (const e of events) {
        const ev = e as Record<string, unknown>;
        const payload = ev.payload as Record<string, unknown> | undefined;
        if (ev.type === "power_profile_summary" && payload) {
          const w = payload.avgWatts as number | undefined;
          if (typeof w === "number") powerReadings.push(w);
        }
      }
      if (powerReadings.length >= 3) {
        const allSame = powerReadings.every((v) => v === powerReadings[0]);
        if (allSame) anomalies.push("sensor_drift_flatline");
      }
    }

    // Poor miners add false positives
    if (accuracy < 0.5 && Math.random() > accuracy) {
      anomalies.push("false_positive_anomaly");
    }

    return [...new Set(anomalies)];
  }

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

  updateScores(trust: number, incentive: number): void {
    this.trust = Math.max(0, Math.min(1, trust));
    this.incentive = Math.max(0, Math.min(1, incentive));
  }
}

// ── Subnet ───────────────────────────────────────────────────────────

export class QualityScoringSubnet {
  private miners: ScoringMiner[] = [];
  private metrics: SubnetMetrics = {
    totalVerifications: 0,
    averageScore: 0,
    activeMinerCount: 0,
    lastEpochRewards: 0,
  };
  private weights: Map<number, number> = new Map();

  constructor(minerCount: number = 8) {
    this.initMiners(minerCount);
  }

  private initMiners(count: number): void {
    const qualities: MinerQuality[] = [
      "excellent", "good", "good", "good", "mediocre", "mediocre", "poor", "poor",
    ];
    for (let i = 0; i < count; i++) {
      const quality = qualities[i % qualities.length];
      const stake = 500 + Math.random() * 2000;
      const miner = new ScoringMiner(i, quality, Math.round(stake));
      this.miners.push(miner);
      this.weights.set(i, 1.0 / count);
    }
    this.metrics.activeMinerCount = count;
  }

  async scoreEvidence(synapse: QualityScoringSynapse): Promise<QualityScoringResult> {
    const start = Date.now();
    if (this.miners.length === 0) throw new Error("No scoring miners available");

    const numToQuery = Math.min(5, this.miners.length);
    const selected = this.selectMiners(numToQuery);

    const responses = await Promise.all(selected.map((m) => m.forward({ ...synapse })));

    // Yuma Consensus on score: compute stake-weighted median, score miners by proximity
    const scores = responses.map((r) => r.qualityScore ?? 0);
    const stakes = selected.map((m) => m.stake);
    const medianScore = weightedMedian(scores, stakes);

    const consensusWeights = scores.map((s) => {
      const distance = Math.abs(s - medianScore);
      return Math.max(0, 1 - distance * 2);
    });

    // Update miner weights
    for (let i = 0; i < selected.length; i++) {
      const miner = selected[i];
      const cw = consensusWeights[i];
      const cur = this.weights.get(miner.uid) ?? 0;
      this.weights.set(miner.uid, cur * 0.7 + cw * 0.3);
      const info = miner.getInfo();
      miner.updateScores(info.trust * 0.8 + cw * 0.2, cw);
    }

    // Aggregate: weighted average of dimensions + anomaly union from high-weight miners
    const totalWeight = consensusWeights.reduce((s, w) => s + w, 0);

    const aggDims = responses.reduce(
      (acc, r, i) => {
        const w = consensusWeights[i];
        const d = r.dimensions ?? { completeness: 0, consistency: 0, precision: 0, timeliness: 0 };
        return {
          completeness: acc.completeness + d.completeness * w,
          consistency: acc.consistency + d.consistency * w,
          precision: acc.precision + d.precision * w,
          timeliness: acc.timeliness + d.timeliness * w,
        };
      },
      { completeness: 0, consistency: 0, precision: 0, timeliness: 0 },
    );

    const divSafe = (v: number) => (totalWeight > 0 ? Math.round((v / totalWeight) * 1000) / 1000 : 0);
    const dimensions: QualityScoreDimensions = {
      completeness: divSafe(aggDims.completeness),
      consistency: divSafe(aggDims.consistency),
      precision: divSafe(aggDims.precision),
      timeliness: divSafe(aggDims.timeliness),
    };

    // Anomalies: include any anomaly reported by miners with weight > 30% of total
    const anomalyCounts = new Map<string, number>();
    for (let i = 0; i < responses.length; i++) {
      const w = consensusWeights[i];
      for (const a of responses[i].anomalies ?? []) {
        anomalyCounts.set(a, (anomalyCounts.get(a) ?? 0) + w);
      }
    }
    const threshold = totalWeight * 0.3;
    const anomalies = [...anomalyCounts.entries()]
      .filter(([, w]) => w > threshold)
      .map(([a]) => a);

    const qualityScore = Math.round(medianScore * 1000) / 1000;

    this.metrics.totalVerifications++;
    const prev = this.metrics.totalVerifications - 1;
    this.metrics.averageScore =
      (this.metrics.averageScore * prev + qualityScore) / this.metrics.totalVerifications;
    this.metrics.lastEpochRewards =
      [...this.weights.values()].reduce((s, w) => s + w, 0) * 10;

    return {
      qualityScore,
      dimensions,
      anomalies,
      minerCount: selected.length,
      totalTimeMs: Date.now() - start,
    };
  }

  private selectMiners(count: number): ScoringMiner[] {
    if (count >= this.miners.length) return [...this.miners];
    const weighted = this.miners.map((m) => ({
      miner: m,
      weight: (this.weights.get(m.uid) ?? 0) * m.stake,
    }));
    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    const selected: ScoringMiner[] = [];
    const used = new Set<number>();
    while (selected.length < count) {
      let random = Math.random() * totalWeight;
      for (const w of weighted) {
        if (used.has(w.miner.uid)) continue;
        random -= w.weight;
        if (random <= 0) {
          selected.push(w.miner);
          used.add(w.miner.uid);
          break;
        }
      }
      if (selected.length < count && used.size === selected.length) {
        for (const w of weighted) {
          if (!used.has(w.miner.uid)) {
            selected.push(w.miner);
            used.add(w.miner.uid);
            break;
          }
        }
      }
    }
    return selected;
  }

  getMetrics(): SubnetMetrics {
    return { ...this.metrics };
  }
}

// ── Utility ───────────────────────────────────────────────────────────

function weightedMedian(values: number[], weights: number[]): number {
  const pairs = values
    .map((v, i) => ({ value: v, weight: weights[i] }))
    .sort((a, b) => a.value - b.value);
  const totalWeight = pairs.reduce((s, p) => s + p.weight, 0);
  let cumWeight = 0;
  for (const pair of pairs) {
    cumWeight += pair.weight;
    if (cumWeight >= totalWeight / 2) return pair.value;
  }
  return pairs[pairs.length - 1]?.value ?? 0;
}
