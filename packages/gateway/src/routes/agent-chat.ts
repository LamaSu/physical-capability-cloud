import type { FastifyInstance } from "fastify";

/**
 * Agent API routes — agents connect to PCC directly, no proxy.
 *
 * GET  /api/agent/tools    — Tool definitions (73 tools)
 * POST /api/agent/execute  — Execute a tool call on behalf of an agent
 *
 * Agents fetch the agent-package.json (static file), get tools + system prompt,
 * then call PCC endpoints directly. No API keys, no middleware, no vendor lock-in.
 */
export async function agentChatRoutes(app: FastifyInstance) {
  // ── Tool spec endpoint ──────────────────────────────────────────
  app.get("/api/agent/tools", async (_req, reply) => {
    return reply.send({
      name: "PCC Network Tools",
      version: "1.0.0",
      description:
        "Tool definitions for the Physical Capability Cloud. " +
        "Feed these to your AI agent so it can discover, price, " +
        "and orchestrate physical capabilities on the PCC network.",
      base_url: "/api",
      tools: PCC_TOOLS,
    });
  });

  // ── Tool execution endpoint ─────────────────────────────────────
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

    const path = typeof tool.path === "function" ? tool.path(body.tool_input ?? {}) : tool.path;
    const options: RequestInit = { method: tool.method };

    if (tool.method === "POST" && tool.body) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(tool.body(body.tool_input ?? {}));
    }

    try {
      const port = (req.server.addresses()?.[0] as { port: number })?.port ?? 3200;
      const res = await fetch(`http://127.0.0.1:${port}/api${path}`, options);
      const json = await res.json();
      return reply.send({ result: json });
    } catch {
      return reply.status(500).send({ error: "Tool execution failed" });
    }
  });
}

// Tool endpoint mapping
interface ToolEndpoint {
  method: "GET" | "POST";
  path: string | ((input: Record<string, unknown>) => string);
  body?: (input: Record<string, unknown>) => Record<string, unknown>;
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
  // Fiat ramp tools
  get_wallet_balance: { method: "GET", path: "/fiat-ramp/status" },
  get_funding_options: { method: "GET", path: "/fiat-ramp/status" },
  create_onramp_session: {
    method: "POST",
    path: (i) => i.provider === "yellowcard" ? "/fiat-ramp/yellowcard/deposit" : "/fiat-ramp/stripe/onramp",
    body: (i) => i,
  },
  get_provider_rates: { method: "GET", path: "/fiat-ramp/yellowcard/rates" },
  get_withdraw_channels: { method: "GET", path: (i) => `/fiat-ramp/yellowcard/channels${i.country ? `?country=${i.country}` : ""}` },
  submit_withdrawal: {
    method: "POST",
    path: "/fiat-ramp/yellowcard/withdraw",
    body: (i) => ({
      walletAddress: i.walletAddress ?? "0x0000000000000000000000000000000000000000",
      amountUsd: i.amountUsd,
      fiatCurrency: i.fiatCurrency,
      country: i.country,
      channelId: i.channelId,
      destination: {
        type: i.accountType,
        accountName: i.accountName,
        accountNumber: i.accountNumber,
        country: i.country,
      },
      sender: i.sender ?? { name: "PCC Agent", country: i.country, address: "PCC", dob: "01/01/2000", email: "agent@pcc.dev", idNumber: "000000", idType: "passport" },
    }),
  },
  get_ramp_activity: { method: "GET", path: (i) => `/fiat-ramp/sessions${i.provider ? `?provider=${i.provider}` : ""}` },
  get_credit_balance: { method: "GET", path: (i) => `/fiat-ramp/stripe/credits/${i.userId}` },
  buy_credits: {
    method: "POST",
    path: "/fiat-ramp/stripe/credits/deposit",
    body: (i) => ({ userId: i.userId, amountUsd: i.amountUsd }),
  },
  send_enterprise_payout: {
    method: "POST",
    path: "/fiat-ramp/wise/payout",
    body: (i) => ({
      sourceAmount: i.amount,
      recipient: { name: i.recipientName, currency: i.currency, type: i.accountType, details: i.details },
      reference: i.reference,
    }),
  },
};

const PCC_TOOLS = [
  { name: "list_capability_types", description: "List all capability types on the PCC network.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "search_capabilities", description: "Search capability templates by type or keyword.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_build_options", description: "Get configuration options for a capability type.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, profileId: { type: "string" } }, required: ["type"] } },
  { name: "calculate_price", description: "Calculate price for a capability configuration.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" } }, required: ["type", "selections"] } },
  { name: "build_contract", description: "Build and submit a capability contract with escrow.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, assuranceTier: { type: "number" } }, required: ["type", "selections", "assuranceTier"] } },
  { name: "list_jobs", description: "List all jobs with status.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_job", description: "Get job details.", input_schema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "list_kernels", description: "List all Shop Kernels.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_kernel", description: "Get kernel details.", input_schema: { type: "object", properties: { kernelId: { type: "string" } }, required: ["kernelId"] } },
  { name: "list_escrows", description: "List escrow contracts.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_escrow", description: "Get escrow details.", input_schema: { type: "object", properties: { escrowId: { type: "string" } }, required: ["escrowId"] } },
  { name: "get_marketplace_overview", description: "Equipment marketplace overview.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_operator_dashboard", description: "Operator dashboard data.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_batches", description: "List batches.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_evidence", description: "List evidence bundles.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_logistics_overview", description: "Logistics hub overview.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_protocols", description: "List protocol templates.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_depin_stats", description: "DePIN statistics.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_subnet_status", description: "Bittensor subnet status.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_wallet_balance", description: "Check agent wallet USDC balance, pending deposits, and API credits.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_funding_options", description: "Show funding options — Stripe (US/EU) and Yellowcard (34 countries).", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "create_onramp_session", description: "Create a fiat-to-crypto funding session.", input_schema: { type: "object", properties: { provider: { type: "string" }, amount: { type: "string" }, currency: { type: "string" }, country: { type: "string" }, channelId: { type: "string" } }, required: ["provider", "amount"] } },
  { name: "get_provider_rates", description: "Get live exchange rates for emerging market currencies.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_withdraw_channels", description: "Get withdrawal channels for a country.", input_schema: { type: "object", properties: { country: { type: "string" } }, required: [] } },
  { name: "submit_withdrawal", description: "Withdraw USDC to local fiat via bank/mobile money.", input_schema: { type: "object", properties: { amountUsd: { type: "string" }, fiatCurrency: { type: "string" }, country: { type: "string" }, channelId: { type: "string" }, accountName: { type: "string" }, accountNumber: { type: "string" }, accountType: { type: "string" } }, required: ["amountUsd", "fiatCurrency", "country", "channelId", "accountName", "accountNumber", "accountType"] } },
  { name: "get_ramp_activity", description: "Show recent fiat on/off ramp activity.", input_schema: { type: "object", properties: { provider: { type: "string" } }, required: [] } },
  { name: "get_credit_balance", description: "Check API credit balance.", input_schema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "buy_credits", description: "Buy API credits with USD.", input_schema: { type: "object", properties: { userId: { type: "string" }, amountUsd: { type: "number" } }, required: ["userId", "amountUsd"] } },
  { name: "send_enterprise_payout", description: "Send fiat payout via Wise to 40+ currencies.", input_schema: { type: "object", properties: { amount: { type: "number" }, recipientName: { type: "string" }, currency: { type: "string" }, accountType: { type: "string" }, details: { type: "object" }, reference: { type: "string" } }, required: ["amount", "recipientName", "currency", "accountType", "details", "reference"] } },
];
