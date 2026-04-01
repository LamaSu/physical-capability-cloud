# Physical Capability Cloud

**AWS for the physical world.**

Every machine, lab, and factory on Earth just became a programmable endpoint.

**Live**: [capability.network](https://capability.network)

---

## What will you build?

Your AI agent can now control real physical hardware — anywhere, on demand.

- Tell your agent to **3D print a bracket** and it finds an operator, negotiates the price, locks escrow, streams evidence of the print, and settles payment. You never make a phone call.
- A biotech startup in Austin needs **HPLC compound analysis**. A lab in Buenos Aires has an idle instrument. PCC connects them in seconds — no RFQs, no NDAs, no middlemen.
- A robotics team needs **PCB fabrication + laser-cut enclosures + assembly**. PCC decomposes the request into a capability DAG and orchestrates the entire supply chain autonomously.
- A woman-owned lab in Kenya offers **bioreactor capacity** to pharmaceutical buyers globally — paid in local currency via mobile money.

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

## License

Apache 2.0

---

*Built during [PL Genesis: Frontiers of Collaboration](https://www.plgenesis.com/), March 2026.*
