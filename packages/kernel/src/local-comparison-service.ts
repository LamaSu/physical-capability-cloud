/**
 * LocalComparisonService — zero-dependency image comparison using pure TypeScript math.
 *
 * Implements two complementary algorithms:
 *   1. Perceptual Hash (pHash): DCT-based hash for fast structural comparison
 *   2. SSIM: Structural Similarity Index for perceptual quality comparison
 *
 * Combined score: 0.4 * pHashSimilarity + 0.6 * ssimScore
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageData {
  /** RGBA pixel data, row-major. Length must equal width * height * 4. */
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface LocalComparisonResult {
  pHashSimilarity: number;  // 0.0–1.0
  ssimScore: number;        // 0.0–1.0
  combinedScore: number;    // weighted average: 0.4 * pHash + 0.6 * SSIM
  verdict: "match" | "partial_match" | "no_match";
  method: "local_phash_ssim";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert RGBA pixels to grayscale (float array, row-major). */
function toGrayscale(image: ImageData): Float64Array {
  const { pixels, width, height } = image;
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 4]!;
    const g = pixels[i * 4 + 1]!;
    const b = pixels[i * 4 + 2]!;
    // Luminance weights (BT.601)
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

/**
 * Bilinear resize of a grayscale Float64Array from srcW x srcH to dstW x dstH.
 * Returns a new Float64Array of size dstW * dstH.
 */
function bilinearResize(
  src: Float64Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float64Array {
  const dst = new Float64Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dstY = 0; dstY < dstH; dstY++) {
    for (let dstX = 0; dstX < dstW; dstX++) {
      // Map destination pixel to source coordinates
      const srcXf = (dstX + 0.5) * xRatio - 0.5;
      const srcYf = (dstY + 0.5) * yRatio - 0.5;

      const x0 = Math.max(0, Math.floor(srcXf));
      const y0 = Math.max(0, Math.floor(srcYf));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const y1 = Math.min(srcH - 1, y0 + 1);

      const dx = srcXf - x0;
      const dy = srcYf - y0;

      // Bilinear interpolation
      const p00 = src[y0 * srcW + x0]!;
      const p01 = src[y0 * srcW + x1]!;
      const p10 = src[y1 * srcW + x0]!;
      const p11 = src[y1 * srcW + x1]!;

      dst[dstY * dstW + dstX] =
        p00 * (1 - dx) * (1 - dy) +
        p01 * dx * (1 - dy) +
        p10 * (1 - dx) * dy +
        p11 * dx * dy;
    }
  }

  return dst;
}

/**
 * Compute 2D DCT-II on an N x N block (in-place on a Float64Array row-major).
 * Uses the separable 1D DCT approach for efficiency.
 *
 * DCT-II formula:
 *   F[k] = sum_{n=0}^{N-1} f[n] * cos(pi * k * (2n + 1) / (2N))
 */
function dct1D(signal: Float64Array, n: number): Float64Array {
  const result = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += signal[i]! * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    }
    result[k] = sum;
  }
  return result;
}

/** 2D DCT on an N x N block stored row-major. Returns new Float64Array. */
function dct2D(block: Float64Array, n: number): Float64Array {
  const temp = new Float64Array(n * n);
  const out = new Float64Array(n * n);

  // Apply 1D DCT to each row
  for (let row = 0; row < n; row++) {
    const rowSlice = block.slice(row * n, row * n + n);
    const rowDct = dct1D(rowSlice, n);
    for (let col = 0; col < n; col++) {
      temp[row * n + col] = rowDct[col]!;
    }
  }

  // Apply 1D DCT to each column of temp
  for (let col = 0; col < n; col++) {
    const colSlice = new Float64Array(n);
    for (let row = 0; row < n; row++) {
      colSlice[row] = temp[row * n + col]!;
    }
    const colDct = dct1D(colSlice, n);
    for (let row = 0; row < n; row++) {
      out[row * n + col] = colDct[row]!;
    }
  }

  return out;
}

/** Compute the median of an array. */
function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/** Extract top-left M x M coefficients from an N x N DCT result (M <= N). */
function topLeftCoefficients(
  dctResult: Float64Array,
  n: number,
  m: number
): Float64Array {
  const coeffs = new Float64Array(m * m);
  for (let row = 0; row < m; row++) {
    for (let col = 0; col < m; col++) {
      coeffs[row * m + col] = dctResult[row * n + col]!;
    }
  }
  return coeffs;
}

/** Compute Hamming distance between two equal-length hex strings. */
function hexHammingDistance(hex1: string, hex2: string): number {
  if (hex1.length !== hex2.length) {
    throw new Error(
      `Hash length mismatch: ${hex1.length} vs ${hex2.length}`
    );
  }
  let distance = 0;
  for (let i = 0; i < hex1.length; i += 2) {
    const byte1 = parseInt(hex1.slice(i, i + 2), 16);
    const byte2 = parseInt(hex2.slice(i, i + 2), 16);
    let xor = byte1 ^ byte2;
    // Count set bits (popcount)
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

// ---------------------------------------------------------------------------
// pHash public API
// ---------------------------------------------------------------------------

const PHASH_RESIZE = 32;  // resize to 32x32 before DCT
const PHASH_DCT_KEEP = 8; // keep top-left 8x8 coefficients (64 values)

/**
 * Compute a perceptual hash (pHash) for an image.
 *
 * Algorithm:
 * 1. Convert to grayscale
 * 2. Resize to 32x32 (bilinear)
 * 3. Compute 2D DCT
 * 4. Take top-left 8x8 DCT coefficients
 * 5. Compute median of the 64 values
 * 6. Produce 64-bit hash (1 if coeff > median, 0 otherwise)
 *
 * Returns a 16-character hex string (64 bits).
 */
export function computePHash(image: ImageData): string {
  const gray = toGrayscale(image);
  const resized = bilinearResize(gray, image.width, image.height, PHASH_RESIZE, PHASH_RESIZE);
  const dct = dct2D(resized, PHASH_RESIZE);
  const coeffs = topLeftCoefficients(dct, PHASH_RESIZE, PHASH_DCT_KEEP);
  const med = median(coeffs);

  // Build 64-bit hash as 8 bytes → 16 hex chars
  let hexHash = "";
  for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      const idx = byteIdx * 8 + bit;
      if (coeffs[idx]! > med) {
        byte |= 1 << (7 - bit);
      }
    }
    hexHash += byte.toString(16).padStart(2, "0");
  }

  return hexHash;
}

/**
 * Compute Hamming distance between two pHash hex strings.
 * Returns an integer in [0, 64].
 */
export function pHashDistance(hash1: string, hash2: string): number {
  return hexHammingDistance(hash1, hash2);
}

/**
 * Compute similarity score from two pHash hex strings.
 * Returns a value in [0.0, 1.0] where 1.0 means identical.
 */
export function pHashSimilarity(hash1: string, hash2: string): number {
  const maxBits = hash1.length * 4; // each hex char = 4 bits
  const distance = hexHammingDistance(hash1, hash2);
  return 1 - distance / maxBits;
}

// ---------------------------------------------------------------------------
// SSIM public API
// ---------------------------------------------------------------------------

const SSIM_WINDOW_SIZE = 8;
const C1 = (0.01 * 255) ** 2;  // 6.5025
const C2 = (0.03 * 255) ** 2;  // 58.5225

/** Compute mean and variance for a window of pixel values. */
function windowStats(
  gray: Float64Array,
  imgW: number,
  startX: number,
  startY: number,
  winW: number,
  winH: number
): { mean: number; variance: number } {
  let sum = 0;
  let sumSq = 0;
  const count = winW * winH;

  for (let y = startY; y < startY + winH; y++) {
    for (let x = startX; x < startX + winW; x++) {
      const v = gray[y * imgW + x]!;
      sum += v;
      sumSq += v * v;
    }
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return { mean, variance };
}

/** Compute cross-covariance between two windows. */
function windowCovariance(
  gray1: Float64Array,
  gray2: Float64Array,
  imgW: number,
  startX: number,
  startY: number,
  winW: number,
  winH: number,
  mean1: number,
  mean2: number
): number {
  let cov = 0;
  const count = winW * winH;

  for (let y = startY; y < startY + winH; y++) {
    for (let x = startX; x < startX + winW; x++) {
      const idx = y * imgW + x;
      cov += (gray1[idx]! - mean1) * (gray2[idx]! - mean2);
    }
  }

  return cov / count;
}

/**
 * Compute SSIM between two images.
 *
 * Algorithm:
 * 1. Convert both to grayscale
 * 2. Resize both to the same dimensions (smaller of the two)
 * 3. Slide an 8x8 window and compute SSIM per window
 * 4. Return mean SSIM across all windows
 *
 * Returns a value in [0.0, 1.0].
 */
export function computeSSIM(image1: ImageData, image2: ImageData): number {
  // Determine target dimensions (use smaller)
  const targetW = Math.min(image1.width, image2.width);
  const targetH = Math.min(image1.height, image2.height);

  // Convert to grayscale
  let gray1 = toGrayscale(image1);
  let gray2 = toGrayscale(image2);

  // Resize if needed
  if (image1.width !== targetW || image1.height !== targetH) {
    gray1 = bilinearResize(gray1, image1.width, image1.height, targetW, targetH);
  }
  if (image2.width !== targetW || image2.height !== targetH) {
    gray2 = bilinearResize(gray2, image2.width, image2.height, targetW, targetH);
  }

  // Handle edge case: image smaller than window
  if (targetW < SSIM_WINDOW_SIZE || targetH < SSIM_WINDOW_SIZE) {
    // Fall back to single full-image SSIM computation
    const s1 = windowStats(gray1, targetW, 0, 0, targetW, targetH);
    const s2 = windowStats(gray2, targetW, 0, 0, targetW, targetH);
    const cov = windowCovariance(
      gray1, gray2, targetW, 0, 0, targetW, targetH, s1.mean, s2.mean
    );
    const num = (2 * s1.mean * s2.mean + C1) * (2 * cov + C2);
    const den = (s1.mean ** 2 + s2.mean ** 2 + C1) * (s1.variance + s2.variance + C2);
    return Math.max(0, Math.min(1, num / den));
  }

  // Slide 8x8 window with stride 1
  let totalSSIM = 0;
  let windowCount = 0;

  const stepsX = targetW - SSIM_WINDOW_SIZE + 1;
  const stepsY = targetH - SSIM_WINDOW_SIZE + 1;

  for (let y = 0; y < stepsY; y++) {
    for (let x = 0; x < stepsX; x++) {
      const s1 = windowStats(gray1, targetW, x, y, SSIM_WINDOW_SIZE, SSIM_WINDOW_SIZE);
      const s2 = windowStats(gray2, targetW, x, y, SSIM_WINDOW_SIZE, SSIM_WINDOW_SIZE);
      const cov = windowCovariance(
        gray1, gray2, targetW,
        x, y, SSIM_WINDOW_SIZE, SSIM_WINDOW_SIZE,
        s1.mean, s2.mean
      );

      const num = (2 * s1.mean * s2.mean + C1) * (2 * cov + C2);
      const den =
        (s1.mean ** 2 + s2.mean ** 2 + C1) *
        (s1.variance + s2.variance + C2);

      const ssimWindow = den === 0 ? 1 : Math.max(0, Math.min(1, num / den));
      totalSSIM += ssimWindow;
      windowCount++;
    }
  }

  if (windowCount === 0) return 1; // degenerate: single pixel images are identical
  return totalSSIM / windowCount;
}

// ---------------------------------------------------------------------------
// LocalComparisonService
// ---------------------------------------------------------------------------

function verdictFromScore(
  combinedScore: number
): "match" | "partial_match" | "no_match" {
  if (combinedScore >= 0.85) return "match";
  if (combinedScore >= 0.55) return "partial_match";
  return "no_match";
}

export class LocalComparisonService {
  compare(captured: ImageData, reference: ImageData): LocalComparisonResult {
    const hash1 = computePHash(captured);
    const hash2 = computePHash(reference);
    const pHashSim = pHashSimilarity(hash1, hash2);
    const ssimSim = computeSSIM(captured, reference);
    const combinedScore = 0.4 * pHashSim + 0.6 * ssimSim;

    return {
      pHashSimilarity: pHashSim,
      ssimScore: ssimSim,
      combinedScore,
      verdict: verdictFromScore(combinedScore),
      method: "local_phash_ssim",
    };
  }
}
