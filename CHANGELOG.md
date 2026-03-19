# Changelog

All notable changes to **Physical Capability Cloud (PCC)** are documented here.

PCC is an open cloud control plane for physical manufacturing capabilities — "AWS for the physical world." Shop Kernels are Availability Zones. Capabilities are the billable unit (not machines — what machines *can do*). Settlement flows through milestone escrow on-chain. Verification is sovereign: IPFS-pinned evidence, Lit Protocol encrypted bundles, Bittensor-validated quality, W3C DIDs, and ZK Merkle proofs.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

## [0.2.0] — 2026-02-10 to 2026-03-31 (PL Genesis Hackathon Period)

> 68 commits · 17 packages + 3 apps · 623 tests passing across 37 test files

This release represents the core sovereign infrastructure sprint built during the Protocol Labs Genesis hackathon period. The primary focus was replacing centralized infrastructure dependencies with open, verifiable alternatives aligned with Filecoin, IPFS, Lit Protocol, Bittensor, and the DePIN ecosystem.

### Wave 1A — IPFS Evidence Storage (Filecoin / Storacha alignment)

**Added**

- `EvidenceStorageService` backed by Helia — content-addressed evidence bundles pinned to IPFS on every job finalization
- `ipfsCid` and `ipfsMetadataCid` fields on `EncryptedEvidenceBundle` — permanent, verifiable pointers to job outputs
- `GET /api/evidence/:bundleId/ipfs` gateway endpoint — fetch evidence directly by IPFS CID
- `IPFS archival` wired into `EvidenceEmitter.finalizeBundle()` — every completed job produces an immutable IPFS record
- `IPFSLink` and `ChainTxLink` UI components in `@pcc/ui` — clickable links from evidence bundles to IPFS gateways and block explorers

### Wave 1B — W3C Decentralized Identities + Verifiable Credentials

**Added**

- `packages/spec/src/identity/` module — `did:key` (Ed25519) and `did:pcc` DID methods from scratch
- Ed25519 key generation with base58btc multibase encoding (W3C DID spec compliant)
- `CapabilityCredential` issuance with Ed25519 signatures — machines issue verifiable credentials for capabilities they offer
- Full round-trip identity pipeline: create DID → issue VC → verify signature (31 tests passing)
- `DIDBadge` UI component in `@pcc/ui` — renders a DID with copy, format, and chain badges
- New spec types: `depin.ts`, `identity/types.ts`, `identity/did.ts`, `identity/credentials.ts`

### Wave 2A — Lit Protocol Encryption

**Added**

- `LitEncryptionService` in `@pcc/kernel` — AES-256-GCM encryption with realistic Lit Protocol access condition types
- Access conditions tied to capability ownership — only the job requester and kernel can decrypt evidence bundles
- `EncryptionService` interface with both Lit (sovereign) and fallback implementations
- 28 encryption/decryption tests passing across the kernel package
- `/evidence` and `/evidence/:bundleId` dashboard routes — encrypted bundle explorer with decrypt-on-demand

### Wave 2B — Solana Agent Wallets

**Added**

- `SolanaAgentWallet` in `@pcc/agent-runtime` — `@solana/web3.js` v1 + SPL transfers, message signing, devnet airdrop
- `SpendingTracker` with rolling window budget enforcement — agents cannot exceed per-window spend limits
- Agent spending policy factories: `userAgentPolicy`, `brokerAgentPolicy`, `kernelAgentPolicy` presets
- 3 new A2A intents: `RequestFunding`, `DelegateBudget`, `ClaimRewards`
- Multi-chain wallet types: `"base-sepolia" | "base" | "solana-devnet" | "solana"`; `"SOL"` currency
- `UnifiedKeychain` — one BIP-39 mnemonic derives all chain wallets (EVM + Solana) + DID identity

### Wave 3 — Bittensor Verification Subnet

**Added**

- `BittensorSubnetBridge` in `@pcc/verifier` — routes evidence verification requests to the Bittensor network
- `MockMiner` with quality tiers (gold/silver/bronze/unverified) and realistic scoring distributions
- `MockValidator` implementing Yuma Consensus for subnet weight aggregation
- Bittensor subnet spec document for hackathon submission (`ebd3e46`)
- `/subnet` dashboard route — live subnet health, miner leaderboard, and consensus status
- 22 Bittensor-related tests passing

### Wave 4 — DePIN Economics + Soulbound Capability NFTs

**Added**

- `CapabilityCertificateService` in `@pcc/contracts` — soulbound cNFTs (non-transferable) issued per verified capability
- `RewardEngine` — DePIN epoch tracking with weighted scoring across uptime, quality, and throughput dimensions
- `FundingHandler` in `@pcc/agent-broker` — demand detection → Alkahest escrow bridge for milestone settlement
- Capability certificates migrated from Bubblegum to **Metaplex Core** (`mpl-core`) for Solana
- Reward epochs: configurable window, participant weighting, claimable on-chain rewards
- 41 DePIN/certificate tests passing
- `/depin` dashboard route — treasury overview, certificate registry, reward epoch status, claim history

### Wave 5 — Dashboard Integration + End-to-End Sovereign Simulation

**Added**

- 9-phase sovereign e2e simulation (`scripts/sovereign-e2e-simulation.ts`): DID creation → VC issuance → IPFS pinning → Lit encryption → Bittensor verification → ZK proof → milestone escrow → DePIN reward → full teardown
- `2354d75` — "Wire real sovereign infrastructure": all sovereign services activated end-to-end in a single simulation run
- Bioluminescent Solarpunk design system: teal/cyan palette, `BorderBeam`, `AnimatedNumber`, `GlowBadge`, `tw-animate-css`
- 18 biotech capability types + 3 San Francisco lab kernels as reference Shop Kernels
- Hackathon demo: multi-hop workflow with agent auction across multiple kernels

### Sovereign Infrastructure — Cross-Cutting

**Added**

- `@pcc/onboard-kit` (new package) — SDK for teams to onboard any device onto the PCC network autonomously
  - 800+ line `AGENT_INSTRUCTIONS.md` (12 steps, 4 appendices, full type reference) readable by AI agents
  - Generic adapters: HTTP REST, sensor, camera (with mock mode for testing without hardware)
  - Scaffolder: JSON config → complete kernel project (adapters, capabilities, agent, tests) in one command
  - Validator: checks 44 capability types, pricing models, assurance tiers, adapter references (10 tests)
  - CLI: `pcc-onboard scaffold` / `pcc-onboard validate` commands
  - `/onboard/kit` dashboard page with integration steps, protocol templates, capability browser

- `@pcc/mcp-server` (new package) — PCC as an MCP server; plug directly into Claude Code or Cursor
  - 14 tools: `pcc_list_capabilities`, `pcc_search_capabilities`, `pcc_build_contract`, `pcc_calculate_price`, `pcc_list_evidence`, `pcc_subnet_status`, `pcc_depin_stats`, and 7 more
  - Agents can discover, price, and book physical capabilities without leaving their IDE

- `@pcc/orchestrator` (new package) — intra-kernel instrument choreography
  - `TransferGraph`, `ResourcePool`, `SampleTracker`, `ProtocolEngine`, `AutomationTracker`, `ProtocolRunner`
  - `/orchestrator` and `/orchestrator/:kernelId` dashboard routes

- `@pcc/contracts` — Solidity: `MilestoneEscrow`, `MockUSDC`; Foundry test suite; TypeScript ABI exports
- `@pcc/payments` — x402 payment protocol middleware + client wired end-to-end through gateway
- Noir ZK circuits: `evidence_inclusion` (Pedersen Merkle proof) and `tier_compliance`
- `NoirProofService` — real ZK proof generation with transparent mock fallback
- `CommitmentService` in `@pcc/verifier` — Merkle commitment trees for evidence bundle inclusion proofs
- `ZKProofService` in `@pcc/verifier` — ZK proof generation and verification pipeline

- **Protocol system** — shareable, forkable multi-instrument workflows with progressive robot automation
  - `/protocols`, `/protocols/new`, `/protocols/:templateId`, `/protocols/:templateId/edit` routes
  - `/protocol-runs`, `/protocol-runs/:runId` — live DAG execution view with status-colored nodes

- **Persistence layer** — `@pcc/db` (SQLite + Drizzle ORM): 17 tables, 8 repositories, seed data
- **SIWE authentication** — Sign-In with Ethereum nonce/verify/session flow in gateway + dashboard
- **ERC-8004 registries** — identity, reputation, and validation registries as Solidity contracts

- **Full agent skills manifest** — 65+ REST endpoints + 13 A2A intents documented for agent consumption
- **BYOA model** — agents connect to PCC directly with no proxy; agent-package.json published alongside gateway
- **Agent-first chat dashboard** with Meteora DLMM capability pricing integration

### Infrastructure / DevOps

**Added**

- Railway deployment: Dockerfile (single-stage to preserve pnpm symlinks), `railway.toml`, startup error handling, healthcheck
- GitHub Actions CI/CD: build, test, Foundry tests, dashboard bundle size reporting
- `isMain` guard in kernel `server.ts` — prevents auto-start on import (fixes test isolation on Linux + Windows)
- Docker: cache-bust headers, `@fastify/static` version pin for Fastify 4 compatibility
- SSE mock data producers for live sensor, batch, and log streaming in development

**Fixed**

- DB schema mismatch and seed idempotency on Railway redeploy
- `isMain` detection on Linux — switched to `fileURLToPath` comparison
- SPA fallback: gateway reads `index.html` directly instead of `sendFile` (fixes 404 on deep routes)
- Static file serving for `agent-package.json`, `docs/`, `tools.json`

---

## [0.1.0] — 2026-02-10 to 2026-03-09 (Foundation)

> 14 commits · Initial MVP through first complete multi-package build

### Added

- `@pcc/spec` — canonical types, Zod schemas, ID generation, hashing
- `@pcc/kernel` — Shop Kernel runtime: device adapters (OctoPrint, Modbus TCP, OPC-UA), `EvidenceEmitter`, `JobRunner`, `SensorPipeline`, `BatchTracker`
- `@pcc/scheduler` — `WorkflowCompiler` (DAG topological sort), `CapabilityRouter`
- `@pcc/verifier` — `VerifierMarket`, `EvidenceVerifier`, `ZKProofService`
- `@pcc/agent-runtime` — `BaseAgent`, `AgentWallet` (viem/EVM), `SpendingPolicy`
- `@pcc/agent-user` — `UserAgent`: discover, negotiate, submit, build contracts
- `@pcc/agent-broker` — `BrokerAgent`: routing, escrow management, NLP intent parsing
- `@pcc/agent-kernel` — `KernelAgent`: wraps kernel runtime, manages jobs and evidence
- `@pcc/a2a` — 27+ typed intents, `MessageBus`, `Conversations`
- `@pcc/contract-builder` — schema-driven contract builder: templates, profiles, resolver, pricing, validator
- `@pcc/gateway` — Fastify REST/SSE: 20+ route files, `StreamHub`, SIWE auth, x402 payment gate
- `@pcc/ui` — Solarpunk component library: 64+ files, design tokens, all dashboard primitives
- `apps/dashboard` — Vite SPA: 44+ routes, React Flow DAG editors, 18-step onboarding tour
- Agent-to-agent interaction layer with `MessageBus` pub/sub
- Dashboard: Contract Builder, Workflow Builder, Sensor Dashboard, Batch Tracking, Evidence Explorer, Logistics Hub, Operator Dashboard, Space Finder, Equipment Marketplace, Escrow Dashboard
- Onboarding: 7-step Machine Onboarding Wizard with AI sidebar, Setup Wizard, Tutorial
- `@pcc/payments` x402 protocol wired end-to-end

---

## Architecture Overview

```
Shop Kernels = Availability Zones (physical sites with equipment)
Capabilities = Billable units (what machines CAN DO, not the machines themselves)
Assurance Tiers = SLAs (0-3, escalating evidence / bonds / challenge windows)
Settlement = Milestone escrow on-chain (MilestoneEscrow.sol)
Microservice payments = x402 protocol
Evidence = IPFS-pinned, Lit-encrypted, Bittensor-verified, ZK-proven
Identity = W3C DIDs (did:key + did:pcc), Verifiable Credentials
DePIN = Soulbound cNFTs per capability + epoch reward engine
```

**Stack:** pnpm monorepo · TypeScript (ES2022/NodeNext/strict) · Turbo · Vitest · Viem · Zod · Fastify · Solidity (Foundry) · React 19 · React Router v7 · TanStack Query v5 · Zustand v5 · Tailwind v4 · React Flow · Recharts

---

[Unreleased]: https://github.com/global-mysterysnailrevolution/physical-capability-cloud/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/global-mysterysnailrevolution/physical-capability-cloud/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/global-mysterysnailrevolution/physical-capability-cloud/commits/v0.1.0
