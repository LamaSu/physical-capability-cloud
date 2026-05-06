# Physical Capability Cloud (PCC)

> **An open protocol for verifiable, settleable physical work.** Operators run hardware. Customers (or their AI agents) discover, negotiate, escrow, and settle — all over HTTP, all anchored on-chain.

**Live**: [capability.network](https://capability.network) · **License**: [Apache-2.0](LICENSE) · **Discord**: [PCC Network](https://discord.gg/CRFvvUgeV4)

---

## What is PCC?

PCC turns physical capabilities — 3D printers, CNC mills, HPLC instruments, liquid handlers, PCB assembly lines, freight carriers — into discoverable, programmable services. Every job is contracted over HTTP, escrowed on-chain, executed on real hardware, evidenced cryptographically, and settled when the evidence meets the agreed assurance tier.

It's substrate, not platform: anyone can run an operator node, contribute a capability adapter, or build an integration. The protocol charges 2.35% on settlement — that's the entire business model.

---

## 30-second start

**Connect an AI agent (no install):**
```bash
curl https://capability.network/agent-package.json
# 230+ tools as JSON Schema. Paste into Claude, GPT, or any LLM tool harness.
```

**Connect a machine (Python operator node):**
```bash
pip install pcc-node
pcc-node start
# Auto-discovers hardware, provisions an API key, registers a kernel, accepts jobs.
```

**MCP server (Claude Code / Codex):**
```json
{ "pcc": { "command": "node", "args": ["packages/mcp-server/dist/index.js"], "env": { "PCC_URL": "https://capability.network" } } }
```

---

## What it actually does

Tell an agent what you need. PCC handles the rest:

- **3D-print a bracket** — an operator with idle FDM capacity gets the job, escrow locks before the print starts, evidence streams while it's running, escrow releases when the print passes verification.
- **HPLC compound analysis** — a regulated lab in Buenos Aires has open instrument time. A startup in Austin queues a sample. The protocol routes the work, anchors the evidence, settles in USDC.
- **Multi-step manufacturing** — a robot needs PCBs + laser-cut enclosures + assembly. PCC decomposes the request into a capability DAG and orchestrates the supply chain across operators.

Operators set their own pricing. Customers pay only on verified completion.

---

## How it works

```
  YOUR AGENT
        │
        │  "analyze this compound and print the report"
        ▼
   ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
   │DISCOVER │───▶│   BID    │───▶│ ESCROW   │───▶│ EXECUTE  │───▶│ VERIFY   │───▶│ SETTLE   │
   │ DHT     │    │ Auction  │    │ On-chain │    │ Real     │    │ Evidence │    │ Auto     │
   │ gossip  │    │ pricing  │    │ milestone│    │ hardware │    │ pipeline │    │ release  │
   └─────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
```

1. **Discover** — your agent broadcasts what it needs. The network finds operators with matching capabilities.
2. **Bid** — operators compete on price. No phone calls, no RFQs, no waiting.
3. **Escrow** — funds lock on-chain before work starts. Both sides are protected.
4. **Execute** — the operator's hardware runs the job. Evidence streams in real time.
5. **Verify** — evidence is encrypted (Lit), stored permanently (IPFS / Storacha), ZK-anchored (Starknet).
6. **Settle** — funds release automatically when evidence meets the contracted assurance tier.

---

## Assurance tiers

| Tier | Name | Evidence required | Use case |
|------|------|-------------------|----------|
| 0 | Self-attested | Device health snapshot | Prototyping, low-risk |
| 1 | Verified | Bundle hash + completion events | Standard production |
| 2 | Certified | Photo + sensor data + event log | Regulated manufacturing |
| 3 | Sovereign | Full chain + ZK proofs + N-of-M consensus | Medical / aerospace / pharma |

Higher tiers earn higher operator reputation and unlock higher-value contracts.

---

## Built on

| Technology | What it does in PCC |
|------------|---------------------|
| **Storacha / Filecoin** | Content-addressed evidence storage on IPFS |
| **Lit Protocol** | Evidence encryption with on-chain access conditions |
| **Starknet** | ZK proof anchors — verifiable proof that physical work happened |
| **Base / Ethereum** | Primary settlement chain — `MilestoneEscrow` + `PCCProtocol` |
| **Flow EVM** | Sub-cent settlement contracts |
| **NEAR** | Cross-chain payment intents via 1Click solver network |
| **Arkhai (Alkahest)** | Conditional peer-to-peer escrow with EAS attestations |

---

## Deployed contracts

| Chain | Contract | Address |
|-------|----------|---------|
| Base Sepolia | MilestoneEscrow | `0x10059efeeab1ddf013489e9597a3aec4480d95e1` |
| Base Sepolia | MockUSDC | `0x5f2eb54dc5cb9a6bfff58222c672e73e16e763e9` |
| Base Sepolia | CaptureClassRegistry | `0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66` |
| Flow EVM Testnet | MilestoneEscrow | [`0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15`](https://evm-testnet.flowscan.io/address/0x2b11d5bf01ec086e0bd071e1a848a848ffd2ca15) |
| Starknet Sepolia | ProofRegistry | `0x43643ebf182210af4e22eb3b2f5e4dbab50c00471743521b4e80d1328debcd` |

---

## Documentation

| Doc | What's in it |
|-----|--------------|
| [Agent Integration Guide](docs/AGENT_INTEGRATION.md) | Complete REST API reference — auth, discovery, contracts, escrow, evidence |
| [E2E Runbook](docs/E2E_RUNBOOK.md) | Full discovery → escrow → execute → settle walkthrough |
| [Capture Verification](docs/CAPTURE_VERIFICATION.md) | Per-frame evidence authenticity protocol (CC0–CC5) |
| [Capture Classes](docs/CAPTURE_CLASSES.md) | Quick reference for capture classes + multipliers |
| [Contributor Economics](docs/CONTRIBUTOR_ECONOMICS.md) | How adapter authors and model trainers earn from settled work |
| [Sponsor Integrations](docs/SPONSOR_INTEGRATIONS.md) | Per-chain integration deep-dives |
| [Threat Model](docs/THREAT_MODEL.md) | Security analysis + attack surface |
| [Architecture](docs/ARCH.md) | Internals: facades, kernels, evidence pipeline |
| [Deploy](docs/DEPLOY.md) | CI/CD pipeline, Docker, Railway, GHCR retag |
| [Whitepaper](apps/dashboard/public/whitepaper.md) | Full protocol spec |
| [CLAUDE.md](CLAUDE.md) | Reference cited by the runtime — endpoints, DTOs, MCP tools, env vars |

---

## Capture Verification Protocol (CVP)

CVP adds per-frame authenticity to evidence. Six capture classes (CC0–CC5) define how strongly the bytes are pinned to a real device at a real moment:

- **CC0** — unattested upload (0.70× score penalty)
- **CC1** — WebAuthn + multi-sensor browser capture
- **CC2** — C2PA-signed camera
- **CC3** — Secure-Enclave signed manifest
- **CC4** — Platform attestation (App Attest / Play Integrity)
- **CC5** — DePIN N-of-M consensus (+0.05 bonus)

Captures pass through six gates (structural, signature, freshness, detection, attestation, consensus) and are anchored on Base Sepolia via [`CaptureClassRegistry`](https://sepolia.basescan.org/address/0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66). See the [operator guide](docs/CAPTURE_VERIFICATION.md) for the full spec.

---

## Build from source

```bash
git clone https://github.com/LamaSu/physical-capability-cloud.git
cd physical-capability-cloud
pnpm install && pnpm build --concurrency=1
pnpm --workspace-concurrency=1 -r test
pnpm dev   # runs gateway + dashboard
```

Requires Node 22+ and pnpm 9+. Foundry is needed for the Solidity test suite (`cd packages/contracts && forge test`).

---

## Repo layout

```
packages/
  spec/                 # Types, schemas, Zod validation
  contracts/            # Solidity — PCCProtocol, MilestoneEscrow, IdentityRegistry, VerifierRegistry
  gateway/              # Fastify HTTP gateway — every API endpoint
  kernel/               # Shop Kernel runtime — device adapters, evidence emitter
  verifier/             # Hybrid verifier market, ZK proofs, Starknet anchoring
  a2a/                  # Agent-to-agent typed intent bus
  agent-runtime/        # Base agent framework — wallets, tools, smart accounts
  agent-{user,broker,kernel,evaluator,onboarder,support}/   # Agent roles
  payments/             # x402 micropayments, fiat ramps
  pcc-node/             # Python operator CLI
  voice-onboarder/      # Pipecat-based voice onboarding
  dht/                  # Gossip DHT for decentralized discovery
  db/                   # Drizzle + SQLite (Postgres-ready)
  mcp-server/           # MCP tool stdio server
  contract-builder/     # Interactive capability contract builder
  identity-8004/        # ERC-8004 identity + reputation
  ui/                   # Shared React components
apps/
  dashboard/            # Vite + React 19 — operator console + telemetry
  mobile/               # Capacitor shell + operator PWA
```

---

## Environment variables

The most common operator-facing knobs:

| Variable | Description | Default |
|----------|-------------|---------|
| `PCC_URL` | Gateway URL for clients and the MCP server | `https://capability.network` |
| `PCC_BASE` | Same, for the `pcc-node` Python CLI | `https://capability.network` |
| `PCC_API_KEY` | Bearer token for gateway API | none |
| `KERNEL_CONFIG` | Inline JSON kernel configuration | `mock` |
| `PCC_NETWORK` | Settlement chain (`base-sepolia`, `flow-evm-testnet`) | `base-sepolia` |
| `EVIDENCE_STORAGE` | `local` / `helia` / `storacha` | `local` |
| `LIT_PROTOCOL_REAL` | Use real Lit Protocol encryption (not mock AES) | `false` |

Full reference in [`CLAUDE.md`](CLAUDE.md) and [`docs/AGENT_INTEGRATION.md`](docs/AGENT_INTEGRATION.md).

---

## Contributing

Issues and pull requests welcome. A few conventions:

- **Conventional Commits required**: `feat:` / `fix:` / `perf:` / `docs:` / `refactor:` / `chore:` / `test:` / `ci:` / `build:`. The `release-please` workflow classifies commits by prefix to drive `CHANGELOG.md` and version bumps.
- **Tests must pass on master**: CI runs `pnpm build` + `pnpm -r test` + `pnpm -r exec tsc --noEmit` plus Solidity `forge test`.
- **Don't hand-edit `CHANGELOG.md` or `package.json` versions** — those are owned by `release-please`.

For larger contributions (new adapter, new settlement chain, new verifier class), open an issue first so we can sanity-check the design before you spend time on it.

---

## License

[Apache 2.0](LICENSE). Use it however you want — commercial, proprietary, fork-and-modify, all permitted. Patent grant included.

---

*Originally shipped during [PL Genesis: Frontiers of Collaboration](https://www.plgenesis.com/), March 2026. Continued development under [LamaSu](https://github.com/LamaSu).*
