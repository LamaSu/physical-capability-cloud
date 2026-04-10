/**
 * Topic-based SSE endpoints — per-job, per-kernel, per-device, per-batch streaming.
 */

import type { FastifyInstance } from "fastify";
import type { StreamTopic } from "@pcc/spec";
import { streamHub } from "./stream-hub.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";

export async function topicSSE(app: FastifyInstance) {
  // Auth + connection limit gate for all SSE topic streams
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/sse/stream/")) return;

    // Require authentication
    const apiKey = resolveApiKey(req);
    const session = resolveSession(req);
    if (!apiKey && !session) {
      return reply.status(401).send({ error: "Authentication required for SSE streams" });
    }

    // Connection limit per IP
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections" });
    }
    trackSSEOpen(req.ip);
  });

  /** Helper to set up an SSE connection for given topics */
  function setupSSE(
    req: { raw: { on: (event: string, cb: () => void) => void } },
    reply: { raw: { writeHead: (status: number, headers: Record<string, string>) => void; write: (data: string) => void } },
    topics: StreamTopic[],
    lastEventId?: string,
  ) {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
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
      // Track SSE close for connection limiting
      if ((req as any).ip) trackSSEClose((req as any).ip);
    });
  }

  // Per-job streaming
  app.get("/sse/stream/job/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    setupSSE(req, reply, [{ type: "job", id: jobId }], lastEventId);
    await new Promise(() => {});
  });

  // Per-kernel streaming
  app.get("/sse/stream/kernel/:kernelId", async (req, reply) => {
    const { kernelId } = req.params as { kernelId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    setupSSE(req, reply, [{ type: "kernel", id: kernelId }], lastEventId);
    await new Promise(() => {});
  });

  // Per-device streaming
  app.get("/sse/stream/device/:deviceId", async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    setupSSE(req, reply, [{ type: "device", id: deviceId }], lastEventId);
    await new Promise(() => {});
  });

  // Per-batch streaming
  app.get("/sse/stream/batch/:batchId", async (req, reply) => {
    const { batchId } = req.params as { batchId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    setupSSE(req, reply, [{ type: "batch", id: batchId }], lastEventId);
    await new Promise(() => {});
  });
}
