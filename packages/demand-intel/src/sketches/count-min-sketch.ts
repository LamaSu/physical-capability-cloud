/**
 * Count-Min Sketch + top-K heavy hitters.
 *
 * For PCC demand-intel: count occurrences of compositionSignatures per
 * window and return the top-50 heaviest hitters without keeping a hash map
 * of every distinct signature.
 *
 * State: width × depth Uint32Array (~width*depth*4 bytes) + a max-heap of
 * the top-K candidates (~32 entries by default).
 *
 * Defaults: w=2048, d=4, k=50 → ~32KB sketch + ~3KB top-K = ~35KB total.
 *
 * Error bounds: with w=2048 the CMS overestimate is bounded by N/w per
 * counter with high probability. For PCC traffic volumes per hour
 * (10^3-10^5 intents/window) the error is well within acceptable bounds.
 *
 * No external deps. Pure ESM.
 */

const DEFAULT_WIDTH = 2048;
const DEFAULT_DEPTH = 4;
const DEFAULT_K = 50;

/** Pairwise hash seeds — fixed so serialize/deserialize round-trip works */
const SEED_BASE = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];

function fnv1a32(input: string, seed: number): number {
  let hash = (seed >>> 0) ^ 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export interface CMSSerialized {
  width: number;
  depth: number;
  k: number;
  counters: number[]; // length = width * depth
  topK: Array<{ key: string; count: number }>;
}

export interface TopKEntry {
  key: string;
  count: number;
}

export class CountMinSketch {
  private readonly width: number;
  private readonly depth: number;
  private readonly k: number;
  private readonly counters: Uint32Array;
  /** key -> current estimate; small map kept in sync with the heap */
  private readonly topKMap: Map<string, number> = new Map();

  constructor(width: number = DEFAULT_WIDTH, depth: number = DEFAULT_DEPTH, k: number = DEFAULT_K) {
    if (depth > SEED_BASE.length) {
      throw new Error(`max depth=${SEED_BASE.length}, got ${depth}`);
    }
    if (width < 16) throw new Error(`width must be >= 16, got ${width}`);
    if (k < 1) throw new Error(`k must be >= 1, got ${k}`);
    this.width = width;
    this.depth = depth;
    this.k = k;
    this.counters = new Uint32Array(width * depth);
  }

  private bucket(key: string, d: number): number {
    const seed = SEED_BASE[d]!;
    return mix32(fnv1a32(key, seed)) % this.width;
  }

  increment(key: string, n: number = 1): void {
    let minEst = Number.MAX_SAFE_INTEGER;
    for (let d = 0; d < this.depth; d++) {
      const idx = d * this.width + this.bucket(key, d);
      this.counters[idx]! += n;
      const v = this.counters[idx]!;
      if (v < minEst) minEst = v;
    }
    // Maintain top-K
    this.topKMap.set(key, minEst);
    if (this.topKMap.size > this.k) {
      // Drop the smallest entry. We're tracking few enough entries that an
      // O(k) sweep is fine; if k were large we'd switch to a real heap.
      let smallestKey = "";
      let smallestVal = Number.MAX_SAFE_INTEGER;
      for (const [kk, vv] of this.topKMap) {
        if (vv < smallestVal) {
          smallestVal = vv;
          smallestKey = kk;
        }
      }
      // Only drop if the smallest stored entry is actually weaker than minEst
      if (smallestVal < minEst && smallestKey !== key) {
        this.topKMap.delete(smallestKey);
      } else {
        // Newcomer is the weakest — drop it
        this.topKMap.delete(key);
      }
    }
  }

  estimate(key: string): number {
    let minEst = Number.MAX_SAFE_INTEGER;
    for (let d = 0; d < this.depth; d++) {
      const idx = d * this.width + this.bucket(key, d);
      const v = this.counters[idx]!;
      if (v < minEst) minEst = v;
    }
    return minEst === Number.MAX_SAFE_INTEGER ? 0 : minEst;
  }

  topK(k?: number): TopKEntry[] {
    const limit = k ?? this.k;
    const arr: TopKEntry[] = [];
    for (const [key, count] of this.topKMap) {
      arr.push({ key, count });
    }
    arr.sort((a, b) => b.count - a.count);
    return arr.slice(0, limit);
  }

  serialize(): string {
    const payload: CMSSerialized = {
      width: this.width,
      depth: this.depth,
      k: this.k,
      counters: Array.from(this.counters),
      topK: this.topK(this.k),
    };
    return JSON.stringify(payload);
  }

  static deserialize(s: string): CountMinSketch {
    const parsed = JSON.parse(s) as CMSSerialized;
    const cms = new CountMinSketch(parsed.width, parsed.depth, parsed.k);
    if (parsed.counters.length !== parsed.width * parsed.depth) {
      throw new Error("CMS deserialize: counter length mismatch");
    }
    for (let i = 0; i < parsed.counters.length; i++) {
      cms.counters[i] = parsed.counters[i]!;
    }
    for (const entry of parsed.topK) {
      cms.topKMap.set(entry.key, entry.count);
    }
    return cms;
  }
}
