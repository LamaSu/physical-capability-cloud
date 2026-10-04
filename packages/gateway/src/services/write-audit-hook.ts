/**
 * Gateway-wide write audit: an onResponse hook that logs every POST, PUT, PATCH
 * and DELETE to the audit log, so each state-changing call is captured without
 * per-route boilerplate. Individual routes may also log richer events.
 *
 * Moved out of server.ts (#458 rounds 1-3), and every field declared under the closed
 * observability schema (N107b, #538): the route is its template (never a URL), the method and
 * action come from closed vocabularies, and the status and duration are server metrics. For a
 * request that targets or imitates the public telemetry sink, the audit also omits the caller's
 * IP and User-Agent (#458). See services/telemetry-privacy.ts.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { isTelemetrySinkRequest } from "./telemetry-privacy.js";
import { declare, declaredRoute, lit, METHODS } from "../observability/closed-schema.js";

const HTTP_WRITE_ACTIONS = ["post", "put", "delete", "patch"] as const;

export async function writeAuditHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const method = request.method;
  if (method !== "POST" && method !== "PUT" && method !== "DELETE" && method !== "PATCH") return;

  const actor = (request as any).operatorId ?? (request as any).apiKeyId ?? (
    request.headers.authorization ? "authenticated" : "anonymous"
  );
  const omitClient = isTelemetrySinkRequest(request.url);

  try {
    const { auditService: audit } = await import("./audit-service.js");
    audit.log({
      eventType: lit("http.write"),
      actor,
      resourceType: lit("http"),
      action: declare.code(method.toLowerCase(), HTTP_WRITE_ACTIONS),
      metadata: {
        method: declare.code(method, METHODS),
        route: declaredRoute(request),
        statusCode: declare.metric(reply.statusCode),
        duration_ms: declare.metric(Math.round(reply.elapsedTime ?? 0)),
      },
      ip: omitClient ? undefined : request.ip,
      userAgent: omitClient ? undefined : request.headers["user-agent"],
    });
  } catch {
    // Audit failures must never affect request handling
  }
}
