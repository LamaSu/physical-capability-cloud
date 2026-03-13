# Physical Capability Cloud (PCC)

AWS for the physical world -- a cloud control plane for physical manufacturing capabilities.

Targeting **Funding the Commons SF** (Mar 14-15, 2026) and **PL_Genesis** ($150K).

## Overview

PCC turns physical manufacturing equipment into composable, billable cloud services. Shop Kernels wrap real machines (CNC mills, 3D printers, laser cutters, chromatographs) and expose what they can *do* as schedulable capabilities with SLA-backed assurance tiers. Jobs settle through milestone escrow on Base with bonds, slashing, and dispute windows. Evidence is content-addressed, encrypted, and verifiable through ZK proofs. Sovereign infrastructure layers -- W3C DIDs, IPFS storage, Lit Protocol encryption, Solana wallets, Bittensor verification, and DePIN economics -- make the whole stack decentralized and self-sustaining.

## Quick Start

```bash
git clone git@github.com:global-mysterysnailrevolution/physical-capability-cloud.git
cd physical-capability-cloud
pnpm install
pnpm build --concurrency=1    # Sequential builds (avoids OOM on Windows)
pnpm dev                       # Dashboard at localhost:5173, Gateway at localhost:3200
```

Run tests and simulations:

```bash
pnpm --workspace-concurrency=1 -r test                # 623 tests across 37 test files
npx tsx scripts/e2e-simulation.ts                      # Kernel-level e2e
npx tsx scripts/agent-e2e-simulation.ts                # Agent-to-agent e2e
npx tsx scripts/sovereign-e2e-simulation.ts            # Sovereign infrastructure e2e (9 phases)
npx tsx scripts/contract-builder-demo.ts               # Contract builder demo
```

## Architecture

```
+--------------------------------------------------+
|  Dashboard (React 19 + Vite)                     |
|  44+ routes, Solarpunk theme, live builders      |
+--------------------------------------------------+
|  Gateway (Fastify)           Agent Swarm (A2A)   |
|  REST + SSE + x402           User<>Broker<>Kernel |
+--------------------------------------------------+
|  Core Services                                    |
|  Scheduler . Verifier . Payments . ContractBuilder|
+--------------------------------------------------+
|  Shop Kernel                 Orchestrator         |
|  Adapters . Evidence . Sensors . Protocols        |
+--------------------------------------------------+
|  Sovereign Infrastructure                         |
|  DIDs . IPFS . Lit . Solana . Bittensor . DePIN  |
+--------------------------------------------------+
|  Smart Contracts (Solidity / Base Sepolia)        |
|  MilestoneEscrow . ERC-8004 . MockUSDC . cNFTs   |
+--------------------------------------------------+
```

## Packages (17 packages + 1 app)

### Core Layer

| Package | Description |
|---------|-------------|
| `@pcc/spec` | Canonical types, Zod schemas, content-addressed hashing, W3C DIDs, Verifiable Credentials |
| `@pcc/kernel` | Shop Kernel runtime: device adapters, evidence emitter, sensor pipeline, batch tracker, IPFS storage (Helia), Lit encryption |
| `@pcc/contracts` | Solidity: MilestoneEscrow with bonds/slashing/disputes, MockUSDC. TS: soulbound capability cNFTs, DePIN reward engine |
| `@pcc/scheduler` | Workflow compiler (DAG/topo-sort) and capability router (price/queue/reputation scoring) |
| `@pcc/verifier` | Verifier market, evidence verification, Merkle commitments, ZK proofs, Bittensor subnet bridge |
| `@pcc/payments` | x402 server middleware (HTTP 402) and client (auto-pay with EIP-3009) |
| `@pcc/contract-builder` | Schema-driven contract builder: templates, machine profiles, pricing engine, validator |
| `@pcc/orchestrator` | TransferGraph, ResourcePool, SampleTracker, ProtocolEngine, ProtocolRunner |
| `@pcc/store` | Persistence layer |

### Agent Layer

| Package | Description |
|---------|-------------|
| `@pcc/a2a` | Agent-to-agent protocol: 27+ typed intents, message bus, conversation tracking |
| `@pcc/agent-runtime` | Base agent framework: viem wallets, Solana wallets, spending policies, intent handlers |
| `@pcc/agent-user` | User agent: discover, quote, negotiate, submit workflows, build contracts |
| `@pcc/agent-broker` | Broker agent: route capabilities, compile workflows, manage escrow, NLP, funding handler |
| `@pcc/agent-kernel` | Kernel agent: wraps kernel runtime, accepts jobs, runs them, emits evidence |

### Frontend Layer

| Package | Description |
|---------|-------------|
| `@pcc/ui` | Solarpunk component library: 64+ components including DIDBadge, IPFSLink, ChainTxLink |
| `@pcc/gateway` | Fastify HTTP/SSE bridge: 20+ route files, StreamHub, SIWE auth, x402 gate |
| `@pcc/dashboard` | Vite SPA: 44+ routes, React Flow builders, contract builder, onboarding wizard, protocol runner |

## Sovereign Infrastructure

Six layers of decentralized infrastructure, all tested end-to-end:

**W3C Decentralized Identity** -- `did:key` (Ed25519) and `did:pcc` method, plus Verifiable Credential issuance and verification. Agents, kernels, and machines all get DIDs.

**IPFS Evidence Storage** -- Helia-based content-addressed storage. Evidence bundles get real CIDs with round-trip store/retrieve verified. ESM-only module.

**Lit Protocol Encryption** -- AES-256-GCM encryption with access-controlled key capsules. Mock implementation for testing; real `@lit-protocol/lit-node-client` v6 integration against the datil-test network (enable with `LIT_PROTOCOL_REAL=true`).

**Solana Agent Wallets** -- `@solana/web3.js` v1 keypair wallets with SPL token transfers and budget-aware spending policies. Three funding intents (request-funding, approve-funding, transfer-funds).

**Bittensor Verification Subnet** -- MockMiner with quality tiers, MockValidator with Yuma Consensus scoring, BittensorSubnetBridge for routing verification tasks to the subnet and aggregating results.

**DePIN Economics** -- Soulbound capability certificates (cNFTs via mock Bubblegum), reward epoch scoring with weighted metrics (utilization, quality, uptime), FundingHandler with demand detection for automated capital allocation.

## Key Features

- Schema-driven contract builder with 4 templates (FDM, SLA, CNC, laser-cut) and live pricing
- 7-step AI-assisted machine onboarding wizard
- React Flow workflow and protocol DAG editors
- Milestone escrow with bonds, slashing, and challenge windows
- Universal sensor pipeline with RingBuffer, LTTB downsampling, anomaly detection
- Encrypted evidence with per-user key capsules (AES-256-GCM + Lit Protocol)
- ZK proof infrastructure (Merkle commitment trees) for dispute settlement
- Batch instrument tracking for autosamplers and chromatographs
- x402 micropayment protocol for per-request billing
- Physical logistics: shipping, space booking, 10-step installation checklists
- Protocol library with fork/run and live execution DAG views
- Equipment marketplace with ROI calculator

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm build --concurrency=1` | Build all 17 packages + 1 app (sequential, avoids OOM) |
| `pnpm --workspace-concurrency=1 -r test` | Run all 623 tests across 37 test files |
| `pnpm dev` | Start Vite dev server (port 5173) + gateway (port 3200) |
| `pnpm lint` | Lint all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm clean` | Remove all build artifacts |
| `npx tsx scripts/e2e-simulation.ts` | Kernel-level end-to-end simulation |
| `npx tsx scripts/agent-e2e-simulation.ts` | Agent-to-agent end-to-end simulation |
| `npx tsx scripts/sovereign-e2e-simulation.ts` | Sovereign infrastructure e2e (9 phases) |
| `npx tsx scripts/contract-builder-demo.ts` | Contract builder demo |
| `npx tsx scripts/generate-wallet.ts` | Generate a deployer wallet for Base Sepolia |
| `DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-base-sepolia.ts` | Deploy contracts to Base Sepolia |

## Tech Stack

Node.js 20+, TypeScript (ES2022, strict), pnpm 9, Turborepo, Vite, React 19, React Router v7, TanStack Query v5, Zustand v5, Tailwind CSS v4, React Flow, Motion, Recharts, Fastify, viem, Zod, Foundry, vitest, @solana/web3.js, Helia (IPFS), Lit Protocol.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KERNEL_ID` | `kernel_dev_001` | Identifier for the local shop kernel |
| `PORT` | `3100` | Kernel server port |
| `PCC_RPC_URL` | `https://sepolia.base.org` | Base Sepolia JSON-RPC endpoint |
| `PCC_TREASURY_ADDRESS` | `0x0000...0001` | Treasury address for escrow settlement |
| `PCC_X402_ENABLED` | `false` | Enable x402 payment gating on gateway routes |
| `PCC_X402_FACILITATOR_URL` | `http://localhost:4020` | x402 facilitator service URL |
| `LIT_PROTOCOL_REAL` | `false` | Use real Lit Protocol network (datil-test) instead of mock |
| `DEPLOYER_PRIVATE_KEY` | -- | Private key for contract deployment to Base Sepolia |

## Documentation

- [TUTORIAL.md](./TUTORIAL.md) -- Comprehensive getting-started guide
- [CLAUDE.md](./CLAUDE.md) -- Developer instructions and project conventions

## License

MIT -- see [LICENSE](./LICENSE).
