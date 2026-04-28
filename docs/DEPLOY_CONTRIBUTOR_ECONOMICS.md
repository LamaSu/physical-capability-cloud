# Deploy: Contributor Economics Contracts

**Contracts**: `RateScheduleRegistry.sol`, `ContributorNFT.sol`
**Script**: `packages/contracts/script/DeployContributorEconomics.s.sol`
**Target**: Base Sepolia (testnet) for v1
**Read first**: `docs/DEPLOY.md` for the build-once / deploy-many CI invariants
that this deploy must NOT violate. Specifically: never rebuild when you can
retag, never swap a Railway image source to a tag that doesn't yet exist, and
prod promotion is always a manual `workflow_dispatch` (not auto-on-merge).

## What this deploys

- **`RateScheduleRegistry`** — content-addressed immutable registry mapping
  `sha256(canonical-JSON RateSchedule) → bytes`. Permissionless writes, sealed
  on first publish. No constructor args, no admin keys.
- **`ContributorNFT`** — sealed-mint ERC-721 + ERC-2981 binding one
  `{role, scheduleHash, ipId, metadataUri}` per token. Constructor takes the
  `RateScheduleRegistry` address; mint() refuses any `scheduleHash` not first
  published into that exact registry instance.

The two contracts are deployed in a single broadcast so the NFT can immediately
reference the freshly-deployed registry. The NFT's `scheduleRegistry` is
`immutable` — re-pointing requires a fresh ContributorNFT deployment.

## Prerequisites

- [ ] `forge` installed locally (Foundry — Spark does not have it; deploy from local).
      Verify with `forge --version`.
- [ ] `DEPLOYER_PRIVATE_KEY` env var set to a funded Base Sepolia testnet key.
      Get test ETH from https://www.alchemy.com/faucets/base-sepolia (~0.01 ETH plenty).
- [ ] `ETHERSCAN_API_KEY` env var set to a BaseScan API key (free at
      https://basescan.org/myapikey). Required for `--verify`.
- [ ] On `feat/contributor-economics` branch (or merged into `master`).
- [ ] `~/.credentials.json` has the active credentials (per `~/.claude` memory).

Optional:

- `RPC_URL` — defaults to `https://sepolia.base.org`. Override for an Alchemy /
  Infura / QuickNode endpoint if the public RPC is rate-limiting.

## Pre-deploy checks (~30 seconds)

```bash
cd C:/Users/globa/pcc-contributor-economics/packages/contracts
forge build
forge test --match-path 'test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}*' -vv
```

Expected: 58 tests pass, 0 fail. If anything fails, **do not deploy** — fix the
failure first. Splitting payouts to >16 recipients is the most common source
of `OutOfGas` failures and means the schedule is malformed; do not ship it.

## Deploy command

```bash
cd C:/Users/globa/pcc-contributor-economics/packages/contracts

export DEPLOYER_PRIVATE_KEY=0x...      # funded Base Sepolia key
export ETHERSCAN_API_KEY=...           # BaseScan key

forge script script/DeployContributorEconomics.s.sol:DeployContributorEconomics \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  -vvvv
```

The script logs both deployed addresses to stdout. Expected tail:

```
Deployer: 0x<your-address>
RateScheduleRegistry deployed at: 0x<registry-address>
ContributorNFT deployed at: 0x<nft-address>
ContributorNFT.scheduleRegistry: 0x<registry-address>   <-- must match the line above

--- Add to chain-config.ts ---
rateScheduleRegistry: 0x<registry-address>
contributorNFT: 0x<nft-address>
```

`forge` writes a broadcast artifact to
`packages/contracts/broadcast/DeployContributorEconomics.s.sol/84532/run-latest.json`
with the full transaction trace. Keep it — it's the canonical record of what
was deployed and which block it landed in.

## What gets deployed (in order)

1. **`RateScheduleRegistry`** — no constructor args. One broadcast tx. Address
   is fully determined by `(deployer, nonce)` so deterministic across runs from
   a clean nonce.
2. **`ContributorNFT(address(registry))`** — one broadcast tx. Wires immutably
   to the registry deployed in step 1.

The script asserts the wiring inline:

```solidity
ContributorNFT nft = new ContributorNFT(address(registry));
console.log("ContributorNFT.scheduleRegistry:", nft.scheduleRegistry());
```

If the third line in the deploy log does not equal the first registry address,
something is wrong — abort and investigate before treating the deploy as good.

## Verification (post-deploy)

Set the addresses from the deploy output:

```bash
export RATE_SCHEDULE_REGISTRY=0x...    # from "RateScheduleRegistry deployed at:"
export CONTRIBUTOR_NFT=0x...           # from "ContributorNFT deployed at:"
export BASE_SEPOLIA_RPC=https://sepolia.base.org
```

### 1. Verify wiring on chain

```bash
cast call "$CONTRIBUTOR_NFT" "scheduleRegistry()(address)" --rpc-url "$BASE_SEPOLIA_RPC"
# Should equal $RATE_SCHEDULE_REGISTRY (case-insensitive)
```

### 2. Smoke-publish a schedule

A 40-bps constant rate schedule, sealed under its sha256:

```bash
SCHEDULE_BYTES='{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}'
SCHEDULE_HASH=$(printf '%s' "$SCHEDULE_BYTES" | shasum -a 256 | cut -d' ' -f1)

cast send "$RATE_SCHEDULE_REGISTRY" \
  "publish(bytes,bytes32)(bytes32)" \
  "$(printf '%s' "$SCHEDULE_BYTES" | xxd -p | tr -d '\n')" \
  "0x$SCHEDULE_HASH" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --rpc-url "$BASE_SEPOLIA_RPC"
```

### 3. Verify it stored

```bash
cast call "$RATE_SCHEDULE_REGISTRY" "exists(bytes32)(bool)" "0x$SCHEDULE_HASH" \
  --rpc-url "$BASE_SEPOLIA_RPC"
# Should return: true
```

If `exists()` returns `false` after a successful publish tx, something is
deeply wrong (wrong registry address, or `publish()` reverted silently). Re-run
the `cast send` with `-vvvv` to inspect.

## Recording deployed addresses

After a successful deploy + verification pass, persist the addresses in the
repo as the canonical source of truth. Create:

- `packages/contracts/deployments/base-sepolia/RateScheduleRegistry.json`
- `packages/contracts/deployments/base-sepolia/ContributorNFT.json`

Following the existing pattern (see
`packages/contracts/deployments/base-sepolia/CaptureClassRegistry.json` in the
parent PCC repo for reference):

```json
{
  "address": "0x...registry-address...",
  "blockNumber": 12345678,
  "chainId": 84532,
  "contract": "RateScheduleRegistry"
}
```

```json
{
  "address": "0x...nft-address...",
  "blockNumber": 12345679,
  "chainId": 84532,
  "contract": "ContributorNFT",
  "scheduleRegistry": "0x...registry-address..."
}
```

`blockNumber` comes from the `forge` broadcast log
(`broadcast/DeployContributorEconomics.s.sol/84532/run-latest.json`,
field `receipts[*].blockNumber`, hex-decoded to decimal).

Commit these JSON files in a `chore(contracts):` commit so the addresses are
auditable in git history.

## Wiring into the gateway

After deploy, set these env vars on the gateway service (Railway → service →
Variables, both `staging` and `production` envs):

```
RATE_SCHEDULE_REGISTRY_ADDRESS=0x...
CONTRIBUTOR_NFT_ADDRESS=0x...
```

The gateway routes in `packages/gateway/src/routes/contributors.ts` do all of
their primary work against the off-chain DB (better-sqlite3 in dev, Postgres in
prod). The on-chain registry is consulted only when a caller requests an
on-chain `exists()` cross-check — so the gateway boots and serves traffic in
"degraded mode" without these vars, and lights up the on-chain path once they
are set. No restart drama, just stronger guarantees.

## Mainnet deployment

**NOT yet supported.** When mainnet promotion is required:

1. Run this same script against Base Mainnet (`--rpc-url https://mainnet.base.org`,
   `--etherscan-api-key` for the mainnet BaseScan key).
2. Promotion is a manual `workflow_dispatch` per `docs/DEPLOY.md` rule #4 —
   the runtime image flows testnet → manual review → mainnet retag, and the
   contract addresses ride the same gate. Do **not** auto-promote contract
   addresses by editing CI.
3. The contracts are immutable, so a mainnet deploy is one-and-done: there is
   no upgrade flow, no proxy admin, no setter. Plan accordingly.

## Rollback

The contracts have no admin, no `pause`, and no proxy. "Rollback" means:

1. Deploy a v2 of whichever contract has the bug.
2. Migrate the gateway env vars to point at v2 (`RATE_SCHEDULE_REGISTRY_ADDRESS`,
   `CONTRIBUTOR_NFT_ADDRESS`).
3. Existing tokens / schedules referencing v1 continue to function — they're
   just snapshotted against the older registry. The off-chain DB rows are
   forward-compatible because they store `scheduleHash` (a content address),
   not a contract reference.

If the bug is in v1's published schedule bytes (not the contract), there is no
recovery — that's the immutable-publish guarantee. Just publish a corrected
schedule under its new hash and route new mints to it.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `Schedule not registered` on `mint()` | The `scheduleHash` was not first published to `RateScheduleRegistry` | Call `publish(bytes, expectedHash)` first; verify with `exists(scheduleHash)` |
| `Schedule hash mismatch` on `publish()` | The bytes you passed do not `sha256` to `expectedHash` | Verify byte encoding: UTF-8, no BOM, canonical-JSON ordering. Use `@pcc/spec`'s `computeScheduleHash()` to derive the hash |
| `Already published` on `publish()` | The same hash was already stored — registry is sealed | Read with `get(scheduleHash)`; if you wanted a different schedule, change the bytes (which changes the hash) |
| `Zero registry` on `ContributorNFT` constructor | Deployer passed `address(0)` | Pass the deployed `RateScheduleRegistry` address. The script does this automatically — only fails if you re-ran the NFT deploy in isolation |
| `Zero scheduleHash` on `mint()` | Caller passed `bytes32(0)` as `scheduleHash` | Hash a real schedule first; `bytes32(0)` is a sentinel for "uninitialized" and is forbidden |
| Gas runs out on `MilestoneEscrow.splitPayout` | More than ~16 recipients in one milestone | Split the milestone into multiple sub-milestones, each ≤16 recipients |
| Forge `Stack too deep` | Compiler optimizer disabled or hitting limits | Build with `forge build --via-ir` (uses Yul IR pipeline; slower but handles deeper stacks) |
| Verification fails on BaseScan | Wrong `--etherscan-api-key` or BaseScan rate-limited | Verify the key at https://basescan.org/myapikey; retry with `forge verify-contract` after the deploy if `--verify` failed mid-broadcast |
| Deploy reverts with no message | Insufficient ETH on deployer for gas | Top up the testnet wallet from https://www.alchemy.com/faucets/base-sepolia |
