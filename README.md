# PCCP — Physical Capability Cloud Protocol

![Tests](https://img.shields.io/badge/tests-1174%20passing-brightgreen) ![Packages](https://img.shields.io/badge/packages-18%20%2B%201%20app-blue) ![Routes](https://img.shields.io/badge/dashboard%20routes-45%2B-blueviolet) ![Track](https://img.shields.io/badge/PL%20Genesis-Existing%20Code-orange)

**AWS for the physical world.** Any physical capability — lab instruments, printers, couriers, robot arms — becomes a composable, verifiable, settleable service. AI agents discover, negotiate, and orchestrate. Evidence proves every step. Settlement is automatic. No middleman.

**Live**: [pcc-gateway-production.up.railway.app](https://pcc-gateway-production.up.railway.app)

---

## PL Genesis: Frontiers of Collaboration

Built for [PL Genesis Season 2](https://plgenesis.devspot.app) | **Existing Code Track**

PCC is a credibly neutral collaboration layer between physical systems. A CNC router in Detroit and a sequencing lab in Boston can form a trustless multi-hop workflow without knowing each other exists — because agents negotiate, escrow holds funds, evidence proves execution, and settlement is automatic. This is the infrastructure for cross-organizational physical collaboration.

### Sponsor Integrations

| Sponsor | Technology | PCC Integration | Package |
|---------|-----------|----------------|---------|
| **Filecoin / Storacha** | IPFS + Filecoin hot storage | Evidence bundles content-addressed to IPFS via Helia; Storacha w3up for durable archival | `@pcc/kernel` |
| **Lit Protocol** | Threshold encryption, PKPs, access conditions | Evidence encrypted with AES-256-GCM; access conditions gate decryption to authorized agents | `@pcc/kernel` |
| **Starknet** | ZK rollup, Cairo | ZK proof anchoring for evidence verification; Merkle commitments bridged to on-chain state | `@pcc/verifier` |
| **Bittensor** | Decentralized ML subnet | Evidence quality scored by MockMiner/MockValidator with Yuma Consensus; testnet-ready | `@pcc/verifier` |
| **Base / Coinbase** | EVM L2, x402 payments | MilestoneEscrow on Base Sepolia; x402 HTTP 402 micropayments for per-step services | `@pcc/contracts`, `@pcc/payments` |
| **Solana** | High-throughput L1 | Agent wallets via `@solana/web3.js`; soulbound cNFTs via Metaplex Core for capability proofs | `@pcc/agent-runtime`, `@pcc/contracts` |

### Track Alignment

| Track | How PCC Qualifies |
|-------|------------------|
| **AI & Robotics** | Agent-orchestrated physical manufacturing; A2A protocol with 27+ typed intents; UserAgent → BrokerAgent → KernelAgent negotiation pipeline |
| **Infrastructure & Digital Rights** | W3C DIDs (`did:key` + `did:pcc`), Verifiable Credentials, IPFS storage, Lit threshold encryption, verifiable evidence trail |
| **Crypto & Economies** | Milestone escrow with bonds/slashing, DePIN reward epochs, x402 micropayments, soulbound capability cNFTs, agent wallets on Base + Solana |
| **Most Improved Physical AI** | Sovereign infrastructure layer (DIDs, IPFS, Lit, Bittensor, DePIN) added as new capability during hackathon period |

---

## How It Works

PCC is the **collaboration layer between physical systems** — the coordination fabric that lets independent shops, labs, and robots form trustless workflows across organizational boundaries.

1. **Post a workflow** — "Analyze this compound's purity, print the report, deliver it back." One intent describes a multi-org, multi-step process.
2. **Agents bid** — Operators set maximum prices. AI BrokerAgents compile optimal capability paths. Competitive auction pricing drives efficiency.
3. **Escrow locks** — Funds lock in on-chain MilestoneEscrow before work starts. Each step carries a slashable bond — operators have skin in the game.
4. **Execute with evidence** — Every step produces cryptographic evidence: sensor readings, QC photos, chain of custody, calibration records. Evidence bundles are content-addressed to IPFS via Helia.
5. **Verify** — Bittensor subnet miners score evidence quality through decentralized consensus. ZK proofs anchor commitments on-chain. Lit Protocol gates access to raw evidence data.
6. **Settle** — Funds release automatically to each operator. Soulbound cNFTs attest competence. DePIN reward epochs grow the network of verified physical operators.

---

## Demo

```bash
# Fast version (2.5 seconds, full pipeline)
npx tsx scripts/hackathon-demo.ts

# Live version (pauses at each phase for dashboard click-through)
npx tsx scripts/demo-live.ts

# Agent-to-agent negotiation
npx tsx scripts/agent-e2e-simulation.ts

# Sovereign infrastructure (DIDs, IPFS, Lit, ZK, Bittensor, DePIN)
npx tsx scripts/sovereign-e2e-simulation.ts
```

---

## Architecture

```
+--------------------------------------------------+
|  Dashboard (React 19 + Vite + Tailwind v4)       |
|  44+ routes, Bioluminescent Solarpunk theme       |
+--------------------------------------------------+
|  Gateway (Fastify)           Agent Swarm (A2A)    |
|  REST + SSE + SIWE           User<>Broker<>Kernel |
+--------------------------------------------------+
|  Core Services                                    |
|  Scheduler . Verifier . Payments . ContractBuilder|
+--------------------------------------------------+
|  Shop Kernel                 Orchestrator         |
|  Adapters . Evidence . Sensors . Protocols        |
+--------------------------------------------------+
|  Sovereign Infrastructure                         |
|  DIDs . IPFS . Lit . Solana . Bittensor . DePIN   |
+--------------------------------------------------+
|  Settlement (Base Sepolia + Solana)               |
|  MilestoneEscrow . MockUSDC . cNFTs . x402       |
+--------------------------------------------------+
```

---

## Packages (17 + 1 app)

| Layer | Package | What It Does |
|-------|---------|-------------|
| **Core** | `@pcc/spec` | Types, Zod schemas, hashing, W3C DIDs, Verifiable Credentials |
| | `@pcc/kernel` | Shop Kernel: device adapters, evidence emitter, sensor pipeline, IPFS (Helia), Lit encryption |
| | `@pcc/contracts` | Solidity: MilestoneEscrow. TS: soulbound cNFTs, DePIN reward engine |
| | `@pcc/scheduler` | Workflow compiler (DAG), capability router (auction pricing) |
| | `@pcc/verifier` | Merkle commitments, ZK proofs, Bittensor subnet bridge |
| | `@pcc/payments` | x402 middleware + client |
| | `@pcc/contract-builder` | Schema-driven config: templates, profiles, pricing, validation |
| | `@pcc/orchestrator` | TransferGraph, ResourcePool, ProtocolEngine, ProtocolRunner |
| | `@pcc/store` | SQLite persistence (Drizzle ORM + better-sqlite3) |
| **Agents** | `@pcc/a2a` | 27+ typed intents, MessageBus, conversation tracking |
| | `@pcc/agent-runtime` | Base agent: viem wallets, Solana wallets, spending policies |
| | `@pcc/agent-user` | Discover, quote, negotiate, submit workflows |
| | `@pcc/agent-broker` | Route capabilities, compile workflows, manage escrow, NLP |
| | `@pcc/agent-kernel` | Wrap kernel, accept jobs, emit evidence |
| **Frontend** | `@pcc/ui` | 64+ Solarpunk components (GlassPanel, BorderBeam, AnimatedNumber, GlowBadge) |
| | `@pcc/gateway` | Fastify REST/SSE, SIWE auth, 20+ route files, StreamHub |
| | `@pcc/dashboard` | Vite SPA: 44+ routes, React Flow builders, 18-step tour |

---

## Capabilities

PCCP supports any physical capability. Built-in types include:

**Biotech/Neurotech**: `hplc` · `mass-spec` · `pcr` · `sequencing` · `cell-culture` · `microscopy` · `spectroscopy` · `flow-cytometry` · `electrophysiology` · `bioreactor` · `assay` · `sample-prep`

**Manufacturing**: `fdm` · `sla` · `sls` · `cnc-3axis` · `cnc-5axis` · `lathe` · `laser-cut` · `waterjet` · `injection-mold`

**Services**: `assembly` · `inspection` · `courier-pickup` · `courier-delivery` · `2d-print` · `imaging`

---

## Pricing Model

Operators set **maximum prices**. Agents bid competitively under the ceiling:
- `mode: "auction"` (default) — agents compete, discounting based on queue depth + reputation
- `mode: "fixed"` — take-it-or-leave-it pricing
- `minimum` — floor price, bids cannot go below

---

## Sovereign Infrastructure

| Layer | Technology | Status |
|-------|-----------|--------|
| **Identity** | W3C DIDs (`did:key` + `did:pcc`), Verifiable Credentials | Implemented + tested |
| **Storage** | IPFS via Helia, content-addressed CIDs; Storacha w3up archival | Implemented + tested |
| **Encryption** | Lit Protocol (AES-256-GCM + access conditions) | Mock + real (`LIT_PROTOCOL_REAL=true`) |
| **Agent Wallets** | Solana (`@solana/web3.js`), Base (viem) | Implemented + tested |
| **Verification** | Bittensor subnet (MockMiner, MockValidator, Yuma Consensus) | Mock, testnet-ready |
| **Settlement** | MilestoneEscrow (Solidity), x402 micropayments | Implemented, Base Sepolia |
| **DePIN** | Soulbound cNFTs, reward epochs, weighted scoring | Implemented + tested |
| **ZK Proofs** | Merkle commitments, inclusion proofs, tier compliance | Mock + Noir integration |

---

## Quick Start

```bash
pnpm install
pnpm build --concurrency=1
pnpm dev                        # Dashboard :5173, Gateway :3200
pnpm --workspace-concurrency=1 -r test   # 1174 tests
```

---

## Networks

| Network | Chain | Use |
|---------|-------|-----|
| Base Sepolia | EVM L2 | Escrow settlement, USDC, contract deploy |
| Solana Devnet | Solana | Agent wallets, DePIN rewards, soulbound cNFTs |
| Bittensor Testnet | Bittensor | Evidence verification subnet |
| IPFS (Helia) | IPFS | Content-addressed evidence storage |
| Lit Protocol (datil-test) | Lit | Threshold encryption for evidence |

---

## Built With

### Sponsor Technologies
- **[Filecoin / IPFS](https://filecoin.io)** — Evidence storage via Helia; Storacha w3up for Filecoin archival
- **[Lit Protocol](https://litprotocol.com)** — Threshold encryption + programmable access conditions for evidence data
- **[Starknet](https://starknet.io)** — ZK proof anchoring and verifiable computation for evidence integrity

### Core Stack
TypeScript · React 19 · Vite · Tailwind v4 · React Flow · Motion · Recharts · Fastify · viem · Zod · Solidity · Foundry · vitest · pnpm · Turborepo · @solana/web3.js · Helia · Lit Protocol · @number-flow/react · tw-animate-css · better-sqlite3 · Drizzle ORM

---

## License

MIT
