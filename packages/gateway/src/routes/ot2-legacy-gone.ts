/**
 * Retired legacy OT-2 relay (N4b-gw item 1).
 *
 * /api/ot2/{tool-call,tool-result,scope,chat,camera}/... were a second, weaker
 * copy of the device relay. Claims, results, chat and camera reads were not
 * bound to a kernel operator, and POST /api/ot2/scope took createdBy and
 * allowedTools from the body. Those routes are unmounted. Every /api/ot2/*
 * request now answers 410 Gone and names the /api/relay/:kernelId/... route
 * that replaces it (routes/device-relay.ts). apiGate still runs first, so an
 * unauthenticated caller gets its 401 before reaching this.
 */

import type { FastifyInstance } from "fastify";

const LEGACY_PREFIX = "/api/ot2";

/** Legacy suffixes that have a device-relay equivalent at the same suffix. */
const RELAYED_SUFFIX_RE =
  /^\/(?:tool-call(?:\/pending)?|tool-result(?:\/[^/]+)?|scope(?:\/[^/]+(?:\/(?:revoke|audit))?)?|chat(?:\/(?:messages|pending|respond))?|camera\/(?:frame|latest|snapshot|stream))$/;

const KERNEL_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The /api/relay route that replaces a legacy /api/ot2 path, or null when the
 * legacy path has no equivalent. The kernel id is filled in when the legacy
 * request carried one; otherwise the route keeps its :kernelId placeholder.
 */
export function relayReplacementFor(legacyPath: string, kernelId?: string): string | null {
  if (!legacyPath.startsWith(`${LEGACY_PREFIX}/`)) return null;
  const suffix = legacyPath.slice(LEGACY_PREFIX.length);
  if (!RELAYED_SUFFIX_RE.test(suffix)) return null;
  const kernel = kernelId && KERNEL_ID_RE.test(kernelId) ? kernelId : ":kernelId";
  return `/api/relay/${kernel}${suffix}`;
}

function kernelIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).kernelId;
  return typeof id === "string" ? id : undefined;
}

export async function ot2LegacyGoneRoutes(app: FastifyInstance) {
  app.all(`${LEGACY_PREFIX}/*`, async (req, reply) => {
    const path = req.url.split("?")[0];
    const kernelId = kernelIdOf(req.query) ?? kernelIdOf(req.body);
    return reply.status(410).send({
      error: "gone",
      message:
        "The legacy /api/ot2 relay is retired. Use /api/relay/:kernelId/... with the " +
        "kernel operator's key, or with the key that holds an execution scope on that kernel.",
      replacement: relayReplacementFor(path, kernelId),
    });
  });
}
