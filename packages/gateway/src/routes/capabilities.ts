import type { FastifyInstance, FastifyReply } from "fastify";
import { getAllTemplates, getRegisteredTypes } from "@pcc/contract-builder";
import type { Result } from "@pcc/spec";
import { getCapabilityFacade, type CreateCapabilityInput } from "../facades/index.js";

// ── Result→HTTP helper ────────────────────────────────────────────────────────
//
// Maps a Result<T> returned by any facade method to a Fastify HTTP response.
// Success → 200 with data as body (Fastify serialises automatically).
// Failure → reply.code(httpStatus).send({ error, message[, details] }).
//
function sendResult<T>(reply: FastifyReply, result: Result<T>): unknown {
  if (result.success) return result.data;
  return reply.code(result.error.httpStatus).send({
    error: result.error.code,
    message: result.error.message,
    ...(result.error.details ? { details: result.error.details } : {}),
  });
}

export async function capabilityRoutes(app: FastifyInstance) {
  // Acquire singleton once per plugin registration — safe because the DB is
  // initialised before route plugins are registered in server.ts.
  const facade = getCapabilityFacade();

  // ── Contract-builder routes (NOT DB-backed) ─────────────────────────────
  // These are pure in-memory lookups against the registered template registry.
  // They do not use the facade and do not need sendResult().

  /** List all registered capability type strings (e.g. "3d-printing", "cnc") */
  app.get("/api/capabilities/types", async () => {
    return { types: getRegisteredTypes() };
  });

  /** List all capability templates with pricing hints and parameter metadata */
  app.get("/api/capabilities/templates", async () => {
    const templates = getAllTemplates();
    return {
      templates: templates.map((t) => ({
        capabilityType: t.capabilityType,
        name: t.name,
        version: t.version,
        description: t.description,
        paramCount: t.params.length,
        groups: [...new Set(t.params.map((p) => p.group))],
        basePrice: t.basePricingHints?.basePrice,
        currency: t.basePricingHints?.currency,
      })),
    };
  });

  // ── DB-backed routes (via CapabilityFacade) ─────────────────────────────

  /**
   * List all capability instances across all kernels.
   * Accepts optional pagination query params (offset, limit).
   * Returns PaginatedResult<CapabilityDTO> for richer clients.
   *
   * PUBLIC — no auth required (see middleware/api-gate.ts PUBLIC_EXACT).
   */
  app.get<{ Querystring: { offset?: number; limit?: number } }>(
    "/api/capabilities",
    async (req, reply) => {
      const result = await facade.list({}, {
        offset: req.query.offset,
        limit: req.query.limit,
      });
      return sendResult(reply, result);
    },
  );

  /**
   * Capabilities for a specific kernel.
   * Returns { capabilities: CapabilityDTO[] } to preserve backward compat
   * with existing clients and tests that expect this envelope shape.
   */
  app.get<{ Params: { kernelId: string } }>(
    "/api/capabilities/by-kernel/:kernelId",
    async (req, reply) => {
      const result = await facade.listByKernel(req.params.kernelId);
      if (result.success) return { capabilities: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Capabilities filtered by type.
   * Returns { capabilities: CapabilityDTO[] } for backward compat.
   */
  app.get<{ Params: { type: string } }>(
    "/api/capabilities/by-type/:type",
    async (req, reply) => {
      const result = await facade.listByType(req.params.type);
      if (result.success) return { capabilities: result.data };
      return sendResult(reply, result);
    },
  );

  /**
   * Full-text search across capability names, types, and materials.
   * Payment-gated at $0.001 USDC per request (enforced by x402-gate middleware
   * before this handler runs — no special handling needed here).
   * Returns early with empty array when query string is absent/empty.
   */
  app.get<{ Querystring: { q?: string } }>(
    "/api/capabilities/search",
    async (req, reply) => {
      const q = req.query.q ?? "";
      if (!q) return { capabilities: [] };
      const result = await facade.search({ query: q });
      return sendResult(reply, result);
    },
  );

  /**
   * Single capability by ID with full enrichment (reputation, availability).
   * Returns 404 when not found (previously returned 200 with { error: "not_found" }).
   */
  app.get<{ Params: { capId: string } }>(
    "/api/capabilities/:capId",
    async (req, reply) => {
      const result = await facade.getById(req.params.capId);
      return sendResult(reply, result);
    },
  );

  /**
   * Embeddable button config for a capability.
   *
   * Returns a JSON config object (default), an HTML snippet (?format=html),
   * or a full drop-in embed snippet (?format=script) that third-party sites
   * can embed to let users launch a PCC negotiation directly in Claude Code.
   *
   * PUBLIC — CORS wildcard (embeddable by any origin), no auth required.
   * Cache: public, max-age=60 (queue depth changes frequently).
   *
   * Query params:
   *   format  "json" (default) | "html" | "script"
   *   label   Custom button label  (default: "Run on Claude Code")
   *   theme   "dark" (default) | "light"
   */
  app.get<{
    Params: { id: string };
    Querystring: {
      format?: "json" | "html" | "script";
      label?: string;
      theme?: "dark" | "light";
    };
  }>(
    "/api/capabilities/:id/button",
    async (req, reply) => {
      const result = await facade.getById(req.params.id);
      if (!result.success) return sendResult(reply, result);

      const cap = result.data;
      const gatewayUrl = process.env.PCC_GATEWAY_URL ?? "https://capability.network";

      const label = req.query.label ?? "Run on Claude Code";
      const command = `pcc negotiate --capability ${cap.type} --kernel ${cap.kernelId}`;
      const kernelDisplay = cap.kernelName ?? cap.kernelId;
      const capDisplay = cap.name ?? cap.type;
      const prompt =
        `I want to use the ${cap.type} capability (${capDisplay}) at ${kernelDisplay}. ` +
        `Help me negotiate a contract and submit a job.`;

      const contextUrl = `${gatewayUrl}/api/capabilities/${cap.id}`;
      const mcpServer = `${gatewayUrl}/mcp`;

      const buttonAttrs = {
        command,
        label,
        prompt,
        contextUrl,
        mcpServer,
      };

      // Escape double-quotes inside attribute values for safe HTML embedding
      const escapeAttr = (s: string) => s.replace(/"/g, "&quot;");

      const htmlSnippet =
        `<claude-code-button` +
        ` command="${escapeAttr(command)}"` +
        ` label="${escapeAttr(label)}"` +
        ` context-url="${escapeAttr(contextUrl)}"` +
        `></claude-code-button>`;

      const format = req.query.format ?? "json";

      reply
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "public, max-age=60");

      if (format === "html") {
        return reply.type("text/html").send(htmlSnippet);
      }

      if (format === "script") {
        const scriptEmbed =
          `<script src="https://unpkg.com/claudebuttons/dist/index.js"></script>\n` +
          htmlSnippet;
        return reply.type("text/html").send(scriptEmbed);
      }

      // Default: JSON
      return {
        capability: {
          id: cap.id,
          kernelId: cap.kernelId,
          type: cap.type,
          name: cap.name,
          description: cap.description,
          available: cap.available,
          queueDepth: cap.queueDepth,
          estimatedWaitMinutes: cap.estimatedWaitMinutes,
          pricing: cap.pricing,
          kernelName: cap.kernelName,
          kernelStatus: cap.kernelStatus,
          reputation: cap.reputation,
        },
        button: buttonAttrs,
        html: htmlSnippet,
        embedScript: `<script src="https://unpkg.com/claudebuttons/dist/index.js"></script>`,
      };
    },
  );

  /**
   * Create a capability instance (upsert-style).
   * Returns 201 + { capability, created: true } on creation.
   * Returns 200 + { capability, created: false } when the capability already exists.
   * Returns 400 when kernelId or type is missing.
   * Returns 500 on DB failure with { error, message }.
   */
  app.post<{ Body: CreateCapabilityInput }>("/api/capabilities", async (req, reply) => {
    const { kernelId, type } = req.body;
    if (!kernelId || !type) {
      return reply.code(400).send({ error: "kernelId and type required" });
    }
    const result = await facade.create(req.body);
    if (!result.success) {
      return reply.code(result.error.httpStatus).send({
        error: result.error.code,
        message: result.error.message,
        ...(result.error.details ? { details: result.error.details } : {}),
      });
    }
    const { capability, created } = result.data;
    if (created) {
      return reply.code(201).send({ capability, created: true });
    }
    return { capability, created: false };
  });
}
