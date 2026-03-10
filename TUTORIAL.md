# Physical Capability Cloud (PCC) -- Tutorial

A complete getting-started guide. Go from zero to running dashboard in 5 minutes.

---

## 1. What is PCC?

PCC is **"AWS for the physical world"** -- a cloud control plane for physical manufacturing capabilities. Instead of provisioning virtual servers, you discover, configure, and pay for real-world fabrication processes (3D printing, CNC milling, laser cutting) through a unified protocol.

**Core abstractions:**

| AWS Concept | PCC Equivalent | What It Means |
|-------------|---------------|---------------|
| Availability Zone | **Shop Kernel** | A physical site with equipment -- could be a garage workshop or a factory floor |
| EC2 Instance Type | **Capability** | Not a machine, but what a machine can *do* (e.g., "FDM print in PLA up to 250x210mm") |
| SLA | **Assurance Tier** | Evidence depth + liability + dispute rules, from Tier 0 (hash-only) to Tier 3 (independent inspection + TEE) |
| Billing | **Milestone Escrow** | On-chain escrow that releases payment step-by-step as evidence meets contract requirements |
| Lambda | **x402 Micropayments** | HTTP 402 protocol for pay-per-request digital microservices (quoting, routing, simulation) |

**How it works:** A user describes what they need ("3D print this bracket in PLA and deliver it"). AI agents discover capable shops, negotiate pricing, compile a workflow, fund escrow, dispatch the job, collect cryptographic evidence during execution, and release payment only when evidence satisfies the contract's assurance tier. If anything goes wrong, disputes are resolved through bonded arbitration with slashing.

---

## 2. Prerequisites

| Requirement | Version | Install |
|-------------|---------|---------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org/) |
| **pnpm** | 9+ | `corepack enable && corepack prepare pnpm@9 --activate` |
| **Git** | any recent | [git-scm.com](https://git-scm.com/) |

Optional for smart contract development:
- **Foundry** (forge, anvil) -- [getfoundry.sh](https://getfoundry.sh/)

---

## 3. Quick Start

```bash
git clone https://github.com/global-mysterysnailrevolution/physical-capability-cloud.git
cd physical-capability-cloud
pnpm install
pnpm build
pnpm test       # 170 tests across 15 packages
pnpm dev        # Dashboard at http://localhost:5173, Gateway at http://localhost:3200
```

Open http://localhost:5173 in your browser. You will see the Ground Control dashboard with live KPIs, active jobs, kernel status, and recent activity.

The gateway serves the REST API and SSE streams at port 3200. The Vite dev server proxies `/api` and `/sse` routes to the gateway automatically.

---

## 4. Project Structure

PCC is a **pnpm + Turborepo monorepo** with 15 packages and 1 app:

```
physical-capability-cloud/
  packages/
    spec/               # Types, Zod schemas, canonical hashing, ID generation
    kernel/             # Shop Kernel runtime: device adapters, evidence, sensors
    contracts/          # Solidity: MilestoneEscrow, ERC-8004 registries, MockUSDC
    scheduler/          # WorkflowCompiler (DAG/topo-sort), CapabilityRouter
    verifier/           # VerifierMarket, EvidenceVerifier, CommitmentService, ZKProofService
    payments/           # x402 middleware (server-side 402) + x402 client (auto-pay)
    contract-builder/   # Schema-driven contract builder: templates, profiles, pricing
    a2a/                # Agent-to-Agent protocol: typed intents, MessageBus
    agent-runtime/      # BaseAgent: AgentWallet (viem), tool registry, intent handlers
    agent-user/         # UserAgent: discover, quote, negotiate, submit, track
    agent-broker/       # BrokerAgent: route, compile, manage escrow, NLP
    agent-kernel/       # KernelAgent: wraps kernel runtime, accepts jobs, emits evidence
    db/                 # Database layer
    ui/                 # 64+ component Solarpunk UI library
    gateway/            # Fastify HTTP/SSE bridge: 17 route files, session, auth
  apps/
    dashboard/          # Vite SPA: 30+ routes, React Flow, contract builder, onboarding
  scripts/
    e2e-simulation.ts           # Kernel-level end-to-end
    agent-e2e-simulation.ts     # Agent-to-agent end-to-end
    contract-builder-demo.ts    # Contract builder demo
```

### Package layers

**Core Layer** -- The protocol primitives:

| Package | What it does |
|---------|-------------|
| `@pcc/spec` | Single source of truth for ALL types and schemas. Every wire type lives here (Invariant #1). Zod schemas, canonical JSON hashing, ID generation with typed prefixes. |
| `@pcc/kernel` | Shop Kernel runtime. MockFDM / PowerMonitor / Camera / Chromatograph device adapters. EvidenceEmitter produces content-addressed bundles. JobRunner executes capability slots. SensorPipeline with RingBuffer, LTTB downsampling, and anomaly detection. BatchTracker for autosampler instruments. EncryptionService for AES-256-GCM evidence encryption. |
| `@pcc/contracts` | Solidity contracts compiled with Foundry. MilestoneEscrow (fund, bond, evidence, attest, challenge, release, dispute, slash). ERC-8004 surface: IdentityRegistry, ReputationRegistry, ValidationRegistry. MockUSDC for testing. |
| `@pcc/scheduler` | WorkflowCompiler takes a CWM (Capability Workflow Manifest) and produces an ExecutionPlan via DAG topological sort. CapabilityRouter scores kernels: 30% price + 30% queue depth + 30% reputation. |
| `@pcc/verifier` | VerifierMarket selects verifiers via weighted random. EvidenceVerifier checks hash integrity + tier requirements. CommitmentService builds Merkle trees for on-chain commitments. ZKProofService provides mock ZK proof infrastructure. |
| `@pcc/payments` | x402 middleware for Fastify (returns 402 with payment instructions). x402 client auto-pays with EIP-3009 transferWithAuthorization. |
| `@pcc/contract-builder` | Schema-driven contract configuration. Templates define process parameters (FDM, SLA, CNC, laser-cut). Profiles constrain templates to specific machines (Prusa MK4, Haas VF-2). PricingCalculator computes live pricing. ContractValidator enforces constraints. |

**Agent Layer** -- AI agents that negotiate on your behalf:

| Package | What it does |
|---------|-------------|
| `@pcc/a2a` | 24+ typed intents (discover, quote, negotiate, submit, track, etc.). In-memory MessageBus for pub/sub. Conversation tracking with thread IDs. |
| `@pcc/agent-runtime` | BaseAgent framework. AgentWallet wraps viem for Base Sepolia transactions. Tool registry for extensible agent capabilities. Intent handler dispatch. |
| `@pcc/agent-user` | UserAgent holds the customer wallet. Discovers capabilities, requests quotes, negotiates pricing, submits workflows, tracks job progress, explores build options. |
| `@pcc/agent-broker` | BrokerAgent orchestrates the marketplace. Routes capability requests to kernels, compiles CWM workflows, manages escrow funding, provides NLP routing for natural language queries, integrates contract builder. |
| `@pcc/agent-kernel` | KernelAgent wraps a Shop Kernel. Accepts jobs from the broker, executes them on mock devices, emits evidence bundles, reports completion. Exposes machine profiles for the contract builder. |

**Frontend Layer** -- The dashboard and API gateway:

| Package | What it does |
|---------|-------------|
| `@pcc/ui` | Solarpunk-themed component library. 64+ components across primitives (GlassPanel, GlowBadge, AmountDisplay), layout (AppShell, Sidebar, TopBar), builder (ParamGroup, ContractSummary, PriceBreakdownChart), kernel, evidence, escrow, agent, onboarding, and chart categories. |
| `@pcc/gateway` | Fastify server with 17 route files, x402 payment gate middleware, SIWE auth, session management, SSE streams (notifications + topic-based pub/sub), and an agent bridge that connects the REST API to live agent conversations. |
| `@pcc/dashboard` (app) | Vite + React 19 SPA. React Router v7 with 30+ lazy-loaded routes. TanStack Query v5 for data fetching. Zustand v5 for state (13 stores). React Flow for workflow DAG editing. Tailwind v4 for styling. Motion for animations. Recharts for data visualization. |

---

## 5. Dashboard Tour

The dashboard uses a sidebar navigation organized into 8 sections:

### Ground Control

**Dashboard** (`/`) -- The home screen. Four KPI cards show active jobs, kernels online, total value locked in escrow, and evidence events in the last 24 hours. Below that: a list of active jobs with progress arcs, a recent activity timeline, and kernel status indicators.

### Manufacturing

**Discover** (`/discover`) -- Browse and search all available capabilities across all kernels. Filter by type (FDM, SLA, CNC, laser-cut), material, tolerance, and assurance tier.

**Build Contract** (`/build`) -- The schema-driven contract configurator. Select a process type, then configure every parameter (material, infill, layer height, tolerances, etc.) with live pricing updating in real-time as you change values. Choose an assurance tier (0-3). Build the contract to get a full specification with pricing breakdown. See Section 7 for details.

**Workflows** (`/workflow`) -- React Flow-based DAG editor for multi-step manufacturing workflows. Drag and drop capability nodes, connect them with dependency edges, and compile the workflow into a CWM.

**Jobs** (`/jobs`, `/jobs/:jobId`) -- Track all active and completed jobs. Job detail pages show step-by-step progress, evidence timeline, escrow milestone status, and real-time updates via SSE.

### Onboarding

**Add Machine** (`/onboard`) -- Landing page with three pathways: register a new machine, join an existing kernel, or explore the marketplace. Links to the 7-step onboarding wizard.

**Onboarding Wizard** (`/onboard/wizard`) -- AI-assisted 7-step flow to register a new machine on the network:
1. **Machine Identity** -- Name, type, manufacturer, model, serial number
2. **Documentation** -- Upload manufacturer datasheets; AI extracts capabilities automatically
3. **Capabilities** -- Review and configure what your machine can do (materials, tolerances, envelope)
4. **Physical Space** -- Footprint, power requirements, environmental needs
5. **Pricing** -- Set rates and review projected ROI
6. **Operator** -- Profile, certifications, availability
7. **Review** -- Confirm everything and submit registration

An AI sidebar assistant provides contextual guidance at each step.

**Marketplace** (`/marketplace`) -- Equipment marketplace showing demand/supply charts by equipment class, with detail pages for each class and an ROI calculator (`/marketplace/roi`).

**Find Space** (`/spaces`) -- Search for physical hosting spaces for your equipment. Filter by location, power availability, square footage, and amenities. Match scoring ranks spaces by compatibility with your equipment.

**Operator** (`/operator`) -- Operator dashboard showing your registered machines, earnings, certifications, and upcoming maintenance. Drill into individual machines at `/operator/:machineId`.

### Logistics

**Logistics Hub** (`/logistics`) -- Unified logistics view covering equipment shipments (tracking, status, ETA), space bookings (active and upcoming), and installation scheduling. Drill into shipment details (`/logistics/shipments/:shipmentId`), booking management (`/logistics/bookings`), and installation checklists (`/logistics/installations/:installationId`).

### Monitoring

**Sensors** (`/sensors`) -- Live sensor dashboard with channel selector and real-time charts. View temperature, vibration, power draw, and other telemetry from kernel devices. Uses SSE for streaming updates. View kernel-specific sensors at `/sensors/:kernelId`.

**Batches** (`/batches`) -- Batch tracking for autosampler and multi-part instruments. Visual slot grid shows per-slot progress and status. Drill into batch details at `/batches/:batchId` for per-slot results.

**Evidence** (`/evidence`) -- Evidence explorer showing encrypted evidence bundles. Decrypt-on-demand with access grants. View ZK proof verification status. Detail view at `/evidence/:bundleId` shows full decrypted evidence with commitment verification.

**Process Logs** (`/logs`) -- Streaming log viewer with job-level filtering. Real-time process log output from kernel executions.

### Infrastructure

**Kernels** (`/kernels`) -- List of all registered shop kernels with online/offline status, capability counts, and queue depth. Kernel detail (`/kernels/:kernelId`) shows capabilities, connected devices, and job queue.

**Escrow** (`/escrow`) -- Escrow dashboard showing all milestone escrows. Track funded amounts, evidence submission status, challenge windows, bond amounts, and dispute resolution.

### Network

**Agent Log** (`/agents`) -- Real-time log of conversations between UserAgent, BrokerAgent, and KernelAgent. See typed intents flow between agents, conversation threads, and message payloads.

### System

**Settings** (`/settings`) -- Wallet address and network display, balance, preferences (default assurance tier, auto-fund escrow).

**Wallet Connect** -- The top bar contains a Connect Wallet button supporting MetaMask, Coinbase Wallet, and WalletConnect. After connecting, Sign-In With Ethereum (SIWE) authenticates your session with the gateway.

---

## 6. Setup Wizard

The setup wizard (state managed by `setup-wizard-store.ts`) guides first-time users through 5 steps:

| Step | Name | What You Configure |
|------|------|-------------------|
| 1 | **Welcome** | Gateway health check -- confirms the backend is reachable |
| 2 | **Network** | Choose network: localhost (Anvil), Base Sepolia (testnet), or Base (mainnet). Sets the RPC URL automatically. |
| 3 | **Wallet** | Connect your wallet (MetaMask, Coinbase, or WalletConnect) |
| 4 | **Identity** | Set your display name, organization, and role (operator, customer, or both) |
| 5 | **Complete** | Confirmation -- your setup is saved and you are dropped into the main dashboard |

Each step validates before allowing you to proceed (e.g., network requires an RPC URL, wallet must be connected, identity needs a display name).

---

## 7. Contract Builder

The **Build Contract** page (`/build`) is the primary interface for configuring a manufacturing job. It uses the `@pcc/contract-builder` package under the hood.

### How it works

1. **Select a process type** -- Choose from FDM, SLA, CNC 3-Axis, or Laser Cut. Each process type has a registered `CapabilityTemplate` that defines its configurable parameters.

2. **Configure parameters** -- The template resolves into parameter groups. For example, FDM shows:
   - Material (PLA, ABS, PETG, TPU, Nylon)
   - Layer Height (0.1mm to 0.3mm)
   - Infill Percentage (10% to 100%)
   - Support Material (none, same, soluble)
   - Print Volume (dimensions in mm)

   Each parameter has constraints (min/max, allowed values) and the UI enforces them.

3. **Machine Profile** (optional) -- If a specific machine is targeted (e.g., Prusa MK4, Haas VF-2), its `MachineProfile` further constrains the template. The Prusa MK4 profile limits materials to what the printer supports, caps infill ranges, and adjusts pricing.

4. **Live pricing** -- As you change any parameter, the `PricingCalculator` recalculates instantly. The right sidebar shows:
   - Total price with glow effect
   - Base price
   - Breakdown chart showing how each parameter affects cost (material surcharge, infill multiplier, etc.)

5. **Assurance Tier** -- Select Tier 0 through 3. Higher tiers require more evidence (and cost more) but provide stronger guarantees.

6. **Build** -- Click "Build Contract" to generate the full contract specification, including all parameters, pricing, tier requirements, and the machine profile reference.

### Built-in templates

| Template | Process | Parameters |
|----------|---------|-----------|
| `fdm` | Fused Deposition Modeling | material, layer height, infill, supports, volume |
| `sla` | Stereolithography | resin type, layer height, exposure, supports, volume |
| `cnc-3axis` | 3-Axis CNC Milling | material, tolerance, surface finish, tool paths |
| `laser-cut` | Laser Cutting | material, thickness, cut speed, power, sheet size |

### Built-in profiles

| Profile | Machine | Constrains |
|---------|---------|-----------|
| `prusa-mk4` | Prusa MK4 | FDM parameters for 250x210x210mm build volume |
| `haas-vf2` | Haas VF-2 | CNC parameters for 762x406x508mm work envelope |

### Adding templates and profiles programmatically

```typescript
import { registerTemplate, registerProfile } from "@pcc/contract-builder";

// Register a new process template
registerTemplate({
  id: "tmpl_my_process",
  type: "resin-casting",
  name: "Resin Casting",
  version: "1.0",
  parameters: [ /* ... */ ],
  pricing: { /* ... */ },
});

// Register a machine profile that constrains it
registerProfile({
  id: "prof_my_machine",
  type: "resin-casting",
  machineName: "Formlabs Form 3+",
  kernelId: "kernel_my_shop",
  constraints: { /* ... */ },
});
```

---

## 8. Adding a New Machine (Onboarding Wizard)

The onboarding wizard at `/onboard/wizard` walks you through registering a new machine on the PCC network:

### Step 1: Machine Identity
Enter your machine's name, manufacturer, model number, serial number, and capability type (FDM, CNC, SLA, laser-cut, or any custom string -- the type system is extensible via `BuiltinCapabilityType | (string & {})`).

### Step 2: Documentation
Upload manufacturer datasheets, spec sheets, and manuals as PDFs. The AI assistant analyzes them to automatically extract:
- Supported materials and tolerances
- Build envelope / work area dimensions
- Power and environmental requirements
- Suggested capabilities with confidence scores

### Step 3: Capabilities
Review the AI-suggested capabilities or manually define what your machine can do. Configure materials, tolerances, surface finishes, and the assurance tiers you can support.

### Step 4: Physical Space
Specify your machine's physical footprint, power requirements (voltage, amperage, phase), ventilation needs, and environmental constraints (temperature, humidity).

### Step 5: Pricing
Set your hourly rates, material markups, and minimum job values. The wizard shows projected ROI based on marketplace demand data for your capability type.

### Step 6: Operator
Create your operator profile with name, certifications, experience level, and availability schedule.

### Step 7: Review
Review all entered information. Submit to create:
- A machine registration on the network
- A capability listing discoverable by other users
- An operator identity (ties into ERC-8004 IdentityRegistry)

After submission, your machine's capabilities appear in the Discover page and are available for the contract builder.

---

## 9. Running E2E Simulations

Three simulation scripts exercise different layers of the stack:

### Kernel-Level E2E

```bash
npx tsx scripts/e2e-simulation.ts
```

Exercises the full lifecycle without blockchain or physical machines:
1. User submits a CWM (3D print + courier pickup)
2. Scheduler compiles CWM into an ExecutionPlan
3. Kernel receives job, executes mock FDM print (with simulated duration)
4. Evidence Emitter collects events (gcode loaded, execution started, power profile, camera snapshot, CV result, execution completed)
5. Events are bundled into a content-addressed EvidenceBundle
6. Verifier verifies the bundle and produces attestation
7. Simulated escrow receives evidence + attestation, opens challenge window, releases payment
8. Second run with a tampered bundle triggers the dispute path

### Agent-to-Agent E2E

```bash
npx tsx scripts/agent-e2e-simulation.ts
```

Demonstrates the full conversational lifecycle between AI agents:
1. UserAgent asks BrokerAgent: "What can do 3D printing in PLA?"
2. BrokerAgent discovers matching kernels, returns capabilities
3. UserAgent requests a quote for FDM printing
4. BrokerAgent quotes from the best kernel (price, timeline, options)
5. UserAgent negotiates for a lower price
6. BrokerAgent accepts counter-offer (within 20% margin)
7. UserAgent submits a full CWM workflow
8. BrokerAgent compiles workflow, returns escrow details
9. BrokerAgent dispatches job to KernelAgent
10. KernelAgent executes the job (mock FDM print)
11. KernelAgent produces evidence bundle
12. KernelAgent reports completion to BrokerAgent
13. BrokerAgent relays completion to UserAgent
14. UserAgent checks final status

This is what happens behind the scenes when a user says: "3D print this bracket in PLA and deliver it to me."

### Contract Builder Demo

```bash
npx tsx scripts/contract-builder-demo.ts
```

Demonstrates the contract builder's template resolution, parameter configuration, constraint validation, and pricing calculation.

---

## 10. Smart Contracts

All Solidity contracts live in `packages/contracts/src/` and are compiled with Foundry.

### MilestoneEscrow

The core settlement contract. Each workflow gets an escrow instance.

**Lifecycle:**
```
fund → lock → submitEvidence → submitAttestation → [challenge window] → release
                                                  → [dispute]        → arbitrate → slash/refund
```

**Milestone states:** Unfunded -> Funded -> Locked -> Evidenced -> Attested -> Released (or Disputed -> Slashed/Refunded)

**Key features:**
- Per-milestone funding (payer deposits per step)
- Operator bonds (skin in the game, slashed on proven fraud)
- Evidence bundle hash submission by kernel
- Verifier attestation hash submission
- Configurable challenge windows (1h to 72h depending on tier)
- Dispute resolution with challenger bonds
- Arbiter-based resolution

### ERC-8004 Registries

Three registries implementing the ERC-8004 identity standard:

| Contract | Purpose |
|----------|---------|
| `IdentityRegistry` | Machine and operator identity registration (DIDs) |
| `ReputationRegistry` | On-chain reputation scores based on job completion, evidence quality, dispute history |
| `ValidationRegistry` | Validator registration and attestation tracking |

### MockUSDC

ERC-20 test token for development and testing.

### Running Foundry Tests

```bash
cd packages/contracts
forge test
```

Requires Foundry installed (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).

---

## 11. Architecture Deep Dive

### Evidence Pipeline

```
Physical Machine
    |
Device Adapter (MockFDM / PowerMonitor / Camera / Chromatograph)
    |
    v
EvidenceEmitter.recordEvent()
    |  -- collects: gcode_loaded, execution_started, power_profile,
    |     camera_snapshot, cv_result, vibration_signature, layer_complete,
    |     temperature_reading, material_flow, ...
    v
EvidenceEmitter.finalizeBundle()
    |  -- canonical JSON serialization
    |  -- SHA-256 hash of bundle contents
    |  -- kernel signature
    v
EvidenceBundle { events[], bundleHash, signature, assuranceTier }
    |
    +----> EncryptionService.encrypt()  -- AES-256-GCM encryption
    |          |
    |          v
    |      EncryptedEvidenceBundle { ciphertext, iv, keyCapsules[] }
    |
    +----> CommitmentService.commit()   -- Merkle tree commitment
    |          |
    |          v
    |      CommitmentTree { root, leaves[], proofs[] }
    |          |
    |          +----> On-chain: store root hash only (Invariant #3)
    |
    +----> ZKProofService.prove()       -- Zero-knowledge proof
               |
               v
           ZKProof { proof, publicInputs, verificationKey }
```

### Agent Swarm

```
User ("print this bracket in PLA")
    |
    v
UserAgent
    |  discover_capabilities intent
    v
MessageBus (in-memory pub/sub)
    |
    v
BrokerAgent
    |  -- queries CapabilityRouter
    |  -- scores kernels (price 30% + queue 30% + reputation 30%)
    |  -- returns matches
    v
MessageBus
    |  quote_request / negotiate / submit_workflow intents
    v
BrokerAgent
    |  -- compiles CWM via WorkflowCompiler (DAG topo-sort)
    |  -- calculates pricing via PricingCalculator
    |  -- funds escrow
    |  dispatch_job intent
    v
MessageBus
    |
    v
KernelAgent
    |  -- wraps Shop Kernel runtime
    |  -- executes job via JobRunner
    |  -- collects evidence via EvidenceEmitter
    |  job_completed intent
    v
MessageBus
    |
    v
BrokerAgent --> UserAgent --> User ("your part is done, evidence verified")
```

### x402 Payment Flow

```
Client                          Gateway                         Blockchain
  |                                |                                |
  |  GET /api/quote?params=...     |                                |
  |------------------------------->|                                |
  |                                |                                |
  |  402 Payment Required          |                                |
  |  X-Payment: { amount, token,   |                                |
  |    recipient, network }        |                                |
  |<-------------------------------|                                |
  |                                |                                |
  |  X402Client.pay()              |                                |
  |  EIP-3009 transferWithAuth     |                                |
  |----------------------------------------------->|               |
  |                                |  transfer confirmed            |
  |  GET /api/quote + X-Receipt    |<-------------------------------|
  |------------------------------->|                                |
  |                                |  verify receipt on-chain       |
  |                                |------------------------------->|
  |                                |  confirmed                     |
  |  200 OK { quote data }        |<-------------------------------|
  |<-------------------------------|                                |
```

### Sensor Pipeline

```
Physical Sensor (temperature, vibration, power, flow, etc.)
    |
    v
SensorPipeline.ingest(reading)
    |
    +----> RingBuffer (fixed-size circular buffer per channel)
    |          |
    |          v
    |      LTTB Downsampling (Largest-Triangle-Three-Buckets)
    |          |  -- preserves visual shape while reducing points
    |          v
    |      Downsampled series for charting
    |
    +----> Anomaly Detection
    |          |  -- threshold-based alerts
    |          |  -- rate-of-change alerts
    |          v
    |      SensorAnomaly { channelId, severity, value, threshold }
    |
    +----> StreamHub (topic-based SSE)
               |
               v
           Dashboard (real-time charts via EventSource)
```

---

## 12. Deployment

### Docker

The repo includes a multi-stage Dockerfile for the gateway:

```bash
# Build the image
docker build -t pcc-gateway .

# Run the gateway
docker run -p 3200:3200 \
  -e PCC_NETWORK=base-sepolia \
  -e PCC_RPC_URL=https://sepolia.base.org \
  pcc-gateway
```

The Dockerfile uses `node:22-slim`, installs pnpm via corepack, builds all packages with turbo, and runs the gateway from `packages/gateway/dist/server.js`. The production image only includes built artifacts.

### CI/CD

GitHub Actions runs on every push and PR to `main`/`master`:

**Build & Test job** (matrix: Node 20 + 22):
1. Install dependencies (`pnpm install --frozen-lockfile`)
2. Build all packages (`pnpm build`)
3. Run all tests (`pnpm test`)
4. Typecheck (`pnpm typecheck`)

**Lint job** (Node 22):
1. Build (required for lint)
2. Lint (currently soft-fail with `continue-on-error`)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PCC_NETWORK` | `base-sepolia` | Target chain: `localhost`, `base-sepolia`, or `base` |
| `PCC_RPC_URL` | (per network) | JSON-RPC endpoint for the target chain |
| `PCC_X402_ENABLED` | `false` | Enable x402 payment gate on protected endpoints |
| `NODE_ENV` | `development` | Set to `production` for the Docker image |

### Development Tips

- The Vite dev server at port 5173 proxies `/api` and `/sse` to the gateway at port 3200 -- no CORS issues in development.
- `pnpm dev` starts both the Vite dev server and the gateway concurrently via Turborepo.
- All packages use TypeScript with ES2022 target and NodeNext module resolution (except the dashboard, which uses Vite's `bundler` resolution).
- Tests use vitest with `--passWithNoTests` so packages without tests don't fail the suite.
- The root `package.json` has an esbuild override to `^0.27.0` for compatibility.

---

## Quick Reference

```bash
pnpm install                                    # Install all dependencies
pnpm build                                      # Build all 15 packages + 1 app
pnpm test                                       # Run all tests (170 tests)
pnpm dev                                        # Dev server (dashboard:5173 + gateway:3200)
pnpm typecheck                                  # TypeScript type checking
pnpm clean                                      # Remove all dist/ directories

npx tsx scripts/e2e-simulation.ts               # Kernel-level E2E
npx tsx scripts/agent-e2e-simulation.ts         # Agent-to-agent E2E
npx tsx scripts/contract-builder-demo.ts        # Contract builder demo

cd packages/contracts && forge test             # Solidity tests (requires Foundry)
```
