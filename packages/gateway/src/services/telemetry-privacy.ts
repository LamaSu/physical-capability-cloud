import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Privacy rules for the public, unauthenticated telemetry sink (`/api/feedback`)
 * in the gateway-wide sinks that see every request: the write-audit hook and the
 * Fastify request logger (#458 rounds 1-3).
 *
 * Anyone can post to the sink, and a query string, a path segment or a
 * User-Agent can carry a token or an email. So for a request that targets the
 * sink, or merely imitates it (`/api/feedback//token-abc`, `/api/%66eedback`),
 * these sinks record only the registered route path, or the canonical sink path
 * when no route matched, and never the caller's IP, User-Agent or raw URL.
 */

/** The public telemetry sink's path. Any request path that begins with it is treated as the sink. */
export const TELEMETRY_SINK_PATH = "/api/feedback";

/** The request path alone: no query or fragment, percent-decoded where possible, lower-cased, repeated slashes collapsed. */
export function canonicalRequestPath(rawUrl: string): string {
  const path = rawUrl.split(/[?#]/, 1)[0] ?? "";
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // a malformed escape: keep the raw path
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/");
}

/** Whether a request targets, or imitates, the public telemetry sink. */
export function isTelemetrySinkRequest(rawUrl: string): boolean {
  return canonicalRequestPath(rawUrl).startsWith(TELEMETRY_SINK_PATH);
}

/** The URL a gateway-wide sink may record: the route template for the sink, otherwise the raw URL. */
export function auditableUrl(rawUrl: string, routeUrl: string | undefined): string {
  return isTelemetrySinkRequest(rawUrl) ? (routeUrl || TELEMETRY_SINK_PATH) : rawUrl;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  hostname?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number } | null;
  routeOptions?: { url?: string };
}

/**
 * Fastify's request serializer, unchanged for every route but the telemetry
 * sink, whose log line carries the method and route path only.
 */
export function requestLogSerializer(req: LoggedRequest): Record<string, unknown> {
  const rawUrl = req.url ?? "";
  if (isTelemetrySinkRequest(rawUrl)) {
    return { method: req.method, url: auditableUrl(rawUrl, req.routeOptions?.url) };
  }
  return {
    method: req.method,
    url: rawUrl,
    version: req.headers?.["accept-version"],
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}

/** The gateway's logger options (server.ts): pino at its default level, with the sanitising request serializer. */
export const GATEWAY_LOGGER_OPTIONS = { serializers: { req: requestLogSerializer } };

/**
 * onRequest hook: an unrouted request that imitates the sink gets a fixed 404
 * here, before Fastify's default not-found handler can log
 * "Route <method>:<raw url> not found" with the caller's path in it.
 */
export async function telemetryLookalikeHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.is404 && isTelemetrySinkRequest(request.url)) {
    await reply.code(404).send({ error: "not_found" });
  }
}
