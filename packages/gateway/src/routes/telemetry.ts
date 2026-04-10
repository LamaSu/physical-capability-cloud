/**
 * Telemetry API Routes
 *
 * GET  /api/telemetry/pipeline/:jobId  — full event timeline for a job
 * GET  /api/telemetry/active           — list active jobs with current phase
 * GET  /api/telemetry/stats            — aggregate statistics
 * GET  /api/telemetry/logs             — query structured logs (with filters)
 * GET  /api/telemetry/logs/stream      — SSE stream of live log + telemetry events
 * POST /api/telemetry/emit             — manually emit a telemetry event
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { pipelineTelemetry, PIPELINE_PHASES } from "../telemetry.js";
import { logger, type LogLevel } from "../structured-logger.js";
import { streamHub } from "../sse/stream-hub.js";
import { auditService } from "../services/audit-service.js";
import type { TelemetryStatus, PipelinePhase } from "../telemetry.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";

// Active SSE clients for the live log stream
const logStreamClients = new Set<FastifyReply>();

// Subscribe to StreamHub global topic once and fan-out to SSE clients
streamHub.subscribe(
  [{ type: "global", id: "*" }],
  (event) => {
    if (event.type !== "telemetry_event" && event.type !== "log_entry") return;
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of logStreamClients) {
      try {
        client.raw.write(payload);
      } catch {
        logStreamClients.delete(client);
      }
    }
  },
);

/** Strip prompt injection patterns from telemetry metadata values */
function sanitizeTelemetryMetadata(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      // Strip common prompt injection patterns
      result[key] = value
        .replace(/\[SYSTEM\]|\[INST\]|<\|im_start\|/gi, "[FILTERED]")
        .replace(/ignore\s+(all\s+)?previous\s+instructions/gi, "[FILTERED]")
        .replace(/<script[\s>]/gi, "[FILTERED]")
        .replace(/javascript\s*:/gi, "[FILTERED]")
        .slice(0, 2000); // Cap string length
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeTelemetryMetadata(value as Record<string, unknown>, depth + 1);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function telemetryRoutes(app: FastifyInstance) {
  // ── GET /api/telemetry/pipeline/:jobId ──────────────────────────────────

  app.get<{ Params: { jobId: string } }>(
    "/api/telemetry/pipeline/:jobId",
    async (req) => {
      const { jobId } = req.params;
      const timeline = pipelineTelemetry.getTimeline(jobId);
      return { jobId, timeline, phases: PIPELINE_PHASES };
    },
  );

  // ── GET /api/telemetry/active ──────────────────────────────────────────

  app.get("/api/telemetry/active", async () => {
    const active = pipelineTelemetry.getActiveJobs();
    return { active, count: active.length };
  });

  // ── GET /api/telemetry/stats ───────────────────────────────────────────

  app.get("/api/telemetry/stats", async () => {
    const stats = pipelineTelemetry.getStats();
    return { stats, phases: PIPELINE_PHASES };
  });

  // ── GET /api/telemetry/jobs ────────────────────────────────────────────

  app.get("/api/telemetry/jobs", async () => {
    const jobIds = pipelineTelemetry.getAllJobIds();
    return { jobIds };
  });

  // ── GET /api/telemetry/logs ────────────────────────────────────────────

  app.get<{
    Querystring: {
      level?: string;
      source?: string;
      jobId?: string;
      kernelId?: string;
      search?: string;
      after?: string;
      before?: string;
      limit?: string;
    };
  }>("/api/telemetry/logs", async (req) => {
    const q = req.query;
    const entries = logger.query({
      level: q.level as LogLevel | undefined,
      source: q.source,
      jobId: q.jobId,
      kernelId: q.kernelId,
      search: q.search,
      after: q.after,
      before: q.before,
      limit: q.limit ? parseInt(q.limit, 10) : 200,
    });
    return {
      entries,
      total: entries.length,
      sources: logger.getSources(),
    };
  });

  // ── GET /api/telemetry/logs/stream  (SSE) ─────────────────────────────

  app.get("/api/telemetry/logs/stream", async (req, reply) => {
    // SSE connection limit (HIGH-06 fix — prevent DoS via connection flood)
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections", message: "SSE connection limit exceeded" });
    }
    trackSSEOpen(req.ip);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent history on connect
    const recent = logger.getRecent(50);
    for (const entry of recent) {
      reply.raw.write(`event: log_entry\ndata: ${JSON.stringify(entry)}\n\n`);
    }

    // Also send recent telemetry events from active jobs
    for (const summary of pipelineTelemetry.getActiveJobs().slice(0, 5)) {
      const timeline = pipelineTelemetry.getTimeline(summary.jobId).slice(-10);
      for (const evt of timeline) {
        reply.raw.write(`event: telemetry_event\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    }

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);

    logStreamClients.add(reply);

    // Heartbeat
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
        logStreamClients.delete(reply);
      }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      logStreamClients.delete(reply);
      trackSSEClose(req.ip);
    });

    // Keep alive
    await new Promise<void>(() => {});
  });

  // ── GET /api/telemetry/audit ───────────────────────────────────────────
  //
  // Returns recent audit log entries from the AuditService.
  // Useful for hackathon judges to see all activity at a glance.
  //
  // Query params:
  //   limit    — max entries to return (default 50, max 500)
  //   method   — filter by HTTP method (POST, PUT, DELETE, PATCH)
  //   eventType — filter by eventType (e.g. "job.submitted")
  //   actor    — filter by actor
  //   since    — ISO timestamp cutoff

  app.get<{
    Querystring: {
      limit?: string;
      method?: string;
      eventType?: string;
      actor?: string;
      since?: string;
    };
  }>("/api/telemetry/audit", async (req) => {
    const q = req.query;
    const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 50, 500);

    // Build audit query — method filter maps to metadata.method for http.write entries
    // but we also support direct eventType filtering for domain events
    let entries = auditService.query({
      eventType: q.eventType,
      actor: q.actor,
      since: q.since,
      limit,
    });

    // Post-filter by HTTP method if provided (filters metadata.method in http.write entries)
    if (q.method) {
      const methodUpper = q.method.toUpperCase();
      entries = entries.filter(
        (e) =>
          e.eventType === "http.write" &&
          (e.metadata as Record<string, unknown> | undefined)?.method === methodUpper,
      );
    }

    return {
      entries,
      count: entries.length,
      filters: {
        limit,
        method: q.method ?? null,
        eventType: q.eventType ?? null,
        actor: q.actor ?? null,
        since: q.since ?? null,
      },
    };
  });

  // ── POST /api/telemetry/emit ───────────────────────────────────────────

  app.post<{
    Body: {
      jobId: string;
      phase: PipelinePhase;
      status: TelemetryStatus;
      duration_ms?: number;
      metadata?: Record<string, unknown>;
      level?: "info" | "warn" | "error" | "debug";
      source?: string;
    };
  }>("/api/telemetry/emit", async (req, reply) => {
    // Restrict to operators with API keys (HIGH-04 fix — prevents arbitrary telemetry injection)
    const apiKeyId = (req as any).apiKeyId;
    const operatorId = (req as any).operatorId;
    if (!apiKeyId || !operatorId) {
      return reply.code(403).send({ error: "forbidden", message: "Telemetry emit requires operator API key authentication" });
    }

    const { jobId, phase, status, duration_ms, metadata, level, source } = req.body;

    if (!jobId || !phase || !status) {
      return reply.code(400).send({ error: "jobId, phase, status are required" });
    }

    // Sanitize metadata to prevent prompt injection in telemetry (AI-02 fix)
    const sanitizedMetadata = metadata ? sanitizeTelemetryMetadata(metadata) : undefined;

    const event = pipelineTelemetry.emit(jobId, phase, status, {
      duration_ms,
      metadata: sanitizedMetadata,
      level,
      source,
    });

    logger.info(`Telemetry event emitted: ${phase} → ${status}`, {
      source: source ?? "api",
      jobId,
      metadata: { phase, status, duration_ms },
    });

    return { event };
  });
}
