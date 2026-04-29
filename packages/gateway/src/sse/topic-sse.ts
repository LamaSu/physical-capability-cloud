/**
 * Topic-based SSE endpoints — per-job, per-kernel, per-device, per-batch streaming.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
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

/**
 * Resolve the lastEventId for resume from EITHER the `last-event-id` HTTP
 * header (the SSE standard) OR the `?lastEventId=` query string param
 * (browser EventSource fallback — the native EventSource API cannot set
 * custom headers on reconnect). The header wins when both are present.
 *
 * Week 6 (A1): added query-string fallback so the mobile EventSource can
 * resume after reconnect; the mobile listener already passes lastEventId
 * as a query param because browser EventSource has no header support.
 *
 * Exported for tests; production callers go through the routes which use
 * this internally.
 */
export function resolveLastEventId(req: FastifyRequest): string | undefined {
  const headerVal = req.headers["last-event-id"];
  if (typeof headerVal === "string" && headerVal.length > 0) return headerVal;
  // Header wins; otherwise check the query string.
  const query = req.query as Record<string, unknown> | undefined;
  const queryVal = query?.lastEventId;
  if (typeof queryVal === "string" && queryVal.length > 0) return queryVal;
  return undefined;
}

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
    const lastEventId = resolveLastEventId(req);
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
    const lastEventId = resolveLastEventId(req);
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
    const lastEventId = resolveLastEventId(req);
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
    const lastEventId = resolveLastEventId(req);
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "batch", id: batchId }], lastEventId, origin);
    await new Promise(() => {});
  });

  // Per-session approval streaming (Week 5).
  //
  // Auth: requires a valid Bearer / SIWE / ?token= credential. This is the
  // same gate as the other topic SSE routes — when SSE_AUTH_REQUIRED is
  // not set the gate passes through (backward compat with the rest of
  // the gateway). Production deployments should set SSE_AUTH_REQUIRED=1
  // so unauth'd subscribers can't fish for approval events.
  //
  // Cross-session isolation: each session has its own `approval:<id>`
  // topic. Subscribers only get events for the session they subscribed
  // to. Since session-ids are unguessable opaque strings, knowing one
  // session's id does not reveal another's. A hardened v2 can additionally
  // bind session-id to the session token's userId; for v1 the auth gate
  // + opaque-id is sufficient.
  app.get("/sse/stream/approval/:sessionId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { sessionId } = req.params as { sessionId: string };
    const lastEventId = resolveLastEventId(req);
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "approval", id: sessionId }], lastEventId, origin);
    await new Promise(() => {});
  });
}
