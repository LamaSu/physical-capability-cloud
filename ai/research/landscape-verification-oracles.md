# Landscape Report: Verification Oracle Integration for PCC

**Date**: 2026-03-23
**Scout**: wheel-scout
**Task**: Evaluate UMA Optimistic Oracle, Chainlink Functions, and EigenLayer AVS as verification oracle backends for PCC evidence bundles (JSON, 1-50KB proving physical work was done). Replacing current Bittensor mock.

---

## Executive Summary

Three real, deployed systems exist today for decentralized evidence verification. UMA OOv3 is the strongest fit for PCC's use case — it is the only system designed for arbitrary data truth claims (not just price feeds), is live on Base mainnet, and has direct TypeScript integration paths. Chainlink Functions is live on Base mainnet but is designed for API fetch/compute tasks, not dispute-driven evidence adjudication. EigenLayer AVS is technically available but requires building and operating a full validator network — it is a 6-12 month future track, not a today integration. No off-the-shelf project solves PCC's exact problem (evidence bundle → settlement), but DirectHelp (UMA OO + EAS for charity fund disbursement) is the closest analog and confirms the UMA path is viable.

**Bottom line**: EXTEND UMA (build a thin adapter), ADOPT Chainlink Functions toolkit as fallback compute layer, BUILD EigenLayer AVS as a future track.

---

## UMA Optimistic Oracle

### npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `@uma/contracts-node` | 0.4.25 (Jan 2026) | ABI + addresses for all deployed UMA contracts (use this for TypeScript integration) |
| `@uma/core` | latest | Contract artifacts (deprecated in favor of contracts-node for ABIs) |
| `@uma/common` | latest | Common JS utilities used across UMA packages |
| `@uma/optimistic-oracle` | latest | Convenience wrapper (limited README, less maintained) |

**Install**: `npm i @uma/contracts-node @uma/common`

The `@uma/contracts-node` package is the canonical package for TypeScript integrations — it exports ABIs, bytecode, and official addresses per network. The package was updated 2 months ago (January 2026), indicating active maintenance.

Note: There is also a separate `uma-js-sdk` from the "UMA Universal Money Address" project (`github.com/uma-universal-money-address/uma-js-sdk`) — this is an **unrelated project** (Lightning Network payment addressing), not UMA protocol.

### Contract Addresses

UMA maintains a canonical network addresses page at `docs.uma.xyz/resources/network-addresses`. The `@uma/contracts-node` package encodes these per-chain JSON files.

**Known confirmed networks** (OOv3 deployed):
- **Ethereum Mainnet** (1): fully supported, DVM governance lives here
- **Optimism** (10): deployed
- **Polygon** (137): deployed
- **Arbitrum** (42161): deployed
- **Base Mainnet** (8453): **deployed** — confirmed by UMA docs and the network supports "fully permissionless settlement and DVM support"
- **Base Sepolia** (84532): deployed for testing
- **Sepolia** (11155111): `0x78b46a3fE653f90637e67c502d816c7F97D4a504` (confirmed in search results)

**To get the exact OOv3 address on Base programmatically** (most reliable pattern):

```typescript
import { getAddress } from "@uma/contracts-node";

// Returns the OptimisticOracleV3 address for the given chainId
const ooV3Address = await getAddress("OptimisticOracleV3", 8453);
```

Or via the on-chain Finder contract (UMA's registry):
```solidity
// Finder.getImplementationAddress(bytes32("OptimisticOracleV3"))
```

**Verified OOv3 address on Base Mainnet**: Confirm at runtime via `@uma/contracts-node` `getAddress("OptimisticOracleV3", 8453)`. The docs confirm Base mainnet is a fully supported chain with DVM escalation path.

### Assertion Flow (OOv3 — "assertTruth" pattern)

OOv3 is a **"True or False"** oracle — the asserter claims a statement is true. This maps directly to PCC's use case: "this evidence bundle proves physical work was done."

**Step-by-step**:

1. **Asserter approves bond currency** (USDC) to OOv3 contract
2. **Asserter calls `assertTruthWithDefaults(claim, asserter)`** — `claim` is a bytes array (ASCII text or encoded evidence hash), `asserter` is who receives bond on settlement
3. **2-hour liveness window opens** (configurable, default is 7200 seconds)
4. **If no dispute**: anyone calls `settleAssertion(assertionId)` → callback fires → assertion is TRUE → downstream contract logic executes
5. **If disputed**: DVM (UMA token holders on Ethereum mainnet) vote on the outcome. Takes ~48-96 hours.

For PCC specifically, use the **Data Asserter** pattern (extends the basic assertTruth):
```
assertDataFor(bytes32 dataId, bytes32 data, address asserter)
```
This associates a specific `dataId` (e.g., keccak256 of evidence bundle ID) with a `data` value (e.g., keccak256 of the evidence JSON hash), enabling the downstream contract to look up the asserted data by ID.

### Dispute Mechanism

- Any party can call `disputeAssertion(assertionId, disputer)` within the liveness window
- Disputer must post the same bond as the asserter (minimum: `getMinimumBond(token)`)
- If dispute is filed → escalated to the **DVM** (Decentralized Verification Mechanism) on Ethereum mainnet — UMA token holders vote
- DVM resolution takes 48-96 hours
- If asserter wins dispute: asserter gets back bond + half of disputer's bond
- If disputer wins: disputer gets 1.5x their bond back; the UMA Store gets the remainder
- The economic incentive design makes frivolous disputes expensive and good-faith assertions safe

### Cost Per Verification

- **Bond**: Minimum bond = `getMinimumBond(currency)`. Default example in docs uses **500 USDC** (minimum), but the docs also show 10,000 USDC for Polymarket-style markets. For PCC, set to the minimum or a small value like 500 USDC.
- **Bond is fully refunded** if assertion is not disputed (it is not a fee, it is a deposit)
- **Final fee**: A small flat fee goes to the UMA Store on settlement (~tens of dollars in USDC depending on network)
- **Gas**: One `assertTruthWithDefaults` call + one `settleAssertion` call. On Base L2, this is very cheap (cents to low dollars)
- **Dispute cost**: Only if disputed. If you're PCC submitting truthful evidence, bonds are returned. Net cost is gas + final fee only.
- **Effective cost for undisputed assertion on Base**: ~$1-5 total (gas + final fee) + the bond locked for 2 hours

### Production Ready

**YES.** UMA OOv3 is live on Base mainnet. It secured over **$1 billion in Polymarket betting volume in 2025**. Multiple major protocols integrate it in production (Polymarket, Story Protocol, various insurance protocols). The `@uma/contracts-node` 0.4.25 was published January 2026.

### TypeScript Code Example (viem pattern)

```typescript
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbiParameters, toHex, keccak256, stringToBytes } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, getAbi } from "@uma/contracts-node";

const OOV3_ADDRESS = await getAddress("OptimisticOracleV3", 8453);
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const BOND_AMOUNT = 500_000_000n; // 500 USDC (6 decimals)
const LIVENESS = 7200; // 2 hours in seconds

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({ account, chain: base, transport: http() });

// 1. Approve bond
await walletClient.writeContract({
  address: USDC_ADDRESS,
  abi: erc20Abi,
  functionName: "approve",
  args: [OOV3_ADDRESS, BOND_AMOUNT],
});

// 2. Encode the claim (evidence bundle hash as bytes)
const evidenceHash = keccak256(toHex(JSON.stringify(evidenceBundle)));
const claim = encodeAbiParameters(
  parseAbiParameters("bytes32"),
  [evidenceHash]
);

// 3. Submit assertion
const assertionId = await walletClient.writeContract({
  address: OOV3_ADDRESS,
  abi: await getAbi("OptimisticOracleV3"),
  functionName: "assertTruthWithDefaults",
  args: [claim, account.address],
});

// 4. Wait for liveness, then settle (anyone can call this)
// After 2 hours:
await walletClient.writeContract({
  address: OOV3_ADDRESS,
  abi: await getAbi("OptimisticOracleV3"),
  functionName: "settleAssertion",
  args: [assertionId],
});
```

**For the Data Asserter pattern** (maps evidence ID → hash on-chain):
Deploy a thin `EvidenceAsserter` contract that:
1. Accepts `(bytes32 evidenceBundleId, bytes32 evidenceHash)` from PCC operator
2. Calls `oov3.assertDataFor(evidenceBundleId, evidenceHash, asserter)`
3. Implements `assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully)` to finalize settlement

---

## Chainlink Functions

### npm Packages

| Package | Version | Purpose |
|---------|---------|---------|
| `@chainlink/functions-toolkit` | latest (GitHub: smartcontractkit/functions-toolkit) | Off-chain toolkit: simulate requests, manage subscriptions, encode/decode requests |
| `@chainlink/contracts` | latest | Solidity interfaces including `FunctionsClient` base contract |
| `@chainlink/cre-sdk` | latest | New Chainlink Runtime Environment SDK (2025, for orchestration layer) |

**Install**: `npm i @chainlink/functions-toolkit @chainlink/contracts`

### Contract Addresses on Base

Chainlink Functions went **live on Base Mainnet in April 2024** (confirmed via PR Newswire announcement). Base Sepolia was an open beta before that.

**Base Mainnet (8453)**:
- FunctionsRouter: Confirm at `docs.chain.link/chainlink-functions/supported-networks`
- DON ID: `fun-base-mainnet-1` (hex: `0x66756e2d626173652d6d61696e6e65742d310000000000000000000000000000`)
- LINK Token on Base: `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196`

**Base Sepolia (84532)**:
- FunctionsRouter: `0xf9B8fc078197181C841c296C876945aaa425B278` (from search result cross-reference)
- DON ID: `fun-base-sepolia-1`

> Note: Always verify current addresses at `docs.chain.link/chainlink-functions/supported-networks` — the canonical source.

### Request Flow

Chainlink Functions is **compute-on-demand**, not a dispute oracle. The pattern is:

1. **Consumer contract** inherits `FunctionsClient`, calls `sendRequest(source, args, subscriptionId, gasLimit, donId)`
2. `source` is JavaScript code (up to 30KB) that runs on the DON (Decentralized Oracle Network)
3. DON nodes independently execute the JS, reach consensus on the result, and call back your contract via `fulfillRequest(requestId, response, err)`
4. Result is the return value of your JS function (max 256 bytes)

**For PCC evidence verification**:
- Submit evidence bundle hash as `args`
- The JS source fetches the evidence from IPFS/HTTP, validates it, returns `0x01` (valid) or `0x00` (invalid)
- Up to 5 external HTTP requests allowed per execution, max 30 seconds runtime

**Subscription management** (required before any request):
```typescript
import { SubscriptionManager, simulateScript } from "@chainlink/functions-toolkit";

const sm = new SubscriptionManager({ signer, linkTokenAddress, functionsRouterAddress });
await sm.initialize();
const subscriptionId = await sm.createSubscription();
await sm.fundSubscription({ subscriptionId, juelsAmount: BigInt(1e18) }); // 1 LINK
await sm.addConsumer({ subscriptionId, consumerAddress: myContract });
```

### Cost Per Request

- **LINK-denominated**: Variable per request based on gas price, callback gas limit, and DON premium
- **Approximate cost**: 0.1 - 0.5 LINK per request on Base (significantly cheaper than Ethereum mainnet)
- **At ~$10/LINK (historical)**: roughly $1-5 per verification request
- Costs are deducted from a pre-funded subscription balance
- **No bond mechanism** — this is a payment, not a deposit. Once spent, not returned.

### Production Ready

**YES.** Chainlink Functions is in production on Base Mainnet since April 2024. It is used by many live protocols for off-chain API access and custom computation. However, it is **not a dispute oracle** — it has no dispute mechanism, no challenge window. The DON reaches consensus internally. This makes it less suitable as a primary evidence verification system (no appeals mechanism) but excellent as a **fallback compute oracle** (e.g., programmatic rule-based evidence checking without human dispute capability).

### TypeScript Code Example

```typescript
import {
  SubscriptionManager,
  buildRequestCBOR,
  Location,
  CodeLanguage,
  ReturnType,
} from "@chainlink/functions-toolkit";
import { ethers } from "ethers";

// The JS source that runs on the DON
const SOURCE = `
  const evidenceHash = args[0];
  const evidenceUrl = args[1];

  const response = await Functions.makeHttpRequest({
    url: evidenceUrl,
    method: "GET",
  });

  if (response.error) return Functions.encodeUint256(0n);

  const data = response.data;
  const computedHash = /* hash logic */;

  return computedHash === evidenceHash
    ? Functions.encodeUint256(1n)
    : Functions.encodeUint256(0n);
`;

// Build and encode the request
const requestCBOR = buildRequestCBOR({
  codeLocation: Location.Inline,
  codeLanguage: CodeLanguage.JavaScript,
  source: SOURCE,
  args: [evidenceHash, evidenceUrl],
  secretsLocation: Location.DONHosted,
});

// Call sendRequest on your FunctionsConsumer contract
await consumerContract.sendRequest(
  SOURCE,
  Location.Inline,
  "0x", // no secrets
  [evidenceHash, evidenceUrl], // args
  [], // bytesArgs
  subscriptionId,
  300_000, // callbackGasLimit
);
```

**Solidity consumer skeleton**:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {FunctionsClient} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest} from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

contract EvidenceVerifier is FunctionsClient {
    using FunctionsRequest for FunctionsRequest.Request;

    mapping(bytes32 => bool) public verifiedEvidence;

    constructor(address router) FunctionsClient(router) {}

    function requestVerification(
        string calldata source,
        string[] calldata args,
        uint64 subscriptionId,
        uint32 gasLimit,
        bytes32 donId
    ) external returns (bytes32 requestId) {
        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(source);
        req.setArgs(args);
        return _sendRequest(req.encodeCBOR(), subscriptionId, gasLimit, donId);
    }

    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) internal override {
        if (err.length == 0 && abi.decode(response, (uint256)) == 1) {
            verifiedEvidence[requestId] = true;
        }
    }
}
```

---

## EigenLayer AVS

### npm / Development Packages

| Tool | Type | Purpose |
|------|------|---------|
| `@eigenlabs/devkit-cli` | CLI (npm) | Scaffold, develop, test AVS — "zero to working product in under an hour" |
| `eigensdk-go` | Go module | Full SDK for building AVS operators in Go (github.com/Layr-Labs/eigensdk-go) |
| `hello-world-avs` | Reference repo | TypeScript/Solidity example AVS (github.com/Layr-Labs/hello-world-avs) |
| Hourglass | Framework | Task-based execution framework for task dispatch, operator execution, result aggregation |

**Install devkit**: `npm install -g @eigenlabs/devkit-cli` (or via the `hgctl` binary in Hourglass)

**Note**: There is **no standalone npm SDK** for consuming an existing AVS. EigenLayer's TypeScript tooling is focused on **building** AVS infrastructure, not integrating with it as a client. The operator-side is primarily Go.

### Current State (March 2026)

- **TVL**: $19.7 billion in restaked ETH
- **DevKit + Hourglass** went live on testnet in mid-2025 (confirmed tweet: "DevKit, Hourglass, and Multichain are now live on Testnet" — @eigenlayer, June 2025)
- **Mainnet**: AVS registration and restaking are live on Ethereum mainnet. Slashing is live. Over 40 AVSs are registered.
- **EigenCloud**: The rebranded product layer (previously EigenLayer) — now calling itself a "Verifiable Cloud"
- **UMA + EigenLayer collaboration**: Both teams are actively researching a next-generation oracle that uses EigenLayer restakers for dispute resolution — this is the "future track" that is relevant to PCC's roadmap

### What Building an AVS Looks Like Today

Building a PCC Evidence Verification AVS would require:

1. **Define task contract** (Solidity): Emits a `NewTaskCreated(uint32 taskNum, Task task)` event when evidence bundle submitted
2. **Implement operator binary** (Go + TypeScript): Off-chain daemon that watches for task events, fetches+validates evidence, signs a response
3. **Aggregator service**: Collects operator signatures, reaches BLS quorum threshold, submits aggregated response on-chain
4. **Registration**: Deploy contracts, register AVS with EigenLayer's `AVSDirectory`, configure operator staking requirements
5. **Operator recruitment**: Convince existing EigenLayer operators to opt-in to your AVS (they must download your binary)
6. **Slashing conditions**: Define under what conditions operators get slashed for wrong answers

**Timeline**: 3-6 months minimum to reach a functional testnet AVS. Mainnet launch requires audits, operator acquisition, and TVL to make slashing economically meaningful.

### Production Ready for PCC

**NO — not as an immediate integration.** AVS is a platform for building decentralized compute networks, not a plug-in oracle. You'd be building the oracle, not consuming one. This is the correct 12-24 month evolution path for PCC once the network has sufficient operator count and staking, but it is not a "replace the mock next sprint" option.

The UMA + EigenLayer joint research (announced via The Block) points toward a future where UMA's dispute mechanism is backed by EigenLayer restakers instead of UMA token holders — this would be the ideal end state for PCC, but it does not exist as a shipping product today.

---

## Existing Solutions Found

| # | Solution | Description | Solves PCC Problem? | Maintained? | Recommendation |
|---|----------|-------------|---------------------|-------------|----------------|
| 1 | [UMA OOv3 + DataAsserter](https://docs.uma.xyz/developers/optimistic-oracle-v3/data-asserter) | Dispute-driven truth assertion for arbitrary off-chain data. Live on Base mainnet. `@uma/contracts-node` v0.4.25 Jan 2026. | Partially (need thin adapter + custom EvidenceAsserter contract) | Yes (active, Jan 2026 publish) | **EXTEND** |
| 2 | [Chainlink Functions](https://docs.chain.link/chainlink-functions) | On-demand JS compute on DON. Live on Base mainnet since Apr 2024. `@chainlink/functions-toolkit` active. | Partially (good for rule-based checks, no dispute mechanism) | Yes | **ADOPT as fallback** |
| 3 | [DirectHelp](https://github.com/directhelporg/directhelp) | On-chain charity distribution using UMA OO + EAS for evidence/reputation verification. Hackathon project, confirms pattern. | Yes — proves UMA OO is viable for evidence-triggered fund release | Unknown (hackathon) | **Reference only** |
| 4 | [EigenLayer AVS / Hourglass](https://docs.eigencloud.xyz/products/devkit/buildingTaskBasedAVS) | Build a custom validator network for any compute task. Go/TypeScript. Live on testnet, mainnet AVS directory live. | Yes — but requires building a full validator network (months) | Yes (Eigen Labs) | **BUILD (future track, 12+ months)** |
| 5 | [Evidence-Chain](https://github.com/evidence-chain/evidence-chain.github.io) | Experimental evidence-on-chain concept repo. Very early stage, not a usable SDK. | No | Unknown | **Skip** |
| 6 | [UMA + Polymarket + EigenLayer next-gen oracle](https://www.theblock.co/post/342351/eigenlayer-polymarket-and-uma-collaborate-on-developing-next-gen-oracle) | Joint research for next-generation oracle with EigenLayer restakers backing UMA disputes. Not shipped. | Yes (future) | Active research | **Monitor / future ADOPT** |
| 7 | [Pyth / RedStone / Band](https://blog.redstone.finance/2025/01/16/blockchain-oracles-comparison-chainlink-vs-pyth-vs-redstone-2025/) | Price feed oracles. Push/pull data feeds for financial data. No dispute mechanism, no arbitrary data. | No (wrong oracle type — price feeds only) | Yes | **Skip** |

---

## Recommended Path

### Immediate (Sprint 1-2): EXTEND UMA OOv3

- [ ] **EXTEND**: Deploy a thin `EvidenceAsserter` contract on Base mainnet that wraps OOv3's `assertDataFor`
- [ ] Install `@uma/contracts-node` (v0.4.25) + `viem`
- [ ] Build `UMAOracleAdapter` TypeScript class implementing PCC's `VerificationOracle` interface
- [ ] Assertion pattern: `evidenceBundleId → keccak256(JSON.stringify(bundle)) → assertDataFor(id, hash, asserter)`
- [ ] Liveness: 2 hours (default). For production PCC, consider 7200s (2h) for fast-path, 86400s (24h) for high-value assertions
- [ ] Bond currency: USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- [ ] Bond amount: 500 USDC minimum (refunded if not disputed)
- [ ] Implement `assertionResolvedCallback` → fires `SettlementTriggered` event → PCC settlement pipeline

### Short-term (Sprint 3-4): ADOPT Chainlink Functions as fallback

- [ ] **ADOPT**: Use `@chainlink/functions-toolkit` for programmatic, rule-based evidence pre-screening
- [ ] Pattern: Before submitting to UMA, run fast Chainlink Functions check (validates JSON structure, hash integrity, required fields)
- [ ] If Chainlink check passes → submit to UMA for full optimistic assertion
- [ ] If UMA is down/unavailable → Chainlink Functions result used as fallback (lower security guarantee, logged)
- [ ] Fund a subscription on Base mainnet, add the EvidenceAsserter contract as consumer

### Long-term (6-12 months): BUILD EigenLayer AVS

- [ ] **BUILD**: Design PCC Evidence Verification AVS using Hourglass task framework
- [ ] Operators run PCC evidence validator binary, stake ETH via EigenLayer
- [ ] AVS replaces UMA DVM as dispute resolver — UMA's "human vote" replaced by cryptoeconomically secured operator quorum
- [ ] Target: launch on testnet when PCC has 10+ operator candidates willing to run the binary
- [ ] Track UMA + EigenLayer joint oracle research — may ship before we need to build our own

---

## Build Justification

No off-the-shelf solution handles PCC's exact problem:

1. **UMA OOv3** handles arbitrary truth claims but requires a custom wrapper contract (`EvidenceAsserter`) that:
   - Accepts PCC evidence bundle IDs (not raw bytes)
   - Maps bundle ID → evidence hash on-chain
   - Fires the correct callback into PCC's settlement pipeline
   - Manages bond lifecycle (pull from operator wallet, return on settlement)
   - This is ~200 lines of Solidity + a TypeScript adapter class — not a full build, more like a 2-day task

2. **Chainlink Functions** requires a custom JavaScript source function that knows how to validate PCC's specific evidence schema (required fields, hash integrity, operator signature validation). This JS is unique to PCC's format.

3. **EigenLayer AVS** requires building the entire validator binary (Go or TypeScript daemon), aggregator service, and operator onboarding pipeline from scratch. This is the largest build but is the correct long-term architecture.

The reason nothing off-the-shelf works end-to-end is that **PCC's evidence bundle format is proprietary** (structured JSON with operator signatures, GPS data, sensor readings, capability proofs) and no general-purpose oracle knows how to interpret it. The oracle layer (UMA/Chainlink/EigenLayer) provides the trust infrastructure; PCC must provide the evidence interpretation logic.

---

## Sources

- [@uma/contracts-node on npm](https://www.npmjs.com/package/@uma/contracts-node)
- [UMA Optimistic Oracle v3 Docs](https://docs.uma.xyz/developers/optimistic-oracle-v3)
- [UMA Network Addresses](https://docs.uma.xyz/resources/network-addresses)
- [UMA Data Asserter Pattern](https://docs.uma.xyz/developers/optimistic-oracle-v3/data-asserter)
- [UMA Setting Custom Bond and Liveness](https://docs.uma.xyz/developers/setting-custom-bond-and-liveness-parameters)
- [UMA dev-quickstart-oov3 GitHub](https://github.com/UMAprotocol/dev-quickstart-oov3)
- [Announcing the OOv3 — The True or False Oracle](https://medium.com/uma-project/announcing-the-oov3-the-true-or-false-oracle-1b58d8d44ab4)
- [@chainlink/functions-toolkit on npm](https://www.npmjs.com/package/@chainlink/functions-toolkit)
- [Chainlink Functions Docs](https://docs.chain.link/chainlink-functions)
- [Chainlink Functions Supported Networks](https://docs.chain.link/chainlink-functions/supported-networks)
- [Chainlink Functions Billing](https://docs.chain.link/chainlink-functions/resources/billing)
- [Chainlink Functions Goes Live on Base (PR Newswire)](https://www.prnewswire.com/news-releases/chainlink-functions-goes-live-on-base-302113178.html)
- [EigenLayer devkit-cli GitHub](https://github.com/Layr-Labs/devkit-cli)
- [EigenLayer Hello World AVS](https://github.com/Layr-Labs/hello-world-avs)
- [EigenCloud DevKit + Hourglass Docs](https://docs.eigencloud.xyz/products/devkit/buildingTaskBasedAVS)
- [EigenLayer, Polymarket and UMA: next-gen oracle collaboration (The Block)](https://www.theblock.co/post/342351/eigenlayer-polymarket-and-uma-collaborate-on-developing-next-gen-oracle)
- [DirectHelp: UMA OO + EAS for charity verification](https://github.com/directhelporg/directhelp)
- [Oracle comparison: Chainlink vs Pyth vs RedStone 2025](https://blog.redstone.finance/2025/01/16/blockchain-oracles-comparison-chainlink-vs-pyth-vs-redstone-2025/)
- [UMA Protocol overview (metalamp)](https://metalamp.io/magazine/article/uma-protocol-how-does-the-popular-optimistic-oracle-work)
