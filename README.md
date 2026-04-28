# Physical Capability Cloud

**AWS for the physical world.**

Every machine, lab, and factory on Earth just became a programmable endpoint.

**Live**: [capability.network](https://capability.network)

---

## Contributor Economics — new on `feat/contributor-economics`

Anyone who contributes to a job — adapter author, capability protocol
author, AI model trainer, pilot who collected the training data — can
mint an immutable, publicly-committed rate schedule once and earn a
fraction of every job that uses their work, forever (or until they ship
a v2). At settlement, `MilestoneEscrow.splitPayout()` routes funds
across all attached contributors in a single transaction. There is **no
OEM royalty class** — by design. OEMs participate as Operators,
Integrators, Protocol Authors, or Model Authors on equal terms with
everyone else.

53 commits, 32 new Forge tests, 700+ TS tests passing, 7 new MCP tools,
8 new REST endpoints under `/api/contributors/*`, agent-package v2.8.0
(218 tools).

- **Quickstart**: [`docs/CONTRIBUTOR_ECONOMICS.md`](docs/CONTRIBUTOR_ECONOMICS.md) — 5-minute "I am a contributor and I want to earn from my work" path
- **API reference**: [`docs/AGENT_INTEGRATION.md`](docs/AGENT_INTEGRATION.md) §14
- **Deploy**: [`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`](docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md)
- **No-OEM thesis**: [`docs/claros-layer4-amendment.md`](docs/claros-layer4-amendment.md)

### What's new

- **2026-04**: Contributor economics layer (53 commits, 700+ tests). See [`docs/CONTRIBUTOR_ECONOMICS.md`](docs/CONTRIBUTOR_ECONOMICS.md).

---

## What will you build?

Your AI agent can now control real physical hardware — anywhere, on demand.

- Tell your agent to **3D print a bracket** and it finds an operator, negotiates the price, locks escrow, streams evidence of the print, and settles payment. You never make a phone call.
- A biotech startup in Austin needs **HPLC compound analysis**. A lab in Buenos Aires has an idle instrument. PCC connects them in seconds — no RFQs, no NDAs, no middlemen.
- A robotics team needs **PCB fabrication + laser-cut enclosures + assembly**. PCC decomposes the request into a capability DAG and orchestrates the entire supply chain autonomously.
- A woman-owned lab in Kenya offers **bioreactor capacity** to pharmaceutical buyers globally — paid in local currency via mobile money.

- Your 3D-printed part is done. PCC dispatches a **courier to pick it up and deliver it to your door** — same protocol, same escrow, same evidence chain. The driver is just another operator on the network. No platform taking 30-40% of their earnings.

**What will you plug into the network?**

---

## Get started in 30 seconds

**Connect your AI agent:**
```bash
curl https://capability.network/agent-package.json | pbcopy
# Paste into Claude, GPT-4, or any agent. 219 tools. Done.
```

**Connect your hardware:**
```bash
pip install pcc-node && pcc-node start --discover
# Auto-discovers devices on your network. Registers. Starts accepting jobs.
```

**MCP (Claude Code / Codex):**
```json
{ "pcc": { "command": "node", "args": ["packages/mcp-server/dist/index.js"], "env": { "PCC_URL": "https://capability.network" } } }
```

---

## What is PCC?

A protocol that turns physical capabilities into composable, verifiable, settleable services — discoverable by AI agents. Operators run `pcc-node`, their hardware is auto-discovered, capabilities are announced to the network, and agents handle the rest: auction pricing, milestone escrow, cryptographic evidence, and automatic settlement.

Every job that settles pays a protocol fee. More operators, more volume, more fees. No token, no inflation, no speculation.

---

## How it works

```
  YOU / YOUR AI AGENT
        │
        │  "analyze this compound and print the report"
        ▼
   ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │DISCOVER │───▶│   BID    │───▶│ ESCROW   │───▶│ EXECUTE  │───▶│ VERIFY   │───▶│ SETTLE   │
   │         │    │          │    │          │    │          │    │          │    │          │
   │ DHT     │    │ Auction  │    │ On-chain │    │ Real     │    │ Storacha │    │ Auto     │
   │ gossip  │    │ pricing  │    │ milestone│    │ hardware │    │ Starknet │    │ release  │
   │ network │    │          │    │ lock     │    │ evidence │    │ Lit      │    │          │
   └─────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

1. **DISCOVER** — Your agent broadcasts what it needs. The network finds operators with matching capabilities.
2. **BID** — Operators compete on price. No phone calls, no RFQs, no waiting.
3. **ESCROW** — Funds lock on-chain before work starts. Both sides are protected.
4. **EXECUTE** — The operator's hardware runs the job. Evidence streams in real time.
5. **VERIFY** — Evidence is encrypted, stored on IPFS, and ZK-anchored on Starknet.
6. **SETTLE** — Funds release automatically when evidence meets the contract requirements.

---

## Built on

| Technology | What it does in PCC |
|-----------|-------------------|
| **Storacha / Filecoin** | Every evidence bundle is content-addressed and stored permanently on IPFS |
| **Starknet** | ZK proof hashes anchored on-chain — verifiable proof that physical work happened |
| **Lit Protocol** | Evidence encrypted with on-chain access conditions — only the buyer or verified auditors can decrypt |
| **Flow EVM** | Settlement contracts deployed on Flow — sub-cent transaction costs |
| **NEAR** | Cross-chain payment intents — fund escrows from any chain via 1Click solver network |
| **Arkhai (Alkahest)** | Conditional peer-to-peer escrow with EAS attestations — boolean-native settlement |
| **Base / Ethereum** | Primary settlement chain — MilestoneEscrow + PCCProtocol root contract |

---

## The numbers

25 packages. 3,300+ tests. 219 agent tools. 497+ gateway tests. 66 Forge tests. 38 A2A intents. 6 real-time SSE streams. Live at [capability.network](https://capability.network) with real hardware running right now.

---

## Quick start

```bash
# Build everything
pnpm install && pnpm build --concurrency=1

# Run all 3,300+ tests
pnpm --workspace-concurrency=1 -r test

# Start the gateway + dashboard
pnpm dev
```

---

## Documentation

| Doc | What's in it |
|-----|-------------|
| [Sponsor Integrations](docs/SPONSOR_INTEGRATIONS.md) | Deep technical docs for every integration — code paths, file tables, verification commands |
| [Hackathon Submission](HACKATHON_SUBMISSION.md) | 390-word project summary for PL Genesis |
| [Bounty Submissions](BOUNTY_SUBMISSIONS.md) | Every bounty we're claiming and why we qualify |
| [Whitepaper](apps/dashboard/public/whitepaper.md) | Full protocol spec — architecture, assurance tiers, evidence chain, settlement |
| [CLAUDE.md](CLAUDE.md) | Complete developer reference — all 25 packages, env vars, commands, invariants |

## Deployed contracts

| Chain | Contract | Address |
|-------|----------|---------|
| Base Sepolia | MilestoneEscrow | `0x10059efeeab1ddf013489e9597a3aec4480d95e1` |
| Base Sepolia | MockUSDC | `0x5f2eb54dc5cb9a6bfff58222c672e73e16e763e9` |
| Flow EVM Testnet | MilestoneEscrow | [`0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15`](https://evm-testnet.flowscan.io/address/0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15) |
| Flow EVM Testnet | MockUSDC | [`0x7e51fbd7c1051847ca3705f382387ef16849f2fd`](https://evm-testnet.flowscan.io/address/0x7e51fbd7c1051847ca3705f382387ef16849f2fd) |
| Starknet Sepolia | ProofRegistry | `0x43643ebf182210af4e22eb3b2f5e4dbab50c00471743521b4e80d1328debcd` |

## Package map

```
packages/
  spec/              # Types, schemas, Zod validation — single source of truth
  contracts/         # Solidity (PCCProtocol, MilestoneEscrow, IdentityRegistry, VerifierRegistry)
  gateway/           # Fastify HTTP gateway — 60+ route files, 497+ tests
  kernel/            # Shop Kernel runtime — device adapters, evidence emitter, Storacha, Lit
  verifier/          # Hybrid verifier market, ZK proofs, Starknet anchoring
  a2a/               # Agent-to-agent typed intent bus (38 intents)
  agent-runtime/     # Base agent framework — wallets, tools, smart accounts
  agent-user/        # User Agent — discovers, negotiates, submits
  agent-broker/      # Broker Agent — routes capabilities, compiles workflows
  agent-kernel/      # Kernel Agent — accepts jobs, emits evidence
  agent-evaluator/   # Evaluator Agent — quality assessment, attestation
  payments/          # x402 micropayments, Meteora DLMM, fiat ramps
  pcc-node/          # Python CLI — hardware discovery, daemon, operator onboarding
  dht/               # WebSocket gossip DHT for decentralized capability discovery
  db/                # SQLite shared database layer
  mcp-server/        # 49 MCP tools over stdio
  contract-builder/  # Interactive capability contract builder
  identity-8004/     # ERC-8004 identity + reputation registries
  ui/                # Shared React components
apps/
  dashboard/         # Vite + React 19 dashboard — operator console, telemetry, setup wizard
```

## Environment variables

| Variable | What it does |
|----------|-------------|
| `EVIDENCE_STORAGE=storacha` | Use Storacha w3up for evidence (default: Helia) |
| `LIT_PROTOCOL_REAL=true` | Use real Lit Protocol encryption (default: local AES-256-GCM) |
| `STARKNET_ACCOUNT_ADDRESS` | Enable real Starknet ZK proof anchoring |
| `PCC_NETWORK=base-sepolia` | Settlement chain (base-sepolia, flow-evm-testnet) |
| `ESCROW_CONTRACT_ADDRESS` | Deployed MilestoneEscrow address |
| `PCC_GATEWAY_PRIVATE_KEY` | Gateway signer for on-chain writes |

Full env var reference in [CLAUDE.md](CLAUDE.md).

---

## License

Apache 2.0

---

*Built during [PL Genesis: Frontiers of Collaboration](https://www.plgenesis.com/), March 2026.*
