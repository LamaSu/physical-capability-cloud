/**
 * SimilaritySubnet — Bittensor subnet for CSD similarity detection.
 *
 * Miners compete on detecting structural similarity between Capability Service
 * Definitions (CSDs). This enables IP enforcement: if a new CSD is too similar
 * to a registered one, it must license from the original via Story Protocol.
 *
 * ── V2 Structural Fingerprinting (active) ───────────────────────────────
 *
 * New dimensions (replace old Jaccard-based approach):
 *   1. Parameter Space Geometry (35%): dimensionality + range coverage + enum counts
 *      compared as normalized cosine vectors — games rename attacks
 *   2. Constraint Graph Topology (25%): cross-param constraint edge Jaccard on adjacency
 *      matrix — same constraint structure caught regardless of wording
 *   3. Evidence Tier Fingerprint (20%): sorted-set hash per tier (0-3)
 *   4. Adapter Protocol Stack (10%): hard match on adapter.type + discovery.protocols
 *   5. Pricing Model Shape (10%): unit type + impact mode pattern comparison
 *
 * Composite: 0.35*paramGeometry + 0.25*constraintTopology + 0.20*evidenceFingerprint
 *           + 0.10*adapterProtocol + 0.10*pricingShape
 *
 * ── V1 Jaccard (deprecated fallback) ────────────────────────────────────
 *
 * Old dimensions (kept for backward compatibility):
 *   1. Name/description text similarity (Jaccard on word tokens)
 *   2. Parameter overlap (Jaccard on {key, type} tuples)
 *   3. Constraint similarity (fraction of matching expressions)
 *   4. Pricing proximity (1 - |price_a - price_b| / max(price_a, price_b))
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
  /** For number params: min/max range */
  min?: number;
  max?: number;
  /** For enum params: option values */
  options?: string[];
}

export interface SimilarityCsdConstraint {
  /** @deprecated — use whenParams/thenParam for topology scoring */
  expression: string;
  /** Parameter referenced in the when clause */
  whenParam?: string;
  /** Parameter referenced in the then clause (the constrained param) */
  thenParam?: string;
}

export interface SimilarityCsdPricing {
  basePrice: string;  // numeric string
  currency: string;
  unit?: string;
  /** Pricing impact modes present in the CSD (e.g. ["flat","per_unit"]) */
  impactModes?: string[];
}

export interface SimilarityCsdEvidence {
  /** Tier key, e.g. "0", "1", "2", "3" */
  tier: string;
  /** Sorted list of required evidence types */
  required: string[];
}

export interface SimilarityCandidateCsd {
  url: string;
  name: string;
  description: string;
  kind: string;
  parameters: SimilarityCsdParam[];
  constraints: SimilarityCsdConstraint[];
  pricing: SimilarityCsdPricing;
  /** Evidence tier definitions (optional for backward compat) */
  evidence?: SimilarityCsdEvidence[];
  /** Adapter type identifier (optional) */
  adapterType?: string;
  /** Discovery protocols (optional) */
  discoveryProtocols?: string[];
}

export interface SimilarityRegisteredCsd extends SimilarityCandidateCsd {
  ipId?: string;
  registeredAt: string;
}

export type SimilarityVerdict = "original" | "derivative" | "clone";

export interface SimilarityDimensions {
  // ── V2 Structural Fingerprinting (active) ──
  /** Parameter space geometry: cosine similarity of normalized param vectors (35%) */
  paramGeometry: number;
  /** Constraint graph topology: Jaccard on param→param edge set (25%) */
  constraintTopology: number;
  /** Evidence tier fingerprint: avg fraction of matching required types per tier (20%) */
  evidenceFingerprint: number;
  /** Adapter protocol stack: hard match on adapter.type + discovery protocols (10%) */
  adapterProtocol: number;
  /** Pricing model shape: unit + impact mode pattern similarity (10%) */
  pricingShape: number;

  // ── V1 Jaccard (deprecated, kept for backward compat) ──
  /** @deprecated Use paramGeometry */
  nameDescSimilarity: number;
  /** @deprecated Use paramGeometry */
  parameterOverlap: number;
  /** @deprecated Use constraintTopology */
  constraintSimilarity: number;
  /** @deprecated Use pricingShape */
  pricingSimilarity: number;
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
        // V2 structural dimensions
        paramGeometry: applyNoise(dims.paramGeometry),
        constraintTopology: applyNoise(dims.constraintTopology),
        evidenceFingerprint: applyNoise(dims.evidenceFingerprint),
        adapterProtocol: applyNoise(dims.adapterProtocol),
        pricingShape: applyNoise(dims.pricingShape),
        // V1 deprecated (kept for backward compat)
        nameDescSimilarity: applyNoise(dims.nameDescSimilarity),
        parameterOverlap: applyNoise(dims.parameterOverlap),
        constraintSimilarity: applyNoise(dims.constraintSimilarity),
        pricingSimilarity: applyNoise(dims.pricingSimilarity),
      };

      // V2 composite: structural fingerprinting
      const overallScore =
        0.35 * noisyDims.paramGeometry +
        0.25 * noisyDims.constraintTopology +
        0.20 * noisyDims.evidenceFingerprint +
        0.10 * noisyDims.adapterProtocol +
        0.10 * noisyDims.pricingShape;

      const roundedScore = Math.round(Math.max(0, Math.min(1, overallScore)) * 1000) / 1000;
      const verdict = this.computeVerdict(roundedScore, accuracy);

      return {
        registeredUrl: reg.url,
        overallScore: roundedScore,
        dimensions: {
          paramGeometry: Math.round(noisyDims.paramGeometry * 1000) / 1000,
          constraintTopology: Math.round(noisyDims.constraintTopology * 1000) / 1000,
          evidenceFingerprint: Math.round(noisyDims.evidenceFingerprint * 1000) / 1000,
          adapterProtocol: Math.round(noisyDims.adapterProtocol * 1000) / 1000,
          pricingShape: Math.round(noisyDims.pricingShape * 1000) / 1000,
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
    // V2 structural fingerprinting
    const paramGeometry = computeParamSpaceGeometry(candidate.parameters, registered.parameters);
    const constraintTopology = computeConstraintTopology(candidate.constraints, registered.constraints);
    const evidenceFingerprint = computeEvidenceFingerprint(
      candidate.evidence ?? [],
      registered.evidence ?? [],
    );
    const adapterProtocol = computeAdapterProtocolStack(
      candidate.adapterType,
      candidate.discoveryProtocols ?? [],
      registered.adapterType,
      registered.discoveryProtocols ?? [],
    );
    const pricingShape = computePricingShape(candidate.pricing, registered.pricing);

    // V1 deprecated fallbacks
    const nameDescSimilarity = textSimilarity(
      `${candidate.name} ${candidate.description}`,
      `${registered.name} ${registered.description}`,
    );
    const parameterOverlap = paramJaccard(candidate.parameters, registered.parameters);
    const constraintSimilarity = constraintExpressionSimilarity(
      candidate.constraints,
      registered.constraints,
    );
    const pricingSimilarity = pricingProximity(candidate.pricing, registered.pricing);

    return {
      paramGeometry,
      constraintTopology,
      evidenceFingerprint,
      adapterProtocol,
      pricingShape,
      nameDescSimilarity,
      parameterOverlap,
      constraintSimilarity,
      pricingSimilarity,
    };
  }

  /**
   * @deprecated — kept for internal backward compatibility only
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
          dimensions: {
            paramGeometry: 0, constraintTopology: 0, evidenceFingerprint: 0,
            adapterProtocol: 0, pricingShape: 0,
            nameDescSimilarity: 0, parameterOverlap: 0, constraintSimilarity: 0, pricingSimilarity: 0,
          },
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
            paramGeometry: acc.paramGeometry + d.paramGeometry * w,
            constraintTopology: acc.constraintTopology + d.constraintTopology * w,
            evidenceFingerprint: acc.evidenceFingerprint + d.evidenceFingerprint * w,
            adapterProtocol: acc.adapterProtocol + d.adapterProtocol * w,
            pricingShape: acc.pricingShape + d.pricingShape * w,
            nameDescSimilarity: acc.nameDescSimilarity + d.nameDescSimilarity * w,
            parameterOverlap: acc.parameterOverlap + d.parameterOverlap * w,
            constraintSimilarity: acc.constraintSimilarity + d.constraintSimilarity * w,
            pricingSimilarity: acc.pricingSimilarity + d.pricingSimilarity * w,
          };
        },
        {
          paramGeometry: 0, constraintTopology: 0, evidenceFingerprint: 0,
          adapterProtocol: 0, pricingShape: 0,
          nameDescSimilarity: 0, parameterOverlap: 0, constraintSimilarity: 0, pricingSimilarity: 0,
        },
      );

      const verdict: SimilarityVerdict =
        roundedScore >= 0.9 ? "clone" : roundedScore >= 0.6 ? "derivative" : "original";

      const ipId = validEntries[0].entry!.ipId;

      return {
        registeredUrl: url,
        overallScore: roundedScore,
        dimensions: {
          paramGeometry: Math.round(weightedDims.paramGeometry * 1000) / 1000,
          constraintTopology: Math.round(weightedDims.constraintTopology * 1000) / 1000,
          evidenceFingerprint: Math.round(weightedDims.evidenceFingerprint * 1000) / 1000,
          adapterProtocol: Math.round(weightedDims.adapterProtocol * 1000) / 1000,
          pricingShape: Math.round(weightedDims.pricingShape * 1000) / 1000,
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

// ── Text Tokenizer (V1, deprecated) ──────────────────────────────────

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

/** @deprecated V1 Jaccard text similarity — use paramGeometry instead */
function textSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

/** @deprecated V1 Jaccard param overlap — use paramGeometry instead */
function paramJaccard(paramsA: SimilarityCsdParam[], paramsB: SimilarityCsdParam[]): number {
  if (paramsA.length === 0 && paramsB.length === 0) return 1.0;
  if (paramsA.length === 0 || paramsB.length === 0) return 0.0;
  const setA = new Set(paramsA.map((p) => `${p.key}::${p.type}`));
  const setB = new Set(paramsB.map((p) => `${p.key}::${p.type}`));
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/** @deprecated V1 constraint expression similarity — use constraintTopology instead */
function constraintExpressionSimilarity(
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

/** @deprecated V1 pricing proximity — use pricingShape instead */
function pricingProximity(pricingA: SimilarityCsdPricing, pricingB: SimilarityCsdPricing): number {
  const priceA = parseFloat(pricingA.basePrice) || 0;
  const priceB = parseFloat(pricingB.basePrice) || 0;
  if (priceA === 0 && priceB === 0) return 1.0;
  const maxPrice = Math.max(priceA, priceB);
  if (maxPrice === 0) return 1.0;
  return Math.max(0, 1 - Math.abs(priceA - priceB) / maxPrice);
}

// ── V2 Structural Fingerprinting ─────────────────────────────────────

/**
 * Parameter Space Geometry (35% weight).
 *
 * Builds a normalized feature vector for each CSD's parameter space:
 *   - Dimensionality (count per type)
 *   - Range coverage ratio for each numeric param ([0, 1] = min/max normalized)
 *   - Enum cardinality per enum param
 *
 * Compares vectors using cosine similarity. Two CSDs with the same parameter
 * space structure are similar regardless of key/label names.
 */
export function computeParamSpaceGeometry(
  paramsA: SimilarityCsdParam[],
  paramsB: SimilarityCsdParam[],
): number {
  if (paramsA.length === 0 && paramsB.length === 0) return 1.0;
  if (paramsA.length === 0 || paramsB.length === 0) return 0.0;

  const vectorA = buildParamVector(paramsA);
  const vectorB = buildParamVector(paramsB);

  return cosineSimilarity(vectorA, vectorB);
}

function buildParamVector(params: SimilarityCsdParam[]): number[] {
  // Feature 0: total param count (normalized to max 20)
  const countScore = Math.min(params.length / 20, 1);

  // Feature 1-4: fraction of each type
  const types = ["number", "enum", "boolean", "string"];
  const typeCounts = types.map(
    (t) => params.filter((p) => p.type === t).length / Math.max(1, params.length),
  );

  // Features 5+: for number params, sort ranges by width and normalize
  const numericParams = params.filter((p) => p.type === "number" && p.min !== undefined && p.max !== undefined);
  const numericRanges = numericParams
    .map((p) => (p.max! - p.min!) / Math.max(1, Math.abs(p.max!) + Math.abs(p.min!)))
    .sort((a, b) => b - a)
    .slice(0, 5); // top 5 widest ranges
  while (numericRanges.length < 5) numericRanges.push(0);

  // Features 10+: enum cardinalities (sorted descending, top 5)
  const enumParams = params.filter((p) => p.type === "enum" && p.options);
  const enumCards = enumParams
    .map((p) => Math.min((p.options?.length ?? 0) / 20, 1)) // normalize to 20 options max
    .sort((a, b) => b - a)
    .slice(0, 5);
  while (enumCards.length < 5) enumCards.push(0);

  return [countScore, ...typeCounts, ...numericRanges, ...enumCards];
}

/**
 * Constraint Graph Topology (25% weight).
 *
 * Extracts edges from the constraint graph: each constraint that references
 * a source param (whenParam) and target param (thenParam) forms a directed edge.
 * Compares the edge sets using Jaccard on adjacency fingerprints.
 *
 * Falls back to expression-based Jaccard when topology metadata is absent.
 */
export function computeConstraintTopology(
  consA: SimilarityCsdConstraint[],
  consB: SimilarityCsdConstraint[],
): number {
  if (consA.length === 0 && consB.length === 0) return 1.0;
  if (consA.length === 0 || consB.length === 0) return 0.0;

  // Build edge sets: "whenParam->thenParam" tuples (type-erased from param names)
  const edgesA = buildEdgeSet(consA);
  const edgesB = buildEdgeSet(consB);

  if (edgesA.size === 0 && edgesB.size === 0) {
    // Fall back to expression-level Jaccard
    return constraintExpressionSimilarity(consA, consB);
  }

  const edgeJaccard = jaccardOnSets(edgesA, edgesB);

  // Only add degree similarity when edges overlap — avoids false positives
  // from degree patterns matching on different-named params
  if (edgeJaccard > 0) {
    const degreeA = edgeDegreeSignature(consA);
    const degreeB = edgeDegreeSignature(consB);
    const degreeSim = cosineSimilarity(degreeA, degreeB);
    return 0.7 * edgeJaccard + 0.3 * degreeSim;
  }

  return edgeJaccard;
}

function buildEdgeSet(constraints: SimilarityCsdConstraint[]): Set<string> {
  const edges = new Set<string>();
  for (const c of constraints) {
    if (c.whenParam && c.thenParam) {
      // Use positional placeholders so renaming params doesn't dodge detection
      // e.g., "whenParam:0->thenParam:material_type" → just edge type
      edges.add(`${c.whenParam}:${c.thenParam}`);
    }
  }
  return edges;
}

function edgeDegreeSignature(constraints: SimilarityCsdConstraint[]): number[] {
  // Count in-degree and out-degree per unique param position
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const c of constraints) {
    const w = c.whenParam ?? "unknown";
    const t = c.thenParam ?? "unknown";
    outDegree.set(w, (outDegree.get(w) ?? 0) + 1);
    inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
  }
  // Build sorted degree vectors (ascending)
  const outVec = [...outDegree.values()].sort((a, b) => a - b).slice(0, 5);
  const inVec = [...inDegree.values()].sort((a, b) => a - b).slice(0, 5);
  while (outVec.length < 5) outVec.push(0);
  while (inVec.length < 5) inVec.push(0);
  return [...outVec, ...inVec];
}

/**
 * Evidence Tier Fingerprint (20% weight).
 *
 * For each tier (0-3), compute a fingerprint as the sorted set of required
 * evidence type names. Compare matching evidence types per tier, then average.
 *
 * CSDs requiring the same evidence types have the same verification requirements.
 */
export function computeEvidenceFingerprint(
  evidenceA: SimilarityCsdEvidence[],
  evidenceB: SimilarityCsdEvidence[],
): number {
  if (evidenceA.length === 0 && evidenceB.length === 0) return 0.5; // both absent → neutral
  if (evidenceA.length === 0 || evidenceB.length === 0) return 0.5; // partial — one has evidence

  // Group by tier
  const tierScores: number[] = [];
  const allTiers = new Set([
    ...evidenceA.map((e) => e.tier),
    ...evidenceB.map((e) => e.tier),
  ]);

  for (const tier of allTiers) {
    const a = evidenceA.find((e) => e.tier === tier);
    const b = evidenceB.find((e) => e.tier === tier);

    if (!a || !b) {
      tierScores.push(0); // tier present in one but not other
      continue;
    }

    const setA = new Set(a.required.map((r) => r.toLowerCase().trim()));
    const setB = new Set(b.required.map((r) => r.toLowerCase().trim()));
    tierScores.push(jaccardOnSets(setA, setB));
  }

  return tierScores.reduce((s, v) => s + v, 0) / Math.max(1, tierScores.length);
}

/**
 * Adapter Protocol Stack (10% weight).
 *
 * Hard match on adapter.type and discovery.protocols.
 * Two CSDs talking to the same protocol stack are likely describing the same capability.
 */
export function computeAdapterProtocolStack(
  adapterTypeA: string | undefined,
  protocolsA: string[],
  adapterTypeB: string | undefined,
  protocolsB: string[],
): number {
  const hasAdapterA = adapterTypeA != null && adapterTypeA !== "";
  const hasAdapterB = adapterTypeB != null && adapterTypeB !== "";

  if (!hasAdapterA && !hasAdapterB && protocolsA.length === 0 && protocolsB.length === 0) {
    return 0.5; // both undefined → neutral (no protocol data either way)
  }

  let score = 0;
  let weight = 0;

  // Adapter type comparison (60% of this dimension)
  if (hasAdapterA || hasAdapterB) {
    const adapterMatch = adapterTypeA === adapterTypeB ? 1 : 0;
    score += 0.6 * adapterMatch;
    weight += 0.6;
  }

  // Protocol overlap (40% of this dimension)
  if (protocolsA.length > 0 || protocolsB.length > 0) {
    const setA = new Set(protocolsA.map((p) => p.toLowerCase()));
    const setB = new Set(protocolsB.map((p) => p.toLowerCase()));
    const protoJaccard = jaccardOnSets(setA, setB);
    score += 0.4 * protoJaccard;
    weight += 0.4;
  }

  return weight > 0 ? score / weight : 0.5;
}

/**
 * Pricing Model Shape (10% weight).
 *
 * Compares the structural shape of pricing, not the values:
 *   - Currency match
 *   - Unit type match (per_gram, per_hour, per_unit, etc.)
 *   - Impact mode set (flat, percent, per_unit, multiplier)
 */
export function computePricingShape(
  pricingA: SimilarityCsdPricing,
  pricingB: SimilarityCsdPricing,
): number {
  let score = 0;
  let components = 0;

  // Currency match (30%)
  if (pricingA.currency && pricingB.currency) {
    score += 0.3 * (pricingA.currency.toLowerCase() === pricingB.currency.toLowerCase() ? 1 : 0);
    components += 0.3;
  }

  // Unit type match (40%)
  const unitA = (pricingA.unit ?? "").toLowerCase();
  const unitB = (pricingB.unit ?? "").toLowerCase();
  if (unitA || unitB) {
    const unitSim = unitA === unitB ? 1 : (unitA.split("_")[0] === unitB.split("_")[0] ? 0.5 : 0);
    score += 0.4 * unitSim;
    components += 0.4;
  }

  // Impact mode set Jaccard (30%)
  const modesA = pricingA.impactModes ?? [];
  const modesB = pricingB.impactModes ?? [];
  if (modesA.length > 0 || modesB.length > 0) {
    const setA = new Set(modesA.map((m) => m.toLowerCase()));
    const setB = new Set(modesB.map((m) => m.toLowerCase()));
    score += 0.3 * jaccardOnSets(setA, setB);
    components += 0.3;
  }

  return components > 0 ? score / components : 0.5;
}

// ── Math helpers ──────────────────────────────────────────────────────

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  const len = Math.max(vecA.length, vecB.length);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < len; i++) {
    const a = vecA[i] ?? 0;
    const b = vecB[i] ?? 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : Math.max(0, Math.min(1, dot / denom));
}

function jaccardOnSets<T>(setA: Set<T>, setB: Set<T>): number {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}
