// ---------------------------------------------------------------------------
// Tool definitions sent to Claude API — maps 1:1 to gateway endpoints
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const agentTools: ToolDef[] = [
  // -- Capabilities --
  {
    name: "list_capability_types",
    description: "List all capability types available on the PCC network (e.g. FDM, SLA, CNC, HPLC).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_capabilities",
    description: "Search for capability templates by type or keyword. Returns matching capability templates with pricing info.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (capability type or keyword)" },
      },
      required: ["query"],
    },
  },

  // -- Build / Contract --
  {
    name: "get_build_options",
    description: "Get available configuration options for a capability type (materials, dimensions, tolerances, etc).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Capability type (e.g. fdm_printing, cnc_machining)" },
        selections: { type: "object", description: "Current parameter selections" },
        profileId: { type: "string", description: "Optional machine profile ID" },
      },
      required: ["type"],
    },
  },
  {
    name: "calculate_price",
    description: "Calculate price for a capability configuration. Returns pricing breakdown.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Capability type" },
        selections: { type: "object", description: "Parameter selections" },
        profileId: { type: "string", description: "Optional machine profile ID" },
      },
      required: ["type", "selections"],
    },
  },
  {
    name: "build_contract",
    description: "Build and submit a capability contract with the given parameters and assurance tier.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Capability type" },
        selections: { type: "object", description: "Parameter selections" },
        assuranceTier: { type: "number", description: "Assurance tier 0-3 (higher = more evidence/bonds)" },
        profileId: { type: "string", description: "Optional machine profile ID" },
      },
      required: ["type", "selections", "assuranceTier"],
    },
  },

  // -- Jobs --
  {
    name: "list_jobs",
    description: "List all jobs (active and completed) with their status.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_job",
    description: "Get detailed information about a specific job including progress and evidence.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID" },
      },
      required: ["jobId"],
    },
  },

  // -- Kernels --
  {
    name: "list_kernels",
    description: "List all Shop Kernels (physical manufacturing sites) with their status and capabilities.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_kernel",
    description: "Get detailed information about a specific Shop Kernel including devices and queue.",
    input_schema: {
      type: "object",
      properties: {
        kernelId: { type: "string", description: "Kernel ID" },
      },
      required: ["kernelId"],
    },
  },

  // -- Escrow --
  {
    name: "list_escrows",
    description: "List all escrow contracts with milestone status and bond information.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_escrow",
    description: "Get detailed escrow information including milestones, bonds, and challenge windows.",
    input_schema: {
      type: "object",
      properties: {
        escrowId: { type: "string", description: "Escrow ID" },
      },
      required: ["escrowId"],
    },
  },

  // -- Marketplace --
  {
    name: "get_marketplace_overview",
    description: "Get equipment marketplace overview with demand/supply metrics.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Operator --
  {
    name: "get_operator_dashboard",
    description: "Get operator dashboard data (machines, earnings, maintenance).",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Sensors --
  {
    name: "get_sensor_data",
    description: "Get sensor readings for a specific kernel.",
    input_schema: {
      type: "object",
      properties: {
        kernelId: { type: "string", description: "Kernel ID" },
      },
      required: ["kernelId"],
    },
  },

  // -- Batches --
  {
    name: "list_batches",
    description: "List all active and completed batches.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Evidence --
  {
    name: "list_evidence",
    description: "List encrypted evidence bundles with verification status.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Logistics --
  {
    name: "get_logistics_overview",
    description: "Get logistics hub overview (shipments, installations, bookings).",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Protocols --
  {
    name: "list_protocols",
    description: "List available protocol templates in the library.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_protocol",
    description: "Get a specific protocol template with DAG definition and parameters.",
    input_schema: {
      type: "object",
      properties: {
        templateId: { type: "string", description: "Protocol template ID" },
      },
      required: ["templateId"],
    },
  },

  // -- Orchestrator --
  {
    name: "get_orchestrator_status",
    description: "Get orchestrator overview (transfer graph, resource pools, active workflows).",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Onboarding --
  {
    name: "get_onboard_options",
    description: "Get onboarding options for registering a new machine on the network.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Spaces --
  {
    name: "search_spaces",
    description: "Search for available lab/workshop spaces with filters.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: [],
    },
  },

  // -- Rewards / DePIN --
  {
    name: "get_depin_stats",
    description: "Get DePIN statistics (treasury, certificates, reward epochs).",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Oracle Verification --
  {
    name: "get_subnet_status",
    description: "Get verification oracle status (cascade health, oracle leaderboard: UMA, Chainlink, EigenLayer).",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Agents / Conversations --
  {
    name: "list_conversations",
    description: "List recent agent-to-agent conversations on the network.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Navigation --
  {
    name: "navigate_to_page",
    description: "Navigate the user to a specific dashboard page for detailed view. Use when the user wants to see full details or interact with a specific feature.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Dashboard route path, e.g. /discover, /build, /jobs, /kernels, /escrow, /operator, /sensors, /protocols, /logistics, /depin, /subnet",
        },
      },
      required: ["path"],
    },
  },

  // -- Wallet --
  {
    name: "check_wallet_status",
    description: "Check if the user has a wallet connected and their authentication status.",
    input_schema: { type: "object", properties: {}, required: [] },
  },

  // -- Wallet & Funding --
  {
    name: "get_wallet_balance",
    description: "Check the agent wallet balance including USDC holdings, pending deposits, and API credits.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_funding_options",
    description: "Show available options to fund the wallet — Stripe (US/EU, card/ACH) and Yellowcard (emerging markets, bank/mobile money). Returns provider cards for the user to choose.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_onramp_session",
    description: "Create a fiat-to-crypto funding session. User pays with card/ACH (Stripe) or bank transfer/mobile money (Yellowcard) and receives USDC in their wallet.",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider: 'stripe' or 'yellowcard'" },
        amount: { type: "string", description: "Amount in source currency" },
        currency: { type: "string", description: "Source fiat currency (USD, NGN, KES, BRL, etc.)" },
        country: { type: "string", description: "Country code (for Yellowcard)" },
        channelId: { type: "string", description: "Payment channel ID (for Yellowcard)" },
      },
      required: ["provider", "amount"],
    },
  },
  {
    name: "get_provider_rates",
    description: "Get live exchange rates from Yellowcard for emerging market currencies (NGN, KES, ZAR, BRL, MXN, etc.).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_withdraw_channels",
    description: "Get available withdrawal channels for a country — shows bank transfer, mobile money, IBAN options with supported currencies.",
    input_schema: {
      type: "object",
      properties: {
        country: { type: "string", description: "Country code (NG, KE, ZA, BR, MX, etc.)" },
      },
      required: [],
    },
  },
  {
    name: "submit_withdrawal",
    description: "Withdraw USDC earnings to local fiat currency via bank transfer or mobile money. Converts crypto to local currency and sends to the operator's account.",
    input_schema: {
      type: "object",
      properties: {
        amountUsd: { type: "string", description: "Amount in USD to withdraw" },
        fiatCurrency: { type: "string", description: "Target fiat currency" },
        country: { type: "string", description: "Country code" },
        channelId: { type: "string", description: "Payment channel ID" },
        accountName: { type: "string", description: "Account holder name" },
        accountNumber: { type: "string", description: "Bank account or phone number" },
        accountType: { type: "string", description: "'bank_transfer' or 'mobile_money'" },
      },
      required: ["amountUsd", "fiatCurrency", "country", "channelId", "accountName", "accountNumber", "accountType"],
    },
  },
  {
    name: "get_ramp_activity",
    description: "Show recent fiat on/off ramp activity — deposits, withdrawals, and their statuses across all providers.",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Filter by provider: 'stripe', 'yellowcard', 'wise'" },
      },
      required: [],
    },
  },
  {
    name: "get_credit_balance",
    description: "Check prepaid API credit balance. Credits are used for PCC API calls as an alternative to on-chain x402 micropayments.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID" },
      },
      required: ["userId"],
    },
  },
  {
    name: "buy_credits",
    description: "Purchase API credits with USD. 100 credits = $1. Credits are deducted per API call instead of requiring wallet payments.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID" },
        amountUsd: { type: "number", description: "Amount in USD to spend on credits" },
      },
      required: ["userId", "amountUsd"],
    },
  },
  {
    name: "send_enterprise_payout",
    description: "Send fiat payout to an institutional bank account via Wise. Supports 40+ currencies for enterprise operators who don't use crypto.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in source currency (USD)" },
        recipientName: { type: "string", description: "Recipient name" },
        currency: { type: "string", description: "Target currency (GBP, EUR, etc.)" },
        accountType: { type: "string", description: "Account type (sort_code, iban, aba, etc.)" },
        details: { type: "object", description: "Bank account details (varies by type)" },
        reference: { type: "string", description: "Payment reference" },
      },
      required: ["amount", "recipientName", "currency", "accountType", "details", "reference"],
    },
  },
];

// Maps tool name → gateway API call config
export interface ToolEndpoint {
  method: "GET" | "POST";
  path: string | ((input: Record<string, unknown>) => string);
  body?: (input: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** Client-side only tools (no API call) */
  clientOnly?: boolean;
}

export const toolEndpoints: Record<string, ToolEndpoint> = {
  list_capability_types: { method: "GET", path: "/capabilities/types" },
  search_capabilities: { method: "GET", path: "/capabilities/templates" },
  get_build_options: {
    method: "POST",
    path: "/build/options",
    body: (i) => ({ type: i.type, selections: i.selections, profileId: i.profileId }),
  },
  calculate_price: {
    method: "POST",
    path: "/build/price",
    body: (i) => ({ type: i.type, selections: i.selections, profileId: i.profileId }),
  },
  build_contract: {
    method: "POST",
    path: "/build/contract",
    body: (i) => ({ type: i.type, selections: i.selections, assuranceTier: i.assuranceTier, profileId: i.profileId }),
  },
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
