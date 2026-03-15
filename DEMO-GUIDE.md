# PCC Live Demo Guide

## Setup
1. Open TWO windows side by side: **Win+Left** (terminal) | **Win+Right** (browser)
2. Terminal: `cd physical-capability-cloud && npx tsx scripts/demo-live.ts`
3. Browser: `http://localhost:5173`
4. Start `pnpm dev` in a separate terminal first if not already running

## Demo Flow (press ENTER to advance each phase)

| Phase | Terminal Shows | Dashboard Page | What To Click/Show |
|-------|--------------|----------------|-------------------|
| START | Title card | `/` (Command Center) | KPIs: 3 active jobs, 3 kernels online, $28K locked |
| 1. DISCOVER | Agents find 3 operators | `/discover` | Filter by "2d-print" — show capabilities list |
| 2. CONTRACT | Route optimized $45, escrow locks | `/escrow` | Show milestone table, bonds, challenge windows |
| 3. PRINT | 6 evidence events flash | `/jobs` | Click an active job — show progress + evidence timeline |
| 4. FRAME | Robot arm evidence flashes | `/sensors` | Show force-torque chart, sensor readings |
| 5. DELIVER | Delivery confirmed | `/evidence` | Show 4 encrypted bundles — click one to see events |
| 6. VERIFY | ZK proofs + Bittensor consensus | `/subnet` | Show miner leaderboard, consensus score |
| 7. SETTLE | Funds released, cNFT minted | `/depin` | Show rewards, soulbound certificate, treasury |

## Key Talking Points Per Phase

**DISCOVER**: "Any capability becomes discoverable. Agents search, filter, compare."
**CONTRACT**: "Escrow locks funds before work starts. Each step has a bond."
**PRINT**: "Every step produces cryptographic evidence. File hashes, QC photos, power profiles."
**FRAME**: "A robot arm frames it — force-torque telemetry, CV alignment at 0.3mm. Zero human intervention."
**DELIVER**: "Chain of custody signed at every handoff. Recipient confirms delivery."
**VERIFY**: "Bittensor miners verify evidence quality through consensus. ZK proofs for inclusion."
**SETTLE**: "Funds release automatically. Soulbound NFT proves operator competence. DePIN rewards grow the network."

## Fast Version (no pauses)
```
npx tsx scripts/hackathon-demo.ts
```
Runs in 2.5 seconds. Use for "let me show you the whole thing real quick."

## API Endpoints (if judges ask)
```
GET  /api/kernels              — List all kernels
GET  /api/capabilities         — Discover capabilities
GET  /api/jobs                 — Active jobs
GET  /api/evidence/encrypted   — Encrypted evidence bundles
GET  /api/sensors/channels     — Sensor channels
GET  /api/batches              — Batch tracking
POST /api/zk/prove/inclusion   — Generate ZK proof
GET  /api/rewards/epochs       — DePIN reward epochs
GET  /sse/stream/job/:id       — Real-time job SSE stream
```

## If Judges Drill On Backend
- "How do agents communicate?" → A2A protocol, 27+ typed intents, MessageBus
- "Is Bittensor real?" → Mock subnet with real Yuma Consensus math, ready for testnet
- "How does escrow work?" → Solidity MilestoneEscrow on Base Sepolia, challenge windows
- "How is evidence stored?" → AES-256-GCM encryption, IPFS via Helia, Merkle commitments
- "How do operators get paid?" → Evidence verified → milestone released → DePIN rewards
