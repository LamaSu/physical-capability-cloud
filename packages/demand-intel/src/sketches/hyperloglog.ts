/**
 * HyperLogLog — approximate distinct-count sketch.
 *
 * For PCC demand-intel: estimate distinct requester hashes per window with
 * ~6KB state (m=2048 registers) and <1% standard error up to n=1B.
 *
 * Pure TypeScript, no external deps. Pure functions, instance methods, plus
 * serialize/deserialize for round-trip via materialized views.
 *
 * Algorithm refs:
 *   Flajolet, Fusy, Gandouet, Meunier (2007) "HyperLogLog: the analysis of
 *   a near-optimal cardinality estimation algorithm"
 *
 * The constants used here are HLL "classic" — sufficient accuracy for
 * internal aggregation. We don't apply the HLL++ small/large-range bias
 * corrections because PCC traffic in a window is comfortably in the
 * standard accuracy range (10^2 to 10^9).
 */

/** Default register count — m = 2^11 = 2048 (~6KB state with byte registers) */
const DEFAULT_M = 2048;

/** Bias correction constant — α_m for m=2048 */
function alphaM(m: number): number {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

/**
 * FNV-1a 32-bit hash of a UTF-8 string. Cheap, well-distributed enough for
 * sketch usage where we already mix bits via bucket-index extraction.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply by FNV prime 0x01000193 using Math.imul to keep
    // intermediate results inside i32 range.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mix function — applies a second hash round to break linear-congruential
 * artefacts in FNV. Murmur3 finalizer.
 */
function mix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Convert string -> 32-bit hash */
function hashString(s: string): number {
  return mix32(fnv1a32(s));
}

/** Count leading zeros + 1 in the LOW (32 - log2(m)) bits of h, then add 1 */
function rho(value: number, maxBits: number): number {
  // Walk bits from MSB of the value-region to LSB. value already has the
  // bucket bits removed (shifted out by caller). Return position of the
  // first 1-bit plus 1. If value == 0 across maxBits, return maxBits+1.
  if (value === 0) return maxBits + 1;
  let count = 1;
  // Start from bit maxBits-1
  let bit = 1 << (maxBits - 1);
  while ((value & bit) === 0 && bit !== 0) {
    count++;
    bit >>>= 1;
  }
  return count;
}

export interface HLLSerialized {
  m: number;
  registers: number[]; // length = m
}

export class HyperLogLog {
  private readonly m: number;
  private readonly p: number; // log2(m)
  private readonly registers: Uint8Array;

  constructor(m: number = DEFAULT_M) {
    if ((m & (m - 1)) !== 0 || m < 16) {
      throw new Error(`HLL register count must be a power of 2 >= 16, got ${m}`);
    }
    this.m = m;
    this.p = Math.log2(m);
    this.registers = new Uint8Array(m);
  }

  add(hash: string): void {
    const h = hashString(hash);
    // Top p bits = bucket index
    const bucket = h >>> (32 - this.p);
    // Remaining (32 - p) bits = rho input
    const valueBits = 32 - this.p;
    const remainder = (h << this.p) >>> this.p; // mask off top p bits
    // rho needs the MSB-aligned remainder over valueBits bits
    const aligned = remainder >>> 0;
    // Convert aligned (low (valueBits) bits set, top bits zero) to compute rho
    const r = rho(aligned, valueBits);
    if (r > this.registers[bucket]!) {
      this.registers[bucket] = r;
    }
  }

  count(): number {
    // Raw HLL estimate
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < this.m; i++) {
      const reg = this.registers[i]!;
      sum += 1 / Math.pow(2, reg);
      if (reg === 0) zeros++;
    }
    const alpha = alphaM(this.m);
    const estimate = (alpha * this.m * this.m) / sum;

    // Small-range correction (linear counting) when many registers are zero
    if (estimate <= 2.5 * this.m && zeros > 0) {
      return Math.round(this.m * Math.log(this.m / zeros));
    }
    return Math.round(estimate);
  }

  merge(other: HyperLogLog): void {
    if (other.m !== this.m) {
      throw new Error(
        `cannot merge HLLs with different register counts (this=${this.m}, other=${other.m})`,
      );
    }
    for (let i = 0; i < this.m; i++) {
      if (other.registers[i]! > this.registers[i]!) {
        this.registers[i] = other.registers[i]!;
      }
    }
  }

  serialize(): string {
    const payload: HLLSerialized = {
      m: this.m,
      registers: Array.from(this.registers),
    };
    return JSON.stringify(payload);
  }

  static deserialize(s: string): HyperLogLog {
    const parsed = JSON.parse(s) as HLLSerialized;
    const hll = new HyperLogLog(parsed.m);
    if (parsed.registers.length !== parsed.m) {
      throw new Error("HLL deserialize: register count mismatch");
    }
    for (let i = 0; i < parsed.m; i++) {
      hll.registers[i] = parsed.registers[i]!;
    }
    return hll;
  }
}
