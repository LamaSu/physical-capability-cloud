/**
 * Topic-based SSE endpoints — per-job, per-kernel, per-device, per-batch streaming.
 */

import type { FastifyInstance } from "fastify";
import type { StreamTopic } from "@pcc/spec";
import { streamHub } from "./stream-hub.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";
import { resolveSSEAuth } from "./sse-auth.js";

// Strict origin allowlist — prevents subdomain spoofing attacks
const ALLOWED_SSE_ORIGINS = new Set([
  "https://capability.network",
  "http://localhost:5173",
  "http://localhost:3200",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3200",
]);

export async function topicSSE(app: FastifyInstance) {
  // Connection limit gate for all SSE topic streams (auth is checked per-route)
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/sse/stream/")) return;
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections" });
    }
    trackSSEOpen(req.ip);
  });

  /** Helper to set up an SSE connection for given topics */
  function setupSSE(
    req: { raw: { on: (event: string, cb: () => void) => void }; ip?: string },
    reply: { raw: { writeHead: (status: number, headers: Record<string, string>) => void; write: (data: string) => void } },
    topics: StreamTopic[],
    lastEventId?: string,
    origin?: string,
  ) {
    // Strict origin validation — reject unknown origins with default
    const allowOrigin = origin && ALLOWED_SSE_ORIGINS.has(origin)
      ? origin : "https://capability.network";

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Credentials": "true",
    });

    reply.raw.write(`data: ${JSON.stringify({ type: "connected", topics })}\n\n`);

    const unsubscribe = streamHub.subscribe(
      topics,
      (event) => {
        const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
        try {
          reply.raw.write(payload);
        } catch {
          unsubscribe();
        }
      },
      lastEventId,
    );

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      if (req.ip) trackSSEClose(req.ip);
    });
  }

  // Per-job streaming
  app.get("/sse/stream/job/:jobId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { jobId } = req.params as { jobId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "job", id: jobId }], lastEventId, origin);
    await new Promise(() => {});
  });

  // Per-kernel streaming
  app.get("/sse/stream/kernel/:kernelId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { kernelId } = req.params as { kernelId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "kernel", id: kernelId }], lastEventId, origin);
    await new Promise(() => {});
  });

  // Per-device streaming
  app.get("/sse/stream/device/:deviceId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { deviceId } = req.params as { deviceId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "device", id: deviceId }], lastEventId, origin);
    await new Promise(() => {});
  });

  // Per-batch streaming
  app.get("/sse/stream/batch/:batchId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { batchId } = req.params as { batchId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "batch", id: batchId }], lastEventId, origin);
    await new Promise(() => {});
  });
}
