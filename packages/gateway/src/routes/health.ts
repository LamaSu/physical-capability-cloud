import type { FastifyInstance } from "fastify";
import { readBuildInfo } from "../build-info.js";

/**
 * GET /api/health and its bare alias GET /health: the gateway healthcheck.
 *
 * PUBLIC: apiGate allowlists /api/health; /health is outside /api/*.
 *
 * Both paths return the SAME payload:
 *   status        "ok"
 *   timestamp     ISO-8601, per request
 *   version       "0.1.0" (static; release-please owns versions)
 *   commit        git SHA this process was built from, or null
 *   commitSource  "image_build" | "railway_deploy" | "unknown"
 *
 * commit/commitSource say WHICH COMMIT is being served (STATUS-BOARD N5,
 * deploy observability); see build-info.ts for the sources and the SHA
 * validation. They are read once, at registration: the build a process
 * serves cannot change while it runs.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { commit, commitSource } = readBuildInfo();

  const healthPayload = () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    commit,
    commitSource,
  });

  // Health check
  app.get("/api/health", async () => healthPayload());

  // Bare /health alias — monitors and curl-based healthchecks commonly hit
  // /health directly (not /api/health). Without this, SERVE_DASHBOARD=true's
  // SPA fallback (setNotFoundHandler in server.ts) would catch bare /health and
  // return index.html — a false-positive 200 for anything watching for a
  // real healthcheck. Same payload as /api/health.
  app.get("/health", async () => healthPayload());
}
