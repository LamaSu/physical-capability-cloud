# Physical Capability Cloud

**AWS for the physical world. A decentralized cloud control plane where AI agents discover, negotiate, and orchestrate physical manufacturing capabilities.**

**Live**: [capability.network](https://capability.network) | **Demo**: [[VIDEO_URL]]

---

## What is PCC?

Physical Capability Cloud is a credibly neutral protocol that turns every machine, lab, and factory into a programmable, composable endpoint. Operators register their physical capabilities — 3D printers, CNC routers, liquid handlers, mass spectrometers, couriers — and the network handles everything else: discovery, bidding, escrow, execution, cryptographic evidence, and automatic settlement.

AI agents orchestrate the full pipeline without any human middleman. A user submits an intent ("analyze this compound and print the report"), and the agent swarm decomposes it into a workflow DAG, discovers capable operators via auction pricing, locks milestone escrow on-chain before work starts, streams cryptographic evidence during execution, and settles payment automatically upon verified completion. Operators keep more. Users pay less. No admin overhead.

The `PCCProtocol` root contract is the business model. It charges a 1.5% protocol fee (150 bps) on every settlement — hardcoded at deployment, governance-adjustable within 0.1%–5%, but can never be zero. The immutable fee recipient is `0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B`. Only factory-deployed escrows can settle through the root contract. More operators, more volume, more fees. Like Uniswap, but for physical work.

---

## Architecture

```
 ┌───────────────────────────────────────────────────────────┐
 │                     USER / AI AGENT                       │
 │          (submits intent, monitors, verifies)             │
 └────────────────────────┬──────────────────────────────────┘
                          │  A2A typed intents
 ┌────────────────────────▼──────────────────────────────────┐
 │                   BROKER AGENT                            │
 │   capability routing · auction pricing · workflow DAG     │
 └────────────────────────┬──────────────────────────────────┘
                          │  job dispatch
 ┌────────────────────────▼──────────────────────────────────┐
 │                   KERNEL AGENT                            │
 │    device adapters · evidence emitter · sensor pipeline   │
 └────────────────────────┬──────────────────────────────────┘
                          │  physical I/O
 ┌────────────────────────▼──────────────────────────────────┐
 │                 PHYSICAL DEVICE                           │
 │    (OT-2, OctoPrint, CNC, Modbus PLC, SiLA instrument)   │
 └───────────────────────────────────────────────────────────┘

           ┌─────────────────────────────────────┐
           │          EVIDENCE CHAIN              │
           │  Storacha IPFS · Lit Encryption      │
           │  Starknet ZK Anchoring · DIDs + VCs  │
           └─────────────────────────────────────┘

           ┌─────────────────────────────────────┐
           │         PCCPROTOCOL ROOT             │
           │  1.5% fee · factory pattern          │
           │  immutable recipient · 0–5% bounds   │
           └──────────────┬──────────────────────┘
                          │
           ┌──────────────▼──────────────────────┐
           │           SETTLEMENT                 │
           │  MilestoneEscrow · Base Sepolia      │
           │  Flow EVM Testnet · NEAR 1Click      │
           │  x402 micropayments · Soulbound NFTs │
           └─────────────────────────────────────┘
```

---

## How It Works

The protocol executes in six phases for every job:

1. **DISCOVER** — User Agent broadcasts capability requirements; the DHT gossip network returns operator bids sorted by price and reputation score.
2. **BID** — Operators set maximum prices; agents compete downward via auction pricing with configurable minimum floors.
3. **ESCROW** — Milestone funds lock in the `MilestoneEscrow` smart contract (Base Sepolia) before any work begins; each step carries an operator bond.
4. **EXECUTE** — The Kernel Agent runs the job through a physical device adapter, streaming SHA-256 content-addressed evidence events (sensor readings, calibration records, photos) in real time.
5. **VERIFY** — Evidence bundles are encrypted via Lit Protocol, stored on IPFS via Storacha, Merkle-committed, and the proof hash anchored on Starknet for permanent on-chain verifiability.
6. **SETTLE** — Once evidence meets the contract's assurance tier requirements, the escrow releases funds automatically to each operator; soulbound capability certificates are minted on Solana.

---

## Sponsor Integrations

### PCCProtocol Root Contract

The `PCCProtocol.sol` root contract acts as the clearinghouse for all settlements. It enforces:

- **1.5% protocol fee** (150 bps), adjustable 0.1%–5% by governance, but never zero
- **Immutable fee recipient**: `0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B`
- **Factory pattern**: only escrows created via the protocol factory can settle through the root
- 66 Forge tests passing

**Files**:
- `packages/contracts/src/PCCProtocol.sol` — root contract
- `packages/gateway/src/contracts/protocol-client.ts` — gateway viem client
- `packages/gateway/src/routes/pcc-protocol.ts` — 5 REST endpoints: `GET /api/protocol/*`

---

### Flow EVM

PCC's `MilestoneEscrow` and `MockUSDC` contracts are deployed to Flow EVM Testnet (chain 545) with sub-cent transaction costs.

**Deployed contracts**:
- MockUSDC: [`0x7e51fbd7c1051847ca3705f382387ef16849f2fd`](https://evm-testnet.flowscan.io/address/0x7e51fbd7c1051847ca3705f382387ef16849f2fd)
- MilestoneEscrow: [`0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15`](https://evm-testnet.flowscan.io/address/0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15)

**How it works**: The same Solidity contracts targeting Base Sepolia are deployed to Flow EVM via a dedicated script. The gateway escrow client routes reads/writes to Flow EVM when `PCC_NETWORK=flow-evm-testnet`.

**Files**:
- `packages/contracts/ts/chain-config.ts` — `flowEVMTestnet` chain definition (chain 545)
- `scripts/deploy-flow-evm.ts` — full deploy script (MockUSDC + MilestoneEscrow + test minting)
- `packages/gateway/src/contracts/escrow-client.ts` — supports `PCC_NETWORK=flow-evm-testnet`

**Explorer**: https://evm-testnet.flowscan.io

---

### NEAR Protocol

Cross-chain payment intents via NEAR's 1Click API let PCC agents fund escrow contracts on any chain without managing bridges.

**How it works**: The gateway calls NEAR's solver network (chaindefuser.com) to route atomic cross-chain swaps. A PCC agent can request a job on Base Sepolia and pay with NEAR-native USDC in a single intent message.

**Files**:
- `packages/gateway/src/routes/near.ts` — 4 REST routes (`/api/near/*`)
- `packages/gateway/src/contracts/near-client.ts` — 1Click API client (plain fetch, mock mode)
- `packages/a2a/src/types.ts` — 4 new A2A intents: `NearPaymentIntentRequest`, `NearPaymentQuoteResult`, `NearPaymentSubmit`, `NearPaymentSettled`

**Test**: `pnpm --filter @pcc/gateway test` (26 tests)

---

### Storacha / Filecoin

Every evidence bundle produced during job execution is content-addressed and stored permanently on IPFS via Storacha's w3up network.

**How it works**: The `StorachaStorageService` uploads raw blobs to Storacha using the `@storacha/client` SDK. Each bundle gets a CIDv1 (sha2-256 + raw codec). A separate public metadata CID is generated containing no sensitive fields — safe for indexing. In real mode, the client authenticates with a UCAN delegation proof. The factory `createEvidenceStorage()` selects between Helia (local IPFS) and Storacha based on the `EVIDENCE_STORAGE=storacha` environment variable.

**Files**:
- `packages/kernel/src/storacha-storage.ts` — `StorachaStorageService` (upload/retrieve via w3up)
- `packages/kernel/src/evidence-storage-factory.ts` — factory routing Helia vs Storacha
- `packages/kernel/src/evidence-storage.ts` — Helia fallback (in-process IPFS node)

**Activation**: Set `EVIDENCE_STORAGE=storacha` and `STORACHA_PROOF=<base64 UCAN delegation>`.

---

### Starknet

ZK proof hashes and Merkle roots are anchored on Starknet Sepolia for permanent, chain-verifiable evidence commitments.

**How it works**: The `StarknetProofAnchoringService` takes the output of `ZKProofService` (evidence inclusion proofs and tier compliance proofs) and commits a canonical SHA-256 hash to the `ProofRegistry` contract on Starknet Sepolia via `starknet.js`. The hash is truncated to a 248-bit felt252 field element before submission. On-chain state stores only the hash — raw evidence never touches the chain. The service polls transaction receipts for finality confirmation.

**Files**:
- `packages/verifier/src/starknet-proof-service.ts` — `StarknetProofAnchoringService`
- `packages/verifier/src/zk-proof-service.ts` — ZK proof generation (evidence inclusion + tier compliance)
- `packages/verifier/src/commitment-service.ts` — Merkle tree construction and root generation
- `packages/gateway/src/routes/zk-proofs.ts` — REST endpoints: `POST /api/zk/anchor`, `GET /api/zk/status/:txHash`

**Activation**: Set `STARKNET_ACCOUNT`, `STARKNET_PRIVATE_KEY`, and `STARKNET_NETWORK=goerli`.

---

### Lit Protocol

Evidence bundles are encrypted with AES-256-GCM under Lit Protocol access conditions that enforce on-chain escrow state — only the buyer or a credentialed verifier can decrypt.

**How it works**: `LitEncryptionService` builds `UnifiedAccessControlCondition` arrays that gate decryption on two checks: (1) the caller's address matches `getBuyer(jobId)` on the `MilestoneEscrow` contract, OR (2) the caller has a verifier reputation score of 100 or more. These conditions are stored alongside the ciphertext. The mock mode uses real AES-256-GCM with the same interface shape. The real mode (`RealLitEncryptionService`) uses `@lit-protocol/lit-node-client` on the `datil-test` network, where key shares are held threshold-split across Lit nodes and released only when conditions are met on-chain.

**Files**:
- `packages/kernel/src/lit-encryption-service.ts` — mock service (real AES-256-GCM, same interface)
- `packages/kernel/src/lit-encryption-real.ts` — real service (`@lit-protocol/lit-node-client` v6, datil-test)

**Activation**: Set `LIT_PROTOCOL_REAL=true` to switch from mock to the real Lit network.

---

## Scale

| Metric | Count |
|--------|-------|
| Packages | 25 + 1 dashboard app |
| Tests | 361+ gateway tests, 3,300+ total |
| Agent tools | 179 (agent-package.json v2.2.0) |
| MCP tools | 49 (stdio server) |
| REST endpoints | 347+ across 60+ route files |
| Forge tests | 66 passing (contracts) |
| A2A intents | 38 typed intents (34 + 4 NEAR) |
| SSE streams | 6 real-time streams |
| Capability types | 30+ (biotech, manufacturing, services) |

Live deployment: [capability.network](https://capability.network) — Railway, Cloudflare, custom domain. Gateway healthcheck passing.

Deployed contracts:
- `MilestoneEscrow` on Sepolia: `0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454`
- `MockUSDC` on Sepolia: `0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb`

---

## Quick Start

```bash
pnpm install
pnpm build --concurrency=1    # sequential build, 25 packages
pnpm --workspace-concurrency=1 -r test   # 3300+ tests
pnpm dev                      # dashboard :5173, gateway :3200
```

**E2E simulations**:

```bash
# Full agent-to-agent pipeline
npx tsx scripts/agent-e2e-simulation.ts

# Sovereign infrastructure (DIDs, IPFS, Lit, ZK, Starknet)
npx tsx scripts/sovereign-e2e-simulation.ts

# Lit Protocol encryption demo
npx tsx scripts/lit-protocol-demo.ts

# OpenClaw print-and-deliver (real OT-2 robot scenario)
npx tsx scripts/openclaw-print-deliver-e2e.ts
```

**MCP server** (for Claude Code or any MCP client):

```json
{
  "pcc": {
    "command": "node",
    "args": ["packages/mcp-server/dist/index.js"],
    "env": { "PCC_URL": "https://capability.network" }
  }
}
```

**Operator node** (connect physical hardware):

```bash
pip install pcc-node
pcc-node start    # auto-detect hardware, generate keys, register, run daemon
```

---

## Supplies Marketplace

The `/api/marketplace/*` endpoints expose a physical supplies marketplace where operators can source raw materials alongside booking capabilities. 9 REST endpoints cover listings, search, ordering, and fulfillment. 12 categories: `raw-metals`, `plastics-polymers`, `lab-reagents`, `lab-consumables`, `electronics`, `chemicals`, `biologicals`, `tooling`, `packaging`, `calibration`, `safety`, and `other`.

**File**: `packages/gateway/src/routes/marketplace.ts`

---

## Sponsor Telemetry

The `/sponsors` dashboard page and `GET /api/status/sponsors` endpoint show live integration status for all 6 sponsor cards (Storacha, Starknet, Lit Protocol, Flow, NEAR, Bittensor).

---

## Demo

**Video**: [[VIDEO_URL]]

**Live site**: [capability.network](https://capability.network)

The demo shows a full six-phase pipeline: User Agent posts a compound analysis workflow, the Broker Agent routes it to a registered OT-2 liquid handler, evidence streams live to the dashboard, the Starknet anchor confirms on-chain, and escrow settles automatically.

---

## Track

**PL Genesis: Frontiers of Collaboration — Fresh Code Track**

AI & Robotics | Infrastructure & Digital Rights

Repo created: March 2, 2026. All code written during the hackathon window.

---

## License

Apache 2.0

---

## Team

globalmysterysnailrevolution

*[Add social handles here]*
