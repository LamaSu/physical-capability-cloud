# PCC Governance — CLI

Sovereign Wealth Fund overview, participant dashboards, and governance proposals.

## When to use
- "Show the sovereign wealth fund"
- "List active proposals"
- "What's my SWF participant status?"
- "How much have I earned from the SWF?"
- "What governance votes are open?"
- "Show fund balance and strategy"
- "Check my dividends"
- "What proposals are pending vote?"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## What is the PCC Sovereign Wealth Fund?

The PCC Sovereign Wealth Fund (SWF) is a protocol-owned treasury that accumulates a share of all job fees processed on the network. Participants (operators with registered kernels, long-term capability providers) earn pro-rata dividends from fund returns. The fund is governed on-chain — participants vote on proposals that set investment strategy, fee parameters, and protocol upgrades.

Key roles:
- **Participants**: Registered operators and capability providers who earn dividends
- **Delegates**: Participants who hold or have been delegated governance voting power
- **Proposals**: On-chain governance proposals that change protocol parameters or fund strategy

## Commands

### SWF Summary — Fund Overview
```bash
node packages/mcp-server/dist/cli.js swf summary
```
Returns the current Sovereign Wealth Fund overview:
- Total fund balance (USDC)
- Current investment strategy allocation (yield sources)
- Epoch number and next distribution date
- Total participants and total dividend distributed to date
- Active proposals count
- Recent yield performance (last 30 days APY)

### SWF Participant — Participant Dashboard
```bash
node packages/mcp-server/dist/cli.js swf participant <participantId>
```
Returns a detailed dashboard for a specific participant (operator or capability provider):
- Participation score (based on job volume, uptime, evidence quality)
- Share of fund (percentage of total participant pool)
- Cumulative dividends earned
- Pending unclaimed dividends
- Voting power (governance weight)
- Voting history (which proposals they voted on)
- Eligibility for next distribution epoch

Replace `<participantId>` with the participant's DID or wallet address.

Example:
```bash
node packages/mcp-server/dist/cli.js swf participant did:pcc:kernel-01
node packages/mcp-server/dist/cli.js swf participant 0xYourWalletAddress
```

### SWF Proposals — Governance Proposals
```bash
node packages/mcp-server/dist/cli.js swf proposals
```
Lists all SWF governance proposals with their status, voting deadline, current vote tally (yes/no/abstain), and quorum progress. Status values:
- `draft` — being prepared, not yet open for vote
- `active` — open for voting right now
- `passed` — vote succeeded, pending execution
- `executed` — change applied on-chain
- `rejected` — vote failed
- `expired` — voting window closed without reaching quorum

Filter by status:
```bash
node packages/mcp-server/dist/cli.js swf proposals --status active
node packages/mcp-server/dist/cli.js swf proposals --status passed
```

## Workflow: Check Your SWF Participation and Earnings

1. Get the overall fund state:
   ```bash
   node packages/mcp-server/dist/cli.js swf summary
   ```

2. Look up your participant dashboard (use your kernel DID or wallet address):
   ```bash
   node packages/mcp-server/dist/cli.js swf participant <yourId>
   ```

3. Note your pending unclaimed dividends. To claim them, use `/pcc-fund` (`wallet balance` shows API credits and any SWF dividends reflected as claimable balance).

## Workflow: Review and Engage with Active Governance

1. Check what proposals are currently open for vote:
   ```bash
   node packages/mcp-server/dist/cli.js swf proposals --status active
   ```

2. For any proposal you want to understand in depth, get its full text by cross-referencing the proposal ID in the dashboard or gateway API.

3. Check your voting power before voting:
   ```bash
   node packages/mcp-server/dist/cli.js swf participant <yourId>
   ```

4. Cast votes on-chain via the governance contract (voting is an on-chain transaction not covered by the CLI — use the PCC dashboard UI at the gateway URL, or interact with the contract directly).

## Tips
- SWF dividends are distributed per epoch (not continuously). Check `swf summary` for the next distribution date — there is no benefit to claiming early.
- Participation score is a composite of job volume + uptime + evidence quality. Operators who run high-tier (Tier 2/3) jobs with clean evidence records score highest.
- Governance quorum is required for proposals to pass. If you hold significant voting power, your vote can be the difference between quorum and expiry on smaller proposals.
- `swf proposals --status passed` is useful for auditing recent protocol changes that have been executed but may affect your configuration.
- Proposal text and full details are stored in IPFS (linked from each proposal in the API response). The CLI shows a summary — fetch the IPFS CID for the full governance document.
- The SWF is protocol-owned and non-custodial — dividends accumulate on-chain and are only claimed when you initiate a claim transaction. There is no automatic disbursement.
