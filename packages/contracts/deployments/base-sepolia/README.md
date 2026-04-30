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

## Why commit the addresses

The contracts are immutable — there is no on-chain admin / upgrade flow.
Committing the addresses here makes the deployment auditable in git history
and lets every package read them from one place instead of guessing from a
broadcast log buried in `packages/contracts/broadcast/`.
