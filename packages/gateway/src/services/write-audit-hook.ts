/**
 * Gateway-wide write audit: an onResponse hook that logs every POST, PUT, PATCH
 * and DELETE to the audit log, so each state-changing call is captured without
 * per-route boilerplate. Individual routes may also log richer events.
 *
 * Moved out of server.ts unchanged, with one exception (#458 rounds 1-3): for a
 * request that targets or imitates the public telemetry sink, the audit keeps
 * the route path only (the canonical sink path when no route matched) and never
 * the caller's IP, User-Agent or raw URL. See services/telemetry-privacy.ts.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { auditableUrl, isTelemetrySinkRequest } from "./telemetry-privacy.js";

export async function writeAuditHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const method = request.method;
  if (method !== "POST" && method !== "PUT" && method !== "DELETE" && method !== "PATCH") return;

  const actor = (request as any).operatorId ?? (request as any).apiKeyId ?? (
    request.headers.authorization ? "authenticated" : "anonymous"
  );
  const omitClient = isTelemetrySinkRequest(request.url);
  const routeUrl = request.routeOptions?.url || undefined;

  try {
    const { auditService: audit } = await import("./audit-service.js");
    audit.log({
      eventType: "http.write",
      actor,
      resourceType: "http",
      action: method.toLowerCase(),
      metadata: {
        method,
        url: auditableUrl(request.url, routeUrl),
        ...(omitClient && routeUrl === undefined ? { route_matched: false } : {}),
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
