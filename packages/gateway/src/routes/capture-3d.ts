/**
 * POST /api/capture/3d-stream — phone-video -> per-frame point maps + poses.
 *
 * The closest server-side analogue to the user-requested "operator capture
 * entry point" for the LingBot-Map integration. Browser-side capture flow
 * (`packages/ui/src/capture/StreamingThreeD.ts`) records a short phone-video
 * clip, base64-encodes it, and POSTs here. We persist the bytes to a
 * tempfile, hand it to the LingBot adapter, and return the validated
 * `PointMap3DTrace`. The caller folds the returned trace into the
 * `CaptureManifest.pointMaps3D` field before POSTing to
 * `/api/capture/upload` (which already hashes the manifest including the
 * new field — no other gateway changes required).
 *
 * Design choices:
 *   - Plain JSON + base64 video (no @fastify/multipart) — matches the
 *     pattern in routes/capture.ts:upload. Keeps the route Zod-first.
 *   - Hard caps: max 32 MB inbound video (well above a 5-second 720p clip
 *     at 6 Mbps), max 512 frames processed, max 4096 points/frame.
 *   - The adapter handles stub mode internally (PCC_LINGBOT_STUB=1), so
 *     CI / aarch64 dev boxes that can't compile FlashInfer still get a
 *     real round-trip through this route.
 *
 * Author: pcc-lingbot adapter
 * License: Apache-2.0 (matches LingBot-Map upstream)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PointMap3DTraceSchemaExport,
  type PointMap3DTrace,
} from "@pcc/spec";
import {
  runLingBotInference,
  LingBotAdapterError,
} from "@pcc/verifier/dist/capture/lingbot-adapter.js";
import { requireAuth } from "../auth/require-auth.js";
import { pipelineTelemetry } from "../telemetry.js";

const MAX_VIDEO_BYTES = 32 * 1024 * 1024; // 32 MB

const StreamingBodySchema = z.object({
  videoBytesBase64: z.string().min(1),
  videoMime: z.string().min(1).optional(),
  mode: z.enum(["streaming", "windowed"]).optional(),
  fps: z.number().int().positive().max(60).optional(),
  maxFrames: z.number().int().positive().max(512).optional(),
  downsamplePoints: z.number().int().positive().max(4096).optional(),
  modelPath: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  /** Optional sha256:<hex> echo — short-circuit verify on the caller's hash. */
  expectedVideoHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

interface StreamingResponse {
  trace: PointMap3DTrace;
  durationMs: number;
  stubbed: boolean;
  bytesReceived: number;
}

/**
 * Register the streaming-3D route on a Fastify instance. Mirror call-site
 * shape of `captureRoutes` in routes/capture.ts so the gateway wires both
 * with one liner.
 */
export async function capture3dRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/capture/3d-stream",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = StreamingBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid 3d-stream request body",
          details: parsed.error.flatten(),
        });
      }

      const {
        videoBytesBase64,
        mode,
        fps,
        maxFrames,
        downsamplePoints,
        modelPath,
        jobId,
        deviceId,
        expectedVideoHash,
      } = parsed.data;

      let videoBytes: Buffer;
      try {
        videoBytes = Buffer.from(videoBytesBase64, "base64");
      } catch (err) {
        return reply.status(400).send({
          error: "invalid_video_bytes",
          message: `videoBytesBase64 failed to decode: ${(err as Error).message}`,
        });
      }

      if (videoBytes.length === 0) {
        return reply.status(400).send({
          error: "empty_video",
          message: "Decoded video has zero bytes",
        });
      }
      if (videoBytes.length > MAX_VIDEO_BYTES) {
        return reply.status(413).send({
          error: "video_too_large",
          message: `Video exceeds ${MAX_VIDEO_BYTES} byte cap (got ${videoBytes.length})`,
        });
      }

      const actualHash =
        "sha256:" + crypto.createHash("sha256").update(videoBytes).digest("hex");
      if (expectedVideoHash && expectedVideoHash.toLowerCase() !== actualHash.toLowerCase()) {
        return reply.status(400).send({
          error: "video_hash_mismatch",
          message: `expectedVideoHash (${expectedVideoHash}) does not match sha256(videoBytes)=${actualHash}`,
        });
      }

      const tempPath = path.join(
        os.tmpdir(),
        `pcc-3d-stream-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`,
      );
      try {
        fs.writeFileSync(tempPath, videoBytes);
      } catch (err) {
        return reply.status(500).send({
          error: "tempfile_write_failed",
          message: (err as Error).message,
        });
      }

      try {
        const result = await runLingBotInference({
          videoPath: tempPath,
          mode,
          fps,
          maxFrames,
          downsamplePoints,
          modelPath,
          deviceId,
        });

        // Defense-in-depth: re-validate the returned trace against the spec
        // schema. The adapter already does this, but the gateway never trusts
        // a verifier result blindly.
        const guard = PointMap3DTraceSchemaExport.safeParse(result.trace);
        if (!guard.success) {
          return reply.status(500).send({
            error: "trace_schema_invalid",
            message: "Adapter returned a trace that failed schema validation",
            details: guard.error.flatten(),
          });
        }

        // Cross-check the trace's videoHash against what we computed —
        // catches an adapter bug where the trace was built from a different
        // file (race, leftover tempfile, etc.).
        if (result.trace.videoHash.toLowerCase() !== actualHash.toLowerCase()) {
          return reply.status(500).send({
            error: "trace_video_hash_mismatch",
            message: `trace.videoHash (${result.trace.videoHash}) does not match request video hash (${actualHash})`,
          });
        }

        pipelineTelemetry.emit(jobId ?? "capture-3d", "evidence_capture", "completed", {
          metadata: {
            subphase: "capture_3d_stream",
            jobId: jobId ?? null,
            frameCount: result.trace.frameCount,
            durationMs: result.durationMs,
            stubbed: result.stubbed,
            mode: result.trace.mode,
            model: result.trace.model,
          },
        });

        const response: StreamingResponse = {
          trace: result.trace,
          durationMs: result.durationMs,
          stubbed: result.stubbed,
          bytesReceived: videoBytes.length,
        };
        return response;
      } catch (err) {
        if (err instanceof LingBotAdapterError) {
          req.log.error({ err, code: err.code }, "capture_3d_stream adapter failed");
          pipelineTelemetry.emit(jobId ?? "capture-3d", "evidence_capture", "failed", {
            metadata: {
              subphase: "capture_3d_stream",
              jobId: jobId ?? null,
              error: err.code,
              message: err.message,
            },
            level: "error",
          });
          // Map adapter errors to user-actionable HTTP shapes.
          const status = err.code === "missing_video_path" ? 400 : 502;
          return reply.status(status).send({
            error: err.code,
            message: err.message,
            detail: err.detail,
          });
        }
        req.log.error({ err }, "capture_3d_stream threw");
        return reply.status(500).send({
          error: "internal_error",
          message: (err as Error).message,
        });
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* best-effort */
        }
      }
    },
  );
}
