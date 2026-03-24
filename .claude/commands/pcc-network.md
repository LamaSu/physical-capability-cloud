# PCC Network — CLI

Monitor live network status: who's online, DePIN reward state, agent balances, and reputation scores.

## When to use
- "Show me the network status"
- "What's the DePIN state / reward epoch?"
- "Who's online on PCC?"
- "Check my agent balance"
- "What's the reputation of agent X?"
- "Show network overview"
- "How many kernels are active?"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## Commands

### Agent Status — Who's Online
```bash
node packages/mcp-server/dist/cli.js agents status
```
Lists all registered agents with their online/offline status, type (user/broker/kernel/evaluator), last heartbeat, and endpoint. Use this to see which shop kernels are accepting jobs right now.

### DePIN Stats — Reward Epochs & Kernel Scores
```bash
node packages/mcp-server/dist/cli.js depin stats
```
Shows the current reward epoch number, total distributed rewards, per-kernel scores, and top earners. Kernel scores are computed from job completion rate, evidence quality, and uptime. Use this to understand who's winning DePIN rewards.

### Wallet Balance — Agent USDC Balance
```bash
node packages/mcp-server/dist/cli.js wallet balance
```
Returns the USDC balance held by your agent wallet on Base Sepolia. Also shows any locked-in-escrow amount and available-to-spend balance. Run this before submitting jobs to confirm you have sufficient funds.

### Reputation — Get Agent or Kernel Reputation
```bash
node packages/mcp-server/dist/cli.js reputation get <agentId>
```
Fetches ERC-8004 reputation scores for a given agent or kernel ID. Output includes:
- Overall reputation score (0-100)
- Jobs completed / jobs failed
- Evidence quality average
- Challenge history (disputes won/lost)
- Staleness indicator (when last updated on-chain)

Replace `<agentId>` with the DID or on-chain address of the agent (e.g., `did:pcc:kernel-01` or `0xAbCd...`).

## Workflow: Full Network Health Check

1. Check who's online and accepting jobs:
   ```bash
   node packages/mcp-server/dist/cli.js agents status
   ```
2. Review current DePIN epoch and top-performing kernels:
   ```bash
   node packages/mcp-server/dist/cli.js depin stats
   ```
3. Verify your agent wallet has enough USDC before placing a job:
   ```bash
   node packages/mcp-server/dist/cli.js wallet balance
   ```
4. If a specific kernel looks interesting, check its reputation before trusting it:
   ```bash
   node packages/mcp-server/dist/cli.js reputation get <kernelId>
   ```

## Tips
- Cross-reference `agents status` online list with `depin stats` scores — high-scoring kernels that are online right now are your best bets for job submission.
- DePIN epoch scores reset on a cadence. Check `depin stats` near epoch boundaries to see who's hungry for work (and therefore likely to prioritize your job).
- Reputation scores are on-chain and lag by one block. A score that just dropped may reflect a very recent dispute — check the challenge history field.
- `wallet balance` shows both the raw on-chain balance and the gateway's cached view. If they differ, the gateway cache is stale — force a refresh with `pcc-fund` (`wallet activity`).
