# @pcc/subgraph

TheGraph subgraph for `ReceiptAnchorRegistry` — indexes Phase-2
InvocationReceipt anchors emitted by the PCC aggregator gateway.

**Design doc**: `ai/scoping/onchain-receipt-anchoring-2026-05-23.md` §5

## What it indexes

Three on-chain events from `packages/contracts/src/ReceiptAnchorRegistry.sol`:

- `AnchorEmitted(bytes32 cidHash, bytes32 toolIdHash, bytes32 callerHash,
   uint8 dccClass, uint64 receiptTimestamp, bytes32 toolCID, bytes32 upstreamKeyHash)`
  — single-receipt anchor (DCC3+/high-stakes path).
- `BatchAnchorEmitted(bytes32 merkleRoot, uint32 count, uint8 minDccClass,
   uint8 maxDccClass, bytes32 batchMetadataCID)` — Merkle-rooted batch
  anchor (DCC0..DCC2 bulk path).
- `DisputeRaised(bytes32 cidHash, address disputer, string reason)` —
  permissionless dispute event.

## 5 entities

- `ReceiptAnchor` — one per `AnchorEmitted`, immutable.
- `BatchAnchor` — one per `BatchAnchorEmitted`, immutable.
- `Tool` — aggregate per `toolIdHash` with per-DCC-class counters.
- `Caller` — aggregate per `callerHash`.
- `Dispute` — one per `DisputeRaised`, linked to `ReceiptAnchor` if known.

## Example queries

```graphql
# All receipts for a tool in the last 24h
query ToolActivity($toolHash: ID!, $since: BigInt!) {
  receiptAnchors(
    where: { toolIdHash: $toolHash, anchoredAtTimestamp_gte: $since }
    orderBy: receiptTimestamp
    orderDirection: desc
    first: 100
  ) {
    cidHash dccClass callerHash receiptTimestamp toolCID
  }
}

# Caller audit trail
query CallerHistory($callerHash: ID!) {
  caller(id: $callerHash) {
    totalReceipts
    receipts(orderBy: receiptTimestamp, orderDirection: desc, first: 1000) {
      cidHash toolIdHash dccClass receiptTimestamp txHash
      batch { merkleRoot count }
    }
  }
}

# Quorum primitive: tools with high DCC3+ activity
query QuorumTools($since: BigInt!) {
  tools(where: { dcc3Count_gt: "10", lastSeenBlock_gt: $since }, first: 100) {
    id totalReceipts dcc3Count dcc4Count dcc5Count
  }
}
```

## Deployment

1. Run `forge script script/DeployReceiptAnchorRegistry.s.sol` and capture
   the deployed address.
2. Edit `subgraph.yaml`:
   - `network:` → `base-sepolia` or `base`
   - `source.address:` → deployed address from
     `deployments/<network>/ReceiptAnchorRegistry.json`
   - `source.startBlock:` (optional) → deploy block number, for faster
     initial sync
3. Install graph CLI (one-time, global): `npm i -g @graphprotocol/graph-cli`
4. `pnpm --filter @pcc/subgraph codegen` — generates AssemblyScript types
   from the ABI + schema.
5. `pnpm --filter @pcc/subgraph build` — compiles handlers to WASM.
6. `pnpm --filter @pcc/subgraph deploy:hosted-sepolia` (after
   `graph auth --product hosted-service <token>`).

## Self-hosted backup

The scoping doc §5.6 recommends a Railway-hosted Graph Node alongside the
TheGraph hosted service (reliability). Both use this same subgraph YAML —
just point the deploy command at the self-hosted indexer URL.

## Tests

Tests use the `matchstick-as` framework. Install: `pnpm install` in this
package, then:

```bash
pnpm --filter @pcc/subgraph test
```

(See `tests/` directory. Note: `graph test` requires `binaryen` / Postgres
to be installed locally — if absent, the test script falls through to a
notice rather than failing the workspace.)
