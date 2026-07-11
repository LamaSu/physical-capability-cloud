/**
 * Context Pack Routes — the primary product endpoint.
 *
 * GET /agent-context-pack      — returns the full context pack as text/markdown
 * GET /agent-context-pack.json — returns the same content as structured JSON
 *
 * The context pack is what an AI agent ingests to become a PCC interface agent.
 * It contains everything: API endpoints, data types, workflow templates, and role definitions.
 */

import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Markdown template
// ---------------------------------------------------------------------------

function buildContextPack(baseUrl: string): string {
  return `# PCC Agent Context Pack
> Physical Capability Cloud -- AWS for the physical world

## What This Is
You are now a PCC interface agent. This context pack gives you everything you need to help your user interact with the Physical Capability Cloud -- a platform where physical manufacturing capabilities (3D printing, CNC machining, PCB fabrication, lab equipment, logistics, inspection, and more) are available as cloud services.

## Your Role
Based on what your user needs, you are either:
- **User Agent**: Help them discover capabilities, build contracts, fund escrow, track jobs, verify evidence
- **Operator Agent**: Help them onboard equipment, configure kernels, manage jobs, earn rewards
- **Verifier Agent**: Help them verify evidence bundles, stake reputation, earn verification rewards

## API Base URL
${baseUrl}

## Authentication
- **API Key**: Send \`X-PCC-API-Key: <key>\` header. Provision keys via \`POST /api/auth/provision\`.
- **SIWE (Sign-In With Ethereum)**: Wallet-based session auth via \`/auth/siwe/*\` endpoints.
- **x402**: Some endpoints accept HTTP 402 micropayments (Coinbase x402 protocol).

## Available API Endpoints

All endpoints are relative to the base URL above. Most return JSON.

### Discovery & Marketplace
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/capabilities | List all registered capability instances |
| GET | /api/capabilities/types | List capability type identifiers |
| GET | /api/capabilities/templates | List capability templates with full details |
| GET | /api/marketplace/classes | Browse marketplace capability classes |
| GET | /api/marketplace/classes/:id | Get marketplace class details |
| GET | /api/marketplace/demand-supply | Demand/supply analytics |
| POST | /api/marketplace/roi | Calculate ROI for a capability class |
| GET | /api/kernels | List Shop Kernels (physical sites), filter by ?status= |
| GET | /api/kernels/:kernelId | Get kernel details + capabilities + devices |
| GET | /api/kernels/:kernelId/devices | List devices at a kernel |
| GET | /api/kernels/:kernelId/jobs | List jobs at a kernel |
| POST | /api/kernels | Create a new kernel |

### Contract Builder
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/build/options | Get configuration options for a capability type. Body: \`{ type, selections?, profileId? }\` |
| POST | /api/build/price | Calculate price. Body: \`{ type, selections, profileId? }\` |
| POST | /api/build/contract | Build a complete contract ready for escrow. Body: \`{ type, selections, assuranceTier, profileId? }\` |

### Jobs
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/jobs | List jobs. Filter: ?kernelId=&status= |
| GET | /api/jobs/:jobId | Get job details + evidence bundles |
| PATCH | /api/jobs/:jobId/status | Update job status. Body: \`{ status, progress? }\` |
| GET | /api/jobs/:jobId/status | Get job execution status |
| POST | /api/jobs/submit | Submit a new job. Body: \`{ kernelId, capabilityType, parameters, ... }\` |

### Escrow & Settlement
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/escrow | List escrow contracts |
| GET | /api/escrow/:escrowId | Get escrow contract details |
| GET | /api/escrow/chain/:address/events | On-chain escrow events |
| GET | /api/escrow/chain/:address/state | On-chain escrow state |
| GET | /api/escrow/chain/token/:tokenAddress/balance/:account | ERC-20 token balance |
| GET | /api/escrow/chain/token/:tokenAddress/allowance/:owner/:spender | ERC-20 allowance |
| GET | /api/escrow/chain/:address/dispute/:milestoneIndex | Dispute details |
| GET | /api/escrow/chain/write-status | Chain write capability status |
| POST | /api/escrow/chain/:address/fund | Fund an escrow |
| POST | /api/escrow/chain/:address/approve | Approve token spending |
| POST | /api/escrow/chain/:address/release/:milestoneIndex | Release milestone |
| POST | /api/escrow/chain/:address/dispute/:milestoneIndex | File a dispute |
| POST | /api/escrow/chain/:address/deposit-bond/:milestoneIndex | Deposit a bond |
| POST | /api/escrow/chain/:address/evidence/:milestoneIndex | Submit evidence |
| POST | /api/escrow/chain/:address/attestation/:milestoneIndex | Submit attestation |
| GET | /api/settlement/status | Settlement pipeline status |
| GET | /api/settlement/epochs | Settlement epochs |
| GET | /api/settlement/:jobId | Job settlement details |
| POST | /api/settlement/flush | Flush pending settlements |

### Evidence & Verification
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/evidence/:jobId | Evidence bundles for a job |
| GET | /api/evidence/encrypted/:bundleId | Get encrypted evidence bundle |
| GET | /api/evidence/grants/:address | Evidence access grants for an address |
| GET | /api/evidence/:bundleId/ipfs | IPFS retrieval info for a bundle |
| GET | /api/evidence/:bundleId/lit-conditions | Lit Protocol access conditions |
| GET | /api/evidence/ipfs/:cid | Retrieve evidence from IPFS by CID |
| POST | /api/evidence/archive | Archive an evidence bundle |
| POST | /api/evidence/:bundleId/archive | Archive a specific bundle |
| POST | /api/zk/commit | Create a ZK commitment. Body: \`{ bundleHash }\` |
| POST | /api/zk/tree | Build a Merkle tree. Body: \`{ bundleHashes }\` |
| POST | /api/zk/verify | Verify a ZK proof. Body: \`{ proofId }\` |
| GET | /api/zk/commitments/:bundleId | Get ZK commitments for a bundle |
| GET | /api/verification/subnet-status | Verification subnet status |
| GET | /api/verification/miners | List verification miners |
| GET | /api/verification/assignments | Verification assignments |
| POST | /api/photo/upload | Upload a photo for verification (base64) |
| POST | /api/photo/compare | Compare two photos (pHash + SSIM) |
| GET | /api/photo/:cid | Get photo metadata by CID |

### Operator Management
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/operator/machines | List operator machines |
| GET | /api/operator/earnings | Operator earnings summary |
| GET | /api/operator/certifications | Operator certifications |
| GET | /api/operator/maintenance | Maintenance schedule |
| GET | /api/operator/approvals | Pending operator approvals |
| POST | /api/operator/emergency-stop | Emergency stop a machine |
| POST | /api/operator/emergency-resume | Resume after emergency stop |

### Operator Setup (START HERE for new operators)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/setup/detect | Auto-detect current configuration state |
| POST | /api/setup/generate-config | Generate KERNEL_CONFIG from device descriptions |
| POST | /api/setup/validate | Validate kernel configuration + adapter connectivity |
| POST | /api/setup/register-device | Register a physical device on the network |
| POST | /api/setup/test-job | Submit a test job to verify the full pipeline |
| GET | /api/setup/status | Comprehensive setup status across all categories |

### Onboarding
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/onboard/analyze | Analyze operator capability description |
| POST | /api/onboard/register | Register a new operator |
| GET | /api/onboard/registrations | List registrations |
| GET | /api/onboard/registrations/:id | Get registration details |
| POST | /api/onboard/redeem | Redeem an onboarding code |
| GET | /api/onboard/check/:code | Check onboarding code validity |
| GET | /api/onboard/status | Onboarding pipeline status |

### Device Discovery
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/discover/scan | Scan local network for devices (mDNS/IPP) |
| POST | /api/discover/generate-csd | Generate a CSD from a discovered device |
| POST | /api/discover/onboard | Full pipeline: discover, generate CSD, register device, register CSD |

### CSD (Capability StructureDefinitions)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/csd/resolve | Resolve a CSD by canonical URL |
| POST | /api/csd/validate | Validate a CSD document |
| GET | /api/csd/:url | Get CSD by canonical URI |
| DELETE | /api/csd/:url | Delete a CSD |

### Sensors & Telemetry
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/sensors/channels | List all sensor channels |
| GET | /api/sensors/channels/:kernelId | List sensor channels for a kernel |
| GET | /api/telemetry/active | Active telemetry streams |
| GET | /api/telemetry/stats | Telemetry statistics |
| GET | /api/telemetry/jobs | Job telemetry data |
| GET | /api/telemetry/logs/stream | Stream telemetry logs (SSE) |

### Batches
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/batches/:batchId | Get batch manifest |
| GET | /api/batches/by-job/:jobId | Get batch for a job |
| POST | /api/batches/shared | Create a shared batch |
| GET | /api/batches/shared/open | List open shared batches |
| GET | /api/batches/shared/:batchId | Get shared batch details |

### Protocols (Multi-Step Workflows)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/protocols/:id | Get protocol template |
| POST | /api/protocols | Create a new protocol template |
| PUT | /api/protocols/:id | Update a protocol template |
| POST | /api/protocols/:id/publish | Publish a protocol |
| POST | /api/protocols/:id/fork | Fork a protocol |
| GET | /api/protocols/:id/forks | List forks of a protocol |
| GET | /api/protocols/:id/runs | List runs of a protocol |
| POST | /api/protocols/:id/runs | Start a new protocol run |
| POST | /api/protocols/:id/validate | Validate a protocol |
| GET | /api/protocol-runs/:runId | Get protocol run details |
| POST | /api/protocol-runs/:runId/start | Start a protocol run |
| POST | /api/protocol-runs/:runId/pause | Pause a protocol run |
| POST | /api/protocol-runs/:runId/resume | Resume a protocol run |
| POST | /api/protocol-runs/:runId/cancel | Cancel a protocol run |

### DePIN Rewards & Certificates
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/rewards/claims | Claim DePIN rewards |
| POST | /api/certificates/mint | Mint a soulbound capability certificate |
| GET | /api/treasury/summary | Treasury balance and allocation |

### IP (Intellectual Property via Story Protocol)
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/ip/register-capability | Register a CSD as a Story Protocol IP Asset |
| POST | /api/ip/register-job-evidence | Register job evidence as IP |
| POST | /api/ip/distribute-royalties | Distribute royalties for an IP asset |
| POST | /api/ip/set-licensing-terms | Set licensing terms for an IP asset |
| POST | /api/ip/settle-royalties | Settle accumulated royalties |
| GET | /api/ip/:ipId/licensing-terms | Get licensing terms |
| GET | /api/ip/:ipId/derivative-tree | Get IP derivative tree |
| GET | /api/ip/:ipId/royalty-distribution | Get royalty distribution breakdown |
| POST | /api/ip/:ipId/pay | Pay royalties for usage |
| POST | /api/ip/:ipId/claim | Claim accumulated royalty revenue |
| GET | /api/ip/:ipId/revenue | Get IP revenue snapshot |
| GET | /api/ip/:ipId/lineage | Get IP provenance graph |
| GET | /api/ip/capability/:capabilityId | Get IP for a capability |
| POST | /api/ip/:ipId/dispute | File an IP dispute |

### SWF (Sovereign Wealth Fund)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/swf/summary | Fund balance, strategy, proposals |
| POST | /api/swf/participants | Register as SWF participant |
| POST | /api/swf/epochs | Trigger epoch processing |
| POST | /api/swf/claims | Claim SWF dividends |
| POST | /api/swf/proposals | Create governance proposal |
| GET | /api/swf/equity/portfolio | Equity portfolio overview |
| POST | /api/swf/equity/record-revenue | Record revenue for equity |
| POST | /api/swf/terms/propose | Propose new fund terms |

### Fiat On/Off Ramp
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/fiat-ramp/status | Ramp provider status |
| POST | /api/fiat-ramp/coinbase/onramp | Create Coinbase on-ramp session |
| GET | /api/fiat-ramp/coinbase/onramp-url | Get Coinbase on-ramp URL |
| GET | /api/fiat-ramp/yellowcard/rates | Live Yellowcard exchange rates (34 countries) |
| POST | /api/faucet/usdc | Request testnet USDC |
| GET | /api/faucet/usdc | Faucet status |

### Spaces (Equipment Hosting)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/spaces | List available hosting spaces |
| GET | /api/spaces/:id | Get space details |
| POST | /api/spaces/match | Match equipment to spaces |

### Logistics
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/logistics/providers | List logistics providers |
| GET | /api/logistics/providers/:id | Get provider details |
| GET | /api/logistics/shipments | List shipments |
| GET | /api/logistics/shipments/:id | Get shipment details |
| POST | /api/logistics/shipments/quote | Get shipping quote |
| GET | /api/logistics/bookings | List bookings |
| GET | /api/logistics/bookings/:id | Get booking details |
| GET | /api/logistics/installations | List installations |
| GET | /api/logistics/installations/:id | Get installation details |
| GET | /api/logistics/timeline | Logistics timeline |
| GET | /api/logistics/summary | Logistics summary dashboard |

### Orchestrator (Multi-Instrument Workflows)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/orchestrator/graphs | List transfer graphs |
| GET | /api/orchestrator/graphs/:kernelId | Get kernel transfer graph |
| GET | /api/orchestrator/samples/:sampleId | Get sample routing info |
| GET | /api/orchestrator/claims | List orchestrator claims |
| POST | /api/orchestrator/workflows | Create an orchestration workflow |
| GET | /api/orchestrator/workflows/:workflowId | Get workflow details |

### Agents & Negotiation
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agents/conversations | List agent conversations |
| GET | /api/agents/conversations/:convId | Get conversation details |
| GET | /api/agent/tools | List available agent tools |
| POST | /api/negotiate/session | Start a negotiation session |

### Bounties & Pools
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/bounty/demand | Create a demand bounty |
| POST | /api/bounty/claim | Claim a bounty |
| POST | /api/bounty/verify | Verify a bounty claim |
| POST | /api/pool/create | Create a capability pool |
| POST | /api/pool/stake | Stake into a pool |

### Anomaly Detection
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/anomaly/report | Report an anomaly |
| GET | /api/anomaly/unresolved | List unresolved anomalies |
| GET | /api/anomaly/stats | Anomaly statistics |
| POST | /api/anomaly/protocol-failure | Report a protocol failure |

### Registry (ERC-8004)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/registry/reputation/leaderboard | Reputation leaderboard |
| GET | /api/registry/summary | Registry summary (entities, capabilities) |

### Subnet
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/subnet/route | Route a capability request via subnet |
| POST | /api/subnet/quality | Score quality via subnet |
| POST | /api/subnet/similarity | Score similarity via subnet |
| GET | /api/subnet/metrics | Subnet metrics |

### Devices
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/devices/register | Register a device |
| GET | /api/devices/:kernelId | List devices for a kernel |
| POST | /api/devices/:deviceId/health | Run device health check |

### SDK & Developer Tools
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/sdk/integration-guide/:deviceType | Full integration guide |
| GET | /api/sdk/adapter-template/:adapterType | TypeScript adapter template |
| GET | /api/sdk/mcp-template/:deviceType | MCP server template |

### Gasless Transactions
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/gasless/status | Gasless relay status (ERC-4337) |

### Auth & API Keys
| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/provision | Provision an API key |
| GET | /api/auth/keys | List your API keys |
| DELETE | /api/auth/keys/:keyId | Revoke an API key |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check |
| GET | /api/status/live | Live service status |
| GET | /api/feedback | List feedback reports |
| POST | /api/feedback | Submit bug report / feedback |
| GET | /api/traces | List distributed traces |
| GET | /api/traces/:traceId | Get trace details |
| GET | /api/traces/stream | Stream traces (SSE) |

### SSE (Server-Sent Events) Streams
| Method | Path | Description |
|--------|------|-------------|
| GET | /sse/stream/job/:jobId | Real-time job updates |
| GET | /sse/stream/kernel/:kernelId | Real-time kernel updates |
| GET | /sse/stream/device/:deviceId | Real-time device updates |
| GET | /sse/stream/batch/:batchId | Real-time batch updates |
| GET | /sse/notifications | Global notification stream |

### Well-Known (Standards Compliance)
| Method | Path | Description |
|--------|------|-------------|
| GET | /.well-known/agent-registration.json | ERC-8004 Agent Registration File |
| GET | /.well-known/agent-card.json | Agent Card (Google A2A format) |

## Data Types

Key types you will work with:

\`\`\`
Capability -- what a machine can DO
  id: "cap_..."
  type: "fdm_printing" | "cnc_milling" | "pcb_fabrication" | ...
  kernelId: string
  status: "available" | "busy" | "offline"

Kernel -- a physical site (Shop Kernel = Availability Zone)
  id: "kernel_..."
  name: string
  status: "online" | "offline" | "maintenance"
  capabilities: string[]
  location: { lat, lng, address }

Job -- a unit of work
  id: "job_..."
  kernelId: string
  capabilityType: string
  status: "queued" | "running" | "completed" | "failed"
  progress: 0-100
  parameters: object

EvidenceBundle -- proof that work was done
  id: "bun_..."
  jobId: string
  bundleHash: "sha256:..."
  events: EvidenceEvent[]
  assuranceTier: 0 | 1 | 2 | 3
  ipfsCid?: string

EscrowContract -- payment locked until evidence verified
  id: "esc_..."
  contractAddress: "0x..."
  status: "created" | "funded" | "milestone_met" | "settled" | "disputed"
  totalAmount: string (USDC, 6 decimals)
  milestones: Milestone[]

AssuranceTier -- evidence depth + liability
  0: Self-attested (operator claims completion)
  1: Sensor-verified (automated sensor data confirms work)
  2: Third-party verified (independent verifier confirms)
  3: Cryptographic proof (ZK proofs + on-chain anchoring)
\`\`\`

## Workflow Templates

### For Users: "I want something manufactured"
1. \`GET /api/capabilities\` -- find what is available
2. \`POST /api/build/options\` -- configure your order (body: \`{ type: "fdm_printing" }\`)
3. \`POST /api/build/price\` -- get a quote (body: \`{ type, selections }\`)
4. \`POST /api/build/contract\` -- create the contract (body: \`{ type, selections, assuranceTier }\`)
5. Fund the escrow: \`POST /api/escrow/chain/:address/fund\`
6. Track progress: \`GET /api/jobs/:jobId\` or SSE: \`GET /sse/stream/job/:jobId\`
7. Evidence is collected automatically by the kernel
8. Settlement happens when evidence meets tier requirements

### For Operators: "I want to offer my equipment"
1. \`GET /api/setup/detect\` -- check what is already configured
2. Describe your equipment in natural language
3. \`POST /api/setup/generate-config\` -- get a kernel config from your description
4. \`POST /api/setup/validate\` -- validate connectivity and adapter compatibility
5. \`POST /api/setup/register-device\` -- register your device on the network
6. \`POST /api/setup/test-job\` -- run a test job to verify the full pipeline
7. Jobs arrive automatically based on your listed capabilities

### For Verifiers: "I want to earn by verifying work"
1. \`GET /api/verification/assignments\` -- see available verification tasks
2. \`GET /api/evidence/encrypted/:bundleId\` -- review evidence
3. \`POST /api/photo/compare\` -- compare before/after photos
4. \`POST /api/zk/verify\` -- verify ZK proofs
5. Earn reputation: \`GET /api/registry/reputation/leaderboard\`

### Full IP Registration Flow
1. \`POST /api/csd/validate\` -- validate your CSD
2. \`POST /api/ip/register-capability\` -- register as Story Protocol IP
3. \`POST /api/ip/set-licensing-terms\` -- set licensing terms
4. \`GET /api/ip/:ipId/revenue\` -- check revenue snapshot
5. \`POST /api/ip/:ipId/claim\` -- claim royalties

### Fiat Funding Flow
1. \`GET /api/fiat-ramp/status\` -- check provider availability
2. \`POST /api/fiat-ramp/coinbase/onramp\` -- create on-ramp session (US/EU card/ACH)
3. Or: \`GET /api/fiat-ramp/yellowcard/rates\` -- check rates for emerging markets
4. Track: \`GET /api/faucet/usdc\` -- testnet faucet for development

## Building UI for Your User
When your user needs to SEE something (charts, tables, status dashboards), you should:
1. Fetch the data from the API endpoints above
2. Present it in whatever format your environment supports (markdown tables, HTML, React components, artifacts, etc.)
3. For real-time updates, connect to SSE streams listed above
4. The web dashboard at \`${baseUrl}/app\` is a limited fallback -- you can build a better interface
5. **Generate a real dashboard when the task needs a surface** (a live job to watch, a step to approve, a recurring order): emit a declarative manifest conforming to \`${baseUrl}/ui-kit/v1/manifest.schema.json\`, save it with the \`save_dashboard\` tool, and share the live page at \`${baseUrl}/a/<slug>\`. The shipped \`pcc-ui\` kit (\`${baseUrl}/ui-kit/v1/pcc-ui.js\`) renders any manifest identically everywhere -- you compose the manifest, the kit renders it. Recall an existing one with \`search_dashboards\` before generating; never bake an API key into a manifest.
6. **Discover options, then ask, before committing** any order: \`POST /api/build/options\` to get the real choices, present them to the user, confirm the price -- then commit. A fiddly config (many toppings, several print params) is a good candidate for a generated \`form\` window.

## Links
- Dashboard (limited web fallback): ${baseUrl}/app
- API Health: ${baseUrl}/api/health
- Service Status: ${baseUrl}/api/status/live
- Agent Registration (ERC-8004): ${baseUrl}/.well-known/agent-registration.json
- Agent Card (Google A2A): ${baseUrl}/.well-known/agent-card.json
- Full Agent Package (56 MCP tools): ${baseUrl}/agent-package.json
- Documentation: ${baseUrl}/docs
- Source: https://capability.network

## Deployed Contracts (Base Sepolia)
- MockUSDC: 0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb
- MilestoneEscrow: 0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454
- Chain: Base Sepolia (chainId: 84532)
`;
}

// ---------------------------------------------------------------------------
// Structured JSON version
// ---------------------------------------------------------------------------

interface EndpointDef {
  method: string;
  path: string;
  description: string;
}

interface EndpointGroup {
  name: string;
  endpoints: EndpointDef[];
}

function buildStructuredPack(baseUrl: string): {
  name: string;
  version: string;
  baseUrl: string;
  description: string;
  roles: string[];
  endpointGroups: EndpointGroup[];
  dataTypes: Record<string, Record<string, string>>;
  sseStreams: EndpointDef[];
  contracts: Record<string, string>;
  links: Record<string, string>;
} {
  return {
    name: "PCC Agent Context Pack",
    version: "1.0.0",
    baseUrl,
    description:
      "Physical Capability Cloud -- AWS for the physical world. A platform where physical manufacturing capabilities are available as cloud services.",
    roles: ["user", "operator", "verifier"],
    endpointGroups: [
      {
        name: "Discovery & Marketplace",
        endpoints: [
          { method: "GET", path: "/api/capabilities", description: "List all registered capabilities" },
          { method: "GET", path: "/api/capabilities/types", description: "List capability type identifiers" },
          { method: "GET", path: "/api/capabilities/templates", description: "List capability templates" },
          { method: "GET", path: "/api/marketplace/classes", description: "Browse marketplace classes" },
          { method: "GET", path: "/api/marketplace/classes/:id", description: "Get marketplace class details" },
          { method: "GET", path: "/api/marketplace/demand-supply", description: "Demand/supply analytics" },
          { method: "POST", path: "/api/marketplace/roi", description: "Calculate ROI" },
          { method: "GET", path: "/api/kernels", description: "List Shop Kernels" },
          { method: "GET", path: "/api/kernels/:kernelId", description: "Get kernel details" },
          { method: "POST", path: "/api/kernels", description: "Create a new kernel" },
        ],
      },
      {
        name: "Contract Builder",
        endpoints: [
          { method: "POST", path: "/api/build/options", description: "Get config options for a capability" },
          { method: "POST", path: "/api/build/price", description: "Calculate price" },
          { method: "POST", path: "/api/build/contract", description: "Build complete contract" },
        ],
      },
      {
        name: "Jobs",
        endpoints: [
          { method: "GET", path: "/api/jobs", description: "List jobs" },
          { method: "GET", path: "/api/jobs/:jobId", description: "Get job details + evidence" },
          { method: "POST", path: "/api/jobs/submit", description: "Submit a new job" },
          { method: "PATCH", path: "/api/jobs/:jobId/status", description: "Update job status" },
        ],
      },
      {
        name: "Escrow & Settlement",
        endpoints: [
          { method: "GET", path: "/api/escrow", description: "List escrow contracts" },
          { method: "GET", path: "/api/escrow/:escrowId", description: "Get escrow details" },
          { method: "POST", path: "/api/escrow/chain/:address/fund", description: "Fund an escrow" },
          { method: "POST", path: "/api/escrow/chain/:address/release/:milestoneIndex", description: "Release milestone" },
          { method: "GET", path: "/api/settlement/status", description: "Settlement pipeline status" },
          { method: "GET", path: "/api/settlement/epochs", description: "Settlement epochs" },
        ],
      },
      {
        name: "Evidence & Verification",
        endpoints: [
          { method: "GET", path: "/api/evidence/:jobId", description: "Evidence bundles for a job" },
          { method: "GET", path: "/api/evidence/encrypted/:bundleId", description: "Encrypted evidence" },
          { method: "POST", path: "/api/zk/commit", description: "Create ZK commitment" },
          { method: "POST", path: "/api/zk/verify", description: "Verify a ZK proof" },
          { method: "POST", path: "/api/photo/upload", description: "Upload photo for verification" },
          { method: "POST", path: "/api/photo/compare", description: "Compare two photos" },
        ],
      },
      {
        name: "Operator Setup",
        endpoints: [
          { method: "GET", path: "/api/setup/detect", description: "Auto-detect configuration state" },
          { method: "POST", path: "/api/setup/generate-config", description: "Generate kernel config" },
          { method: "POST", path: "/api/setup/validate", description: "Validate configuration" },
          { method: "POST", path: "/api/setup/register-device", description: "Register a device" },
          { method: "POST", path: "/api/setup/test-job", description: "Run a test job" },
          { method: "GET", path: "/api/setup/status", description: "Setup status" },
        ],
      },
      {
        name: "IP & Royalties",
        endpoints: [
          { method: "POST", path: "/api/ip/register-capability", description: "Register IP asset" },
          { method: "POST", path: "/api/ip/distribute-royalties", description: "Distribute royalties" },
          { method: "POST", path: "/api/ip/:ipId/claim", description: "Claim royalty revenue" },
          { method: "GET", path: "/api/ip/:ipId/revenue", description: "Revenue snapshot" },
          { method: "GET", path: "/api/ip/:ipId/lineage", description: "IP provenance graph" },
        ],
      },
      {
        name: "SWF Governance",
        endpoints: [
          { method: "GET", path: "/api/swf/summary", description: "Fund summary" },
          { method: "POST", path: "/api/swf/proposals", description: "Create governance proposal" },
          { method: "POST", path: "/api/swf/claims", description: "Claim dividends" },
        ],
      },
      {
        name: "Fiat Ramp",
        endpoints: [
          { method: "GET", path: "/api/fiat-ramp/status", description: "Provider status" },
          { method: "POST", path: "/api/fiat-ramp/coinbase/onramp", description: "Create on-ramp session" },
          { method: "GET", path: "/api/fiat-ramp/yellowcard/rates", description: "Exchange rates" },
        ],
      },
    ],
    dataTypes: {
      Capability: { id: "cap_...", type: "string", kernelId: "string", status: "available|busy|offline" },
      Kernel: { id: "kernel_...", name: "string", status: "online|offline|maintenance", capabilities: "string[]" },
      Job: { id: "job_...", status: "queued|running|completed|failed", kernelId: "string", progress: "0-100" },
      EvidenceBundle: { id: "bun_...", jobId: "string", bundleHash: "sha256:...", assuranceTier: "0-3" },
      EscrowContract: { id: "esc_...", status: "funded|milestone_met|settled|disputed", contractAddress: "0x..." },
    },
    sseStreams: [
      { method: "GET", path: "/sse/stream/job/:jobId", description: "Real-time job updates" },
      { method: "GET", path: "/sse/stream/kernel/:kernelId", description: "Real-time kernel updates" },
      { method: "GET", path: "/sse/stream/device/:deviceId", description: "Real-time device updates" },
      { method: "GET", path: "/sse/stream/batch/:batchId", description: "Real-time batch updates" },
      { method: "GET", path: "/sse/notifications", description: "Global notifications" },
    ],
    contracts: {
      chain: "Base Sepolia (84532)",
      MockUSDC: "0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb",
      MilestoneEscrow: "0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454",
    },
    links: {
      dashboard: `${baseUrl}/app`,
      health: `${baseUrl}/api/health`,
      agentRegistration: `${baseUrl}/.well-known/agent-registration.json`,
      agentCard: `${baseUrl}/.well-known/agent-card.json`,
      agentPackage: `${baseUrl}/agent-package.json`,
      docs: `${baseUrl}/docs`,
      source: "https://capability.network",
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function contextPackRoutes(app: FastifyInstance) {
  // Determine base URL from request or environment
  function getBaseUrl(req: { protocol: string; hostname: string; headers: Record<string, string | string[] | undefined> }): string {
    // Prefer environment variable if set
    if (process.env.PCC_PUBLIC_URL) return process.env.PCC_PUBLIC_URL.replace(/\/$/, "");

    // Use x-forwarded-host / x-forwarded-proto (Railway, Cloudflare, etc.)
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
    const host = (req.headers["x-forwarded-host"] as string) || req.hostname;
    return `${proto}://${host}`;
  }

  // GET /agent-context-pack — markdown
  app.get("/agent-context-pack", async (req, reply) => {
    const baseUrl = getBaseUrl(req);
    const markdown = buildContextPack(baseUrl);
    return reply
      .type("text/markdown; charset=utf-8")
      .header("Cache-Control", "public, max-age=300")
      .header("Access-Control-Allow-Origin", "*")
      .send(markdown);
  });

  // GET /agent-context-pack.json — structured JSON
  app.get("/agent-context-pack.json", async (req, reply) => {
    const baseUrl = getBaseUrl(req);
    const data = buildStructuredPack(baseUrl);
    return reply
      .header("Cache-Control", "public, max-age=300")
      .header("Access-Control-Allow-Origin", "*")
      .send(data);
  });
}
