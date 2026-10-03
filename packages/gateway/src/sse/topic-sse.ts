/**
 * Topic-based SSE endpoints — per-job, per-kernel, per-device, per-batch streaming.
 */

import type { FastifyInstance } from "fastify";
import type { StreamTopic } from "@pcc/spec";
import { streamHub } from "./stream-hub.js";
import { canOpenSSE, trackSSEOpen, trackSSEClose } from "../middleware/security-hardening.js";
import { resolveSSEAuth } from "./sse-auth.js";
import { asSent, gateJobRead, gateKernelRead, refuseJobRead, streamEventFilterOf, type KernelReadGate } from "../readmodels/job-read-gate.js";
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { batchTracker } from "../services.js";

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
    lastEventId: string | undefined,
    origin: string | undefined,
    keep: (event: unknown) => boolean,
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
        // The event is judged as it is sent (review r3 of #403, HIGH): its JSON form, parsed back.
        // An event naming a job the caller may not read, at any depth, is not written (CRITICAL).
        const sent = asSent(event.payload);
        if (!sent || !keep(sent.value)) return;
        const payload = `id: ${event.id}\nevent: ${event.type}\ndata: ${sent.text}\n\n`;
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

  // Per-job streaming. A job's live events are its records, so the job read gate runs before
  // the stream opens (F3 round 2; it replaces #058's SSE_JOB_OWNERSHIP_CHECK, which was off by
  // default and let a caller through when it could not decide). Only an admin, the job's
  // kernel operator or its recorded buyer subscribes: no credential is 401, an unproven one
  // 403, and anyone else gets the 404 a job that does not exist gets. A refused request gives
  // back the connection slot the onRequest hook took.
  app.get("/sse/stream/job/:jobId", async (req, reply) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      trackSSEClose(req.ip);
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const { jobId } = req.params as { jobId: string };
    const gate = gateJobRead(req, jobId);
    if (!gate.ok) {
      trackSSEClose(req.ip);
      return refuseJobRead(reply, gate, { error: "not_found", message: `job '${jobId}' not found` });
    }
    // Which events the caller may see is fixed when the stream opens (as on the log stream).
    const events = streamEventFilterOf(req);
    if (!events.ok) {
      trackSSEClose(req.ip);
      return refuseJobRead(reply, events);
    }

    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [{ type: "job", id: jobId }], lastEventId, origin, events.keep);
    await new Promise(() => {});
  });

  // Per-kernel, per-device and per-batch streaming (F3 round 3, cross-family review r2 of #403,
  // CRITICAL). These topics carry job-bound records: a sensor reading is published to its
  // kernel's and device's topics, and its batch's, as well as its job's. So each takes the
  // kernel's read rule: an admin or the kernel's operator (a proven wallet) subscribes; no
  // credential is 401, an unproven one 403, and anyone else gets the 404 an unknown kernel,
  // device or batch gets, before any subscription. A refused request gives back its slot.
  const kernelStream = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    what: string,
    id: string,
    kernelIdOf: () => string | null | undefined,
    topic: StreamTopic,
    opts: { kernelRow?: boolean } = {},
  ) => {
    const auth = await resolveSSEAuth(req);
    if (!auth.authenticated) {
      trackSSEClose(req.ip);
      return reply.status(401).send({ error: "SSE_AUTH_REQUIRED", message: auth.reason });
    }
    const gate: KernelReadGate = gateKernelRead(req, kernelIdOf, opts);
    if (!gate.ok) {
      trackSSEClose(req.ip);
      return refuseJobRead(reply, gate, { error: "not_found", message: `${what} '${id}' not found` });
    }
    // The kernel's stream carries job-bound readings: each one is also its job's record, so under
    // TENANT_ENFORCE only the jobs of the caller's tenant reach it (review r3 of #403, CRITICAL).
    const events = streamEventFilterOf(req);
    if (!events.ok) {
      trackSSEClose(req.ip);
      return refuseJobRead(reply, events);
    }
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const origin = req.headers.origin as string | undefined;
    setupSSE(req, reply, [topic], lastEventId, origin, events.keep);
    await new Promise(() => {});
  };

  app.get("/sse/stream/kernel/:kernelId", async (req, reply) => {
    const { kernelId } = req.params as { kernelId: string };
    return kernelStream(req, reply, "kernel", kernelId, () => kernelId, { type: "kernel", id: kernelId }, { kernelRow: true });
  });

  app.get("/sse/stream/device/:deviceId", async (req, reply) => {
    const { deviceId } = req.params as { deviceId: string };
    const kernelOfDevice = () =>
      (getStore().db.select({ kernelId: schema.kernelDevices.kernelId }).from(schema.kernelDevices)
        .where(eq(schema.kernelDevices.id, deviceId)).get() as { kernelId?: string } | undefined)?.kernelId;
    return kernelStream(req, reply, "device", deviceId, kernelOfDevice, { type: "device", id: deviceId });
  });

  app.get("/sse/stream/batch/:batchId", async (req, reply) => {
    const { batchId } = req.params as { batchId: string };
    return kernelStream(req, reply, "batch", batchId, () => batchTracker.getBatch(batchId)?.kernelId, { type: "batch", id: batchId });
  });
}
