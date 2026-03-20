# Physical Capability Cloud — PL Genesis Submission Summary

**Track**: Existing Code | **Deadline**: April 1, 2026

---

## What It Is

Physical Capability Cloud (PCC) is a credibly neutral coordination layer for physical manufacturing — "AWS for the physical world." The core insight: cloud infrastructure abstracts compute into billable units (CPU/RAM/storage), not physical servers. PCC does the same for the physical world. A CNC router in Detroit and a sequencing lab in Boston can form a trustless, multi-hop workflow without any prior relationship — because AI agents discover and negotiate, milestone escrow holds funds accountable, cryptographic evidence proves execution, and settlement is automatic. No broker, no platform rent, no single point of trust.

---

## What Was Built

PCC is a pnpm monorepo of 22 packages and one application, with 1,174 tests passing across 69 test files and a live gateway deployed on Railway.

**Core infrastructure**: `@pcc/spec` defines canonical types and Zod schemas for the entire system. `@pcc/kernel` is the Shop Kernel runtime — the edge agent that connects real devices (OctoPrint 3D printers, Modbus industrial controllers, OPC-UA PLCs, SiLA lab instruments) to the network via typed adapters, an evidence emitter, and a sensor pipeline. `@pcc/scheduler` compiles multi-step workflows into dependency DAGs and routes them through a competitive capability auction. `@pcc/contracts` contains the `MilestoneEscrow` Solidity contract with slashable bonds deployed on Base Sepolia.

**Agent-to-agent protocol**: Three cooperating agents — `UserAgent`, `BrokerAgent`, `KernelAgent` — communicate over a typed A2A message bus with 27+ defined intents covering discovery, quoting, job lifecycle, payment, verification, and funding. Agents carry their own wallets (EVM via viem, Solana via `@solana/web3.js`) with configurable spending policies and rolling-window budget enforcement.

**Dashboard**: A 45-route Vite/React 19 SPA covering contract building (React Flow DAG editor), live sensor streams, batch tracking, evidence explorer, escrow management, operator dashboards, a space/equipment marketplace, protocol library, and a Bioluminescent Solarpunk design system built from 64+ custom components.

---

## Technical Highlights

**Sovereign infrastructure stack**: Evidence is never stored in a centralized database. Every completed job produces an encrypted, content-addressed evidence bundle: AES-256-GCM encrypted via Lit Protocol (access conditions tied to job parties), pinned to IPFS via Helia with durable archival through Storacha w3up (`EVIDENCE_STORAGE=storacha`), quality-scored by a Bittensor verification subnet using Yuma Consensus, and integrity-anchored with ZK Merkle proofs bridged to Starknet via `StarknetProofAnchoringService`. A 9-phase sovereign e2e simulation (`scripts/sovereign-e2e-simulation.ts`) exercises every layer end-to-end.

**Identity and DePIN economics**: Every device and agent has a W3C DID (`did:key` Ed25519 or `did:pcc`). Completing verified work earns soulbound capability cNFTs (Metaplex Core on Solana) — non-transferable attestations of demonstrated competence. A `RewardEngine` runs DePIN epochs with weighted scoring across uptime, quality, and throughput, distributing on-chain rewards to operators who prove consistent execution.

**MCP server**: `@pcc/mcp-server` exposes 21 tools — `pcc_list_capabilities`, `pcc_build_contract`, `pcc_subnet_status`, `pcc_depin_stats`, and more — so any Claude Code or Cursor agent can discover, price, and book physical capabilities without leaving their IDE.

---

## The Setup Agent

Onboarding a physical device to PCC requires configuring adapters, wallet keys, evidence storage, and identity registration — historically 40+ environment variables across 6 categories. The `@pcc/onboard-kit` package and a new `SetupAgent` eliminate this.

An operator tells their AI agent: "I have an Ender 3 printer at 192.168.1.50." The agent calls `pcc_setup_detect` to read current config state, `pcc_setup_generate_config` to produce the `KERNEL_CONFIG` JSON, `pcc_setup_register_device` to create the DB record and run a health check, then `pcc_setup_test_job` to submit a test print and verify the full evidence pipeline. Three manual steps: tell it the device, confirm the config, fund the wallet if settlement is needed. The agent scaffolders (`pcc-onboard scaffold`) can generate a complete TypeScript kernel project from a single JSON config file. A 12-step `AGENT_INSTRUCTIONS.md` is machine-readable, designed to be handed directly to any LLM agent without human translation.

---

## What Makes It Different

PCC is not a marketplace — it is a control plane. Marketplaces list machines. PCC abstracts capabilities: not "CNC router" but "5-axis milling, ±0.01mm, aluminum, tier-2 assurance." Operators define what their equipment can do; the network matches demand to capability profiles with auction pricing under operator-set ceilings. Every claim is backed by cryptographic evidence, not reputation scores.

Settlement is not payment processing — it is programmable escrow with skin in the game. Operators post slashable bonds. Challenge windows give counterparties time to dispute. Evidence bundles give verifiers something real to evaluate. A Bittensor subnet provides decentralized quality consensus without a trusted arbiter.

The result is physical infrastructure that composes like cloud services: any capability, from any verified shop, discoverable and bookable by any agent, with automatic settlement and no intermediary taking a cut.

---

**Live gateway**: [pcc-gateway-production.up.railway.app](https://pcc-gateway-production.up.railway.app)
**Repo**: [github.com/global-mysterysnailrevolution/physical-capability-cloud](https://github.com/global-mysterysnailrevolution/physical-capability-cloud)
