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

  // -- Subnet --
  {
    name: "get_subnet_status",
    description: "Get Bittensor verification subnet status (health, miner leaderboard).",
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
};
