/**
 * Photo verification routes.
 *
 * POST /api/photo/upload   — accept base64-encoded image + metadata, run
 *                            PhotoCaptureService, return hash/cid/antiSpoofScore/exif
 * POST /api/photo/compare  — accept two base64 images, run GeminiComparisonService,
 *                            return ComparisonResult
 * GET  /api/photo/:cid     — return photo metadata stored in DB (or 404)
 */

import type { FastifyInstance } from "fastify";
import { PhotoCaptureService, GeminiComparisonService } from "@pcc/kernel";

// ---------------------------------------------------------------------------
// Singletons — created once, shared across all requests
// ---------------------------------------------------------------------------

const photoCaptureService = new PhotoCaptureService(/* no storage — CID via hashing only */);
const geminiService = new GeminiComparisonService(/* reads GEMINI_API_KEY from env */);

// ---------------------------------------------------------------------------
// In-memory photo metadata store
// (A lightweight alternative to a full DB table; CID → metadata map)
// ---------------------------------------------------------------------------

interface PhotoMeta {
  imageHash: string;
  cid: string;
  rawSizeBytes: number;
  antiSpoofScore: number;
  antiSpoofChecks: Array<{ check: string; passed: boolean; detail: string }>;
  exif: {
    timestamp?: string;
    gps?: { lat: number; lng: number };
    device?: string;
    make?: string;
    model?: string;
  };
  uploadedAt: string;
  metadata?: Record<string, unknown>;
}

const photoStore = new Map<string, PhotoMeta>();

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function photoVerificationRoutes(app: FastifyInstance) {
  /**
   * POST /api/photo/upload
   *
   * Body (JSON):
   *   {
   *     imageBase64: string,          // base64-encoded image bytes (JPEG or PNG)
   *     metadata?: {                  // optional capture metadata
   *       deviceId?: string,
   *       expectedLocation?: { lat: number, lng: number, radiusM: number },
   *       maxAgeSeconds?: number,
   *     }
   *   }
   *
   * Response:
   *   { imageHash, cid, antiSpoofScore, exif, rawSizeBytes }
   */
  app.post<{
    Body: {
      imageBase64: string;
      metadata?: {
        deviceId?: string;
        expectedLocation?: { lat: number; lng: number; radiusM: number };
        maxAgeSeconds?: number;
      };
    };
  }>("/api/photo/upload", async (req, reply) => {
    const body = req.body as {
      imageBase64?: string;
      metadata?: Record<string, unknown>;
    };

    if (!body.imageBase64 || typeof body.imageBase64 !== "string") {
      return reply.code(400).send({
        error: "missing_image",
        message: "Request body must include imageBase64 (base64-encoded image bytes)",
      });
    }

    // Decode base64 → Uint8Array
    let imageBytes: Uint8Array;
    try {
      const buf = Buffer.from(body.imageBase64, "base64");
      imageBytes = new Uint8Array(buf);
    } catch {
      return reply.code(400).send({
        error: "invalid_base64",
        message: "imageBase64 could not be decoded as a base64 string",
      });
    }

    if (imageBytes.length === 0) {
      return reply.code(400).send({
        error: "empty_image",
        message: "Decoded image bytes are empty",
      });
    }

    // Run capture pipeline (hash + EXIF + anti-spoof)
    const meta = body.metadata as {
      deviceId?: string;
      expectedLocation?: { lat: number; lng: number; radiusM: number };
      maxAgeSeconds?: number;
    } | undefined;

    let result;
    try {
      result = await photoCaptureService.capture(imageBytes, meta ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Capture failed";
      return reply.code(500).send({ error: "capture_failed", message });
    }

    // Derive CID — prefer storageCid if a storage service is wired in,
    // otherwise use the hash-based identifier produced by the service
    const cid = result.storageCid || `photo:${result.imageHash}`;

    const photoMeta: PhotoMeta = {
      imageHash: result.imageHash,
      cid,
      rawSizeBytes: result.rawSizeBytes,
      antiSpoofScore: result.antiSpoofScore,
      antiSpoofChecks: result.antiSpoofChecks,
      exif: result.exif,
      uploadedAt: new Date().toISOString(),
      metadata: meta as Record<string, unknown> | undefined,
    };

    // Persist to in-memory store keyed by CID
    photoStore.set(cid, photoMeta);

    return {
      imageHash: result.imageHash,
      cid,
      antiSpoofScore: result.antiSpoofScore,
      antiSpoofChecks: result.antiSpoofChecks,
      exif: result.exif,
      rawSizeBytes: result.rawSizeBytes,
    };
  });

  /**
   * POST /api/photo/compare
   *
   * Body (JSON):
   *   {
   *     capturedImageBase64:  string,  // base64-encoded captured image
   *     referenceImageBase64: string,  // base64-encoded reference image/document
   *     context?: string,              // optional context hint for Gemini
   *   }
   *
   * Response: ComparisonResult
   *   { matchScore, verdict, discrepancies, reasoning, modelUsed, tokensUsed }
   */
  app.post<{
    Body: {
      capturedImageBase64: string;
      referenceImageBase64: string;
      context?: string;
    };
  }>("/api/photo/compare", async (req, reply) => {
    const body = req.body as {
      capturedImageBase64?: string;
      referenceImageBase64?: string;
      context?: string;
    };

    if (!body.capturedImageBase64 || typeof body.capturedImageBase64 !== "string") {
      return reply.code(400).send({
        error: "missing_captured_image",
        message: "Request body must include capturedImageBase64",
      });
    }
    if (!body.referenceImageBase64 || typeof body.referenceImageBase64 !== "string") {
      return reply.code(400).send({
        error: "missing_reference_image",
        message: "Request body must include referenceImageBase64",
      });
    }

    let capturedBytes: Uint8Array;
    let referenceBytes: Uint8Array;
    try {
      capturedBytes = new Uint8Array(Buffer.from(body.capturedImageBase64, "base64"));
      referenceBytes = new Uint8Array(Buffer.from(body.referenceImageBase64, "base64"));
    } catch {
      return reply.code(400).send({
        error: "invalid_base64",
        message: "One or both base64 strings could not be decoded",
      });
    }

    if (capturedBytes.length === 0 || referenceBytes.length === 0) {
      return reply.code(400).send({
        error: "empty_image",
        message: "One or both decoded images are empty",
      });
    }

    try {
      const comparison = await geminiService.compare(
        capturedBytes,
        referenceBytes,
        body.context,
      );
      return comparison;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Comparison failed";
      return reply.code(500).send({ error: "comparison_failed", message });
    }
  });

  /**
   * GET /api/photo/:cid
   *
   * Returns photo metadata for the given CID (from a previous /api/photo/upload call).
   * Returns 404 if the CID is not found.
   */
  app.get<{ Params: { cid: string } }>("/api/photo/:cid", async (req, reply) => {
    // CID may be URL-encoded (colons → %3A) — normalise
    const rawCid = decodeURIComponent(req.params.cid);

    // Try exact match first, then look for a CID ending with the param value
    let photo = photoStore.get(rawCid);

    if (!photo) {
      // Linear scan as fallback (photoStore is small in practice)
      for (const [key, value] of photoStore.entries()) {
        if (key.endsWith(rawCid) || rawCid.endsWith(key)) {
          photo = value;
          break;
        }
      }
    }

    if (!photo) {
      return reply.code(404).send({ error: "not_found", cid: rawCid });
    }

    return { photo };
  });
}
