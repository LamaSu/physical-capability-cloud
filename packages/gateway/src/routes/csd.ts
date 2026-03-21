/**
 * CSD Registry API routes.
 *
 * GET    /api/csd               — list all registered CSDs
 * GET    /api/csd/:url          — get a specific CSD by URI (url-encoded)
 * POST   /api/csd               — register a new CSD
 * POST   /api/csd/resolve       — resolve a CSD with inheritance
 * POST   /api/csd/validate      — validate a CSD
 * DELETE /api/csd/:url          — retire a CSD (sets status to "retired")
 */

import type { FastifyInstance } from "fastify";
import { loadBuiltinCsds, CsdRegistry, CsdSchema } from "@pcc/spec";

// Module-level registry instance — initialized once at startup
let _registry: CsdRegistry | null = null;

/**
 * Get (or lazily initialize) the shared CSD registry.
 * Pre-loaded with all 5 built-in CSDs.
 */
export function getCsdRegistry(): CsdRegistry {
  if (!_registry) {
    _registry = loadBuiltinCsds();
  }
  return _registry;
}

/** Reset the registry (used in tests). */
export function resetCsdRegistry(): void {
  _registry = null;
}

export async function csdRoutes(app: FastifyInstance) {
  // ── GET /api/csd ────────────────────────────────────────────────
  // List all registered CSDs with optional filtering.
  // Query: ?kind=base|profile|extension|workflow  &status=active|draft|retired
  app.get<{
    Querystring: { kind?: string; status?: string };
  }>("/api/csd", async (req) => {
    const registry = getCsdRegistry();
    let csds = registry.list();

    const { kind, status } = req.query;
    if (kind) {
      csds = csds.filter((c) => c.kind === kind);
    }
    if (status) {
      csds = csds.filter((c) => c.status === status);
    }

    return { csds };
  });

  // ── POST /api/csd/resolve ───────────────────────────────────────
  // Must be registered BEFORE the /:url wildcard so Fastify doesn't
  // treat "resolve" as a URL param.
  app.post<{ Body: { url: string } }>("/api/csd/resolve", async (req, reply) => {
    const { url } = req.body ?? {};
    if (!url) {
      return reply.status(400).send({ error: "url is required" });
    }

    const registry = getCsdRegistry();
    try {
      const resolved = registry.resolve(url);
      return { csd: resolved };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) {
        return reply.status(404).send({ error: message });
      }
      return reply.status(400).send({ error: message });
    }
  });

  // ── POST /api/csd/validate ──────────────────────────────────────
  app.post("/api/csd/validate", async (req) => {
    const registry = getCsdRegistry();
    const result = registry.validate(req.body);
    return result;
  });

  // ── POST /api/csd ───────────────────────────────────────────────
  // Register a new CSD; validates against schema first.
  app.post("/api/csd", async (req, reply) => {
    const parsed = CsdSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = parsed.error.errors.map(
        (e) => `${e.path.join(".")}: ${e.message}`,
      );
      return reply.status(400).send({ error: "Invalid CSD", errors });
    }

    const registry = getCsdRegistry();
    try {
      registry.register(parsed.data);
      return { registered: true, url: parsed.data.url };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // ── GET /api/csd/:url ───────────────────────────────────────────
  // :url is the full URI, url-encoded, e.g. pcc%3A%2F%2Fcapabilities%2Ffdm%2Fv2
  app.get<{ Params: { url: string } }>("/api/csd/:url", async (req, reply) => {
    const csdUrl = decodeURIComponent(req.params.url);
    const registry = getCsdRegistry();
    const csd = registry.get(csdUrl);
    if (!csd) {
      return reply.status(404).send({ error: "not_found" });
    }
    return { csd };
  });

  // ── DELETE /api/csd/:url ────────────────────────────────────────
  // Retire a CSD by setting its status to "retired".
  app.delete<{ Params: { url: string } }>("/api/csd/:url", async (req, reply) => {
    const csdUrl = decodeURIComponent(req.params.url);
    const registry = getCsdRegistry();
    const csd = registry.get(csdUrl);
    if (!csd) {
      return reply.status(404).send({ error: "not_found" });
    }

    // Register a retired copy back into the registry (overwrites the active entry)
    const retired = { ...csd, status: "retired" as const };
    registry.register(retired);
    return { retired: true };
  });
}
