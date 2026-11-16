# Settlement client re-check kit

Run 1 ships the data kit at `@pcc/spec/recheck` in this clone and the public discovery document at `/.well-known/pcc-settlement-recheck.json`. No settlement reader is registered by this change; the unbound settlement routes continue to answer 503 INDEX_NOT_READY.

Current kitVersion: `1.0.1`.

Current kitSha256: `6bcc742fc79db0d01bbe18056d530ba169850ce634867e993d879176efaba97d`.

## What a MATCH proves

A MATCH means this chain-checkable field equals what the user's RPC returns at the reply's pin, read from a genuine EIP-1167 clone of a deployment the embedded kit knows. It proves chain agreement as of that block. The report must state the block; a non-terminal unit may have moved since.

It does not prove PCC brokerage, the assetReality registry verdict, provenance leaves, logCompleteness, or current state. It proves nothing if the user's RPC lies. A known deployment's permissionless factory can create units for anyone.

## Trust model

The client trusts its own embedded kit from the clone's `@pcc/spec/recheck` source. The descriptor is discovery and transparency at the gateway's own origin; fetching it only compares kitSha256 and warns on a difference. It cannot authenticate a gateway reply. The RPC is another trust point: the report names its origin, and you can cross-check it by re-running against a second, independent RPC.

The descriptor is static, public, cacheable for five minutes and independent of environment variables. Its content object has keys `schema`, `kitVersion`, `readSurfaces`, `abi` and `deployments`, in that order. kitSha256 is the lower-case hexadecimal SHA-256 of the UTF-8 bytes of `JSON.stringify(content)`, without indentation, before adding kitSha256. The kit has no viem runtime import.

All calls and code reads are pinned with EIP-1898 `{ blockHash: asOfBlockHash, requireCanonical: true }`. The pin's number and canonical hash are checked against the user's node, and finality is checked against that node's finalized head. Logs scan `[fromBlock, asOfBlock]`; each log's blockHash must be canonical at its block number. Addresses compare lower-case; amounts compare as canonical decimal strings without a sign or leading zeros. Deployment identities are lower-case by contract and contain exactly chainId, factory, implementation and recordSha256.

The ABI is included verbatim in the descriptor's `abi` member and in [abi.ts](../packages/spec/src/recheck/abi.ts). The exact deployment record bytes remain in git under [deployments/vnext](../packages/contracts/deployments/vnext/). The kit stores validated fields and the record's exact-byte SHA-256. The record layout holds one canonical record per network (deployments/vnext/<network>/CANONICAL.json), and C8 requires one kit entry per such record. A pre-redeploy reply stays re-checkable after a same-network redeploy only once a location for superseded records exists; the next same-network redeploy has to define it first. recordBlockNumber is only a log-scan lower bound: on Base Sepolia factory.implementation() has no result at block 48179681 but returns the implementation at 48180192.

## Field table

Each row is one (route, JSON pointer); `*` denotes an array index. Money rows are marked yes. Null economics is NOT_CLAIMED; non-null economics supports one payout leg only. The receipt's amount is the recipient's amount (net of the fee), the payee's net n, never the buyer's gross g = n + f. Its token is chain-checkable against USDC(), while the assetReality verdict remains registry-only.

The gateway mapper follows the contract's refund causes, inline settlement and emergency cap on these rows. E2 marks the single-leg economics and registry limitations. Off-chain leaves and revisions remain NOT_CHAIN_CHECKABLE.

| Route | Pointer | Source | Reads | Rule | Money | Drift |
|---|---|---|---|---|---|---|
| lifecycle | `/chainId` | chain-header | eth_chainId | Equals eth_chainId and /deployment/chainId. | yes |  |
| receipt | `/chainId` | chain-header | eth_chainId | Equals eth_chainId and /deployment/chainId. | yes |  |
| provenance | `/chainId` | chain-header | eth_chainId | Equals eth_chainId and /deployment/chainId. | yes |  |
| lifecycle | `/escrow` | chain-code, chain-state | code(escrow): eip1167; escrow.initialized(); escrow.unitExists(unitId) | Code is the EIP-1167 runtime 0x363d3d373d3d3d363d73 followed by the known implementation and 0x5af43d82803e903d91602b57fd5bf3; initialized() is true (only the factory initializes a clone), and the unit exists. | yes |  |
| receipt | `/escrow` | chain-code, chain-state | code(escrow): eip1167; escrow.initialized(); escrow.unitExists(unitId) | Code is the EIP-1167 runtime 0x363d3d373d3d3d363d73 followed by the known implementation and 0x5af43d82803e903d91602b57fd5bf3; initialized() is true (only the factory initializes a clone), and the unit exists. | yes |  |
| provenance | `/escrow` | chain-code, chain-state | code(escrow): eip1167; escrow.initialized(); escrow.unitExists(unitId) | Code is the EIP-1167 runtime 0x363d3d373d3d3d363d73 followed by the known implementation and 0x5af43d82803e903d91602b57fd5bf3; initialized() is true (only the factory initializes a clone), and the unit exists. | yes |  |
| lifecycle | `/unitId` | echo, chain-state | escrow.unitExists(unitId) | Equals the requested unit, which exists at the pin. | yes |  |
| receipt | `/unitId` | echo, chain-state | escrow.unitExists(unitId) | Equals the requested unit, which exists at the pin. | yes |  |
| provenance | `/unitId` | echo, chain-state | escrow.unitExists(unitId) | Equals the requested unit, which exists at the pin. | yes |  |
| lifecycle | `/deployment` | kit | none | An object with exactly chainId, factory, implementation and recordSha256. | yes |  |
| receipt | `/deployment` | kit | none | An object with exactly chainId, factory, implementation and recordSha256. | yes |  |
| provenance | `/deployment` | kit | none | An object with exactly chainId, factory, implementation and recordSha256. | yes |  |
| lifecycle | `/deployment/chainId` | chain-header | eth_chainId | Equals eth_chainId. | yes |  |
| receipt | `/deployment/chainId` | chain-header | eth_chainId | Equals eth_chainId. | yes |  |
| provenance | `/deployment/chainId` | chain-header | eth_chainId | Equals eth_chainId. | yes |  |
| lifecycle | `/deployment/factory` | chain-state | escrow.factory() | Equals escrow.factory() and the known deployment's factory. | yes |  |
| receipt | `/deployment/factory` | chain-state | escrow.factory() | Equals escrow.factory() and the known deployment's factory. | yes |  |
| provenance | `/deployment/factory` | chain-state | escrow.factory() | Equals escrow.factory() and the known deployment's factory. | yes |  |
| lifecycle | `/deployment/implementation` | chain-state, chain-code | factory.implementation(); code(implementation): codehash | Equals factory.implementation(); keccak256(code) equals the known deployment's implementationCodehash. | yes |  |
| receipt | `/deployment/implementation` | chain-state, chain-code | factory.implementation(); code(implementation): codehash | Equals factory.implementation(); keccak256(code) equals the known deployment's implementationCodehash. | yes |  |
| provenance | `/deployment/implementation` | chain-state, chain-code | factory.implementation(); code(implementation): codehash | Equals factory.implementation(); keccak256(code) equals the known deployment's implementationCodehash. | yes |  |
| lifecycle | `/deployment/recordSha256` | kit | none | Names a KNOWN_DEPLOYMENTS entry whose chainId, factory and implementation equal /deployment/chainId, /deployment/factory and /deployment/implementation. | yes |  |
| receipt | `/deployment/recordSha256` | kit | none | Names a KNOWN_DEPLOYMENTS entry whose chainId, factory and implementation equal /deployment/chainId, /deployment/factory and /deployment/implementation. | yes |  |
| provenance | `/deployment/recordSha256` | kit | none | Names a KNOWN_DEPLOYMENTS entry whose chainId, factory and implementation equal /deployment/chainId, /deployment/factory and /deployment/implementation. | yes |  |
| lifecycle | `/asOfBlock` | chain-header | block by hash: asOfBlockHash | The block exists and its number equals this decimal string. | yes |  |
| receipt | `/asOfBlock` | chain-header | block by hash: asOfBlockHash | The block exists and its number equals this decimal string. | yes |  |
| provenance | `/asOfBlock` | chain-header | block by hash: asOfBlockHash | The block exists and its number equals this decimal string. | yes |  |
| lifecycle | `/asOfBlockHash` | chain-header | block by number: asOfBlock | The canonical block at asOfBlock has this hash. | yes |  |
| receipt | `/asOfBlockHash` | chain-header | block by number: asOfBlock | The canonical block at asOfBlock has this hash. | yes |  |
| provenance | `/asOfBlockHash` | chain-header | block by number: asOfBlock | The canonical block at asOfBlock has this hash. | yes |  |
| lifecycle | `/finality` | chain-header | block finalized | Equals finalized, and asOfBlock is at most the node's finalized number. | yes |  |
| receipt | `/finality` | chain-header | block finalized | Equals finalized, and asOfBlock is at most the node's finalized number. | yes |  |
| provenance | `/finality` | chain-header | block finalized | Equals finalized, and asOfBlock is at most the node's finalized number. | yes |  |
| lifecycle | `/logCompleteness` | gateway-claim | none | Reported, not checked; UNKNOWN log fields read as NOT_CLAIMED. | no |  |
| receipt | `/logCompleteness` | gateway-claim | none | Reported, not checked; UNKNOWN log fields read as NOT_CLAIMED. | no |  |
| provenance | `/logCompleteness` | gateway-claim | none | Reported, not checked; UNKNOWN log fields read as NOT_CLAIMED. | no |  |
| lifecycle | `/unitState` | chain-state | escrow.settlement(unitId) → state_ | Equals settlement state_. | yes |  |
| lifecycle | `/phase` | derived | inputs: /unitState | Equals PHASE_BY_STATE: 1 active; 2-3 contest; 4-5 escalation; 6-7 allocated; 8-9 settled. | yes |  |
| receipt | `/phase` | derived | inputs: /unitState | Equals PHASE_BY_STATE: 1 active; 2-3 contest; 4-5 escalation; 6-7 allocated; 8-9 settled. | yes |  |
| lifecycle | `/finalState` | derived | inputs: /unitState | State 8 gives SETTLED_RELEASED; 9 gives SETTLED_REFUNDED; otherwise null. | yes |  |
| receipt | `/finalState` | derived | inputs: /unitState | State 8 gives SETTLED_RELEASED; 9 gives SETTLED_REFUNDED; otherwise null. | yes |  |
| lifecycle | `/isTerminal` | derived | inputs: /unitState | True exactly when state is in TERMINAL_STATES {8, 9}. | yes |  |
| lifecycle | `/isAllocated` | derived | inputs: /unitState | True exactly when state is in ALLOCATED_STATES {6, 7}. | yes |  |
| receipt | `/isAllocated` | derived | inputs: /unitState | True exactly when state is in ALLOCATED_STATES {6, 7}. | yes |  |
| lifecycle | `/windowEndsAt` | derived | escrow.settlement(unitId) → assertedAt_; escrow.settlement(unitId) → challengedAt_; escrow.unitTerms(unitId) → reclaimAt_; escrow.emergencyAnchorOf(unitId); inputs: /unitState, deployment.challengeWindowSec, deployment.appealWindowSec | States 2 and 5: assertedAt + challengeWindowSec; state 3: challengedAt + appealWindowSec, capped at a non-zero emergency anchor; state 4: reclaimAt - challengeWindowSec - appealWindowSec; otherwise null, with non-null results as decimal strings. | yes |  |
| receipt | `/network` | echo | none | An object with exactly chainId. | yes |  |
| receipt | `/network/chainId` | echo | inputs: /chainId | Equals /chainId. | yes |  |
| receipt | `/assetReality` | registry | none | Null or the registry envelope, whose verdict is NOT_CHAIN_CHECKABLE. | yes | E2 |
| receipt | `/assetReality/value` | registry | none | One of real, test or unknown; NOT_CHAIN_CHECKABLE. | yes |  |
| receipt | `/assetReality/source` | derived | none | The constant registry. | no |  |
| receipt | `/assetReality/contractOrRegistryId` | registry | none | NOT_CHAIN_CHECKABLE. | no |  |
| receipt | `/assetReality/revision` | registry | none | NOT_CHAIN_CHECKABLE. | no |  |
| receipt | `/assetReality/attests` | derived | none | The constant identity-not-liveness. | yes |  |
| receipt | `/economics` | derived | escrow.unitCounters(unitId) → payoutCount_ | Null is NOT_CLAIMED; non-null is allowed only when payoutCount_ is 1. | yes | E2 |
| receipt | `/economics/amount` | chain-state | escrow.payoutAt(unitId, 0) → amount | The recipient's amount (net of the fee): equals payoutAt amount, which for one leg equals feeAmountsOf n_, never the buyer's gross. | yes | E2 |
| receipt | `/economics/feeAmount` | chain-state | escrow.feeAmountsOf(unitId) → f_ | Equals feeAmountsOf f_. | yes |  |
| receipt | `/economics/recipient` | chain-state | escrow.payoutAt(unitId, 0) → recipient | Equals payoutAt recipient, compared lower-case. | yes | E2 |
| receipt | `/economics/token` | chain-state | escrow.USDC() | Equals USDC() and the known deployment's usdc. | yes |  |
| receipt | `/economics/assuranceTier` | chain-state | escrow.requiredTierOf(unitId) | Equals requiredTierOf; at funding requiredTier must equal requestedTier. | yes | E2 |
| receipt | `/refundReason` | chain-log | escrow.Finalized (unitId topic 1); escrow.EscalationResolved (unitId topic 1) | Null unless state is 7 or 9; witnessed causes are Finalized reason 2 BACKUP_NO_RELEASE, 3 EMERGENCY_SILENCE, 4 DEADLINE_RECLAIM, or EscalationResolved not upheld with role 1 APPEAL_OVERTURN or role 2 EMERGENCY_OVERTURN; UNKNOWN is NOT_CLAIMED. | yes |  |
| receipt | `/refundReason/value` | chain-log | escrow.Finalized (unitId topic 1); escrow.EscalationResolved (unitId topic 1) | Equals the witnessed refund cause. | yes |  |
| receipt | `/refundReason/source` | derived | none | The constant log. | no |  |
| receipt | `/refundReason/chain` | derived | inputs: /chainId | Equals eip155: followed by chainId. | no |  |
| receipt | `/refundReason/contractOrRegistryId` | echo | inputs: /escrow | Equals /escrow. | no |  |
| receipt | `/refundReason/blockNumber` | echo | inputs: /asOfBlock | Equals /asOfBlock (the pin, not the log's block). | no |  |
| receipt | `/refundReason/blockHash` | echo | inputs: /asOfBlockHash | Equals /asOfBlockHash. | no |  |
| receipt | `/refundReason/finality` | echo | inputs: /finality | Equals /finality. | no |  |
| receipt | `/refundReason/completeness` | echo | inputs: /logCompleteness | Equals /logCompleteness. | no |  |
| receipt | `/finalizedBlock` | chain-log | escrow.ReleaseAllocated (unitId topic 1); escrow.RefundAllocated (unitId topic 1); escrow.ClaimCreated (unitId topic 2); escrow.ClaimDischarged (unitId topic 2) | Null unless state is 8 or 9; inline settlement uses the allocation event block when claimCount is 0, and deferred settlement uses the ClaimDischarged block that discharged the last job-class claim (classes 0-2); UNKNOWN is NOT_CLAIMED. | yes |  |
| receipt | `/finalizedBlock/value` | chain-log | escrow.ReleaseAllocated (unitId topic 1); escrow.RefundAllocated (unitId topic 1); escrow.ClaimCreated (unitId topic 2); escrow.ClaimDischarged (unitId topic 2) | Equals that settlement block number as a decimal string. | yes |  |
| receipt | `/finalizedBlock/source` | derived | none | The constant log. | no |  |
| receipt | `/finalizedBlock/chain` | derived | inputs: /chainId | Equals eip155: followed by chainId. | no |  |
| receipt | `/finalizedBlock/contractOrRegistryId` | echo | inputs: /escrow | Equals /escrow. | no |  |
| receipt | `/finalizedBlock/blockNumber` | echo | inputs: /asOfBlock | Equals /asOfBlock (the pin, not the log's block). | no |  |
| receipt | `/finalizedBlock/blockHash` | echo | inputs: /asOfBlockHash | Equals /asOfBlockHash. | no |  |
| receipt | `/finalizedBlock/finality` | echo | inputs: /finality | Equals /finality. | no |  |
| receipt | `/finalizedBlock/completeness` | echo | inputs: /logCompleteness | Equals /logCompleteness. | no |  |
| provenance | `/provenanceAvailability` | derived, gateway-claim | escrow.unitTerms(unitId) → compositionSchemaVersion_ | When compositionSchemaVersion_ is 0 (non-composed), UNANCHORED is required; otherwise this is the gateway DA claim and NOT_CHAIN_CHECKABLE. | no |  |
| provenance | `/compositionRoot` | chain-state | escrow.compositionRootOf(unitId) | Equals compositionRootOf when provenanceAvailability is AVAILABLE. | no |  |
| provenance | `/revision` | offchain | none | NOT_CHAIN_CHECKABLE. | no |  |
| provenance | `/leaves` | offchain | none | NOT_CHAIN_CHECKABLE. | no |  |
| provenance | `/leaves/*` | offchain | none | NOT_CHAIN_CHECKABLE. | no |  |
| provenance | `/leaves/*/kind` | offchain | none | NOT_CHAIN_CHECKABLE. | no |  |
| provenance | `/leaves/*/value` | offchain | none | NOT_CHAIN_CHECKABLE. | no |  |
| provenance | `/nextCursor` | offchain | none | NOT_CHAIN_CHECKABLE. | no |  |

## Pruned nodes and log caps

The replay CLI behaves as follows. A pruned pin reports PIN_STATE_UNAVAILABLE, never a mismatch. With `--later-block-for-terminal`, terminal and frozen facts (/unitState, /phase, /finalState, /isTerminal, /isAllocated and the /economics fields) may be checked at the user's node's own finalized hash only when finalState is non-null. States 8 and 9 have no exit and economics freeze at funding. The report marks the later block; all other unavailable rows remain UNVERIFIED.

The replay requires `--rpc` with no default. Transport uses a `pcc-settlement-recheck/<kitVersion>` User-Agent, a 20-second timeout and one retry on a transport error, never on a JSON-RPC error. Hosted nodes may cap or refuse logs: the observed Base Sepolia public limit was 200 blocks, while the Base mainnet endpoint refused eth_getLogs. A scan starts at 2,000 blocks and halves on range-limit errors to a 50-block floor. The default budget is 1,000 requests, starting at the deployment's recordBlockNumber unless `--from-block` is supplied. Refusal, an unsatisfied cap or budget exhaustion makes log rows UNVERIFIED, never MISMATCH. `--no-logs` skips them.

A node that has not finalized the reply's pin yields UNVERIFIED finality. Mixed pins across replies are refused as INCONSISTENT_REPLIES unless explicitly allowed. The report says MATCH, MISMATCH, UNVERIFIED, NOT_CHAIN_CHECKABLE or NOT_CLAIMED for each field, including its expected and received values, read block and knownDrift. It states that chain agreement does not establish brokerage or current state.

## Versioning

Each deployment names its readSurface; each read surface owns its map. The record layout holds one canonical record per network (deployments/vnext/<network>/CANONICAL.json), and C8 requires one kit entry per such record. A pre-redeploy reply stays re-checkable after a same-network redeploy only once a location for superseded records exists; the next same-network redeploy has to define it first. A new map is added only if the read surface changes. C8 rejects missing or uncommitted entries. KIT_VERSION and kitSha256 are pinned together by C10, so changes need a deliberate version bump and new digest. ABI read selectors and all six filtered event topic0s are pinned by VNextAbiFreeze.t.sol and listed in [ABI §7](VNEXT_SETTLEMENT_ABI.md#7-type-level-freeze-function-selectors). Changing a pinned read is a §9 class-1 change.

## Running the check

Until the operator's publication go, the replay CLI runs from a clone. Run these commands in the clone:

```sh
pnpm install
pnpm --filter @pcc/spec build
node packages/spec/dist/recheck/cli.js --rpc <url> --reply <file>
```

The last command runs the replay CLI. viem resolves from SPEC's devDependency in the clone. Neither run publishes the package.
