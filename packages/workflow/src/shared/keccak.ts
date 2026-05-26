/**
 * Pure-TypeScript Keccak-256 implementation (EVM-compatible hashing).
 *
 * This is a minimal, zero-dependency Keccak-f[1600] permutation plus the
 * "Keccak" sponge — which matches Ethereum's keccak256 (NOT the FIPS-202
 * SHA-3 variant, which differs only in padding).
 *
 * Reference: the Keccak specification (Bertoni, Daemen, Peeters, Van Assche)
 * https://keccak.team/files/Keccak-reference-3.0.pdf
 *
 * We use BigInt for 64-bit lane arithmetic to avoid the complexity of
 * hand-rolled {hi, lo} split arithmetic. Performance is adequate for the
 * single-key-per-activity rate we expect; if it ever becomes a hotspot,
 * we can swap in @noble/hashes as a vetted dep via Gate A.
 */

const MASK64 = (1n << 64n) - 1n;

/** Keccak-256 block size in bytes (rate). For Keccak-256: r = 1088 bits = 136 bytes. */
const KECCAK_256_RATE = 136;

/** Round constants for Keccak-f[1600]. */
const RC: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/** Rotation offsets for Rho/Pi, indexed by (x, y) lane in the 5x5 state. */
const R: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

/** 64-bit left rotate. */
function rotl64(x: bigint, n: number): bigint {
  const shift = BigInt(n);
  return (((x << shift) & MASK64) | (x >> (64n - shift))) & MASK64;
}

/** Keccak-f[1600] permutation: 24 rounds over the 5x5 state of 64-bit lanes. */
function keccakF(state: BigInt64Array): void {
  // Copy to a mutable bigint[] for in-place manipulation.
  const s: bigint[] = new Array(25);
  for (let i = 0; i < 25; i++) s[i] = BigInt.asUintN(64, state[i]);

  for (let round = 0; round < 24; round++) {
    // THETA
    const C: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!;
    }
    const D: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5]! ^ rotl64(C[(x + 1) % 5]!, 1);
    }
    for (let i = 0; i < 25; i++) {
      s[i] = (s[i]! ^ D[i % 5]!) & MASK64;
    }

    // RHO + PI
    const B: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        B[j] = rotl64(s[i]!, R[i]!);
      }
    }

    // CHI
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        s[x + 5 * y] = (B[x + 5 * y]! ^ (~B[((x + 1) % 5) + 5 * y]! & B[((x + 2) % 5) + 5 * y]!)) & MASK64;
      }
    }

    // IOTA
    s[0] = (s[0]! ^ RC[round]!) & MASK64;
  }

  for (let i = 0; i < 25; i++) state[i] = s[i]!;
}

/**
 * Keccak-256 (NOT SHA3-256 — uses 0x01 padding per Ethereum).
 * @param message raw bytes to hash
 * @returns 32-byte digest
 */
export function keccak_256(message: Uint8Array): Uint8Array {
  const state = new BigInt64Array(25);
  const rate = KECCAK_256_RATE;

  // Absorb phase
  const blocks = Math.floor(message.length / rate);
  for (let b = 0; b < blocks; b++) {
    absorbBlock(state, message.subarray(b * rate, (b + 1) * rate));
    keccakF(state);
  }

  // Pad final block (multi-rate padding with Keccak's 0x01 domain separator).
  const lastOffset = blocks * rate;
  const remaining = message.length - lastOffset;
  const padded = new Uint8Array(rate);
  padded.set(message.subarray(lastOffset), 0);
  padded[remaining] = 0x01;          // Keccak-style padding (Ethereum) — SHA3 would use 0x06
  padded[rate - 1] |= 0x80;          // final bit
  absorbBlock(state, padded);
  keccakF(state);

  // Squeeze 32 bytes (256 bits)
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = BigInt.asUintN(64, state[i >> 3]!);
    const byteInLane = i & 7;
    out[i] = Number((lane >> BigInt(byteInLane * 8)) & 0xffn);
  }
  return out;
}

/** XOR a rate-sized block into the sponge state (little-endian lane packing). */
function absorbBlock(state: BigInt64Array, block: Uint8Array): void {
  for (let i = 0; i < block.length; i += 8) {
    let lane = 0n;
    for (let j = 0; j < 8; j++) {
      lane |= BigInt(block[i + j] ?? 0) << BigInt(j * 8);
    }
    const idx = i >> 3;
    state[idx] = BigInt.asIntN(64, BigInt.asUintN(64, state[idx]!) ^ lane);
  }
}
