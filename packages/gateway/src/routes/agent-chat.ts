import type { FastifyInstance } from "fastify";

/**
 * Agent API routes — agents connect to PCC directly, no proxy.
 *
 * GET  /api/agent/tools    — Tool definitions (73 tools)
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
}

const PCC_TOOLS = [
  { name: "list_capability_types", description: "List all capability types on the PCC network.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "search_capabilities", description: "List the built-in capability type templates: each type's name, version, description, parameter count, parameter group names and a base price hint. NOTE: these describe types, not operators' offerings, and carry no assurance tiers or availability. The gateway does not read the query, so it never narrows the list. Registered capabilities of a type are listed by GET /api/capabilities?type=<type>.", input_schema: { type: "object", properties: { query: { type: "string", description: "Optional and not used: the gateway returns the full list whatever you send." } }, required: [] } },
  { name: "get_build_options", description: "Get configuration options for a capability type.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, profileId: { type: "string" } }, required: ["type"] } },
  { name: "calculate_price", description: "Calculate price for a capability configuration.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" } }, required: ["type", "selections"] } },
  { name: "build_contract", description: "Build and submit a capability contract with escrow.", input_schema: { type: "object", properties: { type: { type: "string" }, selections: { type: "object" }, assuranceTier: { type: "number" } }, required: ["type", "selections", "assuranceTier"] } },
  { name: "list_jobs", description: "List all jobs with status.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_job", description: "Get job details.", input_schema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "list_kernels", description: "List all Shop Kernels.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_kernel", description: "Get kernel details.", input_schema: { type: "object", properties: { kernelId: { type: "string" } }, required: ["kernelId"] } },
  { name: "list_escrows", description: "List escrow contracts.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "get_escrow", description: "Get escrow details.", input_schema: { type: "object", properties: { escrowId: { type: "string" } }, required: ["escrowId"] } },
  { name: "get_operator_dashboard", description: "Operator dashboard data.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_batches", description: "List batches.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "list_evidence", description: "List evidence bundles.", input_schema: { type: "object", properties: {}, required: [] } },
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
