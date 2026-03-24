# PCC Evidence — CLI

Browse, inspect, and understand evidence bundles and verification protocols for PCC jobs.

## When to use
- "Show evidence for job X"
- "List verification protocols"
- "Check the evidence bundle for bundle-abc123"
- "What evidence was submitted for the HPLC run?"
- "Is the ZK proof ready?"
- "Show all evidence bundles"
- "What protocols are available for Tier 2?"
- "Verify the evidence for milestone 2"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## Commands

### Evidence List — All Evidence Bundles
```bash
node packages/mcp-server/dist/cli.js evidence list
```
Lists all evidence bundles across all jobs. Each entry shows: bundle ID, associated job ID, milestone number, IPFS CID, encryption status, ZK proof status, Bittensor verification score, and creation timestamp. Use this to get a broad view of evidence state across the network.

Filter by job:
```bash
node packages/mcp-server/dist/cli.js evidence list --job J-0047
```

### Evidence Get — Specific Bundle Details
```bash
node packages/mcp-server/dist/cli.js evidence get <bundleId>
```
Returns full details for a specific evidence bundle. Output includes:
- **Bundle ID** and associated job/milestone
- **Encryption**: Lit Protocol AES-256-GCM status, access control conditions
- **IPFS CID**: Content-addressed storage path (immutable once stored)
- **Evidence events**: List of collected data points (measurements, sensor readings, photos, certificates)
- **ZK proof**: Generated? Verified? Proof ID if available
- **Bittensor verification**: Miner consensus score (0-1), number of miners that participated, individual miner votes
- **Evaluator attestation**: If a third-party evaluator attested, shows their DID, score, and findings

Example:
```bash
node packages/mcp-server/dist/cli.js evidence get bafkreiabcdef1234
```

### Protocols List — Protocol Templates
```bash
node packages/mcp-server/dist/cli.js protocols list
```
Lists all protocol templates (multi-step workflow templates used as evidence collection blueprints). Each protocol defines: step sequence, what data to collect at each step, acceptance criteria, and assurance tier compatibility. Use this to understand what evidence patterns exist before building a contract.

Filter by assurance tier:
```bash
node packages/mcp-server/dist/cli.js protocols list --tier 2
```

Filter by capability type:
```bash
node packages/mcp-server/dist/cli.js protocols list --type hplc
```

## Evidence Lifecycle

Understanding where a bundle is in its lifecycle helps interpret the output of `evidence get`:

```
Collect → Encrypt (Lit Protocol) → Store (IPFS) → Verify (Bittensor) → ZK Proof → Escrow Release
```

| Stage | What It Means |
|-------|---------------|
| `collected` | Raw data captured from device sensors / instruments |
| `encrypted` | Lit Protocol AES-256-GCM applied; access gated by access conditions |
| `stored` | IPFS CID assigned; content-addressed and immutable |
| `verifying` | Bittensor miners are scoring the evidence |
| `verified` | Bittensor consensus reached (score ≥ threshold) |
| `zk_pending` | ZK proof being generated off-chain |
| `zk_ready` | ZK proof generated and anchored (Starknet) |
| `settled` | Escrow milestone released; funds transferred |

## Workflow: Check Evidence for a Job

1. Find the job and its evidence bundles:
   ```bash
   node packages/mcp-server/dist/cli.js jobs get J-0047
   ```
   (This shows bundle IDs for each milestone in the job detail output)

2. Get full details on a specific bundle:
   ```bash
   node packages/mcp-server/dist/cli.js evidence get <bundleId>
   ```

3. Check the Bittensor verification score. If it's below threshold, the milestone won't release. A score ≥ 0.67 (2/3 consensus) typically passes for Tier 2.

4. If ZK proof is pending, note the proof ID and check back in a few minutes — proof generation is async.

## Workflow: Browse Available Protocols Before Building a Contract

1. List all protocols to understand what evidence patterns exist:
   ```bash
   node packages/mcp-server/dist/cli.js protocols list
   ```

2. Filter to Tier 2 protocols for a specific capability type to see what evidence a Tier 2 HPLC job would require:
   ```bash
   node packages/mcp-server/dist/cli.js protocols list --tier 2 --type hplc
   ```

3. Use this information to set expectations with the client about evidence turnaround before building the contract (`/pcc-build`).

## Tips
- `evidence list --job <jobId>` is usually more targeted than bare `evidence list` — it filters to just the bundles you care about.
- IPFS CIDs starting with `bafkrei` are CIDv1 (preferred). Older `Qm...` CIDs are CIDv0 and still valid but less efficient.
- Bittensor verification takes 1-10 minutes depending on subnet congestion. Don't panic if a bundle shows `verifying` immediately after submission.
- ZK proofs are generated asynchronously. The `zk_pending` state is normal for 5-15 minutes after evidence is verified.
- If you see `encrypted: false` on a bundle, that's only valid for Tier 0 (self-attested) evidence. Tier 1+ bundles must always be encrypted.
- Evaluator attestations are optional for Tier 1 and required for Tier 3. Check the protocol template (`protocols list`) to know what's required for your tier.
