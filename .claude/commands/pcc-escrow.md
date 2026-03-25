# PCC Escrow — CLI

Check escrow status, milestones, and evidence for PCC jobs using the CLI.

## When to use
- "What's the status of my job?" / "Show active escrows" / "Check evidence for job X"
- "Is the milestone evidence verified?" / "Show escrow details"

## Prerequisites
- PCC gateway reachable at PCC_URL (default: https://pcc-gateway-production.up.railway.app)
- Build CLI: `cd packages/mcp-server && npx tsc`

## Commands

### List escrows
```bash
node packages/mcp-server/dist/cli.js escrow list [--status=funded|active|completed|disputed] [--pretty]
```
Shows all escrow contracts with milestones, amounts locked, and status.

### Get job details
```bash
node packages/mcp-server/dist/cli.js jobs get <jobId> [--pretty]
```
Full job details including evidence timeline, milestones, and settlement status.

### Get evidence bundle
```bash
node packages/mcp-server/dist/cli.js evidence get <bundleId> [--pretty]
```
Specific evidence bundle: encrypted data reference, IPFS CID, ZK proof status, Bittensor verification scores, evaluator attestations.

### List all jobs
```bash
node packages/mcp-server/dist/cli.js jobs list [--kernelId=x] [--status=queued|running|completed|failed] [--pretty]
```

## Workflow: Check escrow progress
1. `pcc escrow list --status=active --pretty` — see active escrows
2. `pcc jobs get <jobId> --pretty` — drill into a specific job
3. `pcc evidence get <bundleId> --pretty` — inspect the submitted evidence
4. Explain escrow states: funded → active → milestone_fulfilled → completed (or disputed)

## Tips
- Pipe to `jq` for filtering: `node packages/mcp-server/dist/cli.js escrow list | jq '.[] | select(.status=="active")'`
- Use `--pretty` for human-readable output in the terminal
- Bond amounts and challenge windows only apply to Tier 2+ assurance
