/**
 * Gateway-wide write audit: an onResponse hook that logs every POST, PUT, PATCH
 * and DELETE to the audit log, so each state-changing call is captured without
 * per-route boilerplate. Individual routes may also log richer events.
 *
 * Moved out of server.ts unchanged, with one exception (#458 rounds 1-2): for the
 * public, unauthenticated telemetry sink the caller's IP and User-Agent are not
 * kept, and the URL is the registered route path, never the raw URL with its
 * query string. Anyone can post there, and a User-Agent or a query string can
 * carry a token or an email.
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
        url: omitClient ? (request.routeOptions?.url ?? request.url.split("?")[0]) : request.url,
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
