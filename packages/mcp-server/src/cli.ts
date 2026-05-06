#!/usr/bin/env node

/**
 * PCC CLI — command-line interface to the Physical Capability Cloud gateway.
 *
 * All 63 tools from the MCP server are available as subcommands. (49 base
 * + 7 contributor-economics tools added in feat/contributor-economics
 * + 7 CVP capture tools registered via registerCaptureTools.)
 * Output is JSON by default (for piping/jq). Use --pretty for human-readable.
 *
 * Usage:
 *   pcc --help
 *   pcc <group> --help
 *   pcc capabilities list
 *   pcc kernels list --status=online
 *   PCC_URL=http://localhost:3200 pcc jobs list
 */

import { pccFetch, PCC_URL } from "./api.js";

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function out(data: unknown, pretty: boolean): void {
  if (pretty) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify(data) + "\n");
  }
}

function err(msg: string): never {
  process.stderr.write(`pcc: error: ${msg}\n`);
  process.exit(1);
}

function warn(msg: string): void {
  process.stderr.write(`pcc: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Arg parser helpers
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  pretty: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let pretty = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--pretty" || arg === "-p") {
      pretty = true;
    } else if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags, pretty, help };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || typeof v === "boolean") return undefined;
  return v;
}

function flagNum(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (isNaN(n)) err(`--${key} must be a number, got: ${v}`);
  return n;
}

function flagJSON(flags: Record<string, string | boolean>, key: string): unknown {
  const v = flagStr(flags, key);
  if (v === undefined) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    err(`--${key} must be valid JSON, got: ${v}`);
  }
}

function requireArg(positionals: string[], index: number, name: string): string {
  const v = positionals[index];
  if (!v) err(`missing required argument: <${name}>`);
  return v;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const GLOBAL_HELP = `
PCC CLI — Physical Capability Cloud gateway client
Gateway: ${PCC_URL}

Usage: pcc [--pretty] <group> <command> [args] [flags]

Global flags:
  --pretty      Pretty-print JSON output (default: compact JSON)
  --help, -h    Show help for a group or command

Groups:
  capabilities  List and search capability types
  kernels       Shop kernel management
  jobs          Manufacturing job management
  build         Contract builder (options, pricing, contracts)
  workflows     Workflow compiler
  escrow        Escrow contracts
  evidence      Evidence bundles
  protocols     Protocol templates
  sensors       Sensor data
  agents        Agent network / subnet
  reputation    Agent/kernel reputation
  depin         DePIN reward statistics
  setup         Operator setup assistant
  csd           Capability StructureDefinitions
  discover      Network device discovery
  ip            Story Protocol IP / royalties
  swf           Sovereign Wealth Fund
  wallet        Fiat ramp / wallet tools

Run 'pcc <group> --help' for group-specific commands.
`.trim();

const GROUP_HELP: Record<string, string> = {
  capabilities: `
pcc capabilities list
  List all registered capability types.

pcc capabilities search
  Search capability templates with full details.
`.trim(),

  kernels: `
pcc kernels list [--status=<status>]
  List all Shop Kernels. Optionally filter by status (online, offline, maintenance).

pcc kernels get <kernelId>
  Get detailed info about a specific Shop Kernel.
`.trim(),

  jobs: `
pcc jobs list [--kernelId=<id>] [--status=<status>]
  List manufacturing jobs. Filter by kernelId and/or status.

pcc jobs get <jobId>
  Get detailed info about a specific job.
`.trim(),

  build: `
pcc build options <type> [--selections='{}'] [--profileId=<id>]
  Get available configuration options for a capability type.

pcc build price <type> --selections='{}' [--profileId=<id>]
  Calculate price for a capability contract.

pcc build contract <type> --selections='{}' --tier=<0-3> [--profileId=<id>]
  Build a complete capability contract. Tiers: 0=none, 1=basic, 2=standard, 3=full.
`.trim(),

  workflows: `
pcc workflows compile --steps='[{"id":"s1","capabilityType":"fdm-printer","dependsOn":[],"parameters":{}}]'
  Compile a multi-step workflow into an execution DAG.
`.trim(),

  escrow: `
pcc escrow list [--status=<status>]
  List escrow contracts. Filter by status (funded, active, completed, disputed).
`.trim(),

  evidence: `
pcc evidence list
  List all evidence bundles (via jobs endpoint).

pcc evidence get <bundleId>
  Get a specific evidence bundle by ID.
`.trim(),

  protocols: `
pcc protocols list [--tags=<tags>] [--capabilities=<types>] [--search=<term>] [--status=<status>]
  List protocol templates. All filters are optional.
`.trim(),

  sensors: `
pcc sensors list <kernelId>
  List sensor channels for a kernel.

pcc sensors data <kernelId> <channel> [--limit=50]
  Get recent sensor readings for a channel.
`.trim(),

  agents: `
pcc agents status
  Get agent network / subnet status.

pcc agents identity <agentId>
  Get ERC-8004 identity for a kernel or agent.

pcc agents registration
  Get the ERC-8004 Agent Registration File for the PCC gateway.
`.trim(),

  reputation: `
pcc reputation get <agentId> [--tag=<tag>]
  Get reputation scores for a kernel or agent.
`.trim(),

  depin: `
pcc depin stats
  Get DePIN reward statistics (epochs, certificates, treasury).
`.trim(),

  setup: `
pcc setup detect
  Auto-detect current PCC configuration state.

pcc setup config <devicesJson>
  Generate KERNEL_CONFIG JSON from device descriptions.
  devicesJson: JSON array of device objects.

pcc setup validate [--config='{}']
  Validate a kernel config. Omit --config to validate the current config.

pcc setup register-device --kernelId=<id> --deviceId=<id> --type=<type> --adapter=<type> [--model=<name>] [--adapterConfig='{}'] [--capabilities='["cap1"]']
  Register a physical device. Types: machine, sensor, camera.
  Adapters: octoprint, modbus, opcua, sila, generic-http, mock.

pcc setup health [--deviceId=<id>]
  Run health checks. Omit --deviceId to check all devices.

pcc setup test-job [--kernelId=<id>] [--deviceId=<id>] [--tier=<0-3>]
  Submit a test job to verify the full pipeline.

pcc setup env <profile>
  Generate a .env file. Profiles: dev, testnet, mainnet.
  Optional flags: --chainNetwork=<net> --gatewayPrivateKey=0x... --escrowAddress=0x... --evidenceStorage=helia|storacha --litProtocolReal

pcc setup status
  Get comprehensive setup status.
`.trim(),

  csd: `
pcc csd list [--kind=<kind>] [--status=<status>]
  List CSDs. Kinds: base, profile, extension, workflow. Status: active, draft, retired.

pcc csd get <url>
  Get a CSD by canonical URI.

pcc csd register <csdJson>
  Register a new CSD. csdJson: JSON object conforming to CSD schema.
`.trim(),

  discover: `
pcc discover scan [--protocols=ipp] [--timeout=3000]
  Scan local network for physical devices.

pcc discover onboard [--uri=<deviceUri>] [--protocol=<proto>] [--timeout=3000]
  One-command device onboarding: discover → generate CSD → register.
`.trim(),

  ip: `
pcc ip register --capId=<id> --name=<name> --type=<type> --kernelId=<id> --designer=0x... --designerName=<name> [--revShare=5] [--ipfsCid=<cid>] [--description=<text>]
  Register a capability as a Story Protocol IP Asset.

pcc ip revenue <ipId>
  Get revenue snapshot for an IP Asset.

pcc ip claim <ipId> [--tokenIds='["id1"]']
  Claim accumulated revenue from an IP Royalty Vault.

pcc ip lineage <ipId>
  Get IP lineage chain (ancestors + descendants).

pcc ip splits <ipId> --splits='[{"address":"0x...","role":"protocol-author","percentage":2,"label":"CSD Author"},{"address":"0x...","role":"integrator","percentage":2,"label":"Adapter Integrator"},{"address":"0x...","role":"operator","percentage":92,"label":"Machine Operator"},{"address":"0x...","role":"verifier","percentage":3,"label":"Evidence Verifier"},{"address":"0x...","role":"network-treasury","percentage":1,"label":"Network Treasury"}]'
  Configure revenue splits for an IP Asset. Splits must sum to 100.
  Roles (ADR-12): operator, verifier, insurer, integrator, protocol-author,
  model-author, dataset-contributor, curator, assembler, network-treasury.
  Legacy aliases 'designer' and 'network' still decode for backward compat —
  prefer the canonical names above.
`.trim(),

  swf: `
pcc swf summary
  Get Sovereign Wealth Fund summary.

pcc swf participant <participantId>
  Get a participant's SWF dashboard.

pcc swf proposals [--status=<status>]
  List governance proposals. Status: active, passed, rejected, executed.
`.trim(),

  wallet: `
pcc wallet balance
  Check agent wallet USDC balance and API credits.

pcc wallet funding
  Show available fiat-to-crypto funding options.

pcc wallet onramp --provider=stripe|yellowcard --amount=<amount> --wallet=0x... [--currency=<fiat>] [--country=<code>] [--channelId=<id>]
  Create a fiat-to-crypto funding session.

pcc wallet rates
  Get live exchange rates from Yellowcard.

pcc wallet withdraw --amount=<usd> --currency=<fiat> --country=<code> --channelId=<id> --name=<holder> --account=<number> --accountType=<type> --wallet=0x...
  Withdraw USDC earnings to local fiat.

pcc wallet activity [--provider=stripe|yellowcard|wise]
  Show recent fiat on/off ramp activity.

pcc wallet payout --amount=<usd> --name=<recipient> --currency=<fiat> --accountType=<type> --details='{}' --reference=<ref>
  Send fiat payout to institutional bank account via Wise.
`.trim(),
};

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

type Handler = (positionals: string[], flags: Record<string, string | boolean>, pretty: boolean) => Promise<void>;

const commands: Record<string, Record<string, Handler>> = {

  // ---------- capabilities --------------------------------------------------

  capabilities: {
    list: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/capabilities/types");
      out(data, pretty);
    },
    search: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/capabilities/templates");
      out(data, pretty);
    },
  },

  // ---------- kernels -------------------------------------------------------

  kernels: {
    list: async (_pos, flags, pretty) => {
      const status = flagStr(flags, "status");
      const data = await pccFetch("/api/kernels", { query: { status } });
      out(data, pretty);
    },
    get: async (pos, _flags, pretty) => {
      const kernelId = requireArg(pos, 0, "kernelId");
      const data = await pccFetch(`/api/kernels/${encodeURIComponent(kernelId)}`);
      out(data, pretty);
    },
  },

  // ---------- jobs ----------------------------------------------------------

  jobs: {
    list: async (_pos, flags, pretty) => {
      const kernelId = flagStr(flags, "kernelId");
      const status = flagStr(flags, "status");
      const data = await pccFetch("/api/jobs", { query: { kernelId, status } });
      out(data, pretty);
    },
    get: async (pos, _flags, pretty) => {
      const jobId = requireArg(pos, 0, "jobId");
      const data = await pccFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
      out(data, pretty);
    },
  },

  // ---------- build ---------------------------------------------------------

  build: {
    options: async (pos, flags, pretty) => {
      const type = requireArg(pos, 0, "type");
      const selections = (flagJSON(flags, "selections") ?? {}) as Record<string, unknown>;
      const profileId = flagStr(flags, "profileId");
      const data = await pccFetch("/api/build/options", {
        method: "POST",
        body: { type, selections, profileId },
      });
      out(data, pretty);
    },
    price: async (pos, flags, pretty) => {
      const type = requireArg(pos, 0, "type");
      const rawSelections = flagJSON(flags, "selections");
      if (rawSelections === undefined) err("--selections is required for 'build price'");
      const selections = rawSelections as Record<string, unknown>;
      const profileId = flagStr(flags, "profileId");
      const data = await pccFetch("/api/build/price", {
        method: "POST",
        body: { type, selections, profileId },
      });
      out(data, pretty);
    },
    contract: async (pos, flags, pretty) => {
      const type = requireArg(pos, 0, "type");
      const rawSelections = flagJSON(flags, "selections");
      if (rawSelections === undefined) err("--selections is required for 'build contract'");
      const selections = rawSelections as Record<string, unknown>;
      const tierRaw = flagStr(flags, "tier");
      if (tierRaw === undefined) err("--tier is required for 'build contract' (0-3)");
      const assuranceTier = Number(tierRaw);
      if (isNaN(assuranceTier) || assuranceTier < 0 || assuranceTier > 3) {
        err("--tier must be 0, 1, 2, or 3");
      }
      const profileId = flagStr(flags, "profileId");
      const data = await pccFetch("/api/build/contract", {
        method: "POST",
        body: { type, selections, assuranceTier, profileId },
      });
      out(data, pretty);
    },
  },

  // ---------- workflows -----------------------------------------------------

  workflows: {
    compile: async (_pos, flags, pretty) => {
      const rawSteps = flagJSON(flags, "steps");
      if (rawSteps === undefined) err("--steps is required for 'workflows compile'");
      const steps = rawSteps as Array<{
        id: string;
        capabilityType: string;
        dependsOn?: string[];
        parameters?: Record<string, unknown>;
      }>;
      const data = await pccFetch("/api/workflows/compile", {
        method: "POST",
        body: { steps },
      });
      out(data, pretty);
    },
  },

  // ---------- escrow --------------------------------------------------------

  escrow: {
    list: async (_pos, flags, pretty) => {
      const status = flagStr(flags, "status");
      const data = await pccFetch("/api/escrow", { query: { status } });
      out(data, pretty);
    },
  },

  // ---------- evidence ------------------------------------------------------

  evidence: {
    list: async (_pos, _flags, pretty) => {
      // Gateway exposes evidence per-job; list jobs as proxy
      const data = await pccFetch("/api/jobs");
      out(data, pretty);
    },
    get: async (pos, _flags, pretty) => {
      const bundleId = requireArg(pos, 0, "bundleId");
      const data = await pccFetch(`/api/evidence/${encodeURIComponent(bundleId)}`);
      out(data, pretty);
    },
  },

  // ---------- protocols -----------------------------------------------------

  protocols: {
    list: async (_pos, flags, pretty) => {
      const tags = flagStr(flags, "tags");
      const capabilities = flagStr(flags, "capabilities");
      const search = flagStr(flags, "search");
      const status = flagStr(flags, "status");
      const data = await pccFetch("/api/protocols", {
        query: { tags, capabilities, search, status },
      });
      out(data, pretty);
    },
  },

  // ---------- sensors -------------------------------------------------------

  sensors: {
    list: async (pos, _flags, pretty) => {
      const kernelId = requireArg(pos, 0, "kernelId");
      const data = await pccFetch(`/api/sensors/${encodeURIComponent(kernelId)}/channels`);
      out(data, pretty);
    },
    data: async (pos, flags, pretty) => {
      const kernelId = requireArg(pos, 0, "kernelId");
      const channel = requireArg(pos, 1, "channel");
      const limit = flagNum(flags, "limit");
      const data = await pccFetch(
        `/api/sensors/${encodeURIComponent(kernelId)}/data/${encodeURIComponent(channel)}`,
        { query: { limit: limit?.toString() } },
      );
      out(data, pretty);
    },
  },

  // ---------- agents --------------------------------------------------------

  agents: {
    status: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/agents/status");
      out(data, pretty);
    },
    identity: async (pos, _flags, pretty) => {
      const agentId = requireArg(pos, 0, "agentId");
      const data = await pccFetch(`/api/registry/entities/${encodeURIComponent(agentId)}`);
      out(data, pretty);
    },
    registration: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/.well-known/agent-registration.json");
      out(data, pretty);
    },
  },

  // ---------- reputation ----------------------------------------------------

  reputation: {
    get: async (pos, flags, pretty) => {
      const agentId = requireArg(pos, 0, "agentId");
      const tag = flagStr(flags, "tag");
      const data = await pccFetch(
        `/api/registry/entities/${encodeURIComponent(agentId)}/reputation`,
        { query: { tag } },
      );
      out(data, pretty);
    },
  },

  // ---------- depin ---------------------------------------------------------

  depin: {
    stats: async (_pos, _flags, pretty) => {
      const [epochs, certificates, treasury] = await Promise.all([
        pccFetch("/api/rewards/epochs"),
        pccFetch("/api/certificates"),
        pccFetch("/api/treasury/summary"),
      ]);
      out({ epochs, certificates, treasury }, pretty);
    },
  },

  // ---------- setup ---------------------------------------------------------

  setup: {
    detect: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/setup/detect");
      out(data, pretty);
    },
    config: async (pos, flags, pretty) => {
      const devicesArg = pos[0];
      if (!devicesArg) err("missing required argument: <devicesJson>");
      let devices: unknown;
      try {
        devices = JSON.parse(devicesArg);
      } catch {
        err("devicesJson must be valid JSON");
      }
      const kernelId = flagStr(flags, "kernelId");
      const mockMode = flags["mockMode"] === true || flags["mockMode"] === "true";
      const data = await pccFetch("/api/setup/generate-config", {
        method: "POST",
        body: { devices, kernelId, mockMode: mockMode || undefined },
      });
      out(data, pretty);
    },
    validate: async (_pos, flags, pretty) => {
      const config = flagStr(flags, "config");
      const data = await pccFetch("/api/setup/validate", {
        method: "POST",
        body: { config },
      });
      out(data, pretty);
    },
    "register-device": async (_pos, flags, pretty) => {
      const kernelId = flagStr(flags, "kernelId");
      if (!kernelId) err("--kernelId is required");
      const deviceId = flagStr(flags, "deviceId");
      if (!deviceId) err("--deviceId is required");
      const type = flagStr(flags, "type") as "machine" | "sensor" | "camera" | undefined;
      if (!type) err("--type is required (machine, sensor, camera)");
      const adapterType = flagStr(flags, "adapter") as
        | "octoprint"
        | "modbus"
        | "opcua"
        | "sila"
        | "ipp"
        | "opentrons"
        | "hamilton"
        | "trilobio"
        | "generic-http"
        | "mock"
        | undefined;
      if (!adapterType)
        err("--adapter is required (octoprint, modbus, opcua, sila, ipp, opentrons, hamilton, trilobio, generic-http, mock)");
      const model = flagStr(flags, "model");
      const adapterConfigRaw = flagStr(flags, "adapterConfig");
      let adapterConfig: unknown;
      if (adapterConfigRaw) {
        try {
          adapterConfig = JSON.parse(adapterConfigRaw);
        } catch {
          err("--adapterConfig must be valid JSON");
        }
      }
      const capabilitiesRaw = flagStr(flags, "capabilities");
      let capabilities: string[] | undefined;
      if (capabilitiesRaw) {
        try {
          capabilities = JSON.parse(capabilitiesRaw) as string[];
        } catch {
          err("--capabilities must be a valid JSON array");
        }
      }
      const data = await pccFetch("/api/setup/register-device", {
        method: "POST",
        body: { kernelId, deviceId, type, model, adapterType, adapterConfig, capabilities },
      });
      out(data, pretty);
    },
    health: async (_pos, flags, pretty) => {
      const deviceId = flagStr(flags, "deviceId");
      let data: unknown;
      if (deviceId) {
        data = await pccFetch(`/api/devices/${encodeURIComponent(deviceId)}/health`, {
          method: "POST",
          body: {},
        });
      } else {
        data = await pccFetch("/api/setup/status");
      }
      out(data, pretty);
    },
    "test-job": async (_pos, flags, pretty) => {
      const kernelId = flagStr(flags, "kernelId");
      const deviceId = flagStr(flags, "deviceId");
      const assuranceTier = flagNum(flags, "tier");
      const data = await pccFetch("/api/setup/test-job", {
        method: "POST",
        body: { kernelId, deviceId, assuranceTier },
      });
      out(data, pretty);
    },
    env: async (pos, flags, pretty) => {
      const profile = requireArg(pos, 0, "profile") as "dev" | "testnet" | "mainnet";
      if (!["dev", "testnet", "mainnet"].includes(profile)) {
        err(`profile must be dev, testnet, or mainnet, got: ${profile}`);
      }
      const chainNetwork = flagStr(flags, "chainNetwork");
      const gatewayPrivateKey = flagStr(flags, "gatewayPrivateKey");
      const escrowAddress = flagStr(flags, "escrowAddress");
      const evidenceStorage = flagStr(flags, "evidenceStorage") as "helia" | "storacha" | undefined;
      const litProtocolReal = flags["litProtocolReal"] === true || flags["litProtocolReal"] === "true";

      // Generate env content locally (same logic as MCP tool)
      const lines: string[] = [
        `# PCC Environment — profile: ${profile}`,
        `# Generated by pcc cli on ${new Date().toISOString()}`,
        "",
        `NODE_ENV=${profile === "dev" ? "development" : "production"}`,
        "PORT=3200",
        "",
      ];

      if (profile === "testnet" || profile === "mainnet") {
        const network = chainNetwork ?? (profile === "mainnet" ? "base" : "base-sepolia");
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
        lines.push("# Chain / Network (commented out — using mock mode)");
        lines.push("# PCC_NETWORK=localhost");
        lines.push("# PCC_GATEWAY_PRIVATE_KEY=0x...");
        lines.push("# ESCROW_CONTRACT_ADDRESS=0x...");
        lines.push("");
      }

      const storage = evidenceStorage ?? "helia";
      lines.push("# Evidence Storage");
      lines.push(`EVIDENCE_STORAGE=${storage}`);
      if (storage === "storacha") {
        lines.push("# STORACHA_PROOF=<base64_ucan>  (get from: npx w3 delegation create)");
        lines.push("# STORACHA_SPACE_DID=did:key:z6Mk...");
      }
      lines.push("");

      lines.push("# Lit Protocol Encryption");
      if (litProtocolReal) {
        lines.push("LIT_PROTOCOL_REAL=true");
      } else {
        lines.push("# LIT_PROTOCOL_REAL=true  (uncomment to use real Lit Protocol datil-test network)");
      }
      lines.push("");

      if (profile === "dev") {
        lines.push("# Kernel Runtime (optional — mock mode used if not set)");
        lines.push("# KERNEL_CONFIG='{\"kernelId\":\"my-shop\",\"devices\":[...]}'");
        lines.push("# KERNEL_CONFIG_FILE=./kernel-config.json");
      }

      const envContent = lines.join("\n");
      const filename = `.env.${profile}`;
      out({ envContent, filename, profile, linesGenerated: lines.length }, pretty);
    },
    status: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/setup/status");
      out(data, pretty);
    },
  },

  // ---------- csd -----------------------------------------------------------

  csd: {
    list: async (_pos, flags, pretty) => {
      const kind = flagStr(flags, "kind");
      const status = flagStr(flags, "status");
      const data = await pccFetch("/api/csd", { query: { kind, status } });
      out(data, pretty);
    },
    get: async (pos, _flags, pretty) => {
      const url = requireArg(pos, 0, "url");
      const data = await pccFetch(`/api/csd/${encodeURIComponent(url)}`);
      out(data, pretty);
    },
    register: async (pos, _flags, pretty) => {
      const csdArg = pos[0];
      if (!csdArg) err("missing required argument: <csdJson>");
      let csd: unknown;
      try {
        csd = JSON.parse(csdArg);
      } catch {
        err("csdJson must be valid JSON");
      }
      const data = await pccFetch("/api/csd", {
        method: "POST",
        body: csd,
      });
      out(data, pretty);
    },
  },

  // ---------- discover ------------------------------------------------------

  discover: {
    scan: async (_pos, flags, pretty) => {
      const protocolsRaw = flagStr(flags, "protocols");
      const protocols = protocolsRaw ? protocolsRaw.split(",") : undefined;
      const timeoutMs = flagNum(flags, "timeout");
      const data = await pccFetch("/api/discover/scan", {
        method: "POST",
        body: { protocols, timeoutMs },
      });
      out(data, pretty);
    },
    onboard: async (_pos, flags, pretty) => {
      const deviceUri = flagStr(flags, "uri");
      const protocol = flagStr(flags, "protocol");
      const timeoutMs = flagNum(flags, "timeout");
      const data = await pccFetch("/api/discover/onboard", {
        method: "POST",
        body: { deviceUri, protocol, timeoutMs },
      });
      out(data, pretty);
    },
  },

  // ---------- ip ------------------------------------------------------------

  ip: {
    register: async (_pos, flags, pretty) => {
      const capabilityId = flagStr(flags, "capId");
      if (!capabilityId) err("--capId is required");
      const capabilityName = flagStr(flags, "name");
      if (!capabilityName) err("--name is required");
      const capabilityType = flagStr(flags, "type");
      if (!capabilityType) err("--type is required");
      const kernelId = flagStr(flags, "kernelId");
      if (!kernelId) err("--kernelId is required");
      const designerAddress = flagStr(flags, "designer");
      if (!designerAddress) err("--designer is required (wallet address 0x...)");
      const designerName = flagStr(flags, "designerName");
      if (!designerName) err("--designerName is required");
      const commercialRevShare = flagNum(flags, "revShare");
      const ipfsCid = flagStr(flags, "ipfsCid");
      const description = flagStr(flags, "description");
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
      out(data, pretty);
    },
    revenue: async (pos, _flags, pretty) => {
      const ipId = requireArg(pos, 0, "ipId");
      const data = await pccFetch(`/api/ip/${encodeURIComponent(ipId)}/revenue`);
      out(data, pretty);
    },
    claim: async (pos, flags, pretty) => {
      const ipId = requireArg(pos, 0, "ipId");
      const tokenIdsRaw = flagStr(flags, "tokenIds");
      let tokenIds: string[] | undefined;
      if (tokenIdsRaw) {
        try {
          tokenIds = JSON.parse(tokenIdsRaw) as string[];
        } catch {
          err("--tokenIds must be a valid JSON array");
        }
      }
      const data = await pccFetch(`/api/ip/${encodeURIComponent(ipId)}/claim`, {
        method: "POST",
        body: { tokenIds },
      });
      out(data, pretty);
    },
    lineage: async (pos, _flags, pretty) => {
      const ipId = requireArg(pos, 0, "ipId");
      const data = await pccFetch(`/api/ip/${encodeURIComponent(ipId)}/lineage`);
      out(data, pretty);
    },
    splits: async (pos, flags, pretty) => {
      const ipId = requireArg(pos, 0, "ipId");
      const rawSplits = flagJSON(flags, "splits");
      if (rawSplits === undefined) err("--splits is required");
      const splits = rawSplits as Array<{
        address: string;
        role: string;
        percentage: number;
        label: string;
      }>;
      const data = await pccFetch("/api/ip/distribute-royalties", {
        method: "POST",
        body: { ipId, splits },
      });
      out(data, pretty);
    },
  },

  // ---------- swf -----------------------------------------------------------

  swf: {
    summary: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/swf/summary");
      out(data, pretty);
    },
    participant: async (pos, _flags, pretty) => {
      const participantId = requireArg(pos, 0, "participantId");
      const data = await pccFetch(`/api/swf/participants/${participantId}`);
      out(data, pretty);
    },
    proposals: async (_pos, flags, pretty) => {
      const status = flagStr(flags, "status");
      const query = status ? `?status=${status}` : "";
      const data = await pccFetch(`/api/swf/proposals${query}`);
      out(data, pretty);
    },
  },

  // ---------- wallet --------------------------------------------------------

  wallet: {
    balance: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/fiat-ramp/status");
      out(data, pretty);
    },
    funding: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/fiat-ramp/status");
      out(data, pretty);
    },
    onramp: async (_pos, flags, pretty) => {
      const provider = flagStr(flags, "provider") as "stripe" | "yellowcard" | undefined;
      if (!provider) err("--provider is required (stripe or yellowcard)");
      const amount = flagStr(flags, "amount");
      if (!amount) err("--amount is required");
      const walletAddress = flagStr(flags, "wallet");
      if (!walletAddress) err("--wallet is required (wallet address 0x...)");
      const currency = flagStr(flags, "currency");
      const country = flagStr(flags, "country");
      const channelId = flagStr(flags, "channelId");

      let data: unknown;
      if (provider === "stripe") {
        data = await pccFetch("/api/fiat-ramp/stripe/onramp", {
          method: "POST",
          body: { walletAddress, sourceAmount: amount },
        });
      } else {
        data = await pccFetch("/api/fiat-ramp/yellowcard/deposit", {
          method: "POST",
          body: {
            walletAddress,
            fiatAmount: amount,
            fiatCurrency: currency ?? "NGN",
            country: country ?? "NG",
            channelId: channelId ?? "ch_ng_bank",
            recipient: {
              name: "PCC Agent",
              country: country ?? "NG",
              phone: "+0000000000",
              address: "PCC",
              dob: "01/01/2000",
              idNumber: "000000",
              idType: "passport",
            },
          },
        });
      }
      out(data, pretty);
    },
    rates: async (_pos, _flags, pretty) => {
      const data = await pccFetch("/api/fiat-ramp/yellowcard/rates");
      out(data, pretty);
    },
    withdraw: async (_pos, flags, pretty) => {
      const amountUsd = flagStr(flags, "amount");
      if (!amountUsd) err("--amount is required");
      const fiatCurrency = flagStr(flags, "currency");
      if (!fiatCurrency) err("--currency is required (e.g. NGN, KES)");
      const country = flagStr(flags, "country");
      if (!country) err("--country is required (e.g. NG, KE)");
      const channelId = flagStr(flags, "channelId");
      if (!channelId) err("--channelId is required");
      const accountName = flagStr(flags, "name");
      if (!accountName) err("--name is required (account holder name)");
      const accountNumber = flagStr(flags, "account");
      if (!accountNumber) err("--account is required (bank account or phone number)");
      const accountType = flagStr(flags, "accountType");
      if (!accountType) err("--accountType is required (bank_transfer or mobile_money)");
      const walletAddress = flagStr(flags, "wallet");
      if (!walletAddress) err("--wallet is required (source wallet address 0x...)");

      const data = await pccFetch("/api/fiat-ramp/yellowcard/withdraw", {
        method: "POST",
        body: {
          walletAddress,
          amountUsd,
          fiatCurrency,
          country,
          channelId,
          destination: { type: accountType, accountName, accountNumber, country },
          sender: {
            name: "PCC Agent",
            country,
            address: "PCC",
            dob: "01/01/2000",
            email: "agent@pcc.dev",
            idNumber: "000000",
            idType: "passport",
          },
        },
      });
      out(data, pretty);
    },
    activity: async (_pos, flags, pretty) => {
      const provider = flagStr(flags, "provider");
      const query = provider ? { provider } : undefined;
      const data = await pccFetch("/api/fiat-ramp/sessions", { query });
      out(data, pretty);
    },
    payout: async (_pos, flags, pretty) => {
      const amountRaw = flagStr(flags, "amount");
      if (!amountRaw) err("--amount is required");
      const amount = Number(amountRaw);
      if (isNaN(amount)) err("--amount must be a number");
      const recipientName = flagStr(flags, "name");
      if (!recipientName) err("--name is required (recipient name)");
      const currency = flagStr(flags, "currency");
      if (!currency) err("--currency is required (e.g. GBP, EUR, INR)");
      const accountType = flagStr(flags, "accountType");
      if (!accountType) err("--accountType is required (e.g. sort_code, iban, aba)");
      const rawDetails = flagJSON(flags, "details");
      if (rawDetails === undefined) err("--details is required (JSON bank account details)");
      const details = rawDetails as Record<string, unknown>;
      const reference = flagStr(flags, "reference");
      if (!reference) err("--reference is required (payment reference)");

      const data = await pccFetch("/api/fiat-ramp/wise/payout", {
        method: "POST",
        body: {
          sourceAmount: amount,
          recipient: { name: recipientName, currency, type: accountType, details },
          reference,
        },
      });
      out(data, pretty);
    },
  },
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positionals, flags, pretty, help } = parseArgs(argv);

  const group = positionals[0];
  const command = positionals[1];
  const restPositionals = positionals.slice(2);

  // Global help
  if (!group || help && !group) {
    process.stdout.write(GLOBAL_HELP + "\n");
    process.exit(0);
  }

  // Group help
  if (help && group && !command) {
    const groupHelp = GROUP_HELP[group];
    if (!groupHelp) {
      process.stderr.write(`pcc: unknown group '${group}'. Run 'pcc --help' for available groups.\n`);
      process.exit(1);
    }
    process.stdout.write(groupHelp + "\n");
    process.exit(0);
  }

  // Command help
  if (help && group && command) {
    const groupHelp = GROUP_HELP[group];
    if (groupHelp) {
      process.stdout.write(groupHelp + "\n");
    } else {
      process.stdout.write(GLOBAL_HELP + "\n");
    }
    process.exit(0);
  }

  // Validate group
  const groupHandlers = commands[group];
  if (!groupHandlers) {
    process.stderr.write(`pcc: unknown group '${group}'. Run 'pcc --help' for available groups.\n`);
    process.exit(1);
  }

  // No command given — show group help
  if (!command) {
    const groupHelp = GROUP_HELP[group];
    if (groupHelp) {
      process.stdout.write(groupHelp + "\n");
    } else {
      process.stdout.write(GLOBAL_HELP + "\n");
    }
    process.exit(0);
  }

  // Validate command
  const handler = groupHandlers[command];
  if (!handler) {
    const available = Object.keys(groupHandlers).join(", ");
    process.stderr.write(`pcc: unknown command '${command}' in group '${group}'. Available: ${available}\n`);
    process.exit(1);
  }

  warn(`gateway: ${PCC_URL}`);

  try {
    await handler(restPositionals, flags, pretty);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`pcc: ${msg}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`pcc: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
