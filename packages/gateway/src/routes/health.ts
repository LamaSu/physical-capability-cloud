import type { FastifyInstance } from "fastify";
import { readBuildInfo, type BuildInfo } from "../build-info.js";

export interface HealthRoutesOptions {
  /** Test seam: where the build info comes from. Production reads the image file. */
  buildInfo?: () => BuildInfo;
}

/**
 * GET /api/health and its bare alias GET /health: the gateway healthcheck.
 *
 * PUBLIC: apiGate allowlists /api/health; /health is outside /api/*.
 *
 * Both paths return the SAME payload:
 *   status          "ok"
 *   timestamp       ISO-8601, per request
 *   version         "0.1.0" (static; release-please owns versions)
 *   commit          full git SHA baked into the image at build time, or null
 *   commitSource    "image_build" | "unknown"
 *   buildArg        the build argument that supplied the SHA, or null
 *   deployMetadata  { railwayGitCommitSha }: host metadata, not proof of the code served
 *
 * commit/commitSource say WHICH COMMIT is being served (STATUS-BOARD N5, deploy
 * observability). They come only from the image file, never from a runtime variable;
 * see build-info.ts. They are read once, at registration: the build a process serves
 * cannot change while it runs.
 */
export async function healthRoutes(app: FastifyInstance, opts: HealthRoutesOptions = {}): Promise<void> {
  const { commit, commitSource, buildArg, deployMetadata } = (opts.buildInfo ?? readBuildInfo)();

  const healthPayload = () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    commit,
    commitSource,
    buildArg,
    deployMetadata,
  });

  // Health check. no-store: a cache in front of the gateway must never serve the
  // commit of a previous deploy.
  app.get("/api/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return healthPayload();
  });

  // Bare /health alias — monitors and curl-based healthchecks commonly hit
  // /health directly (not /api/health). Without this, SERVE_DASHBOARD=true's
  // SPA fallback (setNotFoundHandler in server.ts) would catch bare /health and
  // return index.html — a false-positive 200 for anything watching for a
  // real healthcheck. Same payload as /api/health.
  app.get("/health", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return healthPayload();
  });
}
