# Verification Report: docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md

**Validator**: val-deploy-charlie
**Date**: 2026-04-28
**Branch**: `feat/contributor-economics`
**Doc under test**: `C:/Users/globa/pcc-contributor-economics/docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`
**Deploy script**: `C:/Users/globa/pcc-contributor-economics/packages/contracts/script/DeployContributorEconomics.s.sol`

A fresh agent with zero priors walked the doc top-to-bottom, ran the listed
commands, and inspected the deploy script + contracts to confirm every claim.
What follows is the unvarnished result. Headline: the doc is genuinely
copy-pasteable for the on-chain part — `forge build` and the 58-test glob both
pass exactly as advertised, the deploy script's `vm.envUint("DEPLOYER_PRIVATE_KEY")`
matches the doc's env var name, the function signatures in the cast-call
section all resolve, and `chainId 84532` matches Base Sepolia. The doc does
have one substantive inaccuracy (a gateway env-wiring section that points at
env vars no code reads) and a couple of error-row claims that don't match the
contracts' actual revert reasons.

## Pre-deploy checklist

| Item | Verdict | Notes |
|------|---------|-------|
| `forge --version` | **CLEAR** | Forge 1.5.1-stable installed locally — doc is right that you deploy from local; the "Spark does not have it" parenthetical reads like an aside, not a blocker. |
| `DEPLOYER_PRIVATE_KEY` env var | **CLEAR** | Script reads it via `vm.envUint("DEPLOYER_PRIVATE_KEY")` at line 34 of `DeployContributorEconomics.s.sol`. Name matches. Linked to https://www.alchemy.com/faucets/base-sepolia, which is reachable per WebFetch baseline. |
| `ETHERSCAN_API_KEY` | **CLEAR** | Used in `--etherscan-api-key "$ETHERSCAN_API_KEY"`. `foundry.toml` at line 21 also references `${ETHERSCAN_API_KEY}` for `[etherscan].base_sepolia`, so both `--verify` and any later `forge verify-contract` retry will pick it up. Free key URL stated. |
| Branch `feat/contributor-economics` or `master` | **CLEAR** | Currently on `feat/contributor-economics`. The branch claim matches; the merge-fork-back is implied for production. |
| `~/.credentials.json` | **CLEAR but vague** | Mentioned as "active credentials per `~/.claude` memory" — fresh agent without the harness wouldn't know what's in there. Not blocking for the deploy itself (deploy uses `DEPLOYER_PRIVATE_KEY` via env; credentials.json is a session-level convenience). Could be deleted from this list without losing anything. |
| `RPC_URL` (optional) | **CLEAR** | Default `https://sepolia.base.org` matches `[rpc_endpoints].base_sepolia` in `foundry.toml` and the script's documented usage block. |

A fresh agent could satisfy every item without asking questions, modulo the
`~/.credentials.json` line which adds noise but not blocks.

## Pre-deploy commands

```bash
cd C:/Users/globa/pcc-contributor-economics/packages/contracts
forge build                                                                                # PASS (exit 0; lint warnings only — no errors)
forge test --match-path 'test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}*' -vv  # PASS — 58 tests passed, 0 failed, 0 skipped
```

Run-by-run breakdown for the test glob (tail of `forge test`):

```
Ran 14 tests for test/MilestoneEscrow.splitPayout.t.sol:MilestoneEscrowSplitPayoutTest   — 14 passed
Ran 18 tests for test/MilestoneEscrow.t.sol:MilestoneEscrowTest                          — 18 passed
Ran 11 tests for test/RateScheduleRegistry.t.sol:RateScheduleRegistryTest                — 11 passed
Ran 15 tests for test/ContributorNFT.t.sol:ContributorNFTTest                            — 15 passed
Ran 4 test suites in 1.90s (2.17s CPU time): 58 tests passed, 0 failed, 0 skipped
```

The doc's "58 tests pass, 0 fail" claim is **literally exact**. Test-path glob
`test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}*` resolves to
exactly the four files that exist (`ContributorNFT.t.sol`,
`RateScheduleRegistry.t.sol`, `MilestoneEscrow.t.sol`,
`MilestoneEscrow.splitPayout.t.sol`).

One tension: this script only deploys two of those four contracts'
counterparties. The MilestoneEscrow tests are still run for coverage hygiene,
but a fresh agent might wonder why MilestoneEscrow shows up in the pre-deploy
gate and never in the deploy. That's a doc-clarity issue, not a correctness
one — see "Specific fixes" §3.

## Deploy command verification

```bash
forge script script/DeployContributorEconomics.s.sol:DeployContributorEconomics \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  -vvvv
```

Flag-by-flag:

| Flag | Verdict | Evidence |
|------|---------|----------|
| Script path `script/DeployContributorEconomics.s.sol:DeployContributorEconomics` | **CORRECT** | File exists at `packages/contracts/script/DeployContributorEconomics.s.sol`; contract name matches the `:DeployContributorEconomics` selector in the colon syntax. |
| `--rpc-url https://sepolia.base.org` | **CORRECT** | Confirmed `cast chain-id --rpc-url https://sepolia.base.org` returns `84532` (Base Sepolia chainId). Same URL is in `foundry.toml [rpc_endpoints].base_sepolia`. |
| `--broadcast` | **CORRECT** | Required for state-changing forge scripts. |
| `--verify` | **CORRECT** | Triggers BaseScan verification post-broadcast. Pairs with `--etherscan-api-key`. |
| `--etherscan-api-key "$ETHERSCAN_API_KEY"` | **CORRECT** | Picked up by Foundry's etherscan integration; `foundry.toml`'s `[etherscan].base_sepolia.url` is the right BaseScan endpoint (`https://api-sepolia.basescan.org/api`). |
| `-vvvv` | **CORRECT** | Standard verbosity for deploy logging. |
| Env var `DEPLOYER_PRIVATE_KEY` | **CORRECT** | Script reads `vm.envUint("DEPLOYER_PRIVATE_KEY")` at line 34, exactly the name the doc says to set. |

Dry-run check: I ran the script against a deliberately-unreachable RPC
(`http://127.0.0.1:9999`) without `--broadcast` to validate that it parses and
gets to the network call:

```
Error: error sending request for url (http://127.0.0.1:9999/)
Context: client error (Connect) — No connection could be made because the target
  machine actively refused it. (os error 10061)
EXIT=1
```

Exit code 1, but the *only* error is the connect failure — the script
compiled, read the env var, derived the deployer address, and got as far as
the RPC call. Confirms the script + env wiring is sound. (Exit 1 here is
expected and correct behavior for an unreachable RPC.)

The "Expected tail" stdout block in the doc (deployer / registry / NFT /
scheduleRegistry / `--- Add to chain-config.ts ---`) matches the actual
`console.log` calls in `DeployContributorEconomics.s.sol` lines 37, 44, 50, 51,
56-58 verbatim. A fresh agent reading that block knows exactly what success
looks like.

## Verification commands

```bash
cast call "$CONTRIBUTOR_NFT" "scheduleRegistry()(address)" --rpc-url "$BASE_SEPOLIA_RPC"
```

- `scheduleRegistry()` — `cast sig "scheduleRegistry()" → 0xe090db7e`. The
  `address public immutable scheduleRegistry` getter at `ContributorNFT.sol:88`
  matches. Return type `(address)` is correct.

```bash
SCHEDULE_BYTES='{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}'
SCHEDULE_HASH=$(printf '%s' "$SCHEDULE_BYTES" | shasum -a 256 | cut -d' ' -f1)
cast send "$RATE_SCHEDULE_REGISTRY" \
  "publish(bytes,bytes32)(bytes32)" \
  "$(printf '%s' "$SCHEDULE_BYTES" | xxd -p | tr -d '\n')" \
  "0x$SCHEDULE_HASH" ...
```

- Tooling: `shasum`, `xxd`, `printf`, `cut` are all available in this Git Bash
  for Windows environment. `sha256sum` is also available as an alternative.
- `printf '%s' '<schedule>' | shasum -a 256` produced
  `127ee0b0762b69016b7b101783c09feb79e2d355b93950f409e154a4f71a48b0` (matches
  `sha256sum`, so the hashing reference is portable).
- `publish(bytes,bytes32)` — `cast sig` resolves to `0xfc0dfe00`. The
  `RateScheduleRegistry.publish(bytes,bytes32)` signature at
  `RateScheduleRegistry.sol:84` matches. Return type `(bytes32)` is correct
  (the function returns the verified hash).
- `cast abi-encode "publish(bytes,bytes32)" "0x<hex>" "0x<hash>"` produces a
  well-formed calldata blob — the encoding step in the doc is reasonable.

```bash
cast call "$RATE_SCHEDULE_REGISTRY" "exists(bytes32)(bool)" "0x$SCHEDULE_HASH" --rpc-url ...
```

- `exists(bytes32)` — `cast sig "exists(bytes32)" → 0x38a699a4`. Function at
  `RateScheduleRegistry.sol:117` returns `bool`. Correct.

One small nit on the `cast send` line: the doc passes the schedule bytes as
`"$(printf '%s' "$SCHEDULE_BYTES" | xxd -p | tr -d '\n')"` — that produces a
hex string *without* `0x` prefix. `cast` is generally lenient and will infer
this is hex, but for safety the doc could prepend `0x` explicitly. Not a
blocker.

## Deployments JSON pattern

Reference cited: `packages/contracts/deployments/base-sepolia/CaptureClassRegistry.json`
in **the parent PCC repo** (`C:/Users/globa/physical-capability-cloud/...`).
That file exists and has shape:

```json
{
  "address": "0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66",
  "blockNumber": 40562689,
  "chainId": 84532,
  "contract": "CaptureClassRegistry",
  "gatewayOracle": "0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B",
  "verifierRegistry": "0x5D84285C487B1dc631B55512D5423A12A48cd97A"
}
```

The doc's two example JSON blobs (RateScheduleRegistry + ContributorNFT)
match the shape — `address`, `blockNumber`, `chainId`, `contract`, plus the
extra `scheduleRegistry` link on the NFT. **CONSISTENT.**

The seed README at
`packages/contracts/deployments/base-sepolia/README.md` exists, says exactly
what `RateScheduleRegistry.json` and `ContributorNFT.json` should look like,
and back-links to the deploy doc with a relative path
`../../../../docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`. **MATCHES.**

The doc says to extract `blockNumber` from `forge` broadcast log
`broadcast/DeployContributorEconomics.s.sol/84532/run-latest.json`,
`receipts[*].blockNumber` (hex-decoded). That path *is* Foundry's standard
broadcast output convention; the directory doesn't exist yet because the
deploy hasn't run, which is correct.

## Common errors verification

| Doc row | Verdict | Cross-check |
|---------|---------|-------------|
| `Schedule not registered` on `mint()` | **CORRECT** | `ContributorNFT.sol:194` reverts with literal string `"Schedule not registered"` when `IRateScheduleRegistry(scheduleRegistry).exists(scheduleHash)` is false. |
| `Schedule hash mismatch` on `publish()` | **CORRECT** | `RateScheduleRegistry.sol:91` reverts with `"Schedule hash mismatch"` when `sha256(scheduleBytes) != expectedHash`. |
| `Already published` on `publish()` | **CORRECT** | `RateScheduleRegistry.sol:92` reverts with `"Already published"` on the second store of the same hash. |
| `Zero registry` on `ContributorNFT` constructor | **CORRECT** | `ContributorNFT.sol:145` reverts with `"Zero registry"`. The doc's parenthetical "fails only if you re-ran the NFT deploy in isolation" is accurate — the `DeployContributorEconomics` script always passes `address(registry)` from step 1, so the script path can't trigger this. |
| `Zero scheduleHash` on `mint()` | **CORRECT** | `ContributorNFT.sol:191` reverts with `"Zero scheduleHash"`. |
| Gas runs out on `MilestoneEscrow.splitPayout` (>16 recipients) | **PARTIALLY WRONG** | `MilestoneEscrow.sol:104` defines `MAX_PAYOUTS = 16`, and `setPayoutMap` at line 316 reverts with **`"Too many payouts"`** on `payouts.length > 16`. So the actual revert reason is `Too many payouts` from a `require`, NOT `OutOfGas` — the doc's framing is inaccurate. Also: this row is about `MilestoneEscrow`, but `DeployContributorEconomics.s.sol` does NOT deploy `MilestoneEscrow`. The error belongs in a different doc (or this doc should clarify that the test glob covers MilestoneEscrow only for hygiene, not because this script touches it). |
| Forge `Stack too deep` → `forge build --via-ir` | **PLAUSIBLE BUT UNUSED** | `via_ir` is NOT set in `foundry.toml`. The doc's suggestion ("Build with `forge build --via-ir`") is correct as a workaround if it ever becomes necessary, but I confirmed `forge build` succeeds without it on the current contract set, so a fresh agent following the doc literally won't hit this. Keep the row for future-proofing. |
| Verification fails on BaseScan | **CORRECT** | Doc-suggested fixes (`--etherscan-api-key`, `forge verify-contract` retry) are standard. |
| Deploy reverts with no message → top up the wallet | **CORRECT** | Empty revert with no calldata error is the canonical signature of insufficient gas funds. |

Two specific fixes for this table: change "Gas runs out" to "Reverts with
`Too many payouts`" and clarify the boundary between this script and
MilestoneEscrow.

## Cross-link integrity

| Link target | Verdict | Notes |
|-------------|---------|-------|
| `docs/DEPLOY.md` (line 6) | **EXISTS** | `C:/Users/globa/pcc-contributor-economics/docs/DEPLOY.md` is present (the deploy-many CI runbook). |
| `packages/contracts/script/DeployContributorEconomics.s.sol` | **EXISTS** | Opened, parsed, dry-ran. |
| `packages/spec`'s `computeScheduleHash()` (Common Errors row 2) | **EXISTS** | `Grep computeScheduleHash` finds it in `packages/spec/src/types/rate-schedule.ts` and the matching test file. |
| `packages/contracts/deployments/base-sepolia/CaptureClassRegistry.json in the parent PCC repo` | **EXISTS** | At `C:/Users/globa/physical-capability-cloud/packages/contracts/deployments/base-sepolia/CaptureClassRegistry.json`. The doc's "see ... in the parent PCC repo for reference" prose is a little awkward (most readers won't have that repo cloned), but the link is accurate. |
| Faucet `https://www.alchemy.com/faucets/base-sepolia` | **EXISTS** (referenced twice, once in Prerequisites, once in last error row) | Standard Alchemy URL. |
| BaseScan API key `https://basescan.org/myapikey` | **EXISTS** | Standard URL. |
| `packages/gateway/src/routes/contributors.ts` | **EXISTS** | But — see next section, the env-var claim about this file is wrong. |
| `broadcast/DeployContributorEconomics.s.sol/84532/run-latest.json` | **WILL EXIST POST-DEPLOY** | Doesn't exist yet (no broadcast directory) — correct, because the deploy hasn't been run. |

No broken links.

## Substantive content issue: "Wiring into the gateway"

This is the one section that does not survive contact with the code:

> After deploy, set these env vars on the gateway service ...
> `RATE_SCHEDULE_REGISTRY_ADDRESS=0x...`
> `CONTRIBUTOR_NFT_ADDRESS=0x...`
> The gateway routes in `packages/gateway/src/routes/contributors.ts` do all of
> their primary work against the off-chain DB ... The on-chain registry is
> consulted only when a caller requests an on-chain `exists()` cross-check —
> so the gateway boots and serves traffic in "degraded mode" without these
> vars, and lights up the on-chain path once they are set.

I grep-searched the entire repo for `RATE_SCHEDULE_REGISTRY_ADDRESS` and
`CONTRIBUTOR_NFT_ADDRESS`. The ONLY file that mentions them is
`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` itself. Specifically:

```
$ grep -r "RATE_SCHEDULE_REGISTRY_ADDRESS\|CONTRIBUTOR_NFT_ADDRESS" .
docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md
```

I also searched `packages/gateway/` for `scheduleRegistry`, `rateScheduleRegistry`,
`contributorNFT` — nothing. The route at
`packages/gateway/src/routes/contributors.ts` (483 lines) handles
schedules/profiles/training-manifests against the off-chain repo and calls
`@pcc/spec`'s `computeScheduleHash` for content-addressed verification, but
has no on-chain code path. There IS no on-chain `exists()` cross-check
implemented today.

This means a fresh agent who follows the doc literally and sets those env
vars on Railway will get a no-op. Worse, an integrator reading the doc may
conclude the gateway has a stronger on-chain guarantee than it actually
provides. The right fix is one of:

1. **Edit the doc** to say "These env vars are reserved for the future
   on-chain verification path; the current gateway does not consume them
   yet" — and ideally cite the issue / branch where it WILL be wired.
2. **OR ship the wiring** — add `process.env.RATE_SCHEDULE_REGISTRY_ADDRESS` /
   `_CONTRIBUTOR_NFT_ADDRESS` reads in `contributors.ts` with a guarded
   `viem` `readContract` `exists()` call, before publishing this doc to
   external integrators.

Either is fine; mismatch-with-reality is not.

## Dry-run walkthrough

Exact copy-paste sequence for a fresh agent who has `forge`, `cast`,
`shasum`, `xxd`, and Git Bash for Windows:

```bash
# 0. Branch + sanity
cd /c/Users/globa/pcc-contributor-economics
git checkout feat/contributor-economics

# 1. Set env (per Prerequisites)
export DEPLOYER_PRIVATE_KEY=0x<funded-base-sepolia-key>
export ETHERSCAN_API_KEY=<basescan-key>

# 2. Pre-deploy gate (~30s)
cd packages/contracts
forge build
forge test --match-path 'test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}*' -vv
# Expected: 58 passed, 0 failed.

# 3. Deploy + verify (single broadcast)
forge script script/DeployContributorEconomics.s.sol:DeployContributorEconomics \
  --rpc-url https://sepolia.base.org \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  -vvvv
# Read deploy log tail. Note registry + NFT addresses. Confirm
# "ContributorNFT.scheduleRegistry: <X>" matches the registry address.

# 4. Capture deploy addresses
export RATE_SCHEDULE_REGISTRY=0x<from-deploy-log>
export CONTRIBUTOR_NFT=0x<from-deploy-log>
export BASE_SEPOLIA_RPC=https://sepolia.base.org

# 5. Verify wiring on chain
cast call "$CONTRIBUTOR_NFT" "scheduleRegistry()(address)" --rpc-url "$BASE_SEPOLIA_RPC"
# Expected: returns $RATE_SCHEDULE_REGISTRY (case-insensitive).

# 6. Smoke-publish a 40-bps constant schedule
SCHEDULE_BYTES='{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}'
SCHEDULE_HASH=$(printf '%s' "$SCHEDULE_BYTES" | shasum -a 256 | cut -d' ' -f1)
cast send "$RATE_SCHEDULE_REGISTRY" \
  "publish(bytes,bytes32)(bytes32)" \
  "0x$(printf '%s' "$SCHEDULE_BYTES" | xxd -p | tr -d '\n')" \
  "0x$SCHEDULE_HASH" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --rpc-url "$BASE_SEPOLIA_RPC"
# (Note: I prefixed the hex bytes with 0x — see Verification commands nit above.)

# 7. Confirm storage
cast call "$RATE_SCHEDULE_REGISTRY" "exists(bytes32)(bool)" "0x$SCHEDULE_HASH" \
  --rpc-url "$BASE_SEPOLIA_RPC"
# Expected: true.

# 8. Persist deployments
BLOCK=$(jq -r '.receipts[0].blockNumber' broadcast/DeployContributorEconomics.s.sol/84532/run-latest.json | xargs printf '%d')
# (or hex-decode by hand)
# Edit packages/contracts/deployments/base-sepolia/RateScheduleRegistry.json
# and ContributorNFT.json per the schema in deployments/base-sepolia/README.md.

# 9. Commit
git add packages/contracts/deployments/base-sepolia/{RateScheduleRegistry,ContributorNFT}.json
git commit -m "chore(contracts): record contributor-economics deployment on base-sepolia"

# 10. Gateway wiring — see "Specific fixes" below; the doc's claim doesn't
#     match the current code, so this step is a no-op until the wiring is
#     shipped or the doc is corrected.
```

Total wall-clock estimate (with funded wallet + working RPC): 5-10 minutes.
The pre-deploy gate is the longest single step at ~3 seconds compile + 2
seconds tests. The deploy itself is two transactions in one broadcast =
seconds at typical Base Sepolia gas.

A fresh agent could execute this end-to-end without asking questions.

## Friction scores (1-10, higher is better)

- **Could deploy off this doc alone**: 8 — the on-chain part is fully
  copy-pasteable and the doc tells you exactly what success looks like in
  the deploy log. Loses 2 points for the gateway-wiring section that points
  at code that doesn't exist.
- **Commands copy-pasteable**: 9 — every flag matches the script, every env
  var name matches `vm.envUint`, the cast signatures all resolve. One nit
  about `0x` prefix on hex bytes.
- **Errors table useful**: 6 — most rows are accurate, but the `MilestoneEscrow.splitPayout`
  row says "OutOfGas" when the actual revert is `"Too many payouts"`, and
  that whole row is about a contract this script doesn't deploy.
- **Overall**: **7.5** — solid runbook for the on-chain piece, with one
  substantive misalignment (gateway env vars) and a couple of error-row nits
  that should be corrected before this is treated as authoritative.

## Specific fixes I'd recommend

1. **"Wiring into the gateway" section — fix or qualify.** Either ship the
   on-chain `exists()` lookup in `packages/gateway/src/routes/contributors.ts`
   that consumes `RATE_SCHEDULE_REGISTRY_ADDRESS` and `CONTRIBUTOR_NFT_ADDRESS`,
   or rewrite the section to say something like: *"These env vars are reserved
   for a future on-chain verification path. Today the gateway is purely
   off-chain; setting them is a no-op until [issue #XYZ / branch foo] lands."*
   Right now the section makes a guarantee the code does not honor.

2. **Common Errors row — fix the MilestoneEscrow row.** Change
   *"Gas runs out on `MilestoneEscrow.splitPayout` | More than ~16 recipients
   in one milestone"* to *"`setPayoutMap` reverts with `"Too many payouts"` |
   `payouts.length > MAX_PAYOUTS (16)`"* — or move the row into the MilestoneEscrow
   deploy doc, since `DeployContributorEconomics.s.sol` does not deploy
   `MilestoneEscrow`.

3. **Pre-deploy commands — explain the test glob.** The glob includes
   `MilestoneEscrow*` even though this script does not deploy MilestoneEscrow.
   Add a one-liner like *"MilestoneEscrow tests run for coverage hygiene
   even though this script does not redeploy it — that contract is shared
   with the parent PCC stack and is deployed elsewhere."* Keeps a fresh
   agent from getting confused.

4. **`0x` prefix on hex bytes.** In the smoke-publish `cast send` block,
   prepend `0x` explicitly to the schedule-bytes argument:
   `"0x$(printf '%s' "$SCHEDULE_BYTES" | xxd -p | tr -d '\n')"`. cast usually
   infers, but explicit is safer.

5. **Drop the `~/.credentials.json` line from Prerequisites.** It's a
   harness-internal nicety that doesn't affect the deploy. Reads as noise to
   a fresh agent without the harness.

6. **Mention `forge --version` 1.5+ as a soft floor.** The script uses
   `vm.envUint`, `console.log`, and `vm.startBroadcast` — all stable in 1.x —
   but newer flag behavior (e.g. `--verify`) has shifted across major
   versions. A one-liner *"tested with forge 1.5+"* would inoculate against
   silent breakage if the agent has 0.x lying around.

---

**Summary**: The on-chain runbook is a B+ — accurate, copy-pasteable,
well-structured. The gateway-wiring section is a hallucinated guarantee
that wants either implementation or correction. Two error-table rows want
small edits. With those five fixes, this doc is ready to be the canonical
deploy reference for the contributor-economics contracts.
