/**
 * Visualizer SSE proxy + replay endpoint.
 *
 * Provides an *unauthenticated*, *CORS-permissive* fan-out of the global
 * StreamHub topic, scoped to non-PII lifecycle events that drive the
 * substrate visualizer at /visualizer.html.
 *
 * Two surfaces:
 *
 *   GET /api/visualizer/events
 *     Server-Sent Events stream. Each event is a JSON line with shape:
 *       { id, type, ts, topic, payload }
 *     Sends a snapshot of the last 200 events on connect, then live.
 *     Optional ?since=<ISO timestamp> filters the snapshot.
 *
 *   GET /api/visualizer/events.json
 *     One-shot snapshot of the last N events (default 600) as JSON array.
 *     Used to generate the offline fixtures file at
 *     apps/dashboard/public/visualizer-test-fixtures.json.
 *
 * Auth model: read-only, public. The visualizer never exposes operator
 * identifiers, monetary balances, or any PII — only event types, kernel/
 * device IDs, and aggregate counts. If a payload contains sensitive
 * fields they are stripped here, not in the visualizer.
 *
 * Why a new endpoint (not reuse /sse/notifications): notifications.ts
 * requires auth and has a strict CORS allowlist. The visualizer is a
 * public demo surface — we want it loadable from any local dev server,
 * any docs page, any conference projector. This route never returns
 * 401 and never enforces an origin.
 *
 * Why a replay window: the demo must survive a brief network drop and
 * support "rewind to a wow moment" via ?since=<ISO>. StreamHub already
 * has a 500-event replay buffer; we expose it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";

// Event types the visualizer cares about. Other event types pass
// through but are tagged in the payload for the renderer to ignore.
const VISIBLE_EVENT_TYPES = new Set<string>([
  // Lifecycle
  "connected",
  "kernel_registered",
  "kernel_heartbeat",
  "device_registered",
  "device_status",
  "capability_announced",
  // Discovery + quoting
  "capability_discovered",
  "quote_requested",
  "quote_returned",
  "negotiation_session_created",
  "negotiation_session_committed",
  // Escrow + funding
  "escrow_created",
  "escrow_funded",
  "escrow_released",
  "escrow_disputed",
  // Jobs
  "job_submitted",
  "job_started",
  "job_progress",
  "job_completed",
  "job_failed",
  "protocol_run_start",
  "protocol_step_complete",
  "protocol_run_complete",
  // Evidence + attestation
  "evidence_captured",
  "evidence",
  "milestone",
  "attestation_submitted",
  "drift_alert",
  "sensor_anomaly",
  // Sensor (heavy — sampled by visualizer)
  "sensor_reading",
  // Batch + log (passthrough but tagged)
  "batch_event",
  "process_log",
  "agent_message",
]);

interface VisualizerEvent {
  id: string;
  type: string;
  ts: string;
  topic: { type: string; id: string };
  payload: unknown;
}

function sanitize(event: StreamEvent): VisualizerEvent {
  // Strip any field that could leak sensitive data. The visualizer
  // only ever reads: type, topic, and a small set of payload keys.
  const payload = event.payload as Record<string, unknown> | null | undefined;
  const safePayload: Record<string, unknown> = {};
  if (payload && typeof payload === "object") {
    // Allowlist payload keys we surface to the visualizer.
    const ALLOW = new Set([
      "kernelId", "deviceId", "jobId", "batchId", "runId",
      "capabilityId", "capabilityType", "type", "status", "progress",
      "phase", "step", "stepIndex", "totalSteps",
      "channel", "metric", "value", "severity",
      "amount", "currency", "milestoneCount", "releasedCount",
      "from", "to", "label", "tier", "assuranceTier",
      "evidenceBundleId", "bundleHash",
    ]);
    for (const k of Object.keys(payload)) {
      if (ALLOW.has(k)) safePayload[k] = payload[k];
    }
  }

  return {
    id: event.id,
    type: event.type,
    ts: event.timestamp,
    topic: event.topic ? { type: event.topic.type, id: event.topic.id } : { type: "global", id: "*" },
    payload: safePayload,
  };
}

function snapshotEvents(sinceISO?: string, limit = 200): VisualizerEvent[] {
  // Peek into the StreamHub's global replay buffer. We use the
  // private-ish field via a small adapter to avoid changing
  // stream-hub.ts public API.
  const hub = streamHub as unknown as {
    replayBuffers: Map<string, StreamEvent[]>;
  };
  const globalBuf = hub.replayBuffers.get("global:*") ?? [];

  let events = globalBuf.slice();
  if (sinceISO) {
    const sinceMs = Date.parse(sinceISO);
    if (!Number.isNaN(sinceMs)) {
      events = events.filter((e) => Date.parse(e.timestamp) >= sinceMs);
    }
  }

  // Cap and sanitize.
  if (events.length > limit) {
    events = events.slice(-limit);
  }
  return events
    .filter((e) => VISIBLE_EVENT_TYPES.has(e.type) || e.type === "connected")
    .map(sanitize);
}

// Track open clients so we can broadcast without re-subscribing
// the hub for every connection.
const clients = new Set<FastifyReply>();

function writeSSE(reply: FastifyReply, event: VisualizerEvent): void {
  try {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`id: ${event.id}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    clients.delete(reply);
  }
}

let hubSubscribed = false;
function ensureHubSubscription(): void {
  if (hubSubscribed) return;
  hubSubscribed = true;
  streamHub.subscribe(
    [{ type: "global", id: "*" }],
    (event: StreamEvent) => {
      if (!VISIBLE_EVENT_TYPES.has(event.type)) return;
      const sanitized = sanitize(event);
      for (const c of clients) writeSSE(c, sanitized);
    },
  );
}

export async function visualizerEvents(app: FastifyInstance): Promise<void> {
  ensureHubSubscription();

  app.get("/api/visualizer/events", async (req: FastifyRequest, reply) => {
    const { since } = (req.query ?? {}) as { since?: string };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
      // Public, no credentials. The visualizer is a demo surface.
      "Access-Control-Allow-Origin": "*",
    });

    // Send a hello so the client knows the stream is alive even
    // before any real events arrive.
    reply.raw.write(`: visualizer stream\n\n`);
    reply.raw.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    // Snapshot — last 200 events filtered by ?since.
    const snapshot = snapshotEvents(since, 200);
    for (const ev of snapshot) writeSSE(reply, ev);

    clients.add(reply);

    // Keep-alive comments so intermediaries don't close idle SSE.
    const ka = setInterval(() => {
      try { reply.raw.write(`: ka\n\n`); } catch { clearInterval(ka); clients.delete(reply); }
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(ka);
      clients.delete(reply);
    });

    // Hold the connection open. Fastify's reply stream stays alive
    // as long as we don't return anything that closes it.
    await new Promise(() => {});
  });

  app.get("/api/visualizer/events.json", async (req: FastifyRequest, reply) => {
    const { since, limit } = (req.query ?? {}) as { since?: string; limit?: string };
    const n = Math.max(1, Math.min(2000, Number.parseInt(limit ?? "600", 10) || 600));
    const events = snapshotEvents(since, n);
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cache-Control", "no-cache");
    return { events, count: events.length, capturedAt: new Date().toISOString() };
  });
}
