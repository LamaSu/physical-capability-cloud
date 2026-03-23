/**
 * Trace API Routes
 *
 * GET  /api/traces              → recent traces (up to last 50)
 * GET  /api/traces/:traceId     → single trace with full span tree
 * GET  /api/traces/stream       → SSE live trace updates
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { traceCollector } from "../trace-collector.js";
import type { Trace } from "../trace-collector.js";

// Active SSE clients for the live trace stream
const traceStreamClients = new Set<FastifyReply>();

// Subscribe to the trace collector and fan-out to SSE clients
traceCollector.subscribe((trace: Trace) => {
  if (traceStreamClients.size === 0) return;
  const payload = `event: trace_update\ndata: ${JSON.stringify(trace)}\n\n`;
  for (const client of traceStreamClients) {
    try {
      client.raw.write(payload);
    } catch {
      traceStreamClients.delete(client);
    }
  }
});

export async function traceRoutes(app: FastifyInstance) {
  // ── GET /api/traces ─────────────────────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>("/api/traces", async (req) => {
    const limit = parseInt((req.query as Record<string, string>).limit ?? "50", 10);
    const traces = traceCollector.getRecentTraces(limit);
    return { traces, total: traces.length };
  });

  // ── GET /api/traces/stream (SSE) ─────────────────────────────────────────
  // NOTE: This route must come BEFORE /api/traces/:traceId so Fastify matches
  // the literal "stream" segment before treating it as a traceId param.

  app.get("/api/traces/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send recent traces on connect
    const recent = traceCollector.getRecentTraces(20);
    for (const trace of recent) {
      reply.raw.write(`event: trace_update\ndata: ${JSON.stringify(trace)}\n\n`);
    }

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);

    traceStreamClients.add(reply);

    // Heartbeat
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        traceStreamClients.delete(reply);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      traceStreamClients.delete(reply);
    });

    // Keep alive
    await new Promise<void>(() => {});
  });

  // ── GET /api/traces/:traceId ─────────────────────────────────────────────

  app.get<{ Params: { traceId: string } }>("/api/traces/:traceId", async (req, reply) => {
    const { traceId } = req.params;
    const trace = traceCollector.getTrace(traceId);
    if (!trace) {
      return reply.code(404).send({ error: "trace_not_found", traceId });
    }
    return { trace };
  });
}
