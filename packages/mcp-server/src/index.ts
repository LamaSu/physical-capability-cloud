#!/usr/bin/env node

/**
 * PCC MCP Server
 *
 * Exposes the Physical Capability Cloud gateway API as MCP tools so that
 * Claude Code, Cursor, or any MCP-compatible client can interact with PCC
 * directly over stdio.
 *
 * Usage:
 *   PCC_URL=https://pcc-gateway-production.up.railway.app node dist/index.js
 *
 * Add to Claude Code settings:
 *   "pcc": { "command": "node", "args": ["packages/mcp-server/dist/index.js"] }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PCC_URL, pccFetch } from "./api.js";

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

function toolResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "pcc",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// 1. pcc_list_capabilities
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_capabilities",
  "List all registered PCC capability types (e.g. fdm-printer, cnc-3axis, hplc, centrifuge). Returns the canonical type identifiers recognized by the contract builder.",
  {},
  async () => {
    const data = await pccFetch("/api/capabilities/types");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 2. pcc_search_capabilities
// ---------------------------------------------------------------------------

server.tool(
  "pcc_search_capabilities",
  "Search capability templates with full details: type, name, version, description, parameter count, parameter groups, and base pricing hints.",
  {},
  async () => {
    const data = await pccFetch("/api/capabilities/templates");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 3. pcc_list_kernels
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_kernels",
  "List all Shop Kernels (physical manufacturing sites) with their status and capability types. Optionally filter by kernel status.",
  {
    status: z
      .string()
      .optional()
      .describe("Filter by kernel status (e.g. 'online', 'offline', 'maintenance')"),
  },
  async ({ status }: { status?: string }) => {
    const data = await pccFetch("/api/kernels", { query: { status } });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 4. pcc_get_kernel
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_kernel",
  "Get detailed information about a specific Shop Kernel including its capabilities and devices.",
  {
    kernelId: z.string().describe("The kernel ID (e.g. 'kernel-biolab-01')"),
  },
  async ({ kernelId }: { kernelId: string }) => {
    const data = await pccFetch(`/api/kernels/${encodeURIComponent(kernelId)}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 5. pcc_list_jobs
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_jobs",
  "List manufacturing jobs across all kernels. Optionally filter by kernel ID and/or job status.",
  {
    kernelId: z.string().optional().describe("Filter by kernel ID"),
    status: z
      .string()
      .optional()
      .describe("Filter by job status (e.g. 'queued', 'running', 'completed', 'failed')"),
  },
  async ({ kernelId, status }: { kernelId?: string; status?: string }) => {
    const data = await pccFetch("/api/jobs", { query: { kernelId, status } });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 6. pcc_get_job
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_job",
  "Get detailed information about a specific job including its evidence bundles.",
  {
    jobId: z.string().describe("The job ID"),
  },
  async ({ jobId }: { jobId: string }) => {
    const data = await pccFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 7. pcc_build_options
// ---------------------------------------------------------------------------

server.tool(
  "pcc_build_options",
  "Get the available configuration options for building a capability contract. Pass a capability type and optionally partial selections to get the next set of available parameters and their valid values.",
  {
    type: z.string().describe("Capability type (e.g. 'fdm-printer', 'cnc-3axis')"),
    selections: z
      .record(z.unknown())
      .optional()
      .describe("Partial parameter selections made so far"),
    profileId: z.string().optional().describe("Optional builder profile ID for presets"),
  },
  async ({ type, selections, profileId }: { type: string; selections?: Record<string, unknown>; profileId?: string }) => {
    const data = await pccFetch("/api/build/options", {
      method: "POST",
      body: { type, selections: selections ?? {}, profileId },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 8. pcc_calculate_price
// ---------------------------------------------------------------------------

server.tool(
  "pcc_calculate_price",
  "Calculate the price for a capability contract given a complete set of parameter selections.",
  {
    type: z.string().describe("Capability type"),
    selections: z.record(z.unknown()).describe("Complete parameter selections"),
    profileId: z.string().optional().describe("Optional builder profile ID"),
  },
  async ({ type, selections, profileId }: { type: string; selections: Record<string, unknown>; profileId?: string }) => {
    const data = await pccFetch("/api/build/price", {
      method: "POST",
      body: { type, selections, profileId },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 9. pcc_build_contract
// ---------------------------------------------------------------------------

server.tool(
  "pcc_build_contract",
  "Build a complete capability contract with all parameters, pricing, and assurance tier. Returns the full contract object ready for escrow.",
  {
    type: z.string().describe("Capability type"),
    selections: z.record(z.unknown()).describe("Complete parameter selections"),
    assuranceTier: z
      .number()
      .min(0)
      .max(3)
      .describe("Assurance tier (0-3): 0=none, 1=basic, 2=standard, 3=full"),
    profileId: z.string().optional().describe("Optional builder profile ID"),
  },
  async ({ type, selections, assuranceTier, profileId }: { type: string; selections: Record<string, unknown>; assuranceTier: number; profileId?: string }) => {
    const data = await pccFetch("/api/build/contract", {
      method: "POST",
      body: { type, selections, assuranceTier, profileId },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 10. pcc_list_escrows
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_escrows",
  "List all escrow contracts with their milestones. Optionally filter by escrow status.",
  {
    status: z
      .string()
      .optional()
      .describe("Filter by escrow status (e.g. 'funded', 'active', 'completed', 'disputed')"),
  },
  async ({ status }: { status?: string }) => {
    const data = await pccFetch("/api/escrow", { query: { status } });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 11. pcc_list_evidence
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_evidence",
  "List all evidence bundles across all jobs. Evidence bundles contain cryptographic proof of manufacturing work (measurements, sensor data, photos, etc.).",
  {},
  async () => {
    // The gateway exposes evidence per-job. We use the top-level capabilities as
    // a proxy — in a full implementation this would be a dedicated endpoint.
    // For now, we list jobs and their associated evidence.
    const data = await pccFetch("/api/jobs");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 12. pcc_list_protocols
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_protocols",
  "List protocol templates (multi-step manufacturing workflows). Optionally filter by tags, required capabilities, search term, or status.",
  {
    tags: z.string().optional().describe("Comma-separated tags to filter by (e.g. 'biotech,protein')"),
    capabilities: z
      .string()
      .optional()
      .describe("Comma-separated capability types to filter by"),
    search: z.string().optional().describe("Free-text search in name, description, and tags"),
    status: z
      .string()
      .optional()
      .describe("Filter by template status ('draft' or 'published')"),
  },
  async ({ tags, capabilities, search, status }: { tags?: string; capabilities?: string; search?: string; status?: string }) => {
    const data = await pccFetch("/api/protocols", {
      query: { tags, capabilities, search, status },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 13. pcc_depin_stats
// ---------------------------------------------------------------------------

server.tool(
  "pcc_depin_stats",
  "Get DePIN (Decentralized Physical Infrastructure Network) reward statistics: epochs, kernel scores, certificates, and treasury balance.",
  {},
  async () => {
    // Fetch multiple reward-related endpoints in parallel
    const [epochs, certificates, treasury] = await Promise.all([
      pccFetch("/api/rewards/epochs"),
      pccFetch("/api/certificates"),
      pccFetch("/api/treasury/summary"),
    ]);
    return toolResult({ epochs, certificates, treasury });
  },
);

// ---------------------------------------------------------------------------
// 14. pcc_subnet_status
// ---------------------------------------------------------------------------

server.tool(
  "pcc_subnet_status",
  "Get the status of the PCC agent network: active agents, their types, and conversation activity.",
  {},
  async () => {
    const data = await pccFetch("/api/agents/status");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 15. pcc_get_agent_identity
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_agent_identity",
  "Get the ERC-8004 agent identity for a PCC kernel or agent, including registration file, reputation summary, and validation status.",
  {
    agentId: z.string().describe("Kernel ID or agent DID to look up"),
  },
  async ({ agentId }: { agentId: string }) => {
    const data = await pccFetch(`/api/registry/entities/${encodeURIComponent(agentId)}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 16. pcc_get_reputation
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_reputation",
  "Get reputation scores for a PCC kernel or agent — assurance tier, quality rating, uptime, response time, and evidence completeness.",
  {
    agentId: z.string().describe("Agent ID or kernel ID"),
    tag: z.string().optional().describe("Filter by reputation tag (e.g. 'quality', 'uptime', 'assurance')"),
  },
  async ({ agentId, tag }: { agentId: string; tag?: string }) => {
    const data = await pccFetch(`/api/registry/entities/${encodeURIComponent(agentId)}/reputation`, {
      query: { tag },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 17. pcc_list_sensors
// ---------------------------------------------------------------------------

server.tool(
  "pcc_list_sensors",
  "List available sensor channels for a kernel — temperature, pressure, pH, flow rate, etc.",
  {
    kernelId: z.string().describe("Kernel ID to list sensors for"),
  },
  async ({ kernelId }: { kernelId: string }) => {
    const data = await pccFetch(`/api/sensors/${encodeURIComponent(kernelId)}/channels`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 18. pcc_get_sensor_data
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_sensor_data",
  "Get recent sensor readings for a specific channel on a kernel.",
  {
    kernelId: z.string().describe("Kernel ID"),
    channel: z.string().describe("Sensor channel name (e.g. 'temperature', 'pressure')"),
    limit: z.number().optional().describe("Number of recent readings to return (default 50)"),
  },
  async ({ kernelId, channel, limit }: { kernelId: string; channel: string; limit?: number }) => {
    const data = await pccFetch(
      `/api/sensors/${encodeURIComponent(kernelId)}/data/${encodeURIComponent(channel)}`,
      { query: { limit: limit?.toString() } },
    );
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 19. pcc_get_evidence
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_evidence",
  "Get a specific evidence bundle by ID — includes encrypted data reference, IPFS CID, ZK proof status, Bittensor verification scores, and evaluator attestations.",
  {
    bundleId: z.string().describe("Evidence bundle ID"),
  },
  async ({ bundleId }: { bundleId: string }) => {
    const data = await pccFetch(`/api/evidence/${encodeURIComponent(bundleId)}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 20. pcc_compile_workflow
// ---------------------------------------------------------------------------

server.tool(
  "pcc_compile_workflow",
  "Compile a multi-step manufacturing workflow into an execution DAG. Provide capability requirements and dependencies — returns topologically sorted execution waves.",
  {
    steps: z.array(z.object({
      id: z.string().describe("Step identifier"),
      capabilityType: z.string().describe("Required capability type"),
      dependsOn: z.array(z.string()).optional().describe("Step IDs this step depends on"),
      parameters: z.record(z.unknown()).optional().describe("Capability parameters"),
    })).describe("Workflow steps with dependencies"),
  },
  async ({ steps }: { steps: Array<{ id: string; capabilityType: string; dependsOn?: string[]; parameters?: Record<string, unknown> }> }) => {
    const data = await pccFetch("/api/workflows/compile", {
      method: "POST",
      body: { steps },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 21. pcc_agent_registration
// ---------------------------------------------------------------------------

server.tool(
  "pcc_agent_registration",
  "Get the ERC-8004 Agent Registration File for the PCC gateway. This is the machine-readable identity document that enables agent discovery.",
  {},
  async () => {
    const data = await pccFetch("/.well-known/agent-registration.json");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 22. pcc_setup_detect
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_detect",
  "Auto-detect the current PCC configuration state. Returns which environment variables are set, database status (kernels/devices/jobs), chain connectivity, adapter health, and evidence storage status. Use this as the FIRST step when helping someone set up PCC.",
  {},
  async () => {
    const data = await pccFetch("/api/setup/detect");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 23. pcc_setup_generate_config
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_generate_config",
  "Generate a KERNEL_CONFIG JSON from device descriptions. Tell it what devices the operator has (type, adapter protocol, connection details) and it produces the config JSON, an env var line, and a JSON file.",
  {
    devices: z
      .array(
        z.object({
          name: z.string().describe("Human-readable device name"),
          type: z.enum(["machine", "sensor", "camera"]),
          adapterType: z.enum(["octoprint", "modbus", "opcua", "sila", "generic-http", "mock"]),
          url: z.string().optional().describe("Device API URL (OctoPrint, SiLA, generic-http)"),
          apiKey: z.string().optional().describe("API key (OctoPrint)"),
          host: z.string().optional().describe("Host IP (Modbus, OPC-UA)"),
          port: z.number().optional().describe("Port (Modbus, OPC-UA)"),
        }),
      )
      .describe("Devices to include in the kernel config"),
    kernelId: z
      .string()
      .optional()
      .describe("Unique kernel ID (e.g. 'kernel_my_shop'). Auto-generated if omitted."),
    mockMode: z.boolean().optional().describe("Force all adapters to mock mode (for testing)"),
  },
  async ({
    devices,
    kernelId,
    mockMode,
  }: {
    devices: Array<{
      name: string;
      type: "machine" | "sensor" | "camera";
      adapterType: "octoprint" | "modbus" | "opcua" | "sila" | "generic-http" | "mock";
      url?: string;
      apiKey?: string;
      host?: string;
      port?: number;
    }>;
    kernelId?: string;
    mockMode?: boolean;
  }) => {
    const data = await pccFetch("/api/setup/generate-config", {
      method: "POST",
      body: { devices, kernelId, mockMode },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 24. pcc_setup_validate_config
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_validate_config",
  "Validate a kernel configuration. Checks adapter connectivity, capability definitions, and configuration completeness. If no config is provided, validates the currently loaded config.",
  {
    config: z
      .string()
      .optional()
      .describe("KERNEL_CONFIG JSON string to validate. Omit to validate current config."),
  },
  async ({ config }: { config?: string }) => {
    const data = await pccFetch("/api/setup/validate", {
      method: "POST",
      body: { config },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 25. pcc_setup_register_device
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_register_device",
  "Register a physical device onto the PCC network. Creates a DB record and optionally runs a health check.",
  {
    kernelId: z.string().describe("Kernel this device belongs to"),
    deviceId: z.string().describe("Unique device ID"),
    type: z.enum(["machine", "sensor", "camera"]).describe("Device type"),
    model: z.string().optional().describe("Device model name (e.g. 'Prusa MK4')"),
    adapterType: z
      .enum(["octoprint", "modbus", "opcua", "sila", "generic-http", "mock"])
      .describe("Adapter protocol"),
    adapterConfig: z
      .string()
      .optional()
      .describe("JSON string of adapter-specific config (url, apiKey, host, port, etc.)"),
    capabilities: z
      .array(z.string())
      .optional()
      .describe("Capability type IDs this device provides"),
  },
  async ({
    kernelId,
    deviceId,
    type,
    model,
    adapterType,
    adapterConfig,
    capabilities,
  }: {
    kernelId: string;
    deviceId: string;
    type: "machine" | "sensor" | "camera";
    model?: string;
    adapterType: "octoprint" | "modbus" | "opcua" | "sila" | "generic-http" | "mock";
    adapterConfig?: string;
    capabilities?: string[];
  }) => {
    const data = await pccFetch("/api/setup/register-device", {
      method: "POST",
      body: {
        kernelId,
        deviceId,
        type,
        model,
        adapterType,
        adapterConfig: adapterConfig ? JSON.parse(adapterConfig) : undefined,
        capabilities,
      },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 26. pcc_setup_health_check
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_health_check",
  "Run health checks on all configured devices or a specific device. Returns connectivity status, response time, and any errors.",
  {
    deviceId: z
      .string()
      .optional()
      .describe("Check a specific device by ID. Omit to check all devices via setup status."),
  },
  async ({ deviceId }: { deviceId?: string }) => {
    let data: unknown;
    if (deviceId) {
      data = await pccFetch(`/api/devices/${encodeURIComponent(deviceId)}/health`, {
        method: "POST",
        body: {},
      });
    } else {
      data = await pccFetch("/api/setup/status");
    }
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 27. pcc_setup_test_job
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_test_job",
  "Submit a test job to verify the full PCC pipeline works end-to-end: job submission → adapter execution → evidence collection → (optional) settlement. Returns job result with evidence bundle ID.",
  {
    kernelId: z.string().optional().describe("Target kernel. Uses default if omitted."),
    deviceId: z.string().optional().describe("Target device. Auto-selects if omitted."),
    assuranceTier: z
      .number()
      .min(0)
      .max(3)
      .optional()
      .describe("Assurance tier 0-3. Default 0 (no challenge window, auto-settle)."),
  },
  async ({
    kernelId,
    deviceId,
    assuranceTier,
  }: {
    kernelId?: string;
    deviceId?: string;
    assuranceTier?: number;
  }) => {
    const data = await pccFetch("/api/setup/test-job", {
      method: "POST",
      body: { kernelId, deviceId, assuranceTier },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 28. pcc_setup_generate_env
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_generate_env",
  "Generate a .env file from configuration answers. Produces all required environment variables for a specific deployment profile (dev, testnet, mainnet). This tool runs locally without a gateway call.",
  {
    profile: z
      .enum(["dev", "testnet", "mainnet"])
      .describe("Deployment profile. 'dev' = all mocked, 'testnet' = Base Sepolia, 'mainnet' = Base Mainnet."),
    chainNetwork: z
      .string()
      .optional()
      .describe("Chain network override (base-sepolia, sepolia, localhost). Defaults per profile."),
    gatewayPrivateKey: z
      .string()
      .optional()
      .describe("Private key (0x...) for on-chain writes. Required for testnet/mainnet."),
    escrowAddress: z.string().optional().describe("Deployed MilestoneEscrow contract address (0x...)."),
    evidenceStorage: z
      .enum(["helia", "storacha"])
      .optional()
      .describe("Evidence storage backend. Default: helia (local IPFS via Helia)."),
    litProtocolReal: z
      .boolean()
      .optional()
      .describe("Use real Lit Protocol network (datil-test) instead of mock AES encryption."),
  },
  async ({
    profile,
    chainNetwork,
    gatewayPrivateKey,
    escrowAddress,
    evidenceStorage,
    litProtocolReal,
  }: {
    profile: "dev" | "testnet" | "mainnet";
    chainNetwork?: string;
    gatewayPrivateKey?: string;
    escrowAddress?: string;
    evidenceStorage?: "helia" | "storacha";
    litProtocolReal?: boolean;
  }) => {
    const lines: string[] = [
      `# PCC Environment — profile: ${profile}`,
      `# Generated by pcc_setup_generate_env on ${new Date().toISOString()}`,
      "",
      `NODE_ENV=${profile === "dev" ? "development" : "production"}`,
      "PORT=3200",
      "",
    ];

    if (profile === "testnet" || profile === "mainnet") {
      const network =
        chainNetwork ?? (profile === "mainnet" ? "base" : "base-sepolia");
      lines.push("# Chain / Network");
      lines.push(`PCC_NETWORK=${network}`);
      if (gatewayPrivateKey) {
        lines.push(`PCC_GATEWAY_PRIVATE_KEY=${gatewayPrivateKey}`);
      } else {
        lines.push("# PCC_GATEWAY_PRIVATE_KEY=0x... (required for on-chain writes)");
      }
      if (escrowAddress) {
        lines.push(`ESCROW_CONTRACT_ADDRESS=${escrowAddress}`);
      } else {
        lines.push("# ESCROW_CONTRACT_ADDRESS=0x... (deploy with: npx tsx scripts/deploy-base-sepolia.ts)");
      }
      lines.push("");
    } else {
      // dev profile — add comment guidance
      lines.push("# Chain / Network (commented out — using mock mode)");
      lines.push("# PCC_NETWORK=localhost");
      lines.push("# PCC_GATEWAY_PRIVATE_KEY=0x...");
      lines.push("# ESCROW_CONTRACT_ADDRESS=0x...");
      lines.push("");
    }

    // Evidence storage
    const storage = evidenceStorage ?? "helia";
    lines.push("# Evidence Storage");
    lines.push(`EVIDENCE_STORAGE=${storage}`);
    if (storage === "storacha") {
      lines.push("# STORACHA_PROOF=<base64_ucan>  (get from: npx w3 delegation create)");
      lines.push("# STORACHA_SPACE_DID=did:key:z6Mk...");
    }
    lines.push("");

    // Lit Protocol
    lines.push("# Lit Protocol Encryption");
    if (litProtocolReal) {
      lines.push("LIT_PROTOCOL_REAL=true");
    } else {
      lines.push("# LIT_PROTOCOL_REAL=true  (uncomment to use real Lit Protocol datil-test network)");
    }
    lines.push("");

    // Kernel config placeholder
    if (profile === "dev") {
      lines.push("# Kernel Runtime (optional — mock mode used if not set)");
      lines.push("# KERNEL_CONFIG='{\"kernelId\":\"my-shop\",\"devices\":[...]}'");
      lines.push("# KERNEL_CONFIG_FILE=./kernel-config.json");
    }

    const envContent = lines.join("\n");
    const filename = `.env.${profile}`;

    return toolResult({ envContent, filename, profile, linesGenerated: lines.length });
  },
);

// ---------------------------------------------------------------------------
// 29. pcc_setup_status
// ---------------------------------------------------------------------------

server.tool(
  "pcc_setup_status",
  "Get comprehensive setup status. Shows what's configured, what's missing, and what needs attention across all categories: gateway, database, adapters, chain, storage, identity.",
  {},
  async () => {
    const data = await pccFetch("/api/setup/status");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 30. pcc_csd_list
// ---------------------------------------------------------------------------

server.tool(
  "pcc_csd_list",
  "List all registered CSD (Capability StructureDefinition) documents. Optionally filter by structural kind or lifecycle status.",
  {
    kind: z
      .enum(["base", "profile", "extension", "workflow"])
      .optional()
      .describe("Filter by CSD kind"),
    status: z
      .enum(["active", "draft", "retired"])
      .optional()
      .describe("Filter by lifecycle status"),
  },
  async ({ kind, status }: { kind?: string; status?: string }) => {
    const data = await pccFetch("/api/csd", {
      query: { kind, status },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 31. pcc_csd_get
// ---------------------------------------------------------------------------

server.tool(
  "pcc_csd_get",
  "Get a specific CSD (Capability StructureDefinition) by its canonical URI.",
  {
    url: z
      .string()
      .describe("CSD canonical URI (e.g. 'pcc://capabilities/fdm/v2')"),
  },
  async ({ url }: { url: string }) => {
    const data = await pccFetch(`/api/csd/${encodeURIComponent(url)}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 32. pcc_csd_register
// ---------------------------------------------------------------------------

server.tool(
  "pcc_csd_register",
  "Register a new CSD (Capability StructureDefinition) in the PCC registry. Validates the document against the CSD schema before storing.",
  {
    csd: z
      .record(z.unknown())
      .describe("CSD document as a JSON object conforming to the CSD schema"),
  },
  async ({ csd }: { csd: Record<string, unknown> }) => {
    const data = await pccFetch("/api/csd", {
      method: "POST",
      body: csd,
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 33. pcc_discover_scan
// ---------------------------------------------------------------------------

server.tool(
  "pcc_discover_scan",
  "Scan the local network for physical devices that can be onboarded to PCC. Currently supports IPP printers via mDNS. Falls back to mock devices in dev mode.",
  {
    protocols: z
      .array(z.string())
      .optional()
      .describe("Protocols to scan (default: ['ipp'])"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Discovery timeout in milliseconds (default: 3000)"),
  },
  async ({ protocols, timeoutMs }: { protocols?: string[]; timeoutMs?: number }) => {
    const data = await pccFetch("/api/discover/scan", {
      method: "POST",
      body: { protocols, timeoutMs },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 34. pcc_discover_onboard
// ---------------------------------------------------------------------------

server.tool(
  "pcc_discover_onboard",
  "One-command device onboarding pipeline: auto-discover a device on the network → generate a CSD → register the CSD in the PCC registry. Returns the discovered device, generated CSD, and registration confirmation.",
  {
    deviceUri: z
      .string()
      .optional()
      .describe("Specific device URI to onboard (e.g. 'ipp://192.168.1.50/ipp/print'). Auto-selects the first found device if omitted."),
    protocol: z
      .string()
      .optional()
      .describe("Discovery protocol to use (default: 'ipp')"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Discovery timeout in milliseconds (default: 3000)"),
  },
  async ({ deviceUri, protocol, timeoutMs }: { deviceUri?: string; protocol?: string; timeoutMs?: number }) => {
    const data = await pccFetch("/api/discover/onboard", {
      method: "POST",
      body: { deviceUri, protocol, timeoutMs },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 35. pcc_ip_register_capability
// ---------------------------------------------------------------------------

server.tool(
  "pcc_ip_register_capability",
  "Register a PCC Capability StructureDefinition (CSD) as a Story Protocol IP Asset. Returns an ipId, nftTokenId, licenseTermsId, and transaction hash. The IP Asset enables programmable royalties for all future jobs using this capability.",
  {
    capabilityId: z.string().describe("PCC capability ID (e.g. 'cap_cnc_001')"),
    capabilityName: z.string().describe("Human-readable capability name"),
    capabilityType: z.string().describe("Capability type (e.g. 'cnc-3axis', 'fdm-printer')"),
    kernelId: z.string().describe("Shop Kernel ID that hosts this capability"),
    designerAddress: z.string().describe("Wallet address of the CSD designer (0x...)"),
    designerName: z.string().describe("Human-readable name of the designer"),
    commercialRevShare: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Percentage of derivative revenue that flows back to this IP (default: 5)"),
    ipfsCid: z
      .string()
      .optional()
      .describe("IPFS CID of the CSD metadata document (from Storacha/Helia upload)"),
    description: z.string().optional().describe("Capability description"),
  },
  async ({
    capabilityId,
    capabilityName,
    capabilityType,
    kernelId,
    designerAddress,
    designerName,
    commercialRevShare,
    ipfsCid,
    description,
  }: {
    capabilityId: string;
    capabilityName: string;
    capabilityType: string;
    kernelId: string;
    designerAddress: string;
    designerName: string;
    commercialRevShare?: number;
    ipfsCid?: string;
    description?: string;
  }) => {
    const data = await pccFetch("/api/ip/register-capability", {
      method: "POST",
      body: {
        capability: {
          id: capabilityId,
          name: capabilityName,
          type: capabilityType,
          kernelId,
          description,
        },
        designerAddress,
        designerName,
        commercialRevShare,
        ipfsCid,
      },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 36. pcc_ip_revenue_snapshot
// ---------------------------------------------------------------------------

server.tool(
  "pcc_ip_revenue_snapshot",
  "Get the current revenue snapshot for a Story Protocol IP Asset — total accumulated revenue, unclaimed balance, and per-holder claimable amounts. Use this to check how much an IP Royalty Vault has accumulated.",
  {
    ipId: z.string().describe("Story Protocol IP Asset address (0x...)"),
  },
  async ({ ipId }: { ipId: string }) => {
    const data = await pccFetch(`/api/ip/${encodeURIComponent(ipId)}/revenue`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 37. pcc_ip_claim
// ---------------------------------------------------------------------------

server.tool(
  "pcc_ip_claim",
  "Claim accumulated revenue from a Story Protocol IP Royalty Vault. Returns a transaction hash and the amount claimed. Optionally specify which Royalty Token IDs to claim; omit to claim all.",
  {
    ipId: z.string().describe("Story Protocol IP Asset address (0x...)"),
    tokenIds: z
      .array(z.string())
      .optional()
      .describe("Specific Royalty Token IDs to claim. Omit to claim all available revenue."),
  },
  async ({ ipId, tokenIds }: { ipId: string; tokenIds?: string[] }) => {
    const data = await pccFetch(`/api/ip/${encodeURIComponent(ipId)}/claim`, {
      method: "POST",
      body: { tokenIds },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 38. pcc_ip_lineage
// ---------------------------------------------------------------------------

server.tool(
  "pcc_ip_lineage",
  "Get the full IP lineage chain for a Story Protocol IP Asset — ancestors (parent CSDs this was derived from) and descendants (job evidence bundles and derivative CSDs). Shows the provenance graph of physical manufacturing work.",
  {
    ipId: z.string().describe("Story Protocol IP Asset address (0x...)"),
  },
  async ({ ipId }: { ipId: string }) => {
    const data = await pccFetch(`/api/ip/${encodeURIComponent(ipId)}/lineage`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 39. pcc_ip_set_splits
// ---------------------------------------------------------------------------

server.tool(
  "pcc_ip_set_splits",
  [
    "Configure revenue splits (Royalty Token distribution) for a Story Protocol IP Asset.",
    "Splits must sum to 100. Each collaborator's role determines their share of all future revenue from this IP.",
    "",
    "ContributorRole taxonomy (ADR-12 §4 — see role responsibility table):",
    "  • operator             — runs the physical machine; residual share (typically 80-95% after others)",
    "  • verifier             — evaluates evidence, signs attestations; slashable (1-5%)",
    "  • insurer              — underwrites job failure coverage; opt-in (0-3%)",
    "  • integrator           — authored the machine-type adapter (OctoPrint, Bambu, ROS); 0-100 bps",
    "  • protocol-author      — authored the capability schema (CSD) + test vectors; 0-50 bps",
    "  • model-author         — trained the AI model invoked at execution time; 0-80 bps",
    "  • dataset-contributor  — pilot who collected training demonstrations; resolved via TrainingManifest",
    "  • curator              — organizes/audits a collection of contributions; 0-5%",
    "  • assembler            — composed multiple capabilities into a workflow; 0-50 bps",
    "  • network-treasury     — per-network protocol treasury (verification, grants, security); 0-3%",
    "",
    "Legacy aliases kept for backward decoding only — prefer the canonical names above:",
    "  • `designer` → use `protocol-author` / `assembler` / `integrator` depending on CSD kind",
    "  • `network`  → use `network-treasury`",
    "",
    "Recommended starting splits:",
    "  • Standard job (no AI):   operator 92, verifier 3, protocol-author 2, integrator 2, network-treasury 1",
    "  • Job with AI model:      operator 87, verifier 3, protocol-author 2, integrator 2, model-author 4, network-treasury 2",
  ].join("\n"),
  {
    ipId: z.string().describe("Story Protocol IP Asset address (0x...)"),
    splits: z
      .array(
        z.object({
          address: z.string().describe("Recipient wallet address (0x...)"),
          role: z
            .enum([
              // Canonical ContributorRole values (ADR-12 §2.1)
              "operator",
              "verifier",
              "insurer",
              "integrator",
              "protocol-author",
              "model-author",
              "dataset-contributor",
              "curator",
              "assembler",
              "network-treasury",
              // Deprecated legacy aliases — kept so older callers still validate.
              // Prefer `protocol-author`/`assembler`/`integrator` over `designer`,
              // and `network-treasury` over `network`.
              "designer",
              "network",
            ])
            .describe(
              "Collaborator role — see tool description for the full ContributorRole taxonomy and migration map for legacy values (`designer`, `network`).",
            ),
          percentage: z
            .number()
            .min(1)
            .max(100)
            .describe("Integer percentage (1-100). All splits must sum to 100."),
          label: z.string().describe("Human-readable label (e.g. 'CSD Author', 'Machine Operator')"),
        }),
      )
      .describe("Revenue splits — must sum to 100"),
  },
  async ({
    ipId,
    splits,
  }: {
    ipId: string;
    splits: Array<{
      address: string;
      role:
        | "operator"
        | "verifier"
        | "insurer"
        | "integrator"
        | "protocol-author"
        | "model-author"
        | "dataset-contributor"
        | "curator"
        | "assembler"
        | "network-treasury"
        /** @deprecated alias for `network-treasury` */
        | "network"
        /** @deprecated use `protocol-author` / `assembler` / `integrator` */
        | "designer";
      percentage: number;
      label: string;
    }>;
  }) => {
    const data = await pccFetch("/api/ip/distribute-royalties", {
      method: "POST",
      body: { ipId, splits },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 30. pcc_swf_summary
// ---------------------------------------------------------------------------

server.tool(
  "pcc_swf_summary",
  "Get the Sovereign Wealth Fund summary: total balance, accrued/distributed amounts, current allocation strategy, participant count, and active proposals.",
  {},
  async () => {
    const data = await pccFetch("/api/swf/summary");
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 31. pcc_swf_participant_dashboard
// ---------------------------------------------------------------------------

server.tool(
  "pcc_swf_participant_dashboard",
  "Get a participant's Sovereign Wealth Fund dashboard: total earned, pending dividends, epoch participation count, claim history, and voting history.",
  {
    participantId: z.string().describe("SWF participant ID (swf_part_XXXX)"),
  },
  async ({ participantId }: { participantId: string }) => {
    const data = await pccFetch(`/api/swf/participants/${participantId}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// 32. pcc_swf_list_proposals
// ---------------------------------------------------------------------------

server.tool(
  "pcc_swf_list_proposals",
  "List governance proposals for the Sovereign Wealth Fund. Optionally filter by status (active, passed, rejected, executed).",
  {
    status: z.string().optional().describe("Filter by proposal status: active, passed, rejected, executed"),
  },
  async ({ status }: { status?: string }) => {
    const query = status ? `?status=${status}` : "";
    const data = await pccFetch(`/api/swf/proposals${query}`);
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// Fiat Ramp tools
// ---------------------------------------------------------------------------

server.tool(
  "pcc_get_wallet_balance",
  "Check agent wallet USDC balance, pending deposits, and API credits",
  {},
  async () => {
    const data = await pccFetch("/api/fiat-ramp/status");
    return toolResult(data);
  },
);

server.tool(
  "pcc_get_funding_options",
  "Show available fiat-to-crypto funding options — Stripe for US/EU (card/ACH) and Yellowcard for 34 emerging market countries (bank transfer/mobile money)",
  {},
  async () => {
    const data = await pccFetch("/api/fiat-ramp/status");
    return toolResult(data);
  },
);

server.tool(
  "pcc_create_onramp_session",
  "Create a fiat-to-crypto funding session — user pays with card/ACH/bank transfer/mobile money and receives USDC",
  {
    provider: z.enum(["stripe", "yellowcard"]).describe("Payment provider"),
    amount: z.string().describe("Amount in source currency"),
    walletAddress: z.string().describe("Destination wallet address"),
    currency: z.string().optional().describe("Source fiat currency"),
    country: z.string().optional().describe("Country code (for Yellowcard)"),
    channelId: z.string().optional().describe("Payment channel ID (for Yellowcard)"),
  },
  async ({ provider, amount, walletAddress, currency, country, channelId }: { provider: "stripe" | "yellowcard"; amount: string; walletAddress: string; currency?: string; country?: string; channelId?: string }) => {
    if (provider === "stripe") {
      const data = await pccFetch("/api/fiat-ramp/stripe/onramp", {
        method: "POST",
        body: { walletAddress, sourceAmount: amount },
      });
      return toolResult(data);
    }
    const data = await pccFetch("/api/fiat-ramp/yellowcard/deposit", {
      method: "POST",
      body: {
        walletAddress,
        fiatAmount: amount,
        fiatCurrency: currency ?? "NGN",
        country: country ?? "NG",
        channelId: channelId ?? "ch_ng_bank",
        recipient: { name: "PCC Agent", country: country ?? "NG", phone: "+0000000000", address: "PCC", dob: "01/01/2000", idNumber: "000000", idType: "passport" },
      },
    });
    return toolResult(data);
  },
);

server.tool(
  "pcc_get_provider_rates",
  "Get live exchange rates from Yellowcard for emerging market currencies",
  {},
  async () => {
    const data = await pccFetch("/api/fiat-ramp/yellowcard/rates");
    return toolResult(data);
  },
);

server.tool(
  "pcc_submit_withdrawal",
  "Withdraw USDC earnings to local fiat via bank transfer or mobile money (Yellowcard) — supports 34 countries",
  {
    amountUsd: z.string().describe("Amount in USD to withdraw"),
    fiatCurrency: z.string().describe("Target fiat currency (NGN, KES, ZAR, BRL, MXN, etc.)"),
    country: z.string().describe("Country code (NG, KE, ZA, BR, MX, etc.)"),
    channelId: z.string().describe("Payment channel ID"),
    accountName: z.string().describe("Account holder name"),
    accountNumber: z.string().describe("Bank account number or phone number"),
    accountType: z.string().describe("bank_transfer or mobile_money"),
    walletAddress: z.string().describe("Source wallet address"),
  },
  async ({ amountUsd, fiatCurrency, country, channelId, accountName, accountNumber, accountType, walletAddress }: { amountUsd: string; fiatCurrency: string; country: string; channelId: string; accountName: string; accountNumber: string; accountType: string; walletAddress: string }) => {
    const data = await pccFetch("/api/fiat-ramp/yellowcard/withdraw", {
      method: "POST",
      body: {
        walletAddress,
        amountUsd,
        fiatCurrency,
        country,
        channelId,
        destination: { type: accountType, accountName, accountNumber, country },
        sender: { name: "PCC Agent", country, address: "PCC", dob: "01/01/2000", email: "agent@pcc.dev", idNumber: "000000", idType: "passport" },
      },
    });
    return toolResult(data);
  },
);

server.tool(
  "pcc_get_ramp_activity",
  "Show recent fiat on/off ramp activity — deposits, withdrawals, and statuses across all providers",
  {
    provider: z.string().optional().describe("Filter by provider: stripe, yellowcard, wise"),
  },
  async ({ provider }: { provider?: string }) => {
    const query = provider ? { provider } : undefined;
    const data = await pccFetch("/api/fiat-ramp/sessions", { query });
    return toolResult(data);
  },
);

server.tool(
  "pcc_send_enterprise_payout",
  "Send fiat payout to institutional bank account via Wise — 40+ currencies, no crypto exposure for enterprise operators",
  {
    amount: z.number().describe("Amount in USD"),
    recipientName: z.string().describe("Recipient name"),
    currency: z.string().describe("Target currency (GBP, EUR, INR, etc.)"),
    accountType: z.string().describe("Account type (sort_code, iban, aba, etc.)"),
    details: z.record(z.unknown()).describe("Bank account details"),
    reference: z.string().describe("Payment reference"),
  },
  async ({ amount, recipientName, currency, accountType, details, reference }: { amount: number; recipientName: string; currency: string; accountType: string; details: Record<string, unknown>; reference: string }) => {
    const data = await pccFetch("/api/fiat-ramp/wise/payout", {
      method: "POST",
      body: { sourceAmount: amount, recipient: { name: recipientName, currency, type: accountType, details }, reference },
    });
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// Contributor-economics tools (Wave 2 of feat/contributor-economics)
//
// Surfaces the @pcc/store ContributorRepository via /api/contributors/*. Each
// tool maps 1:1 onto a route in packages/gateway/src/routes/contributors.ts.
// Listed last so the help/CLI ordering tracks the feature waves.
// ---------------------------------------------------------------------------

// 50. pcc_contributor_register

server.tool(
  "pcc_contributor_register",
  "Register a contributor profile binding a wallet address to a role and a published RateSchedule. Body: address (0x40hex), role (10 ContributorRole values + legacy 'designer'), scheduleHash (0x64hex of a previously published schedule), optional ipId, metadataUri, contributorNftTokenId. Returns the persisted profile (composite id is address:role:tail).",
  {
    address: z.string().describe("Wallet address (0x + 40 hex chars)"),
    role: z
      .enum([
        "operator",
        "verifier",
        "insurer",
        "integrator",
        "protocol-author",
        "model-author",
        "dataset-contributor",
        "curator",
        "assembler",
        "network-treasury",
        "designer",
      ])
      .describe("ContributorRole — 10 ADR-12 roles + deprecated 'designer'"),
    scheduleHash: z
      .string()
      .describe("0x + 64 hex sha256 of a published RateSchedule"),
    ipId: z.string().optional().describe("Story Protocol IP Asset ID"),
    metadataUri: z.string().optional().describe("ipfs:// or https:// URI"),
    contributorNftTokenId: z
      .string()
      .optional()
      .describe("ContributorNFT tokenId once minted on-chain"),
  },
  async ({
    address,
    role,
    scheduleHash,
    ipId,
    metadataUri,
    contributorNftTokenId,
  }: {
    address: string;
    role: string;
    scheduleHash: string;
    ipId?: string;
    metadataUri?: string;
    contributorNftTokenId?: string;
  }) => {
    const data = await pccFetch("/api/contributors", {
      method: "POST",
      body: { address, role, scheduleHash, ipId, metadataUri, contributorNftTokenId },
    });
    return toolResult(data);
  },
);

// 51. pcc_contributor_list

server.tool(
  "pcc_contributor_list",
  "List all contributor profiles for an address across roles. Returns an array of {id, address, role, scheduleHash, ipId, contributorNftTokenId, metadataUri, registeredAt}.",
  {
    address: z.string().describe("Wallet address (0x + 40 hex chars)"),
  },
  async ({ address }: { address: string }) => {
    const data = await pccFetch(`/api/contributors/${encodeURIComponent(address)}`);
    return toolResult(data);
  },
);

// 52. pcc_schedule_publish

server.tool(
  "pcc_schedule_publish",
  "Publish a sealed off-chain RateSchedule. Computes scheduleHash server-side via the canonical sha256-over-canonical-JSON algorithm; idempotent on duplicate content. Returns {scheduleHash, alreadyPublished}.",
  {
    publishedBy: z
      .string()
      .describe("Address that publishes (0x + 40 hex chars)"),
    schedule: z
      .object({
        version: z.number().int().min(1),
        segments: z.array(z.record(z.unknown())).min(1),
        notes: z.string().optional(),
      })
      .describe(
        "RateSchedule body — version, segments (constant/step/linear-decay/exponential-decay/adoption-indexed/piecewise-value), and optional notes",
      ),
  },
  async ({
    publishedBy,
    schedule,
  }: {
    publishedBy: string;
    schedule: { version: number; segments: Array<Record<string, unknown>>; notes?: string };
  }) => {
    const data = await pccFetch("/api/contributors/schedules", {
      method: "POST",
      body: { publishedBy, schedule },
    });
    return toolResult(data);
  },
);

// 53. pcc_schedule_get

server.tool(
  "pcc_schedule_get",
  "Fetch a published RateSchedule by its content hash. Returns {schedule, publishedBy} or 404 if not found.",
  {
    scheduleHash: z
      .string()
      .describe("0x + 64 hex sha256 of the schedule"),
  },
  async ({ scheduleHash }: { scheduleHash: string }) => {
    const data = await pccFetch(
      `/api/contributors/schedules/${encodeURIComponent(scheduleHash)}`,
    );
    return toolResult(data);
  },
);

// 54. pcc_schedule_evaluate

server.tool(
  "pcc_schedule_evaluate",
  "Evaluate a published RateSchedule at a moment, returning the effective bps. Inputs: scheduleHash + now (unix seconds) + optional jobValueCents (piecewise-value) + optional jobsPerDay (adoption-indexed). Returns {scheduleHash, bps, segmentKind, segmentIndex}.",
  {
    scheduleHash: z.string().describe("0x + 64 hex schedule hash"),
    now: z.number().int().min(0).describe("Unix seconds at evaluation moment"),
    jobValueCents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Job value in cents (piecewise-value segments)"),
    jobsPerDay: z
      .number()
      .min(0)
      .optional()
      .describe("Rolling 24h job count (adoption-indexed segments)"),
  },
  async ({
    scheduleHash,
    now,
    jobValueCents,
    jobsPerDay,
  }: {
    scheduleHash: string;
    now: number;
    jobValueCents?: number;
    jobsPerDay?: number;
  }) => {
    const data = await pccFetch(
      `/api/contributors/schedules/${encodeURIComponent(scheduleHash)}/evaluate`,
      { method: "POST", body: { now, jobValueCents, jobsPerDay } },
    );
    return toolResult(data);
  },
);

// 55. pcc_training_manifest_set

server.tool(
  "pcc_training_manifest_set",
  "Set (insert-or-replace) the TrainingManifest for a model IP — the dataset weight map the LicensingEngine walks when distributing payouts to a 'model-author' entry. Dataset weightBps must sum to ≤ 10000. Returns {modelIpId, manifestHash}.",
  {
    modelIpId: z.string().describe("Story IP Asset ID for the model"),
    baseModelIpId: z
      .string()
      .optional()
      .describe("Optional parent ModelNFT IP if this was fine-tuned"),
    datasetWeights: z
      .array(
        z.object({
          datasetIpId: z.string(),
          weightBps: z.number().int().min(0).max(10000),
          dataPointCount: z.number().int().min(0).optional(),
        }),
      )
      .describe("DatasetIP entries with weightBps (sum ≤ 10000)"),
    methodologyHash: z
      .string()
      .optional()
      .describe("Optional 0x64hex reproducibility hash"),
  },
  async ({
    modelIpId,
    baseModelIpId,
    datasetWeights,
    methodologyHash,
  }: {
    modelIpId: string;
    baseModelIpId?: string;
    datasetWeights: Array<{ datasetIpId: string; weightBps: number; dataPointCount?: number }>;
    methodologyHash?: string;
  }) => {
    const data = await pccFetch("/api/contributors/training-manifests", {
      method: "POST",
      body: { modelIpId, baseModelIpId, datasetWeights, methodologyHash },
    });
    return toolResult(data);
  },
);

// 56. pcc_training_manifest_get

server.tool(
  "pcc_training_manifest_get",
  "Fetch the TrainingManifest for a model IP. Returns the parsed datasets array + manifestHash + createdAt, or 404 if no manifest has been set.",
  {
    modelIpId: z.string().describe("Story IP Asset ID for the model"),
  },
  async ({ modelIpId }: { modelIpId: string }) => {
    const data = await pccFetch(
      `/api/contributors/training-manifests/${encodeURIComponent(modelIpId)}`,
    );
    return toolResult(data);
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running on stdio — MCP clients connect via stdin/stdout.
  // Log to stderr so it does not interfere with the MCP protocol on stdout.
  console.error(`[pcc-mcp] PCC MCP server running (gateway: ${PCC_URL})`);
}

main().catch((err) => {
  console.error("[pcc-mcp] Fatal:", err);
  process.exit(1);
});
