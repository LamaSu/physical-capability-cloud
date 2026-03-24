/**
 * SimilaritySubnet — Bittensor subnet for CSD similarity detection.
 *
 * Miners compete on detecting structural similarity between Capability Service
 * Definitions (CSDs). This enables IP enforcement: if a new CSD is too similar
 * to a registered one, it must license from the original via Story Protocol.
 *
 * Four similarity dimensions:
 *   1. Name/description text similarity (Jaccard on word tokens)
 *   2. Parameter overlap (Jaccard on {key, type} tuples)
 *   3. Constraint similarity (fraction of matching expressions)
 *   4. Pricing proximity (1 - |price_a - price_b| / max(price_a, price_b))
 *
 * Composite: 0.3 * nameSim + 0.35 * paramOverlap + 0.25 * constraintSim + 0.1 * pricingSim
 *
 * Verdict thresholds:
 *   >= 0.9 → "clone"
 *   >= 0.6 → "derivative"
 *   <  0.6 → "original"
 */

import type { MinerInfo, SubnetMetrics } from "./types.js";
import { type MinerQuality } from "./mock-miner.js";

// ── CSD shapes (simplified — no Zod deps needed in subnet code) ──────

export interface SimilarityCsdParam {
  key: string;
  type: string;
  label: string;
}

export interface SimilarityCsdConstraint {
  expression: string;
}

export interface SimilarityCsdPricing {
  basePrice: string;  // numeric string
  currency: string;
  unit?: string;
}

export interface SimilarityCandidateCsd {
  url: string;
  name: string;
  description: string;
  kind: string;
  parameters: SimilarityCsdParam[];
  constraints: SimilarityCsdConstraint[];
  pricing: SimilarityCsdPricing;
}

export interface SimilarityRegisteredCsd extends SimilarityCandidateCsd {
  ipId?: string;
  registeredAt: string;
}

export type SimilarityVerdict = "original" | "derivative" | "clone";

export interface SimilarityDimensions {
  nameDescSimilarity: number;   // text similarity (Jaccard on words)
  parameterOverlap: number;     // Jaccard on {key, type} tuples
  constraintSimilarity: number; // fraction of matching constraint expressions
  pricingSimilarity: number;    // price proximity
}

export interface SimilarityEntry {
  registeredUrl: string;
  overallScore: number;
  dimensions: SimilarityDimensions;
  verdict: SimilarityVerdict;
  ipId?: string;
}

export interface SimilarityScoringSynapse {
  candidateCsd: SimilarityCandidateCsd;
  registeredCsds: SimilarityRegisteredCsd[];
  // --- Response (filled by miners) ---
  similarities?: SimilarityEntry[];
  processingTimeMs?: number;
}

// ── Result ───────────────────────────────────────────────────────────

export interface SimilarityResult {
  /** Consensus similarity entries, one per registered CSD */
  similarities: SimilarityEntry[];
  /** Number of miners that participated */
  minerCount: number;
  /** Time taken for the full round (ms) */
  totalTimeMs: number;
}

// ── Similarity Miner ─────────────────────────────────────────────────

const QUALITY_ACCURACY: Record<MinerQuality, number> = {
  excellent: 0.95,
  good: 0.80,
  mediocre: 0.55,
  poor: 0.30,
};

class SimilarityMiner {
  readonly uid: number;
  readonly hotkey: string;
  readonly quality: MinerQuality;
  readonly stake: number;
  private trust: number;
  private incentive: number = 0;

  constructor(uid: number, quality: MinerQuality = "good", stake: number = 1000) {
    this.uid = uid;
    this.hotkey = `5S${uid.toString(16).padStart(46, "0")}`;
    this.quality = quality;
    this.stake = stake;
    this.trust = QUALITY_ACCURACY[quality];
  }

  async forward(synapse: SimilarityScoringSynapse): Promise<SimilarityScoringSynapse> {
    const start = Date.now();
    const result = { ...synapse };
    const accuracy = QUALITY_ACCURACY[this.quality];
    const noise = (1 - accuracy) * 0.15; // noise on similarity scores

    const similarities: SimilarityEntry[] = synapse.registeredCsds.map((reg) => {
      const dims = this.computeDimensions(synapse.candidateCsd, reg);

      // Add quality-proportional noise
      const applyNoise = (v: number) =>
        Math.max(0, Math.min(1, v + (Math.random() - 0.5) * noise));

      const noisyDims: SimilarityDimensions = {
        nameDescSimilarity: applyNoise(dims.nameDescSimilarity),
        parameterOverlap: applyNoise(dims.parameterOverlap),
        constraintSimilarity: applyNoise(dims.constraintSimilarity),
        pricingSimilarity: applyNoise(dims.pricingSimilarity),
      };

      const overallScore =
        0.30 * noisyDims.nameDescSimilarity +
        0.35 * noisyDims.parameterOverlap +
        0.25 * noisyDims.constraintSimilarity +
        0.10 * noisyDims.pricingSimilarity;

      const roundedScore = Math.round(Math.max(0, Math.min(1, overallScore)) * 1000) / 1000;
      const verdict = this.computeVerdict(roundedScore, accuracy);

      return {
        registeredUrl: reg.url,
        overallScore: roundedScore,
        dimensions: {
          nameDescSimilarity: Math.round(noisyDims.nameDescSimilarity * 1000) / 1000,
          parameterOverlap: Math.round(noisyDims.parameterOverlap * 1000) / 1000,
          constraintSimilarity: Math.round(noisyDims.constraintSimilarity * 1000) / 1000,
          pricingSimilarity: Math.round(noisyDims.pricingSimilarity * 1000) / 1000,
        },
        verdict,
        ipId: reg.ipId,
      };
    });

    result.similarities = similarities;
    result.processingTimeMs = Math.round(Date.now() - start + 15 + Math.random() * 70);
    return result;
  }

  private computeDimensions(
    candidate: SimilarityCandidateCsd,
    registered: SimilarityRegisteredCsd,
  ): SimilarityDimensions {
    return {
      nameDescSimilarity: this.textSimilarity(
        `${candidate.name} ${candidate.description}`,
        `${registered.name} ${registered.description}`,
      ),
      parameterOverlap: this.paramJaccard(candidate.parameters, registered.parameters),
      constraintSimilarity: this.constraintSimilarity(candidate.constraints, registered.constraints),
      pricingSimilarity: this.pricingSimilarity(candidate.pricing, registered.pricing),
    };
  }

  /**
   * Jaccard similarity on word tokens (lowercase, stripped of punctuation).
   * Simple, deterministic, no NLP deps.
   */
  private textSimilarity(a: string, b: string): number {
    const tokensA = tokenize(a);
    const tokensB = tokenize(b);
    if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
    if (tokensA.size === 0 || tokensB.size === 0) return 0.0;
    const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
    const union = new Set([...tokensA, ...tokensB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Jaccard index on {key, type} tuples from param lists.
   */
  private paramJaccard(
    paramsA: SimilarityCsdParam[],
    paramsB: SimilarityCsdParam[],
  ): number {
    if (paramsA.length === 0 && paramsB.length === 0) return 1.0;
    if (paramsA.length === 0 || paramsB.length === 0) return 0.0;
    const setA = new Set(paramsA.map((p) => `${p.key}::${p.type}`));
    const setB = new Set(paramsB.map((p) => `${p.key}::${p.type}`));
    const intersection = [...setA].filter((t) => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Fraction of constraint expressions that match exactly (after normalization).
   */
  private constraintSimilarity(
    consA: SimilarityCsdConstraint[],
    consB: SimilarityCsdConstraint[],
  ): number {
    if (consA.length === 0 && consB.length === 0) return 1.0;
    if (consA.length === 0 || consB.length === 0) return 0.0;
    const setA = new Set(consA.map((c) => c.expression.trim().toLowerCase()));
    const setB = new Set(consB.map((c) => c.expression.trim().toLowerCase()));
    const intersection = [...setA].filter((e) => setB.has(e)).length;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Pricing proximity: 1 - |price_a - price_b| / max(price_a, price_b)
   */
  private pricingSimilarity(
    pricingA: SimilarityCsdPricing,
    pricingB: SimilarityCsdPricing,
  ): number {
    const priceA = parseFloat(pricingA.basePrice) || 0;
    const priceB = parseFloat(pricingB.basePrice) || 0;
    if (priceA === 0 && priceB === 0) return 1.0;
    const maxPrice = Math.max(priceA, priceB);
    if (maxPrice === 0) return 1.0;
    return Math.max(0, 1 - Math.abs(priceA - priceB) / maxPrice);
  }

  /**
   * Apply verdict with quality-based noise.
   * Poor miners may mis-classify: originals become derivatives, clones are missed.
   */
  private computeVerdict(score: number, accuracy: number): SimilarityVerdict {
    // Noise may shift effective score slightly for poor miners
    const noisyScore = accuracy < 0.5
      ? score + (Math.random() - 0.5) * 0.15
      : score;

    if (noisyScore >= 0.9) return "clone";
    if (noisyScore >= 0.6) return "derivative";
    return "original";
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

export class SimilaritySubnet {
  private miners: SimilarityMiner[] = [];
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
      const miner = new SimilarityMiner(i, quality, Math.round(stake));
      this.miners.push(miner);
      this.weights.set(i, 1.0 / count);
    }
    this.metrics.activeMinerCount = count;
  }

  async detectSimilarity(synapse: SimilarityScoringSynapse): Promise<SimilarityResult> {
    const start = Date.now();
    if (this.miners.length === 0) throw new Error("No similarity miners available");

    const numToQuery = Math.min(5, this.miners.length);
    const selected = this.selectMiners(numToQuery);

    const responses = await Promise.all(selected.map((m) => m.forward({ ...synapse })));

    // For each registered CSD, compute stake-weighted consensus score and verdict
    const registeredUrls = synapse.registeredCsds.map((r) => r.url);
    const consensusSimilarities: SimilarityEntry[] = registeredUrls.map((url) => {
      const minerEntries = responses.map((r, i) => {
        const entry = (r.similarities ?? []).find((s) => s.registeredUrl === url);
        return { entry, stake: selected[i].stake };
      });

      const validEntries = minerEntries.filter((e) => e.entry != null);
      if (validEntries.length === 0) {
        return {
          registeredUrl: url,
          overallScore: 0,
          dimensions: { nameDescSimilarity: 0, parameterOverlap: 0, constraintSimilarity: 0, pricingSimilarity: 0 },
          verdict: "original" as SimilarityVerdict,
        };
      }

      const totalStake = validEntries.reduce((s, e) => s + e.stake, 0);
      const weightedScore = validEntries.reduce((s, e) => s + e.entry!.overallScore * e.stake, 0) / totalStake;
      const roundedScore = Math.round(Math.max(0, Math.min(1, weightedScore)) * 1000) / 1000;

      const weightedDims = validEntries.reduce(
        (acc, e) => {
          const d = e.entry!.dimensions;
          const w = e.stake / totalStake;
          return {
            nameDescSimilarity: acc.nameDescSimilarity + d.nameDescSimilarity * w,
            parameterOverlap: acc.parameterOverlap + d.parameterOverlap * w,
            constraintSimilarity: acc.constraintSimilarity + d.constraintSimilarity * w,
            pricingSimilarity: acc.pricingSimilarity + d.pricingSimilarity * w,
          };
        },
        { nameDescSimilarity: 0, parameterOverlap: 0, constraintSimilarity: 0, pricingSimilarity: 0 },
      );

      const verdict: SimilarityVerdict =
        roundedScore >= 0.9 ? "clone" : roundedScore >= 0.6 ? "derivative" : "original";

      const ipId = validEntries[0].entry!.ipId;

      return {
        registeredUrl: url,
        overallScore: roundedScore,
        dimensions: {
          nameDescSimilarity: Math.round(weightedDims.nameDescSimilarity * 1000) / 1000,
          parameterOverlap: Math.round(weightedDims.parameterOverlap * 1000) / 1000,
          constraintSimilarity: Math.round(weightedDims.constraintSimilarity * 1000) / 1000,
          pricingSimilarity: Math.round(weightedDims.pricingSimilarity * 1000) / 1000,
        },
        verdict,
        ipId,
      };
    });

    // Update weights using proximity to consensus
    const avgConsensusScore =
      consensusSimilarities.reduce((s, e) => s + e.overallScore, 0) / Math.max(1, consensusSimilarities.length);

    for (let i = 0; i < selected.length; i++) {
      const miner = selected[i];
      const minerAvg = (responses[i].similarities ?? []).reduce((s, e) => s + e.overallScore, 0) /
        Math.max(1, (responses[i].similarities ?? []).length);
      const distance = Math.abs(minerAvg - avgConsensusScore);
      const cw = Math.max(0, 1 - distance * 2);
      const cur = this.weights.get(miner.uid) ?? 0;
      this.weights.set(miner.uid, cur * 0.7 + cw * 0.3);
      const info = miner.getInfo();
      miner.updateScores(info.trust * 0.8 + cw * 0.2, cw);
    }

    this.metrics.totalVerifications++;
    const prev = this.metrics.totalVerifications - 1;
    this.metrics.averageScore =
      (this.metrics.averageScore * prev + avgConsensusScore) / this.metrics.totalVerifications;
    this.metrics.lastEpochRewards =
      [...this.weights.values()].reduce((s, w) => s + w, 0) * 10;

    return {
      similarities: consensusSimilarities,
      minerCount: selected.length,
      totalTimeMs: Date.now() - start,
    };
  }

  private selectMiners(count: number): SimilarityMiner[] {
    if (count >= this.miners.length) return [...this.miners];
    const weighted = this.miners.map((m) => ({
      miner: m,
      weight: (this.weights.get(m.uid) ?? 0) * m.stake,
    }));
    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    const selected: SimilarityMiner[] = [];
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

// ── Text Tokenizer ────────────────────────────────────────────────────

/**
 * Tokenize a string into a set of lowercase word tokens (alpha-numeric only).
 * Common stop words are excluded to focus on semantically meaningful terms.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "for", "to", "with", "is", "are",
  "at", "on", "by", "from", "that", "this", "it", "be", "as", "was", "can",
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return new Set(tokens);
}
