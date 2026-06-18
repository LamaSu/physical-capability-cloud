import type { FastifyInstance, FastifyReply } from "fastify";
import { getAllTemplates, getRegisteredTypes, getTemplate } from "@pcc/contract-builder";
import type { Result, ParamDef, CapabilityTemplate } from "@pcc/spec";
import { getCapabilityFacade, type CreateCapabilityInput } from "../facades/index.js";

// ── WoT Thing Description helpers ────────────────────────────────────────────
//
// Translates a CapabilityTemplate's ParamDef[] into a JSON-Schema-ish
// object suitable for use as a WoT TD action `input` field.
//
function paramDefToJsonSchemaProp(p: ParamDef): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: p.label,
    description: p.description,
  };
  if (p.type === "enum") {
    return {
      ...base,
      type: "string",
      enum: p.options.map((o) => o.value),
      ...(p.defaultValue !== undefined ? { default: p.defaultValue } : {}),
    };
  }
  if (p.type === "number") {
    return {
      ...base,
      type: "number",
      minimum: p.min,
      maximum: p.max,
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.defaultValue !== undefined ? { default: p.defaultValue } : {}),
    };
  }
  if (p.type === "boolean") {
    return {
      ...base,
      type: "boolean",
      ...(p.defaultValue !== undefined ? { default: p.defaultValue } : {}),
    };
  }
  // string
  return {
    ...base,
    type: "string",
    ...(p.maxLength ? { maxLength: p.maxLength } : {}),
    ...(p.defaultValue !== undefined ? { default: p.defaultValue } : {}),
  };
}

function buildExecuteInputSchema(template: CapabilityTemplate | undefined): Record<string, unknown> {
  if (!template) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const p of template.params) {
    properties[p.key] = paramDefToJsonSchemaProp(p);
    if (p.required) required.push(p.key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

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
  app.get(
    "/api/capabilities/types",
    {
      schema: {
        tags: ["discovery"],
        summary: "List all registered capability types",
        description:
          "Returns the canonical set of capability type identifiers " +
          "(e.g. 3d-printing, cnc, hplc, laser-cutting). PUBLIC — no auth required.",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              types: { type: "array", items: { type: "string" } },
            },
            required: ["types"],
          },
        },
      },
    },
    async () => {
      return { types: getRegisteredTypes() };
    },
  );

  /** List all capability templates with pricing hints and parameter metadata */
  app.get(
    "/api/capabilities/templates",
    {
      schema: {
        tags: ["discovery"],
        summary: "List capability templates with pricing hints",
        description:
          "Returns the structural template for each registered capability " +
          "type, including parameter group counts and base pricing hints. " +
          "Use this to build a UI selector before calling /api/build/options.",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              templates: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    capabilityType: { type: "string" },
                    name: { type: "string" },
                    version: { type: "string" },
                    description: { type: "string" },
                    paramCount: { type: "integer" },
                    groups: { type: "array", items: { type: "string" } },
                    basePrice: { type: "number" },
                    currency: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
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
    },
  );

  // ── DB-backed routes (via CapabilityFacade) ─────────────────────────────

  /**
   * List all capability instances across all kernels.
   * Accepts optional pagination query params (offset, limit).
   * Returns PaginatedResult<CapabilityDTO> for richer clients.
   *
   * PUBLIC — no auth required (see middleware/api-gate.ts PUBLIC_EXACT).
   */
  app.get<{ Querystring: { offset?: number; limit?: number; type?: string } }>(
    "/api/capabilities",
    {
      schema: {
        tags: ["discovery"],
        summary: "List capability instances (paginated, optionally filtered by type)",
        description:
          "Returns a paginated set of CapabilityDTO records spanning all " +
          "registered kernels. Each record includes type, materials, " +
          "tolerances, pricing, location, plus enrichment fields " +
          "(reputation, queueDepth, available, kernelStatus). PUBLIC. " +
          "Optional ?type= narrows the set. The match is BOTH exact " +
          "(`type=pizza.order` returns only `pizza.order` caps) and " +
          "prefix-based (`type=courier` returns `courier.dispatch`, " +
          "`courier.quote`, `courier.track`, etc.). This lets agents query " +
          "by a coarse scope (`courier`, `pizza`, `compute`, `manufacturing`, " +
          "`lab`, `food`, `software-service`, `sensor`, `robot`, `custom`) " +
          "without hard-coding the vendor-specific suffixes. The list " +
          "endpoint is the discovery surface — driver/operator agents poll " +
          "it to find jobs they can claim, so filtering must be honoured.",
        querystring: {
          type: "object",
          // additionalProperties tolerated: this is a PUBLIC discovery
          // surface, third-party agents may pass extra harmless params
          // (e.g. cache busters, telemetry tags). Do not 400 them.
          additionalProperties: true,
          properties: {
            offset: { type: "integer", minimum: 0, default: 0 },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            type: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              description:
                "Filter by capability type. Matches either exactly " +
                "(`pizza.order`) or by prefix (`courier` => all `courier.*`).",
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              items: { type: "array", items: { type: "object", additionalProperties: true } },
              total: { type: "integer" },
              offset: { type: "integer" },
              limit: { type: "integer" },
              hasMore: { type: "boolean" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const offset = req.query.offset;
      const limit = req.query.limit;
      const typeFilter = req.query.type?.trim();

      if (!typeFilter) {
        const result = await facade.list({}, { offset, limit });
        return sendResult(reply, result);
      }

      // ?type= filter: BOTH exact match (`pizza.order`) and prefix match
      // (`courier` -> all `courier.*`). The facade.search() path only does
      // exact match, so we filter at the route layer instead. Public
      // marketplace cardinality is small enough to do this in-memory; if
      // it ever grows past O(thousands), push the filter into the repo as
      // `WHERE type = ? OR type LIKE ? || '.%'`.
      const allResult = await facade.list({}, { offset: 0, limit: 100000 });
      if (!allResult.success) return sendResult(reply, allResult);
      const all = allResult.data.items;
      const filtered = all.filter(
        (c) => c.type === typeFilter || c.type.startsWith(typeFilter + "."),
      );
      const total = filtered.length;
      const startOffset = offset ?? 0;
      const pageLimit = limit ?? 50;
      const page = filtered.slice(startOffset, startOffset + pageLimit);
      return {
        items: page,
        total,
        offset: startOffset,
        limit: pageLimit,
        hasMore: startOffset + pageLimit < total,
      };
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
   * W3C WoT Thing Description 2.0 for a capability.
   *
   * Returns a JSON-LD Thing Description document so any WoT-aware agent can
   * discover the capability's executable actions, readable properties, and
   * subscribable events without needing PCC-specific knowledge.
   *
   * Mapping:
   *   Thing.id           = urn:pcc:capability:<capabilityId>
   *   Thing.title        = capability.name
   *   Thing.description  = capability.description
   *   Thing.actions      = { execute: {input = template-derived JSON Schema, output = job-result schema, forms = POST /api/jobs/submit} }
   *   Thing.properties   = { queueDepth, available, reputation } — read-only
   *   Thing.events       = { jobStatusChanged } — linked to SSE
   *   Thing.security     = ["apiKey"] — Bearer
   *
   * PUBLIC — CORS *, 5-minute cache.
   */
  app.get<{ Params: { id: string } }>(
    "/api/capabilities/:id/td",
    async (req, reply) => {
      const result = await facade.getById(req.params.id);
      if (!result.success) return sendResult(reply, result);
      const cap = result.data;

      const gatewayUrl =
        process.env.PCC_GATEWAY_URL ?? "https://capability.network";
      const template = getTemplate(cap.type);
      const inputSchema = buildExecuteInputSchema(template);

      // Minimal job-result output schema. The full JobDetailDTO is too large
      // to inline; downstream clients fetch it via GET /api/jobs/:jobId.
      const outputSchema = {
        type: "object",
        required: ["jobId", "status"],
        properties: {
          jobId: { type: "string", description: "ID of the submitted job" },
          status: {
            type: "string",
            enum: ["queued", "running", "completed", "failed", "cancelled"],
          },
          escrowId: { type: "string", description: "ID of the on-chain escrow (set after commit)" },
        },
      };

      const td = {
        "@context": [
          "https://www.w3.org/2022/wot/td/v1.1",
          { pcc: "https://capability.network/ns/td#" },
        ],
        "@type": "Thing",
        id: `urn:pcc:capability:${cap.id}`,
        title: cap.name ?? cap.type,
        description:
          cap.description ?? `PCC capability of type ${cap.type} on kernel ${cap.kernelId}.`,
        version: { instance: "1.0.0" },
        securityDefinitions: {
          apiKey: {
            scheme: "bearer",
            in: "header",
            name: "Authorization",
            format: "jwt",
            description:
              "PCC API key (pcc_live_... or pcc_test_...). Provision at POST /api/auth/provision.",
          },
        },
        security: ["apiKey"],

        properties: {
          queueDepth: {
            type: "integer",
            minimum: 0,
            readOnly: true,
            description: "Number of jobs currently waiting on this capability",
            forms: [
              {
                href: `${gatewayUrl}/api/capabilities/${cap.id}`,
                op: ["readproperty"],
                contentType: "application/json",
              },
            ],
          },
          available: {
            type: "boolean",
            readOnly: true,
            description: "Whether this capability is currently taking jobs",
            forms: [
              {
                href: `${gatewayUrl}/api/capabilities/${cap.id}`,
                op: ["readproperty"],
                contentType: "application/json",
              },
            ],
          },
          reputation: {
            type: "integer",
            minimum: 0,
            maximum: 1000,
            readOnly: true,
            description: "ERC-8004 reputation score for the operating kernel",
            forms: [
              {
                href: `${gatewayUrl}/api/capabilities/${cap.id}`,
                op: ["readproperty"],
                contentType: "application/json",
              },
            ],
          },
        },

        actions: {
          execute: {
            title: `Execute ${cap.name ?? cap.type}`,
            description: `Submit a job to this capability. Maps to POST /api/jobs/submit with capabilityId=${cap.id}.`,
            input: inputSchema,
            output: outputSchema,
            safe: false,
            idempotent: false,
            forms: [
              {
                href: `${gatewayUrl}/api/jobs/submit`,
                op: ["invokeaction"],
                "htv:methodName": "POST",
                contentType: "application/json",
                additionalResponses: [
                  { contentType: "application/json", schema: "outputSchema", success: true },
                ],
                "pcc:capabilityId": cap.id,
                "pcc:kernelId": cap.kernelId,
              },
            ],
          },
        },

        events: {
          jobStatusChanged: {
            description: "Emitted on every status change for a job spawned from this capability",
            data: {
              type: "object",
              properties: {
                jobId: { type: "string" },
                status: { type: "string" },
                progress: { type: "number", minimum: 0, maximum: 100 },
              },
            },
            forms: [
              {
                href: `${gatewayUrl}/sse/stream/job/{jobId}`,
                op: ["subscribeevent"],
                contentType: "text/event-stream",
                subprotocol: "sse",
              },
            ],
          },
        },

        "pcc:capabilityType": cap.type,
        "pcc:kernelId": cap.kernelId,
        "pcc:assuranceTiers": cap.assuranceTiers ?? [0, 1, 2, 3],
        "pcc:pricing": cap.pricing,
      };

      reply
        .header("content-type", "application/td+json")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300");

      return td;
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
