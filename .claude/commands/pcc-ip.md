# PCC IP — CLI

Register capabilities as Story Protocol IP Assets, track royalties, claim revenue, and configure revenue splits.

## When to use
- "Register this CSD as IP"
- "Check my royalties"
- "Claim my IP revenue"
- "Show the IP lineage for this capability"
- "Set up revenue splits"
- "How much have I earned from my HPLC protocol IP?"
- "Who are the upstream IPs I owe royalties to?"
- "Configure splits between the lab and the developer"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)
- CSD must already be registered (`/pcc-csd`) before registering it as IP

## Commands

### IP Register — Register Capability as IP Asset
```bash
node packages/mcp-server/dist/cli.js ip register
```
Registers a CSD (Capability StructureDefinition) as a Story Protocol IP Asset. Creates an on-chain IP record with provenance anchored to the CSD's canonical URI. Returns the Story Protocol IP Asset ID (`ipId`) which you use in all subsequent IP commands.

Provide the CSD URI and optional metadata:
```bash
node packages/mcp-server/dist/cli.js ip register --csd-uri "https://pcc.example.com/csd/hplc-reverse-phase-v1" --name "HPLC Reverse Phase Protocol" --description "Validated pharma-grade purity analysis protocol"
```

### IP Revenue — Revenue Snapshot
```bash
node packages/mcp-server/dist/cli.js ip revenue <ipId>
```
Returns a snapshot of the IP Royalty Vault for the given IP Asset: total accumulated revenue, unclaimed balance, claimed-to-date, and revenue sources (which downstream IP Assets have paid royalties into this vault).

Example:
```bash
node packages/mcp-server/dist/cli.js ip revenue ip-asset-abc123
```

### IP Claim — Claim Revenue
```bash
node packages/mcp-server/dist/cli.js ip claim <ipId>
```
Claims all accumulated unclaimed revenue from the IP Royalty Vault to the vault's designated recipient address. Triggers an on-chain transaction. Returns the claim transaction hash and amount claimed.

Example:
```bash
node packages/mcp-server/dist/cli.js ip claim ip-asset-abc123
```

### IP Lineage — Provenance Graph
```bash
node packages/mcp-server/dist/cli.js ip lineage <ipId>
```
Returns the full IP provenance graph: ancestors (IP Assets this one derives from) and descendants (IP Assets that derive from this one). Shows royalty flow direction and split percentages at each node. Use this to understand your position in the IP tree and trace where royalties flow.

Example:
```bash
node packages/mcp-server/dist/cli.js ip lineage ip-asset-abc123
```

Output includes:
- Parent IP Assets with their royalty share percentages
- Child IP Assets that pay into this vault
- Total depth of the derivation tree
- Per-node revenue amounts (if available)

### IP Splits — Configure Revenue Splits
```bash
node packages/mcp-server/dist/cli.js ip splits <ipId>
```
Configures how revenue flowing into this IP Asset's vault is split between multiple recipients. Splits must sum to exactly 100. Recipients can be wallet addresses or other IP Asset IDs (creating royalty chains).

```bash
node packages/mcp-server/dist/cli.js ip splits ip-asset-abc123 --splits '[
  {"recipient":"0xLabWalletAddress","percentage":70},
  {"recipient":"0xDeveloperAddress","percentage":20},
  {"recipient":"ip-asset-parent-001","percentage":10}
]'
```

Note: Changing splits does not affect already-vaulted revenue — only future revenue flows are affected.

## Workflow: Register a CSD as IP and Start Earning Royalties

1. Ensure the CSD is registered first (`/pcc-csd`), then register it as an IP Asset:
   ```bash
   node packages/mcp-server/dist/cli.js ip register --csd-uri "https://pcc.example.com/csd/my-protocol-v1"
   ```

2. Note the returned `ipId` — save it, you'll use it repeatedly.

3. Configure revenue splits between contributors:
   ```bash
   node packages/mcp-server/dist/cli.js ip splits <ipId> --splits '[
     {"recipient":"0xYourWallet","percentage":80},
     {"recipient":"0xCollaboratorWallet","percentage":20}
   ]'
   ```

4. As jobs using this CSD run on PCC, revenue accumulates in the vault. Check the balance:
   ```bash
   node packages/mcp-server/dist/cli.js ip revenue <ipId>
   ```

5. When ready to claim:
   ```bash
   node packages/mcp-server/dist/cli.js ip claim <ipId>
   ```

## Workflow: Audit Your IP Royalty Tree

1. Get your IP Asset's lineage to see the full provenance tree:
   ```bash
   node packages/mcp-server/dist/cli.js ip lineage <ipId>
   ```

2. Check revenue snapshots for all ancestor IPs that receive royalties from yours — confirm the upstream recipients are correct:
   ```bash
   node packages/mcp-server/dist/cli.js ip revenue <parentIpId>
   ```

3. If splits need updating (e.g., a collaborator changed), update them:
   ```bash
   node packages/mcp-server/dist/cli.js ip splits <ipId> --splits '[...]'
   ```

## Tips
- `ipId` is returned by `ip register` and is a Story Protocol canonical identifier. Store it permanently — there is no lookup by CSD URI in the IP commands (you'd need to cross-reference CSD list).
- `ip revenue` is a snapshot — values reflect the vault state at query time, not a live stream. Poll it manually when you expect revenue to have accumulated.
- `ip claim` is an on-chain write — it costs gas. Batch claims if you have many IP Assets by checking `ip revenue` first and only claiming when the balance is meaningful.
- Splits of 100 are enforced by the contract. If you set 3 recipients at 33% each, the total is 99 — the contract will reject this. Use 34/33/33 instead.
- IP lineage is computed on-chain and may take a few seconds to return for deep trees (>10 hops). Be patient.
- Any CSD can be registered as IP regardless of capability type. Novel protocols (new lab methods, rare machining techniques) are the highest-value candidates for IP registration.
