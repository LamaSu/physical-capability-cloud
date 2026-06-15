/**
 * Trace-ID middleware — agent-onboarding observability piece 1.
 *
 * Mints / echoes a `trace_id` for every request so we can correlate the
 * full per-agent onboarding journey across multiple calls.
 *
 *   • If `x-pcc-trace-id` is present and well-formed, it is honored.
 *   • If absent or malformed, a fresh `tr_<16hex>` is minted.
 *   • The decision is decorated onto `req.traceId` (typed accessor).
 *   • An `onSend` hook copies the trace_id into the `x-pcc-trace-id`
 *     response header so every reply round-trips it.
 *   • The trace_id is set as an attribute on the current OTel span so
 *     trace backends can index by it.
 *
 * Entry routes (`POST /api/auth/provision`, `POST /api/onboard/redeem`)
 * additionally surface `trace_id` in their JSON response body so the
 * agent can save it.
 *
 * Format choice: `tr_<random16hex>` (≈18 chars). Half the length of a
 * UUID; visibly different from operator_id/job_id/keyId so it is easy
 * to grep and hard to confuse.
 *
 * Backward-compat: nothing else changes. Routes that ignore `req.traceId`
 * continue working exactly as before.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { trace } from "@opentelemetry/api";

// ── Constants ──────────────────────────────────────────────────────────────

/** Header name carrying the trace correlation id (lowercase per HTTP/2 norm). */
export const TRACE_ID_HEADER = "x-pcc-trace-id";

/** OTel span attribute name. */
export const TRACE_ID_ATTR = "pcc.trace_id";

/** Validation regex — `tr_` prefix + 16–32 lowercase hex chars. */
const TRACE_ID_RE = /^tr_[0-9a-f]{16,32}$/;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Mint a fresh trace_id: `tr_` + 16 lowercase-hex chars (8 random bytes). */
export function mintTraceId(): string {
  return `tr_${randomBytes(8).toString("hex")}`;
}

/** Returns true iff `s` is a well-formed PCC trace_id. */
export function isValidTraceId(s: unknown): s is string {
  return typeof s === "string" && TRACE_ID_RE.test(s);
}

// ── Type augmentation ──────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    /** Stamped by the trace-id plugin. Always present after onRequest. */
    traceId: string;
  }
}

// ── Plugin ─────────────────────────────────────────────────────────────────

/**
 * Register the trace-id plugin. MUST be registered EARLY in server.ts —
 * before any route plugin that may want to read `req.traceId`. Order it
 * after the session decorator but before `apiGate`.
 *
 * Idempotent — re-registering this plugin has no effect (Fastify's
 * plugin scope guarantees this).
 */
export const traceIdPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest("traceId", "");

  app.addHook("onRequest", async (req) => {
    const raw = req.headers[TRACE_ID_HEADER];
    // headers can be string | string[] | undefined
    const candidate = Array.isArray(raw) ? raw[0] : raw;

    const traceId = isValidTraceId(candidate) ? candidate : mintTraceId();
    (req as FastifyRequest & { traceId: string }).traceId = traceId;

    // Tag the active OTel span so backends can index by it. Safe to no-op
    // when there is no active span.
    try {
      trace.getActiveSpan()?.setAttribute(TRACE_ID_ATTR, traceId);
    } catch {
      // OTel may be uninitialized in some test environments; do not fail.
    }
  });

  // Echo the trace_id back on every response so the agent sees it even
  // when the route body forgets to include it.
  app.addHook("onSend", async (req, reply, payload) => {
    const traceId = (req as FastifyRequest & { traceId?: string }).traceId;
    if (traceId) reply.header(TRACE_ID_HEADER, traceId);
    return payload;
  });
};
