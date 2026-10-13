import type { FastifyReply, FastifyRequest } from "fastify";
import { hasValidAdminKey } from "../readmodels/job-execution.js";

export const RELAY_DISABLED_REFUSAL = {
  error: "forbidden",
  reason: "relay_disabled",
  message: "The device relay is closed on this deployment.",
} as const;

export function isRelayGateOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PCC_RELAY_GATE === "open";
}

function isRelayPath(path: string | undefined): boolean {
  return path === "/api/relay" || path?.startsWith("/api/relay/") === true
    || path === "/api/ot2" || path?.startsWith("/api/ot2/") === true;
}

export function isRelayRequest(req: { url: string; routeOptions?: { url?: string } }): boolean {
  if (isRelayPath(req.routeOptions?.url)) return true;
  return isRelayPath(req.url.split("?")[0].replace(/\/+/g, "/"));
}

function countAdminKeyFields(req: FastifyRequest): number {
  let count = 0;
  const { rawHeaders } = req.raw;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "x-admin-key") count++;
  }
  return count;
}

/**
 * Root onRequest hook, registered second in createGateway, directly after the
 * request-target guard (rejectNonCanonicalTarget). Unless PCC_RELAY_GATE is
 * exactly "open", a request whose matched route or raw path is in the relay family
 * (/api/relay, /api/ot2) is refused with the fixed 403 unless it carries exactly one
 * X-Admin-Key field, counted case-insensitively from the raw header list, equal to
 * a non-empty, non-whitespace-only PCC_ADMIN_KEY (neither value is trimmed).
 *
 * For a refused request, no later request-stage hook (onRequest, preParsing,
 * preValidation, preHandler) runs. No body is read or parsed by any content-type
 * parser, nothing is validated, and no route or not-found handler runs.
 *
 * Response-stage hooks do run: onSend hooks shape the 403, and onResponse hooks
 * record it, including the gateway write audit (services/write-audit-hook.ts).
 * Its actor is only "anonymous" or "authenticated" because no caller identity has
 * been resolved. If a response-stage hook itself fails while sending the 403,
 * Fastify's onError hooks and error handler for that route handle that failure.
 *
 * Returning reply is load-bearing: Fastify settles an async hook that returns the
 * reply only once the response has finished, skipping the remaining onRequest hooks.
 *
 * Not covered: a URL whose percent-escapes the router cannot decode never reaches
 * this hook. Fastify answers 400 FST_ERR_BAD_URL before any hook runs, and no handler runs.
 */
export async function rejectRelayWithoutAdminKey(req: FastifyRequest, reply: FastifyReply) {
  if (isRelayGateOpen()) return;
  if (!isRelayRequest(req)) return;
  if (countAdminKeyFields(req) === 1 && hasValidAdminKey(req.headers["x-admin-key"])) return;
  return reply.code(403).send(RELAY_DISABLED_REFUSAL);
}
