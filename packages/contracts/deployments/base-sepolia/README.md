# Base Sepolia deployments — contributor-economics

After running `script/DeployContributorEconomics.s.sol`, persist the deployed
addresses here as the canonical record. See
[`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`](../../../../docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md)
for the full runbook.

## Files (added on first deploy)

- `RateScheduleRegistry.json` — content-addressed RateSchedule storage,
  no constructor args.
- `ContributorNFT.json` — sealed-mint ERC-721, references
  `RateScheduleRegistry` via the `scheduleRegistry` field.

## Schema

```json
{
  "address": "0x...",
  "blockNumber": 12345678,
  "chainId": 84532,
  "contract": "RateScheduleRegistry"
}
```

`ContributorNFT.json` adds a `"scheduleRegistry": "0x..."` field pointing to
the registry it was wired to at construction (immutable).

## Files — V2 / EAS settlement (added with the V2 settlement path)

- `PCCProtocolV2.json` — EAS-gated escrow factory. `createEscrowV2` deploys
  `MilestoneEscrowV2` instances. Mirrored in `ts/chain-config.ts` as
  `contracts.milestoneEscrowFactoryV2`. (Supersedes the retired per-instance
  factory `0x5810Bf`.)
- `EASSchema.json` — the registered `pcc.evidence.v1` EAS schema (`uid` +
  schema string). Threaded into every V2 escrow as `PCC_EVIDENCE_SCHEMA_UID`.
- `SampleEscrow.json` — a reference `MilestoneEscrowV2` clone INSTANCE (not the
  factory). Per-job escrows are minted fresh via `createEscrowV2`; this one is
  for smoke wiring / reference only.

> `blockNumber` is intentionally omitted from the V2 files where it was not
> independently verified — committing a guessed block number would defeat the
> "auditable record" purpose. Add it when confirmed from an explorer.

## Why commit the addresses

The contracts are immutable — there is no on-chain admin / upgrade flow.
Committing the addresses here makes the deployment auditable in git history
and lets every package read them from one place instead of guessing from a
broadcast log buried in `packages/contracts/broadcast/`.
