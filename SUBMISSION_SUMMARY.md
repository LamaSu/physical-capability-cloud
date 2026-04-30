# Physical Capability Cloud — PL Genesis Submission Summary

**Track**: Existing Code | **Submitted**: April 1, 2026

---

## What It Is

Physical Capability Cloud (PCC) is a coordination protocol for physical manufacturing — every physical capability, composable and verifiable through one protocol. A CNC router in Detroit and a sequencing lab in Boston form a trustless, multi-hop workflow without any prior relationship — because AI agents discover and negotiate, milestone escrow holds funds accountable, cryptographic evidence proves execution, and settlement is automatic.

---

## What Was Built

PCC is a pnpm monorepo of 25 packages and one application, with 3,000+ tests passing across 100+ test files, 218 agent tools, 421 API endpoints, 56 MCP tools, 34 A2A intents, and a live gateway deployed on Railway at capability.network.

**Core infrastructure**: `@pcc/spec` defines canonical types and Zod schemas. `@pcc/kernel` is the Shop Kernel runtime — connecting real devices (OctoPrint, Modbus, OPC-UA, SiLA, Opentrons OT-2) via typed adapters, evidence emitter, and sensor pipeline. `@pcc/scheduler` compiles multi-step workflows into dependency DAGs. `@pcc/contracts` contains MilestoneEscrow with slashable bonds deployed on Base Sepolia and Flow EVM.

**Agent-to-agent protocol**: UserAgent, BrokerAgent, KernelAgent, EvaluatorAgent, and SupportAgent communicate over a typed A2A message bus with 34 defined intents covering discovery, quoting, job lifecycle, payment, verification, and funding. Agents carry their own wallets (EVM via viem, Solana via @solana/web3.js) with configurable spending policies.

**Distributed infrastructure**: `@pcc/pcc-node` — pip-installable Python CLI for operators. `@pcc/dht` — WebSocket gossip DHT for decentralized capability discovery. Ed25519-signed capability announcements, NaCl-box encrypted P2P messages.

**Dashboard**: 57+ route Vite/React 19 SPA with contract building, live sensor streams, batch tracking, evidence explorer, escrow management, operator onboarding wizard, and setup agent.

---

## Sponsor Integrations (5/5 Live)

| Sponsor | Integration | Status |
|---------|------------|--------|
| **Storacha** | Evidence archived to IPFS via w3up, UCAN delegation, pcc-evidence space | LIVE — CIDs resolve on w3s.link |
| **Flow EVM** | MilestoneEscrow + PCCProtocol (2.35% oracle fee factory) deployed | LIVE — verified on FlowScan |
| **NEAR** | 1Click cross-chain solver via chaindefuser, intent-based settlement | LIVE — real solver responses |
| **Lit Protocol** | Evidence encryption via Chipotle v3 REST API, AES-256-GCM | LIVE — API key in production |
| **Starknet** | ProofRegistry Cairo contract, anchor_proof + get_proof entrypoints | LIVE — deployed on Sepolia, tested end-to-end |

All five integrations are independently verifiable by their respective sponsor judges.

---

## Technical Highlights

**Sovereign evidence pipeline**: Every completed job produces an encrypted, content-addressed evidence bundle. Encrypted via Lit Protocol → archived to IPFS via Storacha → ZK proof anchored on Starknet → quality-scored by Bittensor consensus. Real IPFS CIDs and real Starknet transaction hashes on every job completion.

**On-chain settlement**: MilestoneEscrow deployed on Base Sepolia and Flow EVM. PCCProtocol factory with oracle-based fee structure. Settlement service calls on-chain when write mode is enabled.

**Execution Scope Protocol**: 4-class security model (READ / SAFE CONTROL / SCOPED WRITE / PRIVILEGED) for remote equipment control. Brain/Executor split — LLM reasoning on cloud, tool execution on device, PCC as relay.

**207-tool agent package**: Available at capability.network/agent-package.json. Any LLM agent (Claude, GPT-4, etc.) can discover, price, and book physical capabilities.

**56 MCP tools**: stdio-based MCP server for Claude Code and Cursor integration.

---

## What Makes It Different

PCC is not a marketplace — it is a protocol. Marketplaces extract 35-65% (Uber 40%, Xometry 34.5%). PCC enables operators to keep the value they generate. Evidence is cryptographic, not reputation-based. Settlement is programmable, not manual. Access is permissionless — a student in Lagos can connect to a biolab in Singapore with no broker and no institutional affiliation.

Every physical supply chain becomes semi-digital. Open science becomes economically viable when IP is protected by math, not lawyers. $467B in counterfeit goods exist because supply chains are opaque — transparent evidence chains change that equation.

---

**Live**: [capability.network](https://capability.network)
**Repo**: [github.com/global-mysterysnailrevolution/physical-capability-cloud](https://github.com/global-mysterysnailrevolution/physical-capability-cloud)
**License**: Apache 2.0
