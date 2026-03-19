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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PCC_URL = (process.env.PCC_URL ?? "https://pcc-gateway-production.up.railway.app").replace(
  /\/$/,
  "",
);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface FetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  query?: Record<string, string | undefined>;
}

async function pccFetch(path: string, opts: FetchOptions = {}): Promise<unknown> {
  const url = new URL(path, PCC_URL);

  // Append query parameters (skip undefined values)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== "") {
        url.searchParams.set(k, v);
      }
    }
  }

  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
  };

  if (opts.method === "POST" && opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url.toString(), init);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PCC API ${res.status}: ${text || res.statusText}`);
  }

  return res.json();
}

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
  async ({ status }) => {
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
  async ({ kernelId }) => {
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
  async ({ kernelId, status }) => {
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
  async ({ jobId }) => {
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
  async ({ type, selections, profileId }) => {
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
  async ({ type, selections, profileId }) => {
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
  async ({ type, selections, assuranceTier, profileId }) => {
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
  async ({ status }) => {
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
  async ({ tags, capabilities, search, status }) => {
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
  async ({ agentId }) => {
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
  async ({ agentId, tag }) => {
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
  async ({ kernelId }) => {
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
  async ({ kernelId, channel, limit }) => {
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
  async ({ bundleId }) => {
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
  async ({ steps }) => {
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
