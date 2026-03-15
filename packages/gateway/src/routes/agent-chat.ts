import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";

/**
 * Agent connection routes:
 *
 * GET  /api/agent/tools   — Returns PCC tool definitions for any agent to consume
 * POST /api/agent/chat    — Relays messages to the user's connected agent endpoint
 * POST /api/agent/execute — Executes a tool call on behalf of a connected agent
 *
 * The user connects THEIR agent (Claude, GPT, custom) by providing an endpoint.
 * PCC provides the tools — the user's agent provides the intelligence.
 */
export async function agentChatRoutes(app: FastifyInstance) {
  // ── Tool spec endpoint — any agent can fetch this ───────────────
  app.get("/api/agent/tools", async (_req, reply) => {
    return reply.send({
      name: "PCC Network Tools",
      version: "1.0.0",
      description:
        "Tool definitions for the Physical Capability Cloud. " +
        "Feed these to your AI agent so it can discover capabilities, " +
        "build contracts, monitor jobs, and manage escrow on the PCC network.",
      base_url: "/api",
      tools: PCC_TOOLS,
    });
  });

  // ── Relay to user's agent ───────────────────────────────────────
  app.post("/api/agent/chat", async (req, reply) => {
    const body = req.body as {
      /** User's agent endpoint URL */
      agent_endpoint: string;
      /** Optional API key for the user's agent */
      agent_api_key?: string;
      /** Provider type for formatting (claude, openai, custom) */
      provider?: string;
      /** Conversation messages */
      messages: unknown[];
      /** Whether to include PCC tool definitions */
      include_tools?: boolean;
      /** System prompt override */
      system?: string;
      max_tokens?: number;
      stream?: boolean;
    };

    if (!body.agent_endpoint) {
      return reply.status(400).send({
        error: "agent_endpoint is required. Provide your agent's API URL.",
        hint: "GET /api/agent/tools to see the tool spec to feed your agent.",
      });
    }

    const provider = body.provider ?? detectProvider(body.agent_endpoint);

    // Build the request for the user's agent
    const agentBody = formatForProvider(provider, {
      system: body.system ?? PCC_SYSTEM_PROMPT,
      messages: body.messages,
      tools: body.include_tools !== false ? PCC_TOOLS : undefined,
      max_tokens: body.max_tokens ?? 4096,
      stream: body.stream ?? true,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Auth header based on provider
    if (body.agent_api_key) {
      if (provider === "openai") {
        headers["Authorization"] = `Bearer ${body.agent_api_key}`;
      } else if (provider === "claude") {
        headers["x-api-key"] = body.agent_api_key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${body.agent_api_key}`;
      }
    }

    try {
      const upstream = await fetch(body.agent_endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(agentBody),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        app.log.error({ status: upstream.status, body: errText }, "User agent error");
        return reply.status(upstream.status).send({ error: errText });
      }

      if (body.stream && upstream.body) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(decoder.decode(value, { stream: true }));
          }
        } catch (err) {
          app.log.error(err, "Stream read error");
        } finally {
          reply.raw.end();
        }
        return;
      }

      const json = await upstream.json();
      return reply.send(json);
    } catch (err) {
      app.log.error(err, "Failed to reach user's agent");
      return reply.status(502).send({ error: "Failed to reach your agent endpoint" });
    }
  });

  // ── Tool execution endpoint — agent calls this to use PCC tools ──
  app.post("/api/agent/execute", async (req, reply) => {
    const body = req.body as {
      tool_name: string;
      tool_input: Record<string, unknown>;
    };

    if (!body.tool_name) {
      return reply.status(400).send({ error: "tool_name is required" });
    }

    const tool = TOOL_ENDPOINTS[body.tool_name];
    if (!tool) {
      return reply.status(404).send({ error: `Unknown tool: ${body.tool_name}` });
    }

    if (tool.clientOnly) {
      return reply.send({ result: { note: "This tool is client-side only" } });
    }

    const path = typeof tool.path === "function" ? tool.path(body.tool_input ?? {}) : tool.path;
    const options: RequestInit = { method: tool.method };

    if (tool.method === "POST" && tool.body) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(tool.body(body.tool_input ?? {}));
    }

    try {
      // Internal request to ourselves
      const internalUrl = `http://127.0.0.1:${(req.server.addresses()?.[0] as { port: number })?.port ?? 3200}`;
      const res = await fetch(`${internalUrl}/api${path}`, options);
      const json = await res.json();
      return reply.send({ result: json });
    } catch (err) {
      return reply.status(500).send({ error: "Tool execution failed" });
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────

function detectProvider(endpoint: string): string {
  if (endpoint.includes("anthropic.com")) return "claude";
  if (endpoint.includes("openai.com")) return "openai";
  return "claude"; // default
}

function formatForProvider(
  provider: string,
  params: { system?: string; messages: unknown[]; tools?: unknown[]; max_tokens: number; stream: boolean },
): Record<string, unknown> {
  if (provider === "openai") {
    const msgs = params.system
      ? [{ role: "system", content: params.system }, ...(params.messages as unknown[])]
      : params.messages;
    return {
      model: "gpt-4o",
      messages: msgs,
      tools: params.tools?.map((t: any) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
      max_tokens: params.max_tokens,
      stream: params.stream,
    };
  }

  // Claude format (default)
  return {
    model: "claude-sonnet-4-20250514",
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    max_tokens: params.max_tokens,
    stream: params.stream,
  };
}

const PCC_SYSTEM_PROMPT = `You are connected to the Physical Capability Cloud (PCC) network.
You have tools to discover manufacturing capabilities, build contracts, monitor jobs, and manage escrow.
Use the available tools to help the user interact with the PCC network.`;

// Tool endpoint mapping (mirrors dashboard agent-tools.ts)
interface ToolEndpoint {
  method: "GET" | "POST";
  path: string | ((input: Record<string, unknown>) => string);
  body?: (input: Record<string, unknown>) => Record<string, unknown>;
  clientOnly?: boolean;
}

const TOOL_ENDPOINTS: Record<string, ToolEndpoint> = {
  list_capability_types: { method: "GET", path: "/capabilities/types" },
  search_capabilities: { method: "GET", path: "/capabilities/templates" },
  get_build_options: { method: "POST", path: "/build/options", body: (i) => ({ type: i.type, selections: i.selections, profileId: i.profileId }) },
  calculate_price: { method: "POST", path: "/build/price", body: (i) => ({ type: i.type, selections: i.selections, profileId: i.profileId }) },
  build_contract: { method: "POST", path: "/build/contract", body: (i) => ({ type: i.type, selections: i.selections, assuranceTier: i.assuranceTier, profileId: i.profileId }) },
  list_jobs: { method: "GET", path: "/jobs" },
  get_job: { method: "GET", path: (i) => `/jobs/${i.jobId}` },
  list_kernels: { method: "GET", path: "/kernels" },
  get_kernel: { method: "GET", path: (i) => `/kernels/${i.kernelId}` },
  list_escrows: { method: "GET", path: "/escrow" },
  get_escrow: { method: "GET", path: (i) => `/escrow/${i.escrowId}` },
  get_marketplace_overview: { method: "GET", path: "/marketplace" },
  get_operator_dashboard: { method: "GET", path: "/operator" },
  get_sensor_data: { method: "GET", path: (i) => `/sensors/${i.kernelId}` },
  list_batches: { method: "GET", path: "/batches" },
  list_evidence: { method: "GET", path: "/evidence" },
  get_logistics_overview: { method: "GET", path: "/logistics" },
  list_protocols: { method: "GET", path: "/protocols" },
  get_protocol: { method: "GET", path: (i) => `/protocols/${i.templateId}` },
  get_orchestrator_status: { method: "GET", path: "/orchestrator" },
  get_onboard_options: { method: "GET", path: "/onboard" },
  search_spaces: { method: "GET", path: "/spaces" },
  get_depin_stats: { method: "GET", path: "/rewards" },
  get_subnet_status: { method: "GET", path: "/agents/status" },
  list_conversations: { method: "GET", path: "/agents/conversations" },
  navigate_to_page: { method: "GET", path: "", clientOnly: true },
  check_wallet_status: { method: "GET", path: "", clientOnly: true },
};

// Full tool definitions served to agents
const PCC_TOOLS = [
  { name: "list_capability_types", description: "List all capability types available on the PCC network (e.g. FDM, SLA, CNC, HPLC).", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "search_capabilities", description: "Search for capability templates by type or keyword.", input_schema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] } },
  { name: "get_build_options", description: "Get configuration options for a capability type (materials, dimensions, tolerances).", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, profileId: { type: "string" } }, required: ["type"] } },
  { name: "calculate_price", description: "Calculate price for a capability configuration.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, profileId: { type: "string" } }, required: ["type", "selections"] } },
  { name: "build_contract", description: "Build and submit a capability contract.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, assuranceTier: { type: "number" }, profileId: { type: "string" } }, required: ["type", "selections", "assuranceTier"] } },
  { name: "list_jobs", description: "List all jobs with their status.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_job", description: "Get detailed job information.", input_schema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "list_kernels", description: "List all Shop Kernels with status and capabilities.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_kernel", description: "Get detailed kernel information.", input_schema: { type: "object", properties: { kernelId: { type: "string" } }, required: ["kernelId"] } },
  { name: "list_escrows", description: "List all escrow contracts.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_escrow", description: "Get detailed escrow information.", input_schema: { type: "object", properties: { escrowId: { type: "string" } }, required: ["escrowId"] } },
  { name: "get_marketplace_overview", description: "Get equipment marketplace overview.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_operator_dashboard", description: "Get operator dashboard data.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_batches", description: "List all batches.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_evidence", description: "List encrypted evidence bundles.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_logistics_overview", description: "Get logistics hub overview.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_protocols", description: "List protocol templates.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_depin_stats", description: "Get DePIN statistics.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_subnet_status", description: "Get Bittensor subnet status.", input_schema: { type: "object", properties: {}, required: [] } },
];
