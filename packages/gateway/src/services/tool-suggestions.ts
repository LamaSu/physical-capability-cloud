/**
 * Tool Suggestion Engine — maps device/adapter types to recommended tool sets.
 *
 * When an operator registers a device, the platform suggests which tools
 * to expose. The operator can accept, reject, or customize.
 *
 * Tool categories:
 *   - Platform tools (always included): discovery, negotiate, quote, settlement, evidence
 *   - Device-specific tools: based on adapter type (opentrons, octoprint, opcua, etc.)
 *   - Capability-specific tools: based on capability type (liquid-handler, fdm, cnc, etc.)
 *   - Batch tools: for multi-user shared runs
 */

import type { CapabilityType } from "@pcc/spec";

// ── Tool Definition ───────────────────────────────────────────────

export interface SuggestedTool {
  name: string;
  description: string;
  category: "platform" | "device" | "capability" | "batch" | "operator";
  /** Whether this tool is recommended (true) or optional (false) */
  recommended: boolean;
  /** API endpoint this tool maps to */
  endpoint: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
  };
  /** Input parameter schema */
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

// ── Platform Tools (always included) ──────────────────────────────

const PLATFORM_TOOLS: SuggestedTool[] = [
  {
    name: "discover_capabilities",
    description: "Search for capabilities on the PCC network by type, material, location",
    category: "platform",
    recommended: true,
    endpoint: { method: "GET", path: "/api/capabilities" },
    inputSchema: { type: "object", properties: { type: { type: "string", description: "Capability type filter" }, material: { type: "string", description: "Material filter" } } },
  },
  {
    name: "negotiate_session",
    description: "Start a negotiation session with an operator to configure job parameters",
    category: "platform",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session" },
    inputSchema: { type: "object", properties: { kernelId: { type: "string", description: "Kernel to negotiate with" }, capabilityType: { type: "string", description: "Capability type" }, userAgentId: { type: "string", description: "Your agent ID" } }, required: ["kernelId", "capabilityType", "userAgentId"] },
  },
  {
    name: "configure_params",
    description: "Set job parameters during negotiation (materials, volumes, settings)",
    category: "platform",
    recommended: true,
    endpoint: { method: "PATCH", path: "/api/negotiate/session/{sessionId}/select" },
    inputSchema: { type: "object", properties: { selections: { type: "object", description: "Parameter key-value pairs" } }, required: ["selections"] },
  },
  {
    name: "get_quote",
    description: "Lock parameters and get a price quote with scheduling",
    category: "platform",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session/{sessionId}/quote" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "review_contract",
    description: "Review contract terms (milestones, bonds, challenge windows) before committing",
    category: "platform",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session/{sessionId}/review" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "commit_job",
    description: "Commit to the job — funds escrow and creates the job",
    category: "platform",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session/{sessionId}/commit" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "check_job_status",
    description: "Check the status and progress of a running job",
    category: "platform",
    recommended: true,
    endpoint: { method: "GET", path: "/api/jobs/{jobId}" },
    inputSchema: { type: "object", properties: { jobId: { type: "string", description: "Job ID" } }, required: ["jobId"] },
  },
  {
    name: "get_evidence",
    description: "Get the evidence bundle for a completed job (photos, sensor data, logs)",
    category: "platform",
    recommended: true,
    endpoint: { method: "GET", path: "/api/evidence/{bundleId}" },
    inputSchema: { type: "object", properties: { bundleId: { type: "string", description: "Evidence bundle ID" } }, required: ["bundleId"] },
  },
  {
    name: "fund_wallet",
    description: "Get fiat on-ramp options to fund your agent wallet with a credit card",
    category: "platform",
    recommended: true,
    endpoint: { method: "POST", path: "/api/fiat-ramp/onramp/session" },
    inputSchema: { type: "object", properties: { walletAddress: { type: "string", description: "Your wallet address" }, amount: { type: "number", description: "Amount in USD" }, currency: { type: "string", description: "Currency code", enum: ["USD", "EUR", "GBP"] } }, required: ["walletAddress", "amount"] },
  },
  {
    name: "get_operator_policy",
    description: "Get the operator's policy (approval mode, hours, pricing rules, limits)",
    category: "platform",
    recommended: true,
    endpoint: { method: "GET", path: "/api/operator/policy/{kernelId}" },
    inputSchema: { type: "object", properties: { kernelId: { type: "string", description: "Kernel ID" } }, required: ["kernelId"] },
  },
];

// ── Device-Specific Tools ─────────────────────────────────────────

const OPENTRONS_TOOLS: SuggestedTool[] = [
  {
    name: "ot_deck_layout",
    description: "Get current OT-2 deck layout — labware in each of 11 slots",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/kernels/{kernelId}/deck" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ot_list_protocols",
    description: "List available protocol templates for this OT-2",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/protocols" },
    inputSchema: { type: "object", properties: { capabilityType: { type: "string", description: "Filter by capability" } } },
  },
  {
    name: "ot_queue_status",
    description: "Get the OT-2 job queue — active job, pending jobs, estimated wait",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/kernels/{kernelId}/devices" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ot_estimate_protocol",
    description: "Estimate time, cost, and consumables for a liquid handling protocol",
    category: "device",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session/{sessionId}/quote" },
    inputSchema: { type: "object", properties: { protocolType: { type: "string", description: "Protocol type", enum: ["transfer", "serial-dilution", "distribute", "consolidate", "mixing", "normalization"] }, sampleCount: { type: "number", description: "Number of samples" }, volumeUl: { type: "number", description: "Volume per transfer in µL" } }, required: ["protocolType", "sampleCount"] },
  },
  {
    name: "ot_robot_status",
    description: "Check OT-2 health — online, pipettes attached, modules, calibration state",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/setup/health-check" },
    inputSchema: { type: "object", properties: { kernelId: { type: "string", description: "Kernel ID" } }, required: ["kernelId"] },
  },
];

const OCTOPRINT_TOOLS: SuggestedTool[] = [
  {
    name: "printer_status",
    description: "Get 3D printer status — temperature, progress, state",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/kernels/{kernelId}/devices" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "print_estimate",
    description: "Estimate print time, material usage, and cost for an STL/3MF file",
    category: "device",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session/{sessionId}/quote" },
    inputSchema: { type: "object", properties: { material: { type: "string", description: "Filament material", enum: ["pla", "petg", "abs", "tpu", "nylon", "pc"] }, infill: { type: "number", description: "Infill percentage (5-100)" }, layerHeight: { type: "string", description: "Layer height", enum: ["0.12", "0.16", "0.20", "0.28"] } }, required: ["material"] },
  },
  {
    name: "filament_check",
    description: "Check filament availability and stock on this printer",
    category: "device",
    recommended: false,
    endpoint: { method: "GET", path: "/api/capabilities/by-kernel/{kernelId}" },
    inputSchema: { type: "object", properties: {} },
  },
];

const OPCUA_TOOLS: SuggestedTool[] = [
  {
    name: "cnc_status",
    description: "Get CNC machine status — spindle RPM, tool loaded, program running",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/kernels/{kernelId}/devices" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cnc_estimate",
    description: "Estimate machining time and cost for a part",
    category: "device",
    recommended: true,
    endpoint: { method: "POST", path: "/api/negotiate/session/{sessionId}/quote" },
    inputSchema: { type: "object", properties: { material: { type: "string", description: "Stock material", enum: ["aluminum-6061", "stainless-304", "delrin", "brass"] }, operations: { type: "number", description: "Number of machining operations" } }, required: ["material"] },
  },
];

const SILA_TOOLS: SuggestedTool[] = [
  {
    name: "instrument_status",
    description: "Get lab instrument status — ready, running, error, maintenance",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/kernels/{kernelId}/devices" },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "instrument_capabilities",
    description: "List what this instrument can do (methods, protocols, sample types)",
    category: "device",
    recommended: true,
    endpoint: { method: "GET", path: "/api/capabilities/by-kernel/{kernelId}" },
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Batch Tools (for multi-user shared runs) ──────────────────────

const BATCH_TOOLS: SuggestedTool[] = [
  {
    name: "batch_list_slots",
    description: "List available slots in an open batch run (e.g., empty wells on a shared 96-well plate)",
    category: "batch",
    recommended: true,
    endpoint: { method: "GET", path: "/api/batches/{batchId}" },
    inputSchema: { type: "object", properties: { batchId: { type: "string", description: "Batch ID" } }, required: ["batchId"] },
  },
  {
    name: "batch_claim_slots",
    description: "Claim slots in a shared batch run — reserve wells for your samples",
    category: "batch",
    recommended: true,
    endpoint: { method: "POST", path: "/api/batches/{batchId}/slots" },
    inputSchema: { type: "object", properties: { batchId: { type: "string", description: "Batch ID" }, slotCount: { type: "number", description: "Number of slots to claim" }, sampleLabels: { type: "string", description: "Comma-separated sample labels" } }, required: ["batchId", "slotCount"] },
  },
  {
    name: "batch_create",
    description: "Create a new shared batch run — open slots for multiple users on one plate/run",
    category: "batch",
    recommended: false,
    endpoint: { method: "POST", path: "/api/batches" },
    inputSchema: { type: "object", properties: { kernelId: { type: "string", description: "Kernel to run on" }, capabilityType: { type: "string", description: "Capability type" }, totalSlots: { type: "number", description: "Total available slots (e.g., 96 for a 96-well plate)" }, protocolType: { type: "string", description: "Protocol for this batch" } }, required: ["kernelId", "capabilityType", "totalSlots"] },
  },
  {
    name: "batch_status",
    description: "Check batch run status — how many slots claimed, who's in, when it runs",
    category: "batch",
    recommended: true,
    endpoint: { method: "GET", path: "/api/batches/{batchId}" },
    inputSchema: { type: "object", properties: { batchId: { type: "string", description: "Batch ID" } }, required: ["batchId"] },
  },
];

// ── Operator Management Tools ─────────────────────────────────────

const OPERATOR_TOOLS: SuggestedTool[] = [
  {
    name: "emergency_stop",
    description: "EMERGENCY: Immediately halt all jobs on this kernel",
    category: "operator",
    recommended: true,
    endpoint: { method: "POST", path: "/api/operator/emergency-stop" },
    inputSchema: { type: "object", properties: { kernelId: { type: "string", description: "Kernel ID" }, reason: { type: "string", description: "Reason for stop" } }, required: ["kernelId"] },
  },
  {
    name: "list_approvals",
    description: "List pending job approvals waiting for operator decision",
    category: "operator",
    recommended: true,
    endpoint: { method: "GET", path: "/api/operator/approvals" },
    inputSchema: { type: "object", properties: { kernelId: { type: "string", description: "Kernel ID" }, status: { type: "string", description: "Filter by status", enum: ["pending", "approved", "rejected"] } } },
  },
  {
    name: "approve_job",
    description: "Approve a pending job request",
    category: "operator",
    recommended: true,
    endpoint: { method: "POST", path: "/api/operator/approvals/{approvalId}/approve" },
    inputSchema: { type: "object", properties: { approvalId: { type: "string", description: "Approval ID" } }, required: ["approvalId"] },
  },
  {
    name: "reject_job",
    description: "Reject a pending job request",
    category: "operator",
    recommended: true,
    endpoint: { method: "POST", path: "/api/operator/approvals/{approvalId}/reject" },
    inputSchema: { type: "object", properties: { approvalId: { type: "string", description: "Approval ID" }, reason: { type: "string", description: "Reason for rejection" } }, required: ["approvalId"] },
  },
  {
    name: "update_policy",
    description: "Update operator policy — pricing rules, schedule, approval mode, limits",
    category: "operator",
    recommended: true,
    endpoint: { method: "PATCH", path: "/api/operator/policy/{kernelId}" },
    inputSchema: { type: "object", properties: { approvalMode: { type: "string", description: "Approval mode", enum: ["auto", "manual", "policy"] }, maxJobsPerDay: { type: "number", description: "Max jobs per day" } } },
  },
];

// ── Suggestion Engine ─────────────────────────────────────────────

/** Map adapter type → device-specific tools */
const ADAPTER_TOOL_MAP: Record<string, SuggestedTool[]> = {
  opentrons: OPENTRONS_TOOLS,
  octoprint: OCTOPRINT_TOOLS,
  opcua: OPCUA_TOOLS,
  sila: SILA_TOOLS,
  "generic-http": [], // Generic devices get platform tools only
  modbus: [],
  ipp: OCTOPRINT_TOOLS, // IPP printers share print tools
  mock: [],
};

/** Map capability type → additional batch-friendly flag */
const BATCH_CAPABLE_TYPES = new Set<string>([
  "liquid-handler", "hplc", "pcr", "sequencing", "assay",
  "sample-prep", "centrifuge", "flow-cytometry", "chromatography",
]);

export interface ToolSuggestionResult {
  /** All suggested tools (platform + device + capability + batch + operator) */
  tools: SuggestedTool[];
  /** Breakdown by category */
  categories: {
    platform: number;
    device: number;
    capability: number;
    batch: number;
    operator: number;
  };
  /** Whether this device supports multi-user batching */
  batchCapable: boolean;
  /** Adapter type that drove the device suggestions */
  adapterType: string;
  /** Capability types on this kernel */
  capabilityTypes: string[];
}

/**
 * Generate tool suggestions for a kernel based on its devices and capabilities.
 */
export function suggestTools(
  adapterTypes: string[],
  capabilityTypes: string[],
  isOperator: boolean,
): ToolSuggestionResult {
  const tools: SuggestedTool[] = [...PLATFORM_TOOLS];

  // Add device-specific tools for each adapter type
  const addedDeviceTools = new Set<string>();
  for (const adapterType of adapterTypes) {
    const deviceTools = ADAPTER_TOOL_MAP[adapterType] ?? [];
    for (const tool of deviceTools) {
      if (!addedDeviceTools.has(tool.name)) {
        tools.push(tool);
        addedDeviceTools.add(tool.name);
      }
    }
  }

  // Add batch tools if any capability type supports batching
  const batchCapable = capabilityTypes.some((t) => BATCH_CAPABLE_TYPES.has(t));
  if (batchCapable) {
    tools.push(...BATCH_TOOLS);
  }

  // Add operator management tools if this is an operator request
  if (isOperator) {
    tools.push(...OPERATOR_TOOLS);
  }

  return {
    tools,
    categories: {
      platform: tools.filter((t) => t.category === "platform").length,
      device: tools.filter((t) => t.category === "device").length,
      capability: tools.filter((t) => t.category === "capability").length,
      batch: tools.filter((t) => t.category === "batch").length,
      operator: tools.filter((t) => t.category === "operator").length,
    },
    batchCapable,
    adapterType: adapterTypes[0] ?? "unknown",
    capabilityTypes,
  };
}

/**
 * Filter tools based on operator's tool config.
 */
export function applyOperatorToolConfig(
  suggestions: ToolSuggestionResult,
  config: { enabledTools?: string[]; disabledTools?: string[]; customTools?: SuggestedTool[] },
): SuggestedTool[] {
  let tools = suggestions.tools;

  // If operator has an explicit enabled list, filter to only those + platform
  if (config.enabledTools && config.enabledTools.length > 0) {
    const enabled = new Set(config.enabledTools);
    tools = tools.filter((t) => t.category === "platform" || enabled.has(t.name));
  }

  // Remove explicitly disabled tools (except platform essentials)
  if (config.disabledTools && config.disabledTools.length > 0) {
    const disabled = new Set(config.disabledTools);
    const essentials = new Set(["discover_capabilities", "negotiate_session", "check_job_status"]);
    tools = tools.filter((t) => essentials.has(t.name) || !disabled.has(t.name));
  }

  // Add custom tools
  if (config.customTools && config.customTools.length > 0) {
    tools.push(...config.customTools);
  }

  return tools;
}
