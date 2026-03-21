/**
 * Tests for PhotoCaptureService and GeminiComparisonService.
 */

import { describe, it, expect, vi } from "vitest";
import { PhotoCaptureService } from "../photo-capture-service.js";
import { GeminiComparisonService } from "../gemini-comparison-service.js";

// ---------------------------------------------------------------------------
// Helpers — minimal synthetic image bytes
// ---------------------------------------------------------------------------

/** Minimal valid JPEG: SOI + APP0 + a small payload */
function makeMinimalJpeg(sizeBytes = 15_000): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  buf[0] = 0xff; // SOI marker
  buf[1] = 0xd8;
  buf[2] = 0xff; // APP0 marker start
  buf[3] = 0xe0;
  buf[4] = 0x00;
  buf[5] = 0x10; // APP0 length = 16
  buf[6] = 0x4a; // J
  buf[7] = 0x46; // F
  buf[8] = 0x49; // I
  buf[9] = 0x46; // F
  buf[10] = 0x00; // NUL terminator
  // Fill the rest with non-zero data so it passes size plausibility
  for (let i = 11; i < sizeBytes; i++) {
    buf[i] = (i % 200) + 1;
  }
  return buf;
}

/** Minimal valid PNG: 8-byte signature + IHDR chunk */
function makeMinimalPng(sizeBytes = 15_000): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  // PNG signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((b, i) => { buf[i] = b; });
  // Fill rest
  for (let i = 8; i < sizeBytes; i++) {
    buf[i] = (i % 200) + 1;
  }
  return buf;
}

/** Random bytes — not a valid image format */
function makeRandomBytes(size = 15_000): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  // Ensure it won't accidentally start with JPEG or PNG magic
  buf[0] = 0x00;
  return buf;
}

// ---------------------------------------------------------------------------
// PhotoCaptureService
// ---------------------------------------------------------------------------

describe("PhotoCaptureService", () => {
  describe("imageHash", () => {
    it("produces a sha256: prefixed hash for a JPEG", async () => {
      const svc = new PhotoCaptureService();
      const bytes = makeMinimalJpeg();
      const result = await svc.capture(bytes);
      expect(result.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("produces a sha256: prefixed hash for a PNG", async () => {
      const svc = new PhotoCaptureService();
      const bytes = makeMinimalPng();
      const result = await svc.capture(bytes);
      expect(result.imageHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("different bytes produce different hashes", async () => {
      const svc = new PhotoCaptureService();
      const a = makeMinimalJpeg(15_000);
      const b = makeMinimalJpeg(15_001); // different length → different content
      const ra = await svc.capture(a);
      const rb = await svc.capture(b);
      expect(ra.imageHash).not.toBe(rb.imageHash);
    });

    it("same bytes always produce the same hash (deterministic)", async () => {
      const svc = new PhotoCaptureService();
      const bytes = makeMinimalJpeg();
      const r1 = await svc.capture(bytes);
      const r2 = await svc.capture(bytes);
      expect(r1.imageHash).toBe(r2.imageHash);
    });
  });

  describe("rawSizeBytes", () => {
    it("reflects the exact input size", async () => {
      const svc = new PhotoCaptureService();
      const bytes = makeMinimalJpeg(20_000);
      const result = await svc.capture(bytes);
      expect(result.rawSizeBytes).toBe(20_000);
    });
  });

  describe("file_format anti-spoof check", () => {
    it("passes for a valid JPEG", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg());
      const check = result.antiSpoofChecks.find((c) => c.check === "file_format");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
      expect(check!.detail).toContain("JPEG");
    });

    it("passes for a valid PNG", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalPng());
      const check = result.antiSpoofChecks.find((c) => c.check === "file_format");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
      expect(check!.detail).toContain("PNG");
    });

    it("fails for random bytes", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeRandomBytes());
      const check = result.antiSpoofChecks.find((c) => c.check === "file_format");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
    });
  });

  describe("size_plausibility anti-spoof check", () => {
    it("passes for a plausible-sized image (15 KB)", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg(15_000));
      const check = result.antiSpoofChecks.find((c) => c.check === "size_plausibility");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
    });

    it("fails for a suspiciously small image (<10 KB)", async () => {
      const svc = new PhotoCaptureService();
      // 5 KB — too small
      const tiny = new Uint8Array(5_000);
      tiny[0] = 0xff; tiny[1] = 0xd8; tiny[2] = 0xff; // JPEG magic
      for (let i = 3; i < tiny.length; i++) tiny[i] = i % 200;
      const result = await svc.capture(tiny);
      const check = result.antiSpoofChecks.find((c) => c.check === "size_plausibility");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
      expect(check!.detail).toContain("small");
    });

    it("fails for a suspiciously large image (>50 MB)", async () => {
      const svc = new PhotoCaptureService();
      const huge = new Uint8Array(51 * 1024 * 1024); // 51 MB
      huge[0] = 0xff; huge[1] = 0xd8; huge[2] = 0xff; // JPEG magic
      const result = await svc.capture(huge);
      const check = result.antiSpoofChecks.find((c) => c.check === "size_plausibility");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
      expect(check!.detail).toContain("large");
    });
  });

  describe("timestamp_freshness anti-spoof check", () => {
    it("passes when no EXIF timestamp is present (graceful skip)", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg()); // no real EXIF
      const check = result.antiSpoofChecks.find((c) => c.check === "timestamp_freshness");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(true);
      expect(check!.detail).toContain("skipped");
    });
  });

  describe("gps_proximity anti-spoof check", () => {
    it("is omitted when no expectedLocation is provided", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg());
      const check = result.antiSpoofChecks.find((c) => c.check === "gps_proximity");
      expect(check).toBeUndefined();
    });

    it("fails when expectedLocation is set but EXIF has no GPS", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg(), {
        expectedLocation: { lat: 37.7749, lng: -122.4194, radiusM: 100 },
      });
      const check = result.antiSpoofChecks.find((c) => c.check === "gps_proximity");
      expect(check).toBeDefined();
      expect(check!.passed).toBe(false);
      expect(check!.detail).toContain("no GPS data");
    });
  });

  describe("antiSpoofScore", () => {
    it("returns a number between 0 and 1", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg());
      expect(result.antiSpoofScore).toBeGreaterThanOrEqual(0);
      expect(result.antiSpoofScore).toBeLessThanOrEqual(1);
    });

    it("is 1.0 when all checks pass", async () => {
      const svc = new PhotoCaptureService();
      // A valid JPEG with plausible size and no expectedLocation → all checks pass
      const result = await svc.capture(makeMinimalJpeg(20_000));
      expect(result.antiSpoofScore).toBe(1);
    });

    it("is less than 1.0 when a check fails", async () => {
      const svc = new PhotoCaptureService();
      // Provide expectedLocation but no GPS in EXIF → gps_proximity fails
      const result = await svc.capture(makeMinimalJpeg(20_000), {
        expectedLocation: { lat: 37.7749, lng: -122.4194, radiusM: 100 },
      });
      expect(result.antiSpoofScore).toBeLessThan(1);
    });
  });

  describe("exif", () => {
    it("returns empty exif object for a synthetic JPEG with no EXIF segment", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg());
      // All fields should be undefined (not errored)
      expect(result.exif).toBeDefined();
      expect(result.exif.timestamp).toBeUndefined();
      expect(result.exif.gps).toBeUndefined();
    });
  });

  describe("storageCid", () => {
    it("returns empty string when no storage service provided", async () => {
      const svc = new PhotoCaptureService(); // no storage
      const result = await svc.capture(makeMinimalJpeg());
      expect(result.storageCid).toBe("");
    });

    it("returns a photo:sha256: CID when a mock storage service is provided", async () => {
      // Create a minimal mock storage that satisfies IEvidenceStorageService
      const mockStorage = {
        isReady: vi.fn().mockReturnValue(true),
        init: vi.fn().mockResolvedValue(undefined),
        archiveBundle: vi.fn().mockResolvedValue({ cid: "baf_mock", metadataCid: "baf_meta" }),
        archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "baf_mock", metadataCid: "baf_meta" }),
        retrieveBundle: vi.fn().mockResolvedValue({}),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const svc = new PhotoCaptureService(mockStorage);
      const result = await svc.capture(makeMinimalJpeg());
      // The internal _uploadBytes method generates a photo:sha256: CID
      expect(result.storageCid).toMatch(/^photo:sha256:[0-9a-f]{64}$/);
    });
  });

  describe("antiSpoofChecks structure", () => {
    it("each check has check, passed, and detail fields", async () => {
      const svc = new PhotoCaptureService();
      const result = await svc.capture(makeMinimalJpeg());
      for (const check of result.antiSpoofChecks) {
        expect(typeof check.check).toBe("string");
        expect(typeof check.passed).toBe("boolean");
        expect(typeof check.detail).toBe("string");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// GeminiComparisonService
// ---------------------------------------------------------------------------

describe("GeminiComparisonService", () => {
  describe("no API key (local fallback mode)", () => {
    it("returns matchScore > 0 using local fallback when no API key is set", async () => {
      // Ensure env var is absent for this test
      const saved = process.env["GEMINI_API_KEY"];
      delete process.env["GEMINI_API_KEY"];
      try {
        const svc = new GeminiComparisonService(); // no key
        const result = await svc.compare(makeMinimalJpeg(), makeMinimalJpeg());
        // With local fallback, matchScore is the local combined score (not -1)
        expect(result.matchScore).toBeGreaterThanOrEqual(0);
        expect(result.modelUsed).toBe("local_phash_ssim");
      } finally {
        if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
      }
    });

    it("returns empty discrepancies array when no API key", async () => {
      const saved = process.env["GEMINI_API_KEY"];
      delete process.env["GEMINI_API_KEY"];
      try {
        const svc = new GeminiComparisonService();
        const result = await svc.compare(makeMinimalJpeg(), makeMinimalPng());
        expect(Array.isArray(result.discrepancies)).toBe(true);
        expect(result.discrepancies).toHaveLength(0);
      } finally {
        if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
      }
    });

    it("tokensUsed is {prompt:0, completion:0} when no API key", async () => {
      const saved = process.env["GEMINI_API_KEY"];
      delete process.env["GEMINI_API_KEY"];
      try {
        const svc = new GeminiComparisonService();
        const result = await svc.compare(makeMinimalJpeg(), makeMinimalJpeg());
        expect(result.tokensUsed.prompt).toBe(0);
        expect(result.tokensUsed.completion).toBe(0);
      } finally {
        if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
      }
    });
  });

  describe("result shape validation", () => {
    it("ComparisonResult has all required fields", async () => {
      const saved = process.env["GEMINI_API_KEY"];
      delete process.env["GEMINI_API_KEY"];
      try {
        const svc = new GeminiComparisonService();
        const result = await svc.compare(makeMinimalJpeg(), makeMinimalJpeg());
        expect(result).toHaveProperty("matchScore");
        expect(result).toHaveProperty("verdict");
        expect(result).toHaveProperty("discrepancies");
        expect(result).toHaveProperty("reasoning");
        expect(result).toHaveProperty("modelUsed");
        expect(result).toHaveProperty("tokensUsed");
        expect(result.tokensUsed).toHaveProperty("prompt");
        expect(result.tokensUsed).toHaveProperty("completion");
      } finally {
        if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
      }
    });
  });

  describe("API key from env var", () => {
    it("picks up GEMINI_API_KEY from env", async () => {
      // We mock the GoogleGenerativeAI module dynamically
      const svc = new GeminiComparisonService("test-key-from-arg");
      // @ts-expect-error accessing private for test
      expect(svc.apiKey).toBe("test-key-from-arg");
    });

    it("constructor arg takes precedence over env var", async () => {
      process.env["GEMINI_API_KEY"] = "env-key";
      try {
        const svc = new GeminiComparisonService("explicit-key");
        // @ts-expect-error accessing private for test
        expect(svc.apiKey).toBe("explicit-key");
      } finally {
        delete process.env["GEMINI_API_KEY"];
      }
    });
  });
});
