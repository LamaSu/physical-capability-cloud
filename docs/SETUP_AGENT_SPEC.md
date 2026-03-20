# PCC Setup Agent — Technical Specification

> **Purpose**: This document gives a Claude Code agent (or any LLM agent) everything it needs to build an integrated setup system for PCC. The goal: an operator hands their agent this spec, and the agent walks them through onboarding a physical device onto the PCC network in as few manual steps as possible.
>
> **Branch**: Work on a feature branch (`feature/setup-agent`) off `master`.
>
> **Date**: 2026-03-20

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [What Exists Today](#2-what-exists-today)
3. [What We're Building](#3-what-were-building)
4. [Architecture Decision](#4-architecture-decision)
5. [Setup Flows to Implement](#5-setup-flows-to-implement)
6. [Implementation Plan](#6-implementation-plan)
7. [MCP Tool Definitions](#7-mcp-tool-definitions)
8. [A2A Intent Definitions](#8-a2a-intent-definitions)
9. [Environment Variable Reference](#9-environment-variable-reference)
10. [Existing Code Index](#10-existing-code-index)
11. [Testing Strategy](#11-testing-strategy)
12. [Conventions](#12-conventions)

---

## 1. Project Overview

PCC (Physical Capability Cloud) is "AWS for the physical world" — a cloud control plane for physical manufacturing capabilities. Shop Kernels are Availability Zones (physical sites with equipment). Capabilities are billable units (not machines — what machines can DO).

**The problem**: Setting up a kernel (registering devices, configuring adapters, connecting to the network, deploying contracts, wiring evidence storage, etc.) requires manually setting 40+ environment variables across 6 config categories. Nobody should have to do this by hand.

**The solution**: A setup agent that:
1. Interviews the operator conversationally
2. Auto-detects what's already configured
3. Generates all config (env vars, KERNEL_CONFIG JSON, .env files)
4. Validates connectivity (pings printers, checks wallet balances, verifies contracts)
5. Registers on the network (writes device to DB, registers capabilities on-chain)
6. Runs a health check and reports what's working

**Repo**: `C:\Users\globa\physical-capability-cloud`
**Stack**: pnpm monorepo, TypeScript (ES2022/NodeNext/strict), turbo, vitest, Fastify, viem, Zod, SQLite (Drizzle)

---

## 2. What Exists Today

### 2.1 Operator Runtime (just built — commit `93e762e`)

The glue layer that connects real devices to the PCC network:

| Component | File | What It Does |
|---|---|---|
| Device Registry | `packages/db/src/schema/kernels.ts` | `kernelDevices` table with `adapterType`, `adapterConfig`, `healthStatus`, `lastHealthCheck` columns |
| Kernel Config | `packages/kernel/src/kernel-config.ts` | `loadKernelConfig()` — reads from `KERNEL_CONFIG` env (JSON), `KERNEL_CONFIG_FILE` (path), or defaults to mock |
| Adapter Factory | `packages/kernel/src/adapter-factory.ts` | `createAdaptersFromConfig()` — instantiates OctoPrint/Modbus/OPC-UA/SiLA/mock adapters |
| Kernel Service | `packages/gateway/src/services/kernel-service.ts` | Singleton that manages JobRunners, routes jobs to devices, tracks status |
| Settlement Service | `packages/gateway/src/services/settlement-service.ts` | Evidence storage → DB persist → on-chain settlement (graceful degradation) |
| Job Submit API | `packages/gateway/src/routes/job-submit.ts` | `POST /api/jobs/submit`, `GET /api/jobs/:jobId/status`, device registration + health endpoints |

### 2.2 MCP Server (21 tools)

File: `packages/mcp-server/src/index.ts`

Exposes gateway API to Claude Code / Cursor. Current tools focus on read operations and contract building. **No setup/config tools exist yet.**

Key existing tools: `pcc_list_capabilities`, `pcc_search_capabilities`, `pcc_list_kernels`, `pcc_get_kernel`, `pcc_list_jobs`, `pcc_get_job`, `pcc_build_options`, `pcc_calculate_price`, `pcc_build_contract`, `pcc_list_escrows`, `pcc_list_evidence`, `pcc_list_protocols`, `pcc_depin_stats`, `pcc_subnet_status`, `pcc_get_agent_identity`, `pcc_get_reputation`, `pcc_list_sensors`, `pcc_get_sensor_data`, `pcc_get_evidence`, `pcc_compile_workflow`, `pcc_agent_registration`.

### 2.3 Onboard Kit (`@pcc/onboard-kit`)

| Entry Point | File | What It Does |
|---|---|---|
| `quickStart()` | `packages/onboard-kit/src/quick-start.ts` | One-call setup: creates adapters + capability + JobRunner + KernelAgent. Returns running agent. |
| `scaffold()` | `packages/onboard-kit/src/scaffolder.ts` | Code generator: config JSON → full TypeScript kernel project on disk |
| `validate()` | `packages/onboard-kit/src/validate.ts` | Validates an OnboardConfig: 20+ checks on adapters, capabilities, pricing, protocols |
| CLI | `packages/onboard-kit/src/cli.ts` | `pcc-onboard scaffold --config my-shop.json --output ./my-kernel` |
| Agent Guide | `packages/onboard-kit/AGENT_INSTRUCTIONS.md` | 12-step guide for AI agents to onboard a kernel |

### 2.4 Identity Registration (`@pcc/identity-8004`)

| Component | File | What It Does |
|---|---|---|
| `IdentityRegistryClient` | `packages/identity-8004/src/identity-registry.ts` | `register(agentURI, metadata?)` → on-chain ERC-721 token (agent identity) |
| `ReputationRegistryClient` | `packages/identity-8004/src/reputation-registry.ts` | Submit/query reputation feedback |
| `ValidationRegistryClient` | `packages/identity-8004/src/validation-registry.ts` | Trust attestation management |
| `generateRegistrationFile()` | `packages/identity-8004/src/registration-file.ts` | Creates `/.well-known/agent-registration.json` |
| `CrossChainRegistrationManager` | `packages/identity-8004/src/cross-chain.ts` | Multi-chain registration (Base Sepolia + Ethereum Sepolia) |

### 2.5 Dashboard Wizards (UI — currently mocked)

| Wizard | Route | Steps | State |
|---|---|---|---|
| Platform Setup | `/setup` | 5 steps: Welcome → Network → Wallet → Identity → Complete | Working UI, Zustand-only (no backend calls) |
| Machine Onboarding | `/onboard/wizard` | 7 steps: Identity → Docs → Capabilities → Space → Pricing → Operator → Review | Working UI, submits to `alert("mock")` |
| Device Builder | `/build/new-device` | 5 steps: Info → Params → Pricing → Constraints → Register | Working UI, store-backed |

### 2.6 Agent Layer

| Agent | Package | Role | Intents Handled |
|---|---|---|---|
| UserAgent | `@pcc/agent-user` | `user` | 7 LLM tools, 10 intent handlers |
| BrokerAgent | `@pcc/agent-broker` | `scheduler` | 10 intent handlers, NLP routing, 3 LLM tools |
| KernelAgent | `@pcc/agent-kernel` | `kernel` | 6 intent handlers, 4 LLM tools |
| SupportAgent | `@pcc/agent-support` | `support` | 6 handlers, knowledge base, diagnostics, telemetry, escalation |
| EvaluatorAgent | `@pcc/agent-evaluator` | `verifier` | Evaluation engine, ACP bridge, reputation bridge |

### 2.7 A2A Protocol (28 intent types)

Categories: Discovery (4), Quoting/Negotiation (4), Contract Builder (4), Job Lifecycle (5), Payment (3), Logistics (3), Verification (2), Evaluation (2), Funding (3), General (2).

---

## 3. What We're Building

### 3.1 Setup Agent Tools (add to `@pcc/mcp-server`)

New MCP tools that any AI agent (Claude Code, Cursor, custom) can use to set up PCC:

| Tool | Purpose |
|---|---|
| `pcc_setup_detect` | Auto-detect current config state (which env vars are set, DB status, chain connectivity) |
| `pcc_setup_generate_config` | Generate KERNEL_CONFIG JSON from device descriptions |
| `pcc_setup_validate_config` | Validate a kernel config (adapter connectivity, capability definitions) |
| `pcc_setup_register_device` | Register a device via the gateway API |
| `pcc_setup_health_check` | Run health checks on all configured devices |
| `pcc_setup_generate_env` | Generate a .env file from answers to setup questions |
| `pcc_setup_deploy_contracts` | Deploy escrow contracts to testnet (requires funded wallet) |
| `pcc_setup_register_identity` | Register kernel identity on-chain via ERC-8004 |
| `pcc_setup_test_job` | Submit a test job to verify the full pipeline works |
| `pcc_setup_status` | Get a comprehensive status of what's configured and what's missing |

### 3.2 Setup Intents (add to `@pcc/a2a`)

New A2A intents so agents can trigger setup flows programmatically:

| Intent | Direction | Purpose |
|---|---|---|
| `setup_detect` | request | Ask for current config detection |
| `setup_detect_result` | response | Return detected config state |
| `setup_configure` | request | Configure a specific subsystem (adapter, chain, storage, identity) |
| `setup_configure_result` | response | Return config result |
| `setup_validate` | request | Validate full setup |
| `setup_validate_result` | response | Return validation results with pass/warn/fail per check |

### 3.3 SetupAgent (new agent in `@pcc/agent-support` or standalone)

A new agent class that orchestrates the setup flow:

```
SetupAgent extends BaseAgent
  role: "setup"

  Intents handled:
    - setup_detect → runs detection, returns state
    - setup_configure → generates config for a subsystem
    - setup_validate → validates the full setup
    - text_message → NLP routing to setup commands

  LLM tools:
    - detect_config → what's configured
    - configure_adapter → set up a device adapter
    - configure_chain → set up chain/wallet
    - configure_storage → set up evidence storage
    - register_identity → on-chain identity
    - run_test_job → end-to-end verification
    - get_setup_status → comprehensive status
```

### 3.4 Wire Dashboard Wizards to Real Backend

Connect the currently-mocked wizard submit steps to the actual gateway APIs:

- Setup Wizard Step 5 → `POST /api/onboard/register`
- Onboarding Wizard Step 7 → `POST /api/devices/register` + `POST /api/onboard/register`
- Both should also trigger identity registration when wallet is connected

---

## 4. Architecture Decision

**The agent IS the skill.** Instead of 20 separate slash commands, we build:

1. **MCP tools** in `@pcc/mcp-server` — so any Claude Code / Cursor / custom agent can call them
2. **A2A intents** in `@pcc/a2a` — so PCC agents can trigger setup flows
3. **SetupAgent** in `@pcc/agent-support` — orchestrates the conversational flow
4. **Gateway endpoints** — the actual backend logic (detection, validation, registration)

The MCP tools call gateway endpoints. The A2A intents route through the SetupAgent. The dashboard wizards call the same gateway endpoints. One backend, three interfaces.

```
                    ┌─────────────────┐
                    │  Claude Code    │
                    │  (MCP client)   │
                    └────────┬────────┘
                             │ MCP tools
                    ┌────────▼────────┐
                    │  @pcc/mcp-server │
                    └────────┬────────┘
                             │ HTTP
┌──────────────┐    ┌────────▼────────┐    ┌──────────────┐
│  Dashboard   │───▶│    Gateway      │◀───│  SetupAgent  │
│  Wizards     │    │  /api/setup/*   │    │  (A2A)       │
└──────────────┘    └────────┬────────┘    └──────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
        │  SQLite   │ │  Adapters │ │  Chain    │
        │  (store)  │ │  (health) │ │  (deploy) │
        └───────────┘ └───────────┘ └───────────┘
```

---

## 5. Setup Flows to Implement

### Flow A: "I have a 3D printer, get me on PCC"

**Minimum manual steps for operator**: 3
1. Tell the agent what printer they have (make/model/IP)
2. Confirm the generated config
3. Fund their wallet (if they want on-chain settlement)

**Agent handles everything else**:
1. Detect current state (gateway running? DB initialized? any devices already?)
2. Generate `KERNEL_CONFIG` JSON with OctoPrint adapter
3. Validate config (ping printer API, check reachability)
4. Register device in DB via `POST /api/devices/register`
5. Run health check via `POST /api/devices/:id/health`
6. Submit test job via `POST /api/jobs/submit`
7. Report success with evidence bundle ID

### Flow B: "I want to operate a full kernel with settlement"

Adds to Flow A:
8. Generate wallet (or import existing) via UnifiedKeychain
9. Deploy contracts to testnet (if not already deployed)
10. Register on-chain identity via ERC-8004
11. Configure evidence storage (IPFS/Storacha)
12. Configure Lit Protocol encryption (if tier 2+)
13. Wire escrow address into config
14. Run full pipeline test (job → evidence → settlement)

### Flow C: "Check what's set up and what's missing"

Non-interactive diagnostic:
1. Check all env vars (which are set, which are missing)
2. Check DB state (kernels, devices, capabilities)
3. Check chain connectivity (RPC reachable, wallet funded)
4. Check adapter health (ping each device)
5. Check evidence storage (IPFS/Storacha reachable)
6. Report comprehensive status with remediation steps

---

## 6. Implementation Plan

### Wave 1: Gateway Setup Endpoints (backend)

Create `packages/gateway/src/routes/setup.ts`:

```typescript
export async function setupRoutes(app: FastifyInstance) {
  // GET /api/setup/detect — auto-detect current config state
  // Returns: { envVars: {name, set, value?}[], db: {kernels, devices, jobs}, chain: {connected, network, balance?}, adapters: {id, type, healthy}[], storage: {type, connected} }

  // POST /api/setup/generate-config — generate KERNEL_CONFIG from device descriptions
  // Body: { kernelId?, devices: [{ name, type, adapterType, url?, apiKey?, host?, port? }], mockMode? }
  // Returns: { config: KernelConfig, envLine: string, jsonFile: string }

  // POST /api/setup/validate — validate a kernel config
  // Body: { config: KernelConfig } or reads from current env
  // Returns: { valid, checks: [{name, status: pass|warn|fail, message}], errors, warnings }

  // POST /api/setup/register-device — register a device and its capabilities
  // Body: { kernelId, device: DeviceConfig, capabilities?: string[] }
  // Returns: { device, registered: true }

  // POST /api/setup/test-job — submit a test job to verify pipeline
  // Body: { kernelId?, deviceId? }
  // Returns: { jobId, status, evidenceBundleId?, duration }

  // GET /api/setup/status — comprehensive setup status
  // Returns: { overall: "ready"|"partial"|"unconfigured", categories: [...] }
}
```

Register in `packages/gateway/src/server.ts`.

### Wave 2: MCP Tools (agent interface)

Add to `packages/mcp-server/src/index.ts`:

10 new tools that call the gateway setup endpoints. Each tool should:
- Have a clear description for LLM function calling
- Accept minimal parameters (the agent fills in what it knows)
- Return structured results the agent can reason about

### Wave 3: A2A Intents + SetupAgent

Add setup intent types to `packages/a2a/src/types.ts`.

Create `SetupAgent` class (either in `@pcc/agent-support` or new `@pcc/agent-setup`):
- Handles `setup_detect`, `setup_configure`, `setup_validate` intents
- Handles `text_message` with NLP routing to setup commands
- Registered LLM tools: `detect_config`, `configure_adapter`, `configure_chain`, `configure_storage`, `register_identity`, `run_test_job`, `get_setup_status`

### Wave 4: Dashboard Wiring (optional, lower priority)

Wire the existing wizard submit steps to the real gateway endpoints.

---

## 7. MCP Tool Definitions

### `pcc_setup_detect`

```json
{
  "name": "pcc_setup_detect",
  "description": "Auto-detect the current PCC configuration state. Returns which environment variables are set, database status (kernels/devices/jobs), chain connectivity, adapter health, and evidence storage status. Use this as the FIRST step when helping someone set up PCC.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### `pcc_setup_generate_config`

```json
{
  "name": "pcc_setup_generate_config",
  "description": "Generate a KERNEL_CONFIG JSON from device descriptions. Tell it what devices the operator has (type, adapter protocol, connection details) and it produces the config JSON, an env var line, and a JSON file.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "kernelId": { "type": "string", "description": "Unique kernel ID (e.g., 'kernel_my_shop'). Auto-generated if omitted." },
      "devices": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string", "description": "Human-readable device name" },
            "type": { "type": "string", "enum": ["machine", "sensor", "camera"] },
            "adapterType": { "type": "string", "enum": ["octoprint", "modbus", "opcua", "sila", "generic-http", "mock"] },
            "url": { "type": "string", "description": "Device API URL (OctoPrint, SiLA, generic-http)" },
            "apiKey": { "type": "string", "description": "API key (OctoPrint)" },
            "host": { "type": "string", "description": "Host IP (Modbus, OPC-UA)" },
            "port": { "type": "number", "description": "Port (Modbus, OPC-UA)" }
          },
          "required": ["name", "type", "adapterType"]
        }
      },
      "mockMode": { "type": "boolean", "description": "Force all adapters to mock mode (for testing)" }
    },
    "required": ["devices"]
  }
}
```

### `pcc_setup_validate_config`

```json
{
  "name": "pcc_setup_validate_config",
  "description": "Validate a kernel configuration. Checks adapter connectivity, capability definitions, and configuration completeness. If no config is provided, validates the currently loaded config.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "config": { "type": "string", "description": "KERNEL_CONFIG JSON string to validate. Omit to validate current config." }
    },
    "required": []
  }
}
```

### `pcc_setup_register_device`

```json
{
  "name": "pcc_setup_register_device",
  "description": "Register a physical device onto the PCC network. Creates a DB record and optionally runs a health check.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "kernelId": { "type": "string" },
      "deviceId": { "type": "string" },
      "type": { "type": "string", "enum": ["machine", "sensor", "camera"] },
      "model": { "type": "string" },
      "adapterType": { "type": "string", "enum": ["octoprint", "modbus", "opcua", "sila", "generic-http", "mock"] },
      "adapterConfig": { "type": "string", "description": "JSON string of adapter-specific config (url, apiKey, host, port, etc.)" },
      "capabilities": { "type": "array", "items": { "type": "string" }, "description": "Capability type IDs this device provides" }
    },
    "required": ["kernelId", "deviceId", "type", "adapterType"]
  }
}
```

### `pcc_setup_health_check`

```json
{
  "name": "pcc_setup_health_check",
  "description": "Run health checks on all configured devices or a specific device. Returns connectivity status, response time, and any errors.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "deviceId": { "type": "string", "description": "Check a specific device. Omit to check all." }
    },
    "required": []
  }
}
```

### `pcc_setup_test_job`

```json
{
  "name": "pcc_setup_test_job",
  "description": "Submit a test job to verify the full PCC pipeline works end-to-end: job submission → adapter execution → evidence collection → (optional) settlement. Returns job result with evidence bundle ID.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "kernelId": { "type": "string", "description": "Target kernel. Uses default if omitted." },
      "deviceId": { "type": "string", "description": "Target device. Auto-selects if omitted." },
      "assuranceTier": { "type": "number", "description": "0-3. Default 0 (no challenge window, auto-settle)." }
    },
    "required": []
  }
}
```

### `pcc_setup_status`

```json
{
  "name": "pcc_setup_status",
  "description": "Get comprehensive setup status. Shows what's configured, what's missing, and what needs attention across all categories: gateway, database, adapters, chain, storage, identity.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

### `pcc_setup_generate_env`

```json
{
  "name": "pcc_setup_generate_env",
  "description": "Generate a .env file from configuration answers. Produces all required environment variables for a specific deployment profile (dev, testnet, mainnet).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "profile": { "type": "string", "enum": ["dev", "testnet", "mainnet"], "description": "Deployment profile. Default: dev" },
      "chainNetwork": { "type": "string", "description": "Chain network (base-sepolia, sepolia, localhost)" },
      "gatewayPrivateKey": { "type": "string", "description": "Private key for on-chain writes (optional for dev)" },
      "escrowAddress": { "type": "string", "description": "Deployed escrow contract address" },
      "evidenceStorage": { "type": "string", "enum": ["helia", "storacha"], "description": "Evidence storage backend" },
      "litProtocolReal": { "type": "boolean", "description": "Use real Lit Protocol (vs mock)" }
    },
    "required": ["profile"]
  }
}
```

---

## 8. A2A Intent Definitions

Add to `packages/a2a/src/types.ts` in the intent type union:

```typescript
// Setup intents
| "setup_detect"           // Request: detect current config state
| "setup_detect_result"    // Response: detected config state
| "setup_configure"        // Request: configure a subsystem
| "setup_configure_result" // Response: configuration result
| "setup_validate"         // Request: validate full setup
| "setup_validate_result"  // Response: validation results

// Intent payload types
interface SetupDetectIntent { /* no params needed */ }

interface SetupDetectResultIntent {
  gateway: { running: boolean; url: string; version?: string };
  database: { initialized: boolean; kernels: number; devices: number; jobs: number };
  chain: { connected: boolean; network?: string; walletAddress?: string; balance?: string };
  adapters: Array<{ id: string; type: string; adapterType: string; healthy: boolean }>;
  storage: { type: string; connected: boolean };
  identity: { registered: boolean; agentId?: string; did?: string };
  overall: "ready" | "partial" | "unconfigured";
  missing: string[];  // human-readable list of what's not configured
}

interface SetupConfigureIntent {
  subsystem: "adapter" | "chain" | "storage" | "identity" | "full";
  config: Record<string, unknown>;
}

interface SetupConfigureResultIntent {
  subsystem: string;
  success: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

interface SetupValidateIntent {
  config?: string;  // JSON string, or omit to validate current
}

interface SetupValidateResultIntent {
  valid: boolean;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
  errors: string[];
  warnings: string[];
}
```

---

## 9. Environment Variable Reference

### Minimum for Local Dev (everything mocked)
```bash
NODE_ENV=development
PORT=3200
```

### Add Real Printer (OctoPrint)
```bash
KERNEL_CONFIG='{"kernelId":"my-shop","devices":[{"id":"printer-1","type":"machine","adapterType":"octoprint","config":{"url":"http://192.168.1.50:5000","apiKey":"YOUR_OCTOPRINT_API_KEY"}}]}'
```

### Add On-Chain Settlement
```bash
PCC_NETWORK=base-sepolia
PCC_GATEWAY_PRIVATE_KEY=0x...
ESCROW_CONTRACT_ADDRESS=0x...
```

### Add Evidence Storage (IPFS)
```bash
EVIDENCE_STORAGE=helia
# or for Storacha:
EVIDENCE_STORAGE=storacha
STORACHA_PROOF=<base64_ucan>
STORACHA_SPACE_DID=did:key:z6Mk...
```

### Add Lit Protocol Encryption
```bash
LIT_PROTOCOL_REAL=true
```

### Add Starknet ZK Anchoring
```bash
STARKNET_ACCOUNT_ADDRESS=0x...
STARKNET_PRIVATE_KEY=0x...
```

### Full Reference

See the complete env var audit (60+ variables across 12 categories) in the research data. The setup agent's `pcc_setup_detect` tool should check all of these and report which are set.

**Categories**: Chain/Network (3), Contracts/Escrow (9), ERC-4337 Batch Settlement (6), Payment Gate x402/MPP (8), PGTR Relay (2), Gateway/Server (12), Database (1), Kernel Runtime (3), Evidence Storage (3), Lit Protocol (1), Starknet (4), Dashboard Vite (8).

---

## 10. Existing Code Index

### Files You MUST Read Before Implementing

| Priority | File | Why |
|---|---|---|
| P0 | `packages/mcp-server/src/index.ts` | Pattern for adding MCP tools (21 existing tools to match) |
| P0 | `packages/gateway/src/routes/job-submit.ts` | Pattern for gateway route handlers (newest, cleanest) |
| P0 | `packages/gateway/src/services/kernel-service.ts` | Pattern for gateway services (singleton, init/get/reset) |
| P0 | `packages/kernel/src/kernel-config.ts` | The config system your setup tools will generate config for |
| P0 | `packages/kernel/src/adapter-factory.ts` | Adapter types and their config shapes |
| P1 | `packages/onboard-kit/src/validate.ts` | Existing validation logic to reuse/reference |
| P1 | `packages/onboard-kit/src/quick-start.ts` | How a kernel agent is bootstrapped |
| P1 | `packages/onboard-kit/AGENT_INSTRUCTIONS.md` | Existing agent onboarding guide (12 steps) |
| P1 | `packages/a2a/src/types.ts` | All 28 intent types + message format |
| P1 | `packages/agent-runtime/src/base-agent.ts` | BaseAgent class to extend for SetupAgent |
| P1 | `packages/agent-support/src/support-agent.ts` | Existing support agent pattern (diagnostic engine, knowledge base) |
| P2 | `packages/identity-8004/src/identity-registry.ts` | On-chain registration SDK |
| P2 | `packages/gateway/src/contracts/escrow-client.ts` | Chain interaction patterns |
| P2 | `packages/db/src/repositories/kernels.ts` | DB repository methods for devices |
| P2 | `packages/gateway/src/routes/onboard.ts` | Existing onboarding endpoints |
| P2 | `CLAUDE.md` | Project-level conventions and commands |

### Files You Should NOT Modify

| File | Reason |
|---|---|
| `packages/kernel/src/adapters/*.ts` | Adapter implementations are stable |
| `packages/spec/src/types/*.ts` | Only add new types if absolutely necessary (use spec barrel) |
| `packages/db/src/schema/*.ts` | Schema was just extended; don't change again |
| `packages/contracts/` | Solidity contracts are deployed; don't modify |

### Test Files to Reference for Patterns

| Test File | Pattern |
|---|---|
| `packages/gateway/src/__tests__/job-submit.test.ts` | Fastify inject testing, mock setup, beforeEach/afterEach |
| `packages/gateway/src/__tests__/settlement.test.ts` | vi.mock() for external services, DB seeding |
| `packages/kernel/src/__tests__/kernel-config.test.ts` | Env var mocking, config loading |
| `packages/kernel/src/__tests__/adapter-factory.test.ts` | Factory pattern testing |
| `packages/db/src/__tests__/device-registry.test.ts` | In-memory SQLite, repo method testing |

---

## 11. Testing Strategy

### Unit Tests Required

| Component | Test File | What to Test |
|---|---|---|
| Setup routes | `gateway/src/__tests__/setup.test.ts` | All 6 endpoints via Fastify inject |
| MCP tools | `mcp-server/src/__tests__/setup-tools.test.ts` | Tool registration, parameter validation, gateway call mocking |
| SetupAgent | `agent-support/src/__tests__/setup-agent.test.ts` | Intent handling, NLP routing, tool execution |
| A2A intents | Existing A2A test patterns | New intent type validation |

### Integration Test

Create `scripts/setup-e2e.ts`:
1. Start gateway with mock config
2. Call `pcc_setup_detect` → verify unconfigured state
3. Call `pcc_setup_generate_config` with mock printer
4. Call `pcc_setup_register_device`
5. Call `pcc_setup_health_check` → verify healthy
6. Call `pcc_setup_test_job` → verify job completes
7. Call `pcc_setup_status` → verify "ready"

### Test Commands

```bash
# Affected packages
pnpm --filter @pcc/gateway test
pnpm --filter @pcc/mcp-server test  # currently 0 tests, --passWithNoTests
pnpm --filter @pcc/agent-support test
pnpm --filter @pcc/a2a test

# Full suite
pnpm --workspace-concurrency=1 -r test

# Build check (sequential, 16GB RAM constraint)
pnpm build --concurrency=1
```

---

## 12. Conventions

### TypeScript
- Strict mode, no `any`
- `.js` extensions in all relative imports (NodeNext module resolution)
- `export async function routeName(app: FastifyInstance)` for route files
- Singleton pattern: `init/get/reset` exports for services
- Zod for runtime validation where possible

### Gateway Routes
- File per domain: `routes/setup.ts`
- Generic route params: `app.post<{ Body: {...}; Params: {...} }>(...)`
- Error handling: `try/catch`, return `{ error: "snake_case_code" }` for 4xx
- Import repos from `"../db.js"` via `getRepos()`

### MCP Tools
- One tool = one gateway endpoint call
- Clear descriptions for LLM function calling
- Structured return types (not raw text)
- `PCC_URL` env var for gateway base URL

### A2A Intents
- Add to the type union in `packages/a2a/src/types.ts`
- Follow existing naming: `verb_noun` for requests, `verb_noun_result` for responses
- All payloads must be JSON-serializable

### Testing
- vitest, in-memory SQLite for DB tests
- `vi.mock()` for external services (IPFS, chain, adapters)
- Fastify `.inject()` for route testing
- `--passWithNoTests` flag on all packages

### Git
- Feature branch: `feature/setup-agent`
- Commit messages: `Add setup agent: [component]`
- Don't modify unrelated files
- Run `pnpm build --concurrency=1` before committing (Windows OOM with parallel)

---

## Appendix: Quick Reference — All 130+ Gateway Endpoints

The gateway has endpoints across these route files:

| Route File | Prefix | Count | Domain |
|---|---|---|---|
| `capabilities.ts` | `/api/capabilities` | 7 | Capability discovery |
| `build.ts` | `/api/build` | 3 | Contract builder |
| `kernels.ts` | `/api/kernels` | 4 | Kernel management |
| `jobs.ts` + `job-submit.ts` | `/api/jobs`, `/api/devices` | 8 | Job lifecycle + device management |
| `escrow.ts` | `/api/escrow` | 15 | On-chain escrow |
| `settlement.ts` | `/api/settlement`, `/api/evidence` | 6 | Batch settlement + evidence |
| `evidence-encrypted.ts` | `/api/evidence` | 10 | Encrypted evidence + Lit Protocol |
| `zk-proofs.ts` | `/api/zk`, `/api/verification` | 11 | ZK proofs + Bittensor + Starknet |
| `sensors.ts` | `/api/sensors` | 5 | Sensor data |
| `auth/siwe-auth.ts` | `/api/auth` | 5 | SIWE authentication |
| `agents.ts` | `/api/agents` | 2 | Agent conversations |
| `agent-chat.ts` | `/api/agent` | 2 | Agent tool execution |
| `protocols.ts` | `/api/protocols`, `/api/protocol-runs` | 21 | Protocol templates + runs |
| `rewards.ts` | `/api/rewards`, `/api/certificates`, `/api/treasury` | 9 | DePIN rewards |
| `registry.ts` | `/api/registry` | 6 | ERC-8004 identity |
| `operator.ts` | `/api/operator` | 4 | Operator dashboard |
| `marketplace.ts` | `/api/marketplace` | 4 | Equipment marketplace |
| `logistics.ts` | `/api/logistics` | 12 | Shipping + bookings + installations |
| `spaces.ts` | `/api/spaces` | 3 | Space management |
| `batches.ts` | `/api/batches` | 4 | Batch tracking |
| `orchestrator.ts` | `/api/orchestrator` | 7 | Transfer graphs + workflows |
| `onboard.ts` | `/api/onboard` | 6 | Onboarding registration |
| `telemetry.ts` | `/api/telemetry` | 7 | Pipeline telemetry |
| `bounty.ts` | `/api/bounty` | 7 | Bounties + demand signals |
| `pool.ts` | `/api/pool` | 8 | Liquidity pools + staking |
| `tmp-tasks.ts` | `/api/tmp` | 8 | Task management protocol |
| `feedback.ts` | `/api/feedback` | 2 | Bug reports |
| `pgtr-relay.ts` | `/api/pgtr` | 2 | Payment-gated relay |
| `well-known.ts` | `/.well-known` | 2 | ERC-8004 agent registration |
| `setup.ts` (NEW) | `/api/setup` | 6 | **Setup agent endpoints** |
| SSE | `/sse/stream/*` | 4 | Real-time event streams |
