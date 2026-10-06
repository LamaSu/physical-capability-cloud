/**
 * Telemetry API Routes
 *
 * GET  /api/telemetry/pipeline/:jobId  — full event timeline for a job
 * GET  /api/telemetry/active           — list active jobs with current phase
 * GET  /api/telemetry/stats            — aggregate statistics
 * GET  /api/telemetry/logs             — query structured logs (with filters)
 * GET  /api/telemetry/logs/stream      — SSE stream of live log + telemetry events
 * POST /api/telemetry/emit             — manually emit a telemetry event
 *
 * A job's timeline, the job-id enumerations and log lines that name a job are that job's
 * records: they take the job read gate (F3 round 2, cross-family review r1 of #403). No
 * credential is 401, an unproven one 403; a proven wallet sees only the jobs it may read
 * (jobReadScopeOf) and a job it may not read looks like a job with no telemetry. Log lines
 * and live events keep the record filter's rule (jobRecordFilterOf, F3 round 3): a record is
 * kept only when the caller may read every job it names at any depth (or, naming no job, every
 * kernel it names, as that kernel's operator). A line naming neither is an admin's: its text
 * can name any job.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { pipelineTelemetry, PIPELINE_PHASES } from "../telemetry.js";
import { logger, type LogLevel } from "../structured-logger.js";
import { streamHub } from "../sse/stream-hub.js";
import { auditService } from "../services/audit-service.js";
import type { TelemetryStatus, PipelinePhase } from "../telemetry.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";
import { declare, lit } from "../observability/closed-schema.js";
import { asSent, gateJobRead, jobReadScopeOf, jobRecordFilterOf, keepAsSent, refuseJobRead, scopeAllows } from "../readmodels/job-read-gate.js";

/** The pipeline statuses the server defines: a status stays readable in the log only as one of them. */
const TELEMETRY_STATUSES: readonly TelemetryStatus[] = ["started", "completed", "failed", "skipped"];

// Active SSE clients for the live log stream, each with the records it may see
const logStreamClients = new Map<FastifyReply, (record: unknown) => boolean>();

// Subscribe to StreamHub global topic once and fan-out to SSE clients
streamHub.subscribe(
  [{ type: "global", id: "*" }],
  (event) => {
    if (event.type !== "telemetry_event" && event.type !== "log_entry") return;
    // Each client's filter judges the event as it is sent (review r3 of #403, HIGH): the text
    // written is exactly the serialization the filter read back.
    const sent = asSent(event.payload);
    if (!sent) return;
    const payload = `event: ${event.type}\ndata: ${sent.text}\n\n`;
    for (const [client, keep] of logStreamClients) {
      if (!keep(sent.value)) continue;
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
    async (req, reply) => {
      const { jobId } = req.params;
      const gate = gateJobRead(req, jobId);
      if (!gate.ok && gate.kind !== "not_found") return refuseJobRead(reply, gate);
      // A job the caller may not read gets what a job with no telemetry gets.
      // The job's own events, each judged as sent by the record filter too: an event that also
      // names a job the caller may not read is left out (review r3 of #403, HIGH).
      const filter = jobRecordFilterOf(req);
      if (!filter.ok) return refuseJobRead(reply, filter);
      const timeline = gate.ok ? keepAsSent(pipelineTelemetry.getTimeline(jobId), filter.keep) : [];
      return { jobId, timeline, phases: PIPELINE_PHASES };
    },
  );

  // ── GET /api/telemetry/active ──────────────────────────────────────────

  app.get("/api/telemetry/active", async (req, reply) => {
    const scope = jobReadScopeOf(req);
    if (!scope.ok) return refuseJobRead(reply, scope);
    const active = pipelineTelemetry.getActiveJobs().filter((summary) => scopeAllows(scope, summary.jobId));
    return { active, count: active.length };
  });

  // ── GET /api/telemetry/stats ───────────────────────────────────────────

  app.get("/api/telemetry/stats", async () => {
    const stats = pipelineTelemetry.getStats();
    return { stats, phases: PIPELINE_PHASES };
  });

  // ── GET /api/telemetry/jobs ────────────────────────────────────────────

  app.get("/api/telemetry/jobs", async (req, reply) => {
    const scope = jobReadScopeOf(req);
    if (!scope.ok) return refuseJobRead(reply, scope);
    const jobIds = pipelineTelemetry.getAllJobIds().filter((jobId) => scopeAllows(scope, jobId));
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
  }>("/api/telemetry/logs", async (req, reply) => {
    const q = req.query;
    // Asking for one job's lines is reading that job: the gate runs, and a job the caller may
    // not read has no lines. Without a job, the lines naming a job the caller may not read are
    // left out, before the limit is applied.
    // A job's lines also pass the record filter (review r3 of #403, HIGH): a line naming the job
    // at the top and another job inside is the other job's record too.
    let keep: (entry: unknown) => boolean;
    if (q.jobId) {
      const gate = gateJobRead(req, q.jobId);
      if (!gate.ok && gate.kind !== "not_found") return refuseJobRead(reply, gate);
      const filter = jobRecordFilterOf(req);
      if (!filter.ok) return refuseJobRead(reply, filter);
      keep = (entry) => gate.ok && filter.keep(entry);
    } else {
      const filter = jobRecordFilterOf(req);
      if (!filter.ok) return refuseJobRead(reply, filter);
      keep = filter.keep;
    }
    // Each line is judged, and returned, as it is sent (review r3 of #403, HIGH).
    const queried = logger
      .query({
        level: q.level as LogLevel | undefined,
        source: q.source,
        jobId: q.jobId,
        kernelId: q.kernelId,
        search: q.search,
        after: q.after,
        before: q.before,
        limit: Number.POSITIVE_INFINITY,
      });
    const entries = keepAsSent(queried, keep).slice(-(q.limit ? parseInt(q.limit, 10) : 200));
    return {
      entries,
      total: entries.length,
      // Only the sources of the lines this caller receives (review r4 of #403, MEDIUM): the full
      // list would name the sources of lines it may not read.
      sources: [...new Set(entries.map((entry) => (entry as { source?: unknown }).source).filter((s): s is string => typeof s === "string"))].sort(),
    };
  });

  // ── GET /api/telemetry/logs/stream  (SSE) ─────────────────────────────

  app.get("/api/telemetry/logs/stream", async (req, reply) => {
    // SSE connection limit (HIGH-06 fix — prevent DoS via connection flood)
    if (!canOpenSSE(req.ip)) {
      return reply.status(429).send({ error: "too_many_connections", message: "SSE connection limit exceeded" });
    }
    // Which jobs' lines and events the caller may see is fixed when the stream opens: a job
    // the caller becomes a party to later streams after a reconnect (it fails closed).
    const filter = jobRecordFilterOf(req);
    if (!filter.ok) return refuseJobRead(reply, filter);
    trackSSEOpen(req.ip);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent history on connect, each record judged as it is sent (review r3 of #403, HIGH)
    for (const entry of logger.getRecent(50)) {
      const sent = asSent(entry);
      if (sent && filter.keep(sent.value)) reply.raw.write(`event: log_entry\ndata: ${sent.text}\n\n`);
    }

    // Also send recent telemetry events from active jobs
    const activeJobs = pipelineTelemetry.getActiveJobs().filter((active) => {
      const sent = asSent(active);
      return sent !== undefined && filter.keep(sent.value);
    });
    for (const summary of activeJobs.slice(0, 5)) {
      for (const evt of pipelineTelemetry.getTimeline(summary.jobId).slice(-10)) {
        const sent = asSent(evt);
        if (sent && filter.keep(sent.value)) reply.raw.write(`event: telemetry_event\ndata: ${sent.text}\n\n`);
      }
    }

    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);

    logStreamClients.set(reply, filter.keep);

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

    // The structured log is a sink (GET /api/telemetry/logs returns it to any caller) and closes
    // what it stores (structured-logger.ts, N107b round 4, F). This route takes phase, status,
    // jobId and source straight from the body (their TS types are not checked at run time), so it
    // declares each: the phase and status readable only as members of the server's vocabularies,
    // the job id, the source and the caller's own duration_ms (not a server measurement, round 2 of
    // #538, Q2) keyed. The event returned below is the caller's own telemetry: a product response,
    // not the log.
    logger.info(lit("telemetry event emitted"), {
      phase: declare.code(phase, PIPELINE_PHASES),
      status: declare.code(status, TELEMETRY_STATUSES),
      jobId: declare.id(jobId),
      source: declare.id(source ?? "api"),
      ...(duration_ms !== undefined ? { duration_ms: declare.id(duration_ms) } : {}),
    });

    return { event };
  });
}
