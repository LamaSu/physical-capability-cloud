/**
 * Browser-compatible shim for the subset of `node:crypto` that @pcc/spec uses
 * at runtime in the dashboard. The dashboard's vite.config.ts aliases
 * `node:crypto` -> this file, so any code path that imports `createHash`
 * resolves here in browser builds.
 *
 * Why this exists: @pcc/spec was authored as a Node-first library
 * (server-side hash computation, schedule validation, manifest signing).
 * The dashboard nonetheless needs `computeScheduleHash` + `evaluateRateSchedule`
 * client-side so the publish form can show a live hash preview without a
 * round-trip. Without this shim, Vite bombs out with
 * `"createHash" is not exported by "__vite-browser-external"`.
 *
 * What's implemented: just enough of the Node Hash interface to satisfy
 * `createHash("sha256").update(bytes_or_string).digest("hex")`. SHA-256 only
 * because that's the only digest @pcc/spec ever asks for.
 *
 * Implementation: a self-contained synchronous SHA-256 compute. Pure JS,
 * no Web Crypto (which is async via SubtleCrypto and would change the
 * call-site signature). ~50 LOC of well-known FIPS-180-2 reference code.
 */

// SHA-256 round constants (first 32 bits of the fractional parts of the cube
// roots of the first 64 primes 2..311).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const ROTR = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha256(bytes: Uint8Array): Uint8Array {
  // Initial hash values (first 32 bits of the fractional parts of the square
  // roots of the first 8 primes).
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  // Pad the message: append 0x80, then zeros, then a 64-bit big-endian length
  // in bits, so the total length is a multiple of 64 bytes.
  const bitLen = bytes.length * 8;
  const padLen = ((bytes.length + 9 + 63) & ~63) - bytes.length;
  const padded = new Uint8Array(bytes.length + padLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // Length goes in the last 8 bytes, big-endian. We only handle messages up
  // to 2^32 bits — schedules are tiny, so this is plenty.
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0, false);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(off + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = ROTR(W[t - 15], 7) ^ ROTR(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = ROTR(W[t - 2], 17) ^ ROTR(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25);
      const ch = (e & f) ^ (~e & g);
      const T1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const T2 = (S0 + mj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + T1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (T1 + T2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i], false);
  return out;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

class Hash {
  private chunks: Uint8Array[] = [];
  private algo: string;

  constructor(algo: string) {
    if (algo !== "sha256") {
      throw new Error(
        `node-crypto-shim: only sha256 is implemented, got ${algo}`,
      );
    }
    this.algo = algo;
  }

  update(data: Uint8Array | string): this {
    this.chunks.push(toBytes(data));
    return this;
  }

  digest(): Uint8Array;
  digest(encoding: "hex"): string;
  digest(encoding?: "hex"): Uint8Array | string {
    // Concatenate all chunks into one buffer.
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    const out = sha256(all);
    if (encoding === "hex") return bytesToHex(out);
    return out;
  }
}

export function createHash(algo: string): Hash {
  return new Hash(algo);
}

// Some Node tooling expects a default export with `createHash` on it.
export default { createHash };
