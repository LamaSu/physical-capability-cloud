# Physical Capability Cloud Protocol (PCCP)
## PL Genesis Season 2 — Existing Code Track

**Submission Date**: March 18, 2026
**Team**: [TEAM]
**Live Gateway**: [pcc-gateway-production.up.railway.app](https://pcc-gateway-production.up.railway.app)
**Tracks**: Existing Code · AI & Robotics · Infrastructure & Digital Rights · Crypto & Economies · Most Improved Physical AI

---

## The Problem

Physical manufacturing capabilities are siloed, unverifiable, and trust-dependent. A biotech startup needing HPLC analysis, followed by 3D printing, followed by cold-chain delivery must negotiate three separate contracts with three shops they may never have worked with — and take their word that the work was done correctly. There is no shared protocol. No verifiable evidence standard. No trustless settlement. Cross-organizational physical workflows are either impossible or require expensive intermediaries.

The result: manufacturing access is gatekept by relationships, geography, and institutional credibility. Small teams can't access the equipment they need. Shop operators sit idle when their machines could be serving a global pipeline.

## The Solution

PCCP is a **credibly neutral cloud control plane for physical manufacturing capabilities** — the AWS for the physical world. It turns any physical capability (a CNC router, a sequencer, a robot arm, a courier) into a composable, verifiable, settleable service that any agent can discover and use.

The core insight: treat capabilities, not machines, as the billable unit. A Shop Kernel wraps a physical site the way an Availability Zone wraps a data center. Capabilities are SLA-tiered services with defined evidence requirements. Agents negotiate, escrow locks funds, work executes, evidence proves it happened, and settlement is automatic.

No middleman. No trust required. The infrastructure does the coordination.

## Architecture

PCCP is a TypeScript pnpm monorepo with **17 packages + 1 dashboard app**, 623 passing tests across 37 test files, and 44+ dashboard routes.

The agent layer implements a full **A2A (Agent-to-Agent) protocol** with 27+ typed intents. A UserAgent discovers capabilities, negotiates pricing via auction, and submits a workflow. A BrokerAgent compiles the optimal multi-hop capability path and manages escrow. KernelAgents at each physical site execute jobs and emit cryptographic evidence bundles.

The dashboard is a Vite + React 19 SPA with React Flow builders for visual workflow composition, a live sensor feed, batch tracking, evidence explorer, and an 18-step onboarding tour for new operators.

## Sponsor Integration

**Filecoin / Storacha**: Every evidence bundle produced during job execution is content-addressed to IPFS via Helia (`@pcc/kernel`). The Storacha w3up client provides durable Filecoin archival. Evidence is never stored in a single operator's database — it lives permanently on the content-addressed web.

**Lit Protocol**: Raw evidence data (sensor readings, QC images, calibration records) is encrypted with AES-256-GCM. Lit Protocol access conditions gate decryption to authorized parties — the submitting agent, the verifier, or the escrow contract. `LIT_PROTOCOL_REAL=true` switches from the mock to the live Lit datil-test network.

**Starknet**: ZK proof anchoring in `@pcc/verifier` generates Merkle commitments over evidence bundles and bridges them to on-chain state for tamper-evident verification. Inclusion proofs let any party verify a specific evidence item without revealing the full bundle.

## Impact

PCCP democratizes access to physical manufacturing at global scale. A researcher in Lagos can submit a workflow to a sequencing lab in Singapore, a printing shop in Berlin, and a logistics provider in São Paulo — in a single intent, with trustless settlement, with cryptographic proof of every step.

For operators, it means idle capacity becomes discoverable revenue. For submitters, it means manufacturing access without gatekeeping. For the network, DePIN reward epochs and soulbound capability cNFTs build a permanent, reputation-backed registry of verified physical infrastructure.

## Existing Code + Hackathon Additions

PCCP is an existing codebase with substantial sovereign infrastructure added during the hackathon period: W3C DID identity layer, IPFS evidence storage via Helia, Lit Protocol encryption service, Solana agent wallets, Bittensor verification subnet, DePIN reward engine, soulbound capability certificates, and the `/subnet` and `/depin` dashboard pages. The 9-phase sovereign e2e simulation (`scripts/sovereign-e2e-simulation.ts`) demonstrates the full stack end-to-end.

---

*Built at the intersection of physical infrastructure and decentralized coordination — because the future of manufacturing should be as open as the internet.*
