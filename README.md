# Physical Capability Cloud (PCC)

AWS for the physical world — a cloud control plane for physical manufacturing capabilities.

## Overview

PCC turns physical manufacturing equipment into composable, billable cloud services. Shop Kernels wrap real machines (CNC mills, 3D printers, laser cutters, chromatographs) and expose what they can *do* as schedulable capabilities with SLA-backed assurance tiers. Jobs settle through milestone escrow on Base with bonds, slashing, and dispute windows. Evidence is content-addressed, encrypted, and verifiable through ZK proofs. Universal machine onboarding, an AI-assisted contract builder, and an agent-to-agent protocol tie it all together.

## Quick Start

```bash
git clone git@github.com:global-mysterysnailrevolution/physical-capability-cloud.git
cd physical-capability-cloud
pnpm install
pnpm build
pnpm dev        # Dashboard at localhost:5173, Gateway at localhost:3200
```

Run the end-to-end simulations:

```bash
npx tsx scripts/e2e-simulation.ts           # Kernel-level e2e
npx tsx scripts/agent-e2e-simulation.ts     # Agent-to-agent e2e
npx tsx scripts/contract-builder-demo.ts    # Contract builder demo
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Dashboard (React 19 + Vite)                     │
│  37 routes, Solarpunk theme, live contract builder│
├──────────────────────────────────────────────────┤
│  Gateway (Fastify)           Agent Swarm (A2A)   │
│  REST + SSE + x402           User<>Broker<>Kernel │
├──────────────────────────────────────────────────┤
│  Core Services                                    │
│  Scheduler · Verifier · Payments · ContractBuilder│
├──────────────────────────────────────────────────┤
│  Shop Kernel                                      │
│  Device Adapters · Evidence · Sensors · Batches   │
├──────────────────────────────────────────────────┤
│  Smart Contracts (Solidity / Base Sepolia)        │
│  MilestoneEscrow · ERC-8004 Identity · USDC      │
└──────────────────────────────────────────────────┘
```

## Packages

### Core Layer

| Package | Description |
|---------|-------------|
| `@pcc/spec` | Canonical types, Zod schemas, content-addressed hashing, ID generation |
| `@pcc/kernel` | Shop Kernel runtime: device adapters, evidence emitter, sensor pipeline, batch tracker |
| `@pcc/contracts` | Solidity: MilestoneEscrow with bonds, slashing, and disputes; MockUSDC |
| `@pcc/scheduler` | Workflow compiler (DAG/topo-sort) and capability router (price/queue/reputation scoring) |
| `@pcc/verifier` | Verifier market (weighted random selection), evidence verification, Merkle commitments, ZK proofs |
| `@pcc/payments` | x402 server middleware (HTTP 402 responses) and client (auto-pay with EIP-3009) |
| `@pcc/contract-builder` | Schema-driven contract builder: templates, machine profiles, pricing engine, validator |

### Agent Layer

| Package | Description |
|---------|-------------|
| `@pcc/a2a` | Agent-to-agent protocol: 24+ typed intents, in-memory message bus, conversation tracking |
| `@pcc/agent-runtime` | Base agent framework: wallet management (viem), tool registry, intent handlers |
| `@pcc/agent-user` | User agent: discover, quote, negotiate, submit workflows, build contracts |
| `@pcc/agent-broker` | Broker agent: route capabilities, compile workflows, manage escrow, NLP routing |
| `@pcc/agent-kernel` | Kernel agent: wraps kernel runtime, accepts jobs, runs them, emits evidence |

### Frontend Layer

| Package | Description |
|---------|-------------|
| `@pcc/ui` | Solarpunk component library: 64+ components across primitives, layout, builder, kernel, agent |
| `@pcc/gateway` | Fastify HTTP/SSE bridge: REST routes, StreamHub topic-based SSE, session management |
| `@pcc/dashboard` | Vite SPA: 37 routes, React Flow workflow editor, contract builder, onboarding wizard, marketplace |

## Key Features

- Schema-driven contract builder with 4 templates (FDM, SLA, CNC, laser-cut) and live pricing
- 7-step AI-assisted machine onboarding wizard
- React Flow workflow DAG editor with topological compilation
- Milestone escrow with bonds, slashing, and challenge windows
- Universal sensor pipeline with RingBuffer, LTTB downsampling, and anomaly detection
- AES-256-GCM encrypted evidence with per-user key capsules
- ZK proof infrastructure (Merkle commitment trees) for dispute settlement
- Batch instrument tracking for autosamplers and chromatographs
- x402 micropayment protocol for per-request billing
- ERC-8004 identity, reputation, and validation registries
- Physical logistics: shipping, space booking, 10-step installation checklists
- Real device adapter scaffolds: OctoPrint, Modbus TCP, OPC-UA

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm build` | Build all 15 packages + 1 app (via Turbo) |
| `pnpm test` | Run all tests (131 passing across 11 test files) |
| `pnpm dev` | Start Vite dev server (port 5173) + gateway (port 3200) |
| `pnpm lint` | Lint all packages |
| `pnpm typecheck` | Type-check all packages |
| `pnpm clean` | Remove all build artifacts |
| `npx tsx scripts/e2e-simulation.ts` | Kernel-level end-to-end simulation |
| `npx tsx scripts/agent-e2e-simulation.ts` | Agent-to-agent end-to-end simulation |
| `npx tsx scripts/contract-builder-demo.ts` | Contract builder demo |

## Tech Stack

Node.js 20+, TypeScript (ES2022, strict), pnpm 9, Turborepo, Vite, React 19, React Router v7, TanStack Query v5, Zustand v5, Tailwind CSS v4, React Flow, Motion, Recharts, Fastify, viem, Zod, Foundry, vitest.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KERNEL_ID` | `kernel_dev_001` | Identifier for the local shop kernel |
| `PORT` | `3100` | Kernel server port |
| `PCC_RPC_URL` | `https://sepolia.base.org` | Base Sepolia JSON-RPC endpoint |
| `PCC_TREASURY_ADDRESS` | `0x0000...0001` | Treasury address for escrow settlement |
| `PCC_X402_ENABLED` | `false` | Enable x402 payment gating on gateway routes |
| `PCC_X402_FACILITATOR_URL` | `http://localhost:4020` | x402 facilitator service URL |

## Documentation

- [TUTORIAL.md](./TUTORIAL.md) -- Comprehensive getting-started guide
- [CLAUDE.md](./CLAUDE.md) -- Developer instructions and project conventions

## License

MIT -- see [LICENSE](./LICENSE).
