/**
 * OT-2 Camera Relay Routes
 *
 * The OT-2 pushes camera frames TO PCC. Users view them FROM PCC.
 * Only the latest 5 frames are kept per kernel to avoid DB bloat.
 *
 * POST /api/ot2/camera/frame     — Agent pushes a frame (base64 JPEG)
 * GET  /api/ot2/camera/latest    — Get latest frame as raw JPEG (image/jpeg)
 * GET  /api/ot2/camera/stream    — SSE stream of frame notifications
 * GET  /api/ot2/camera/snapshot  — Get latest frame as JSON
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { getStore } from "../db.js";
import { schema, eq, sql } from "@pcc/store";

const { ot2CameraFrames } = schema;

function generateId(): string {
  return `frame_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Active SSE clients for camera stream
const cameraStreamClients = new Set<FastifyReply>();

export async function ot2CameraRoutes(app: FastifyInstance) {
  // Ensure the table exists (idempotent — handles fresh deploys without migrations)
  const { db } = getStore();
  db.run(sql`CREATE TABLE IF NOT EXISTS ot2_camera_frames (
    id TEXT PRIMARY KEY,
    kernel_id TEXT NOT NULL,
    frame_data TEXT NOT NULL,
    captured_at TEXT NOT NULL
  )`);

  // ── POST /api/ot2/camera/frame — Agent pushes a frame ─────────────
  app.post<{
    Body: {
      kernelId?: string;
      frame?: string;
      capturedAt?: string;
    };
  }>("/api/ot2/camera/frame", async (req, reply) => {
    const { kernelId, frame, capturedAt } = req.body ?? {};

    if (!kernelId || !frame) {
      return reply.status(400).send({ error: "kernelId and frame (base64 JPEG) are required" });
    }

    // Validate base64 — just check it's non-empty and reasonable size (max 5MB base64)
    if (frame.length > 5 * 1024 * 1024 * 1.37) {
      return reply.status(400).send({ error: "Frame too large (max ~5MB JPEG)" });
    }

    const id = generateId();
    const now = capturedAt ?? new Date().toISOString();

    const { db } = getStore();

    // Insert the new frame
    db.insert(ot2CameraFrames).values({
      id,
      kernelId,
      frameData: frame,
      capturedAt: now,
    }).run();

    // Keep only the latest 5 frames for this kernel — delete older ones
    const allFrames = db
      .select({ id: ot2CameraFrames.id })
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .all();

    if (allFrames.length > 5) {
      const toDelete = allFrames.slice(5);
      for (const old of toDelete) {
        db.delete(ot2CameraFrames).where(eq(ot2CameraFrames.id, old.id)).run();
      }
    }

    // Notify SSE clients
    const ssePayload = `event: frame\ndata: ${JSON.stringify({ id, kernelId, capturedAt: now })}\n\n`;
    for (const client of cameraStreamClients) {
      try {
        client.raw.write(ssePayload);
      } catch {
        cameraStreamClients.delete(client);
      }
    }

    return reply.status(201).send({
      id,
      kernelId,
      capturedAt: now,
      framesKept: Math.min(allFrames.length, 5),
    });
  });

  // ── GET /api/ot2/camera/latest — Raw JPEG image ───────────────────
  app.get<{
    Querystring: {
      kernelId?: string;
    };
  }>("/api/ot2/camera/latest", async (req, reply) => {
    const kernelId = req.query.kernelId ?? "kernel-nanoclaw";

    const { db } = getStore();
    const latest = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .limit(1)
      .get();

    if (!latest) {
      return reply.status(404).send({ error: "No frames available" });
    }

    // Decode base64 and return as raw JPEG
    const buffer = Buffer.from(latest.frameData, "base64");
    return reply
      .header("Content-Type", "image/jpeg")
      .header("X-Frame-Id", latest.id)
      .header("X-Captured-At", latest.capturedAt)
      .send(buffer);
  });

  // ── GET /api/ot2/camera/stream — SSE stream of frame events ───────
  app.get<{
    Querystring: {
      kernelId?: string;
    };
  }>("/api/ot2/camera/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);

    cameraStreamClients.add(reply);

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        cameraStreamClients.delete(reply);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      cameraStreamClients.delete(reply);
    });

    // Keep alive
    await new Promise<void>(() => {});
  });

  // ── GET /api/ot2/camera/snapshot — JSON snapshot ──────────────────
  app.get<{
    Querystring: {
      kernelId?: string;
    };
  }>("/api/ot2/camera/snapshot", async (req, reply) => {
    const kernelId = req.query.kernelId ?? "kernel-nanoclaw";

    const { db } = getStore();
    const latest = db
      .select()
      .from(ot2CameraFrames)
      .where(eq(ot2CameraFrames.kernelId, kernelId))
      .orderBy(sql`${ot2CameraFrames.capturedAt} DESC`)
      .limit(1)
      .get();

    if (!latest) {
      return reply.status(404).send({ error: "No frames available" });
    }

    return {
      id: latest.id,
      kernelId: latest.kernelId,
      frame: latest.frameData,
      capturedAt: latest.capturedAt,
    };
  });
}
