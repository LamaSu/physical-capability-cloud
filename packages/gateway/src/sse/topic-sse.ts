/**
 * Topic-based SSE endpoints — per-job, per-kernel, per-device, per-batch streaming.
 */

import type { FastifyInstance } from "fastify";
import type { StreamTopic } from "@pcc/spec";
import { streamHub } from "./stream-hub.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";
import { resolveSSEAuth } from "./sse-auth.js";
import { getJobFacade } from "../facades/index.js";

// ---------------------------------------------------------------------------
// SSE per-job ownership (gated by SSE_JOB_OWNERSHIP_CHECK)
// ---------------------------------------------------------------------------
//
// Per pcc-deliberation #058 gateway item: "SSE per-job scoping — verify each
// SSE stream only emits events for jobs the requester owns."
//
// Today: SSE topics route correctly by jobId, but ANY authenticated caller
// can subscribe to ANY jobId. This adds an env-gated ownership check on the
// per-job stream: when SSE_JOB_OWNERSHIP_CHECK is truthy AND auth resolved a
// userId, the resolver fetches the job through the JobFacade and ensures the
// caller is the owner (or the operator). If not, the request is rejected
// with 403.
//
// Default: OFF (preserves back-compat with pcc-node clients that historically
// streamed without an operator-bound API key). Owners can flip
// SSE_JOB_OWNERSHIP_CHECK=true once they've verified their fleet's keys are
// scoped per-operator.

function isJobOwnershipCheckEnabled(): boolean {
  const v = process.env.SSE_JOB_OWNERSHIP_CHECK;
  if (!v) return false;
  return v === "true" || v === "1" || v === "yes";
}

interface JobOwnerCheckResult {
  authorized: boolean;
  reason?: string;
}

/**
 * Best-effort job-ownership check. Returns `authorized: true` when:
 *   - ownership check is disabled, OR
 *   - no userId was resolved (no caller identity to compare against), OR
 *   - the userId matches the job's operatorId / ownerAddress, OR
 *   - the job cannot be loaded (open-fail — never block legitimate streams
 *     because of a transient facade error)
 *
 * Returns `authorized: false` only on a positive mismatch.
 */
async function checkJobOwnership(
  jobId: string,
  userId: string | undefined,
): Promise<JobOwnerCheckResult> {
  if (!isJobOwnershipCheckEnabled()) return { authorized: true };
  if (!userId) return { authorized: true };

  try {
    const facade = getJobFacade();
    const res = await facade.getById(jobId);
    if (!res.success) {
      // Job not found / facade error — don't 403 on missing data; the SSE
      // stream will simply receive no events.
      return { authorized: true };
    }
    const job = res.data as {
      operatorId?: string;
      ownerAddress?: string;
      payerAddress?: string;
    };
    const owners = [
      job.operatorId,
      job.ownerAddress,
      job.payerAddress,
    ].filter((x): x is string => typeof x === "string" && x.length > 0);
    if (owners.length === 0) return { authorized: true };
    const userLower = userId.toLowerCase();
    const match = owners.some((o) => o.toLowerCase() === userLower);
    if (match) return { authorized: true };
    return {
      authorized: false,
      reason: `userId=${userId} is not the owner of jobId=${jobId}`,
    };
  } catch {
    // Open-fail on facade errors.
    return { authorized: true };
  }
}

// Strict origin allowlist — prevents subdomain spoofing attacks
const ALLOWED_SSE_ORIGINS = new Set([
  "https://capability.network",
  "http://localhost:5173",
  "http://localhost:3200",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3200",
]);

/** The longest id or event name a frame carries (N49 round 6). */
const MAX_SSE_FIELD_LENGTH = 256;

/**
 * Whether a value can go on an SSE `id:` or `event:` line as it is (N49 round 6).
 * Those lines end at the first CR or LF, so a publisher's id or type holding
 * one could add lines or whole frames to the stream; a NUL is refused too.
 * Data is always JSON.stringify'd, which escapes all three, so data needs no guard.
 */
function isSafeSseField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SSE_FIELD_LENGTH && !/[\r\n\0]/.test(value);
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

  /**
   * Helper to set up an SSE connection for given topics.
   *
   * Every frame is guarded (N49 round 6): an event whose type is not a safe
   * line is dropped, and a publisher id that is not one is left out of the
   * frame. A stream that passes `cursorIds` (the shared batch stream) writes
   * nothing the publisher wrote: each frame is the view the hub decided once,
   * at publish, and froze with the event's cursor (rounds 7 and 8). Its id is
   * that cursor, and Last-Event-ID is read back as one. An event without a view
   * is never written there. Other streams write events as published.
   */
  function setupSSE(
    req: { raw: { on: (event: string, cb: () => void) => void }; ip?: string },
    reply: { raw: { writeHead: (status: number, headers: Record<string, string>) => void; write: (data: string) => void } },
    topics: StreamTopic[],
    lastEventId?: string,
    origin?: string,
    cursorIds = false,
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
      (event, cursor) => {
        let type: unknown;
        let data: unknown;
        if (cursorIds) {
          // The view the hub froze with the cursor at publish: the one
          // judgment that decided both whether the event is numbered and what
          // the stream shows (rounds 7 and 8). The event itself is not read again.
          if (!cursor?.view) return;
          type = cursor.view.type;
          data = cursor.view.payload;
        } else {
          type = event.type;
          data = event.payload;
        }
        // A type that could end its line early would let the event write
        // lines of its own choosing: drop the event.
        if (!isSafeSseField(type)) return;
        // The frame's id: the hub's cursor on a cursor stream (no cursor, no
        // id), else the publisher's id when it is a safe line.
        const id = cursorIds
          ? (cursor ? String(cursor.seq) : undefined)
          : (isSafeSseField(event.id) ? event.id : undefined);
        const idLine = id === undefined ? "" : `id: ${id}\n`;
        const payload = `${idLine}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          reply.raw.write(payload);
        } catch {
          unsubscribe();
        }
      },
      lastEventId,
      cursorIds ? { cursor: "seq" } : undefined,
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

    // #058 — verify the authenticated user owns this job. Gated by
    // SSE_JOB_OWNERSHIP_CHECK to preserve back-compat with shared clients.
    const ownership = await checkJobOwnership(jobId, auth.userId);
    if (!ownership.authorized) {
      return reply.status(403).send({
        error: "SSE_JOB_FORBIDDEN",
        message: ownership.reason ?? "not authorized for this jobId",
      });
    }

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

  // Per-batch streaming. The batch topic is SHARED: every authenticated
  // subscriber of a batchId receives the same events, and there is no ownership
  // check. So per-sample data must never be on it. The projection therefore
  // applies to every event on the topic, whoever published it (the sensor
  // pipeline, the BatchTracker, a mock producer, a future producer), not inside
  // any one producer: the hub runs it ONCE per event at publish
  // (sse/stream-hub.ts, batchStreamView) and freezes the result with the
  // event's cursor, and this stream writes only that view (rounds 7 and 8).
  // Only the aggregate batch-level events pass; per-sample events stay on the
  // authenticated, owner-projected HTTP surface (routes/batches.ts viewEvents).
  // The whole frame is the stream's, not the publisher's (round 6): its id is
  // the hub's cursor on this topic, so no publisher id (which could name a
  // sample, a job or a result) reaches a subscriber, and Last-Event-ID resumes
  // from that cursor. Anything else as Last-Event-ID replays nothing.
  app.get("/sse/stream/batch/:batchId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { batchId } = req.params as { batchId: string };
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "batch", id: batchId }], lastEventId, origin, true);
    await new Promise(() => {});
  });
}
