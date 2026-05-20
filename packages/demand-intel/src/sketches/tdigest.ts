/**
 * T-Digest — approximate quantile sketch.
 *
 * For PCC demand-intel: compute budget percentiles (p25/p50/p75/p90/p99)
 * over a windowed stream of budget upper bounds without storing every value.
 *
 * Implementation: a simplified merge-sketch variant of Dunning & Ertl 2019.
 * Compression parameter δ controls accuracy vs size: higher δ = more precise
 * around extremes. δ=100 is a common production setting (~2KB state).
 *
 * Algorithm summary:
 *   - Maintain a list of (mean, weight) centroids sorted by mean
 *   - On insert, find nearest centroid; if its weight is below a
 *     scale-function-derived max, absorb the new point; else add a new
 *     centroid
 *   - Periodically compress: re-sort and re-bucket within scale-function
 *     constraints
 *   - Quantile estimate: interpolate across centroid positions
 *
 * No external deps. Pure ESM.
 */

interface Centroid {
  /** running mean of the points absorbed into this centroid */
  mean: number;
  /** count of points absorbed */
  weight: number;
}

const DEFAULT_COMPRESSION = 100;
/** Compress when buffer exceeds this multiple of compression */
const COMPRESS_TRIGGER = 10;

export interface TDigestSerialized {
  compression: number;
  centroids: Array<{ m: number; w: number }>;
  totalWeight: number;
}

export class TDigest {
  private readonly compression: number;
  private centroids: Centroid[] = [];
  private totalWeight = 0;
  /** unmerged points buffered between compressions for amortized efficiency */
  private buffer: Centroid[] = [];

  constructor(compression: number = DEFAULT_COMPRESSION) {
    if (compression < 10) {
      throw new Error(`compression must be >= 10, got ${compression}`);
    }
    this.compression = compression;
  }

  add(value: number, weight: number = 1): void {
    this.buffer.push({ mean: value, weight });
    this.totalWeight += weight;
    if (this.buffer.length > this.compression * COMPRESS_TRIGGER) {
      this.compress();
    }
  }

  /** Merge buffered points into centroids and resort */
  private compress(): void {
    if (this.buffer.length === 0) return;
    const all = [...this.centroids, ...this.buffer];
    all.sort((a, b) => a.mean - b.mean);

    const merged: Centroid[] = [];
    let cumWeight = 0;
    const total = this.totalWeight;
    const delta = this.compression;

    for (const c of all) {
      if (merged.length === 0) {
        merged.push({ ...c });
        cumWeight += c.weight;
        continue;
      }
      const last = merged[merged.length - 1]!;
      const proposedWeight = last.weight + c.weight;
      // Scale function k(q) = δ * (asin(2q - 1) / π + 1/2). Allowable weight
      // for a centroid at quantile q is roughly total / (4δ * q * (1-q)).
      const q = (cumWeight + last.weight / 2) / total;
      const allowable = total / (4 * delta * Math.max(q * (1 - q), 1e-12));
      if (proposedWeight <= allowable) {
        // Absorb
        last.mean = (last.mean * last.weight + c.mean * c.weight) / proposedWeight;
        last.weight = proposedWeight;
      } else {
        merged.push({ ...c });
      }
      cumWeight += c.weight;
    }

    this.centroids = merged;
    this.buffer = [];
  }

  quantile(q: number): number {
    if (q < 0 || q > 1) throw new Error(`quantile q must be in [0,1], got ${q}`);
    this.compress();
    if (this.centroids.length === 0) return NaN;
    if (this.centroids.length === 1) return this.centroids[0]!.mean;

    const target = q * this.totalWeight;
    let cum = 0;
    for (let i = 0; i < this.centroids.length; i++) {
      const c = this.centroids[i]!;
      // The centroid's "center" sits at cum + w/2 in the cumulative order
      const center = cum + c.weight / 2;
      if (target <= center) {
        if (i === 0) return c.mean;
        const prev = this.centroids[i - 1]!;
        const prevCenter = cum - prev.weight / 2;
        const span = center - prevCenter;
        if (span <= 0) return c.mean;
        const t = (target - prevCenter) / span;
        return prev.mean + t * (c.mean - prev.mean);
      }
      cum += c.weight;
    }
    return this.centroids[this.centroids.length - 1]!.mean;
  }

  merge(other: TDigest): void {
    if (other.compression !== this.compression) {
      // Different compression is allowed in principle; we just keep ours.
    }
    other.compress();
    for (const c of other.centroids) {
      this.buffer.push({ ...c });
      this.totalWeight += c.weight;
    }
    this.compress();
  }

  serialize(): string {
    this.compress();
    const payload: TDigestSerialized = {
      compression: this.compression,
      centroids: this.centroids.map((c) => ({ m: c.mean, w: c.weight })),
      totalWeight: this.totalWeight,
    };
    return JSON.stringify(payload);
  }

  static deserialize(s: string): TDigest {
    const parsed = JSON.parse(s) as TDigestSerialized;
    const td = new TDigest(parsed.compression);
    td.centroids = parsed.centroids.map((c) => ({ mean: c.m, weight: c.w }));
    td.totalWeight = parsed.totalWeight;
    return td;
  }

  get count(): number {
    return this.totalWeight;
  }
}
