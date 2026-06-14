/**
 * Commentary Streaming Route — POST /api/commentary/stream
 *
 * Returns a text/event-stream where each event is a JSON-encoded
 * CommentaryChunk emitted by the narrator. The route is POST so callers can
 * pass optional body fields (windowMs, model, since) without URL bloat; the
 * EventSource API forces GET, so the dashboard uses fetch() + a ReadableStream
 * reader instead (see apps/dashboard/public/commentary.html).
 *
 * Auth: protected by the global apiGate, so an authenticated key is required.
 * Missing ANTHROPIC_API_KEY does NOT 5xx — the session emits a friendly
 * `needs_api_key` chunk and continues to surface raw events.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  startCommentarySession,
  type CommentaryChunk,
  type CommentaryTopic,
} from "../services/commentary-narrator.js";

interface CommentaryBody {
  topic?: string;
  windowMs?: number;
  model?: string;
  since?: string;
  historyWindows?: number;
}

interface CommentaryQuery {
  topic?: string;
  windowMs?: string;
  model?: string;
  since?: string;
  historyWindows?: string;
}

const ALLOWED_TOPICS: ReadonlySet<CommentaryTopic> = new Set([
  "jobs",
  "escrows",
  "attestations",
  "all",
]);

function coerceTopic(raw: string | undefined): CommentaryTopic {
  if (!raw) return "all";
  const lower = raw.toLowerCase();
  return ALLOWED_TOPICS.has(lower as CommentaryTopic)
    ? (lower as CommentaryTopic)
    : "all";
}

function coerceWindowMs(raw: number | string | undefined): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1500;
  return Math.min(Math.max(Math.floor(n), 250), 15_000);
}

function coerceHistory(raw: number | string | undefined): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return 6;
  return Math.min(Math.max(Math.floor(n), 1), 30);
}

function writeSseChunk(reply: FastifyReply, chunk: CommentaryChunk): boolean {
  try {
    const data = JSON.stringify(chunk);
    reply.raw.write(`event: ${chunk.type}\ndata: ${data}\n\n`);
    return true;
  } catch {
    return false;
  }
}

async function handleStream(req: FastifyRequest, reply: FastifyReply) {
  const body = (req.body ?? {}) as CommentaryBody;
  const query = (req.query ?? {}) as CommentaryQuery;

  const topic = coerceTopic(body.topic ?? query.topic);
  const windowMs = coerceWindowMs(body.windowMs ?? query.windowMs);
  const historyWindows = coerceHistory(body.historyWindows ?? query.historyWindows);
  const model = body.model ?? query.model;
  const since = body.since ?? query.since;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // First handshake chunk so the client knows the route is wired
  reply.raw.write(
    `event: connected\ndata: ${JSON.stringify({
      ts: new Date().toISOString(),
      topic,
      windowMs,
      historyWindows,
    })}\n\n`,
  );

  const session = startCommentarySession(
    { topic, windowMs, model, historyWindows, ...(since ? { since } as any : {}) },
    (chunk) => {
      const ok = writeSseChunk(reply, chunk);
      if (!ok) session.stop();
    },
  );

  req.raw.on("close", () => {
    session.stop();
    try { reply.raw.end(); } catch { /* ignore */ }
  });

  // Hold the connection open until the session ends
  await session.done;
  try { reply.raw.end(); } catch { /* ignore */ }
}

export async function commentaryRoutes(app: FastifyInstance) {
  // POST is canonical (body-based config)
  app.post("/api/commentary/stream", handleStream);
  // GET is convenience (query-based config — lets EventSource work directly in dev)
  app.get("/api/commentary/stream", handleStream);

  // Liveness probe for the route — useful for the dashboard "live indicator"
  app.get("/api/commentary/status", async () => {
    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    return {
      route: "/api/commentary/stream",
      anthropic_configured: hasKey,
      default_model: "claude-sonnet-4-5",
      default_window_ms: 1500,
      supported_topics: ["jobs", "escrows", "attestations", "all"],
    };
  });
}
