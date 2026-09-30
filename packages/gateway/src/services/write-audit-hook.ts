/**
 * Gateway-wide write audit: an onResponse hook that logs every POST, PUT, PATCH
 * and DELETE to the audit log, so each state-changing call is captured without
 * per-route boilerplate. Individual routes may also log richer events.
 *
 * Moved out of server.ts unchanged, with one exception (#458 round 1): for the
 * public, unauthenticated telemetry sink the caller's IP and User-Agent are not
 * kept. Anyone can post there, a User-Agent can carry a token or an email, and
 * the sink's own records store neither for attempt reports.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

/** Routes (as registered) whose write audit omits the caller's IP and User-Agent. */
export const WRITE_AUDIT_NO_CLIENT_META = new Set(["/api/feedback"]);

export async function writeAuditHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const method = request.method;
  if (method !== "POST" && method !== "PUT" && method !== "DELETE" && method !== "PATCH") return;

  const actor = (request as any).operatorId ?? (request as any).apiKeyId ?? (
    request.headers.authorization ? "authenticated" : "anonymous"
  );
  const omitClient = WRITE_AUDIT_NO_CLIENT_META.has(request.routeOptions?.url ?? "");

  try {
    const { auditService: audit } = await import("./audit-service.js");
    audit.log({
      eventType: "http.write",
      actor,
      resourceType: "http",
      action: method.toLowerCase(),
      metadata: {
        method,
        url: request.url,
        statusCode: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime ?? 0),
      },
      ip: omitClient ? undefined : request.ip,
      userAgent: omitClient ? undefined : request.headers["user-agent"],
    });
  } catch {
    // Audit failures must never affect request handling
  }
}
