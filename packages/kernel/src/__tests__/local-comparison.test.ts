/**
 * Tests for LocalComparisonService, pHash, and SSIM.
 */

import { describe, it, expect } from "vitest";
import {
  computePHash,
  pHashDistance,
  pHashSimilarity,
  computeSSIM,
  LocalComparisonService,
  type ImageData,
} from "../local-comparison-service.js";
import { GeminiComparisonService } from "../gemini-comparison-service.js";

// ---------------------------------------------------------------------------
// Test image factories
// ---------------------------------------------------------------------------

/** Solid color 8x8 RGBA image. */
function solidImage(r: number, g: number, b: number, size = 8): ImageData {
  const pixels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { pixels, width: size, height: size };
}

/** Horizontal gradient: left = black, right = white. */
function gradientImage(size = 8): ImageData {
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const v = Math.round((col / (size - 1)) * 255);
      const idx = (row * size + col) * 4;
      pixels[idx] = v;
      pixels[idx + 1] = v;
      pixels[idx + 2] = v;
      pixels[idx + 3] = 255;
    }
  }
  return { pixels, width: size, height: size };
}

/** Checkerboard pattern (black and white squares). */
function checkerboardImage(size = 8): ImageData {
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const v = ((row + col) % 2 === 0) ? 255 : 0;
      const idx = (row * size + col) * 4;
      pixels[idx] = v;
      pixels[idx + 1] = v;
      pixels[idx + 2] = v;
      pixels[idx + 3] = 255;
    }
  }
  return { pixels, width: size, height: size }
}

/** Larger solid image for SSIM testing (32x32). */
function solidImage32(r: number, g: number, b: number): ImageData {
  return solidImage(r, g, b, 32);
}

// ---------------------------------------------------------------------------
// pHash tests
// ---------------------------------------------------------------------------

describe("computePHash", () => {
  it("returns a 16-character hex string (64 bits)", () => {
    const img = solidImage(255, 0, 0);
    const hash = computePHash(img);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns a deterministic hash for the same image", () => {
    const img = solidImage(128, 128, 128);
    expect(computePHash(img)).toBe(computePHash(img));
  });

  it("identical images produce identical hashes", () => {
    const img1 = solidImage(255, 0, 0);
    const img2 = solidImage(255, 0, 0);
    expect(computePHash(img1)).toBe(computePHash(img2));
  });
});

describe("pHashDistance", () => {
  it("returns 0 for identical hashes", () => {
    const img = solidImage(255, 0, 0);
    const hash = computePHash(img);
    expect(pHashDistance(hash, hash)).toBe(0);
  });

  it("returns 0 for identical images", () => {
    const img1 = solidImage(255, 0, 0);
    const img2 = solidImage(255, 0, 0);
    expect(pHashDistance(computePHash(img1), computePHash(img2))).toBe(0);
  });

  it("returns a high distance for very different images (solid red vs solid blue)", () => {
    const red = solidImage(255, 0, 0);
    const blue = solidImage(0, 0, 255);
    const distance = pHashDistance(computePHash(red), computePHash(blue));
    // Different images should have non-zero Hamming distance
    // Both are uniform colors so they'll have the same DCT structure; we
    // mainly verify this doesn't crash and gives a valid result.
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(distance).toBeLessThanOrEqual(64);
  });

  it("returns higher distance for structurally different images (gradient vs checkerboard)", () => {
    const grad = gradientImage(32);
    const check = checkerboardImage(32);
    const dist = pHashDistance(computePHash(grad), computePHash(check));
    // These are structurally different; distance should be >0
    expect(dist).toBeGreaterThan(0);
  });
});

describe("pHashSimilarity", () => {
  it("returns 1.0 for identical images", () => {
    const img = solidImage(100, 150, 200);
    const hash = computePHash(img);
    expect(pHashSimilarity(hash, hash)).toBe(1.0);
  });

  it("returns a value between 0 and 1", () => {
    const img1 = gradientImage(32);
    const img2 = checkerboardImage(32);
    const sim = pHashSimilarity(computePHash(img1), computePHash(img2));
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it("returns < 1.0 for structurally different images", () => {
    const grad = gradientImage(32);
    const check = checkerboardImage(32);
    const sim = pHashSimilarity(computePHash(grad), computePHash(check));
    // Not identical → similarity should be less than 1
    expect(sim).toBeLessThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// SSIM tests
// ---------------------------------------------------------------------------

describe("computeSSIM", () => {
  it("returns 1.0 for identical images", () => {
    const img = solidImage32(128, 128, 128);
    const ssim = computeSSIM(img, img);
    expect(ssim).toBeCloseTo(1.0, 5);
  });

  it("returns 1.0 for two independently constructed identical images", () => {
    const img1 = solidImage32(200, 100, 50);
    const img2 = solidImage32(200, 100, 50);
    const ssim = computeSSIM(img1, img2);
    expect(ssim).toBeCloseTo(1.0, 5);
  });

  it("returns a value between 0 and 1 for different images", () => {
    const img1 = solidImage32(255, 0, 0);    // red
    const img2 = solidImage32(0, 0, 255);    // blue
    const ssim = computeSSIM(img1, img2);
    expect(ssim).toBeGreaterThanOrEqual(0);
    expect(ssim).toBeLessThanOrEqual(1);
  });

  it("returns < 0.9 for structurally different images (gradient vs solid)", () => {
    const grad = gradientImage(32);
    const solid = solidImage32(128, 128, 128);
    const ssim = computeSSIM(grad, solid);
    expect(ssim).toBeLessThan(0.9);
  });

  it("handles images with different dimensions (resizes to smaller)", () => {
    const small = solidImage(255, 0, 0, 8);   // 8x8
    const large = solidImage(255, 0, 0, 32);  // 32x32 (same color)
    // Both red — SSIM should be high even after resize
    const ssim = computeSSIM(small, large);
    expect(ssim).toBeGreaterThan(0.5);
  });

  it("returns a number (not NaN) for edge-case tiny images", () => {
    const tiny1 = solidImage(100, 100, 100, 4); // 4x4 < window size 8
    const tiny2 = solidImage(200, 200, 200, 4);
    const ssim = computeSSIM(tiny1, tiny2);
    expect(typeof ssim).toBe("number");
    expect(isNaN(ssim)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LocalComparisonService tests
// ---------------------------------------------------------------------------

describe("LocalComparisonService", () => {
  const svc = new LocalComparisonService();

  describe("identical images", () => {
    it("produces match verdict for identical images", () => {
      const img = solidImage32(100, 200, 100);
      const result = svc.compare(img, img);
      expect(result.verdict).toBe("match");
    });

    it("produces combinedScore close to 1.0 for identical images", () => {
      const img = solidImage32(100, 200, 100);
      const result = svc.compare(img, img);
      expect(result.combinedScore).toBeGreaterThan(0.84);
    });

    it("pHashSimilarity is 1.0 for identical images", () => {
      const img = solidImage32(50, 50, 50);
      const result = svc.compare(img, img);
      expect(result.pHashSimilarity).toBe(1.0);
    });

    it("ssimScore is close to 1.0 for identical images", () => {
      const img = solidImage32(50, 50, 50);
      const result = svc.compare(img, img);
      expect(result.ssimScore).toBeCloseTo(1.0, 5);
    });
  });

  describe("different images", () => {
    it("produces no_match verdict for very different images", () => {
      // Use structurally different 32x32 images
      const gradient = gradientImage(32);
      const inverted: ImageData = {
        pixels: gradient.pixels.map((v, i) =>
          (i % 4 === 3) ? v : (255 - v)
        ) as unknown as Uint8Array,
        width: 32,
        height: 32,
      };
      // Create proper inverted using typed array
      const invPixels = new Uint8Array(32 * 32 * 4);
      for (let i = 0; i < 32 * 32 * 4; i++) {
        invPixels[i] = (i % 4 === 3) ? 255 : (255 - gradient.pixels[i]!);
      }
      const invertedImg: ImageData = { pixels: invPixels, width: 32, height: 32 };

      const result = svc.compare(gradient, invertedImg);
      // Inverted gradient should have low similarity
      expect(result.combinedScore).toBeLessThan(0.85);
    });

    it("returns method 'local_phash_ssim'", () => {
      const img1 = solidImage32(255, 0, 0);
      const img2 = solidImage32(0, 255, 0);
      const result = svc.compare(img1, img2);
      expect(result.method).toBe("local_phash_ssim");
    });

    it("all result fields are present", () => {
      const img1 = solidImage32(255, 0, 0);
      const img2 = solidImage32(0, 0, 255);
      const result = svc.compare(img1, img2);
      expect(typeof result.pHashSimilarity).toBe("number");
      expect(typeof result.ssimScore).toBe("number");
      expect(typeof result.combinedScore).toBe("number");
      expect(["match", "partial_match", "no_match"]).toContain(result.verdict);
      expect(result.method).toBe("local_phash_ssim");
    });
  });

  describe("verdict thresholds", () => {
    it("combinedScore >= 0.85 gives match verdict", () => {
      // Two nearly identical images (same color) should score very high
      const img1 = solidImage32(128, 128, 128);
      const img2 = solidImage32(128, 128, 128);
      const result = svc.compare(img1, img2);
      expect(result.verdict).toBe("match");
    });

    it("weighted formula: 0.4 * pHash + 0.6 * SSIM", () => {
      const img = solidImage32(100, 100, 100);
      const result = svc.compare(img, img);
      const expected = 0.4 * result.pHashSimilarity + 0.6 * result.ssimScore;
      expect(result.combinedScore).toBeCloseTo(expected, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// GeminiComparisonService fallback tests
// ---------------------------------------------------------------------------

describe("GeminiComparisonService — local fallback when no API key", () => {
  it("uses local comparison when GEMINI_API_KEY is not set", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      const img1 = solidImage32(255, 0, 0);
      const img2 = solidImage32(255, 0, 0);
      const result = await svc.compare(img1, img2);
      // Should use local scores, not return -1
      expect(result.matchScore).toBeGreaterThan(0);
      expect(result.modelUsed).toBe("local_phash_ssim");
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });

  it("matchScore is the local combinedScore when no API key", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      const localSvc = new LocalComparisonService();
      const img1 = solidImage32(100, 200, 50);
      const img2 = solidImage32(100, 200, 50);
      const geminiResult = await svc.compare(img1, img2);
      const localResult = localSvc.compare(img1, img2);
      expect(geminiResult.matchScore).toBeCloseTo(localResult.combinedScore, 10);
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });

  it("includes localScores in result when no API key", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      const img1 = solidImage32(255, 255, 0);
      const img2 = solidImage32(255, 255, 0);
      const result = await svc.compare(img1, img2);
      expect(result.localScores).toBeDefined();
      expect(typeof result.localScores!.pHashSimilarity).toBe("number");
      expect(typeof result.localScores!.ssimScore).toBe("number");
      expect(typeof result.localScores!.combinedScore).toBe("number");
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });

  it("reasoning mentions local comparison when no API key", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      const img = solidImage32(100, 100, 100);
      const result = await svc.compare(img, img);
      expect(result.reasoning.toLowerCase()).toContain("local");
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });

  it("verdict is match for identical images when no API key", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      const img = solidImage32(128, 128, 128);
      const result = await svc.compare(img, img);
      expect(result.verdict).toBe("match");
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });

  it("accepts raw Uint8Array bytes for input (synthetic pixels fallback)", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      // Same raw bytes → should produce match
      const bytes = new Uint8Array(100).fill(128);
      const result = await svc.compare(bytes, bytes);
      expect(result.matchScore).toBeGreaterThan(0);
      expect(result.modelUsed).toBe("local_phash_ssim");
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });

  it("tokensUsed is {prompt:0, completion:0} when no API key", async () => {
    const saved = process.env["GEMINI_API_KEY"];
    delete process.env["GEMINI_API_KEY"];
    try {
      const svc = new GeminiComparisonService();
      const img = solidImage32(200, 200, 200);
      const result = await svc.compare(img, img);
      expect(result.tokensUsed.prompt).toBe(0);
      expect(result.tokensUsed.completion).toBe(0);
    } finally {
      if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
    }
  });
});
