# Physical Capability Cloud (PCC)

## What This Is
AWS for the physical world. A cloud control plane for physical manufacturing capabilities.
- Shop Kernels = Availability Zones (physical sites with equipment)
- Capabilities = billable units (not machines — what machines can DO)
- Assurance Tiers = SLAs (evidence depth + liability + dispute rules)
- Settlement = milestone escrow on-chain; x402 for digital microservices

## Architecture

### Core Packages
- **packages/spec**: Single source of truth for ALL types, schemas, validation (Zod)
- **packages/kernel**: Shop Kernel runtime — device adapters, evidence emitter, Capability API
- **packages/contracts**: Solidity contracts — MilestoneEscrow with bonds/slashing
- **packages/scheduler**: Workflow compiler + capability router
- **packages/verifier**: Hybrid verifier market + evidence verification
- **packages/payments**: x402 middleware (server) + x402 client (auto-pay)

### Agent Layer (A2A)
- **packages/a2a**: Agent-to-Agent protocol — typed intents, message bus, conversations
- **packages/agent-runtime**: Base agent framework — wallet (viem), tools, intent handlers
- **packages/agent-user**: User Agent — holds wallet, discovers, negotiates, submits workflows
- **packages/agent-broker**: Broker Agent — routes capabilities, quotes, compiles workflows
- **packages/agent-kernel**: Kernel Agent — wraps shop kernel, accepts jobs, emits evidence

## Invariants
1. All schemas live in `packages/spec` — no other package defines wire types
2. Every Evidence Bundle is content-addressed (SHA-256 of canonical JSON)
3. On-chain state only stores hashes/commitments, never raw data
4. Shop Kernel is the only external interface to a physical site
5. Every capability has an assurance tier; every tier has defined evidence requirements
6. Escrow only settles when evidence meets the contract's tier requirements

## Protocols
- **ERC-8004**: Identity Registry + Reputation Registry + Validation Registry for machines/agents
- **x402**: HTTP 402 Payment Required protocol (Coinbase) for per-request micropayments

## Dev Commands
- `pnpm install` — install all deps
- `pnpm test` — run all tests (36 tests across spec + scheduler)
- `pnpm build` — build all 10 packages
- `npx tsx scripts/e2e-simulation.ts` — run kernel-level e2e simulation
- `npx tsx scripts/agent-e2e-simulation.ts` — run agent-to-agent e2e simulation
