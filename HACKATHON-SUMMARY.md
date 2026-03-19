# PCC — Physical Capability Cloud Protocol

## Project Summary (for DevSpot submission)

**Track:** Existing Code | **Themes:** AI & Robotics, Infrastructure & Digital Rights, Crypto & Economies

### Problem

Physical manufacturing is siloed. A university lab in Boston with an idle HPLC cannot serve a startup in Austin that needs compound analysis — because there is no composable, trust-minimized protocol for discovering, negotiating, executing, verifying, and settling physical work across organizational boundaries. Existing platforms are centralized marketplaces that extract rent, control access, and provide no cryptographic guarantees of execution quality.

### Solution

PCC is a **credibly neutral collaboration layer between physical systems** — "AWS for the physical world." Any physical capability (lab instrument, 3D printer, CNC router, courier) becomes a composable, verifiable, settleable service. AI agents handle discovery and negotiation. Milestone escrow locks funds before work starts. Cryptographic evidence proves every step. Settlement is automatic.

**How it works:** A user submits an intent ("print this document and deliver it"). AI agents decompose the workflow into a DAG, discover capable operators via auction pricing, lock escrow per milestone, execute with evidence (sensor readings, photos, chain-of-custody), verify via Bittensor subnet consensus + ZK proofs, and settle automatically — releasing funds to each operator and minting soulbound capability certificates.

### Architecture

PCC is a TypeScript/Solidity monorepo with 18 packages spanning six layers:

- **Agent Layer** — A2A protocol with 27+ typed intents. UserAgent discovers, BrokerAgent routes, KernelAgent executes. Wallets on Base (viem) and Solana.
- **Core Services** — Workflow compiler (DAG/topo-sort), capability router (auction pricing), contract builder (schema-driven templates), protocol engine (choreographed multi-instrument runs).
- **Shop Kernel** — The only interface to physical hardware. Device adapters, evidence emitter (SHA-256 content-addressed bundles), sensor pipeline, batch tracker.
- **Sovereign Infrastructure** — W3C DIDs, IPFS evidence storage (Helia + Storacha w3up), Lit Protocol threshold encryption, Bittensor verification subnet, ZK Merkle proofs (+ Starknet anchoring), DePIN reward epochs with soulbound cNFTs.
- **Settlement** — MilestoneEscrow on Base Sepolia with bonds/slashing, x402 micropayments, Solana agent wallets.
- **Dashboard** — React 19 + Vite SPA with 45+ routes, React Flow DAG editors, live telemetry, Solarpunk design system.

### Sponsor Integrations

- **Filecoin / Storacha**: Evidence bundles stored to IPFS via Helia; Storacha w3up client for durable Filecoin archival
- **Lit Protocol**: Threshold encryption with unified access control conditions — only authorized parties (buyer, verified auditor) can decrypt evidence
- **Starknet**: ZK proof anchoring — Merkle commitments and inclusion proofs bridged to Starknet for on-chain verification
- **Bittensor**: Decentralized evidence quality scoring via subnet miners with Yuma Consensus

### What's New (Hackathon Period)

All sovereign infrastructure was built during the hackathon window: IPFS storage, W3C DIDs, Lit encryption, Solana wallets, Bittensor subnet, DePIN economics, soulbound certificates, ZK proofs, Storacha integration, Starknet anchoring, pipeline telemetry system, and the OpenClaw print-and-deliver E2E scenario demonstrating a full multi-hop workflow with 3 variations.

**1,174 tests passing** across 69 test files. Live deployment on Railway.

---

*Team: globalmysterysnailrevolution*
