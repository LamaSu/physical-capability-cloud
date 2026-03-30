# Quick Sponsor Integrations — PL Genesis Hackathon
**Date**: 2026-03-28
**Deadline**: 2026-03-31 (~72 hours remaining)
**Goal**: Brutally honest feasibility assessment for $1,800 in bounties ($300 + $500 + $1,000)
**Judges**: Eshan Chordia (Impulse AI), Elliot Braem (NEAR), Ali Serag (Flow)

---

## Summary Verdicts

| Sponsor | Bounty | Verdict | Time Estimate | Risk |
|---------|--------|---------|---------------|------|
| Impulse AI | $300 | **MAYBE (low priority)** | 3-5 hrs | Unclear bounty criteria, early product |
| NEAR Protocol | $500 | **DO IT** | 4-6 hrs | Low — SDK is mature, prior research done |
| Flow | $1,000 | **DO IT (highest ROI)** | 3-4 hrs | Very low — pure viem, almost zero new code |

---

## 1. Impulse AI ($300 bounty)

### What It Is

Impulse AI (impulselabs.ai, founded 2025) is an autonomous machine learning engineer platform. It lets non-technical users train and deploy ML models via English-language prompts and CSV/Excel data uploads — no coding required. Their flagship demo placed an autonomous ML agent in the top 2.5% on a Kaggle competition. The product straddles two modes: (a) a no-code web dashboard for training models, and (b) a REST API for calling deployed models in production. Eshan Chordia is founder and CEO, based in San Francisco, CMU alumni.

The PL Genesis listing describes them as "Autonomous MLE Agent." Their whitepaper (Feb 2026) covers a next-generation AI system architecture. The product is early-stage — the inference capabilities page explicitly noted "In-house evaluation and inference capabilities will be available soon" as of the fine-tuning docs, but the introduction page confirms a hosted inference endpoint is live at `https://inference.impulselabs.ai`.

### API/SDK Available

- **Python SDK**: `pip install impulse-api-sdk-python`
  - `client.fine_tuning.create_fine_tuning_job()` — submit training
  - `client.fine_tuning.list_fine_tuning_jobs()` — monitor status
  - Auth: `IMPSDK_API_KEY` env var, keys start with `imp_`
- **REST API base URL**: `https://api.impulselabs.ai`
- **Inference endpoint**: `https://inference.impulselabs.ai`
- **Inference call pattern**:
  ```
  POST https://inference.impulselabs.ai/infer
  Authorization: Bearer imp_...
  Content-Type: application/json
  {"deployment_id": "...", "data": {...}}
  ```
- **Documentation**: https://docs.impulselabs.ai/
- **Rate limits**: 120-1,000 req/min depending on plan tier
- **Fine-tuning models**: Llama 3.1 8B (LoRA, QLoRA, full fine-tune)
- No official npm/JS package found. Python SDK only confirmed.

### What the Bounty Actually Requires

No detailed criteria were published on the hackathon page. The descriptor is "Autonomous MLE Agent." Given Eshan is the judge and founder, the bar is probably: demonstrate meaningful use of the Impulse API in a PCC workflow, not just a hello-world. Most likely acceptable: train a model on PCC-relevant data (e.g., capability pricing history, anomaly detection on sensor data) and call the inference endpoint from the gateway.

### Minimum Viable Integration

**Option A — Sensor Anomaly Classifier (most relevant to PCC):**
1. Export synthetic sensor data from PCC (temperature/pressure readings, normal vs. anomalous)
2. Upload CSV to Impulse dashboard, train a classifier (their no-code flow — ~30 min)
3. Call `POST /infer` from a new gateway route `POST /api/impulse/predict`
4. Surface result in a dashboard widget or as part of evidence bundle scoring

**Option B — Capability Demand Predictor:**
1. Generate synthetic capability usage history (timestamped job submissions by type)
2. Train a time-series or regression model to predict demand
3. Wire into the CapabilityRouter as a soft scoring input
4. Call inference endpoint at job scheduling time

Option A is cleaner and more demo-able. The entire integration is one new gateway route + one new dashboard card.

### Time Estimate

- Account creation + API key: 15 min
- Training a model on synthetic PCC data via their dashboard: 30-60 min
- Writing `packages/gateway/src/routes/impulse.ts` (new route, ~80 lines): 45 min
- Wiring into evidence scoring or sensor anomaly detection: 1-2 hrs
- Dashboard widget: 30-60 min
- **Total: 3-5 hours**

### Risk

- **Bounty criteria are completely unspecified.** No public rubric. Could require deep integration or could accept a demo call.
- **Product is early-stage.** The fine-tuning docs say "inference coming soon" — contradicted by the intro page saying it's live. There may be gaps between what's documented and what works.
- **No JS SDK.** PCC is TypeScript — must call REST directly from the gateway (not a blocker, but adds friction vs. an official SDK).
- **$300 is the lowest bounty.** If the integration hits a dead end after 2 hours, it's not worth more time.
- **Eshan is the judge.** This is actually a risk-reducer — if something doesn't work, you can DM him on X (@eshanchordia) directly. He's responsive.

### Verdict: MAYBE

Do this LAST, after Flow and NEAR. If you have 4+ hours of buffer after those are done, build the sensor anomaly integration. The Eshan relationship (judge = founder) is a meaningful differentiator — a thoughtful integration that frames PCC as a "physical ML deployment platform" aligns with his narrative. But $300 doesn't justify blocking time on the other two.

**Decision rule**: Start Flow and NEAR first. If both are merged and deployed by end of day 1, add Impulse. Otherwise skip.

---

## 2. NEAR Protocol ($500 bounty)

### What It Is

NEAR Protocol is a Layer-1 blockchain positioning itself as "The Blockchain for AI" and "AI Super-App Layer." Its key differentiator is **Chain Abstraction** — smart contracts on NEAR can sign transactions on 35+ other chains via a multi-party computation (MPC) network. For PCC, the relevant primitive is **NEAR Intents**: a protocol where users or AI agents declare desired outcomes (e.g., "swap X for Y", "pay for capability Y from chain Z") and a competing solver network routes execution cross-chain without the agent managing bridges or gas.

The `intents.near` contract is live, handles $1.8B+ volume, and supports 121 assets. The 1Click API (`https://1click.chaindefuser.com/v0/`) provides a REST abstraction for submitting intents without directly calling NEAR contracts. Significant prior research already exists in this repo at `ai/research/near-intents-comprehensive.md` and `ai/research/near-intents-pcc-integration-plan.md`.

NEAR also has `near-api-js` (v7.1.1, actively maintained, last published 8 days ago) for full account + transaction management, and `near-sdk-js` for writing smart contracts.

### API/SDK Available

- **near-api-js** (JS/TS): `npm install near-api-js`
  - Account creation, named accounts (e.g., `pcc-agent.near`), key management, contract calls
  - Docs: https://docs.near.org/tools/near-api
  - GitHub: https://github.com/near/near-api-js
- **py-near** (Python): `pip install py-near`
- **@defuse-protocol/one-click-sdk-typescript**: `npm install @defuse-protocol/one-click-sdk-typescript`
  - Wraps the 1Click API with TypeScript types
  - Token listing, quote requests, intent execution
- **1Click REST API** (no SDK needed):
  ```
  POST https://1click.chaindefuser.com/v0/quote
  Content-Type: application/json
  {
    "swapType": "EXACT_INPUT",
    "originAsset": "nep141:wrap.near",
    "depositType": "ORIGIN_CHAIN",
    "destinationAsset": "nep141:arb-0x912...",
    "amount": "100000000000000000000000"
  }
  ```
- **Solver relay WebSocket**: `wss://solver-relay-v2.chaindefuser.com`
  - JSON-RPC for publishing intents and receiving solver quotes
- **NEAR Docs**: https://docs.near.org
- **Intents Docs**: https://docs.near-intents.org
- **GitHub (contracts)**: https://github.com/near/near-intents

### What the Bounty Actually Requires

Elliot Braem (DevRel @ NEAR) is the judge. DevRel judges typically look for: real API usage (not mocked), a coherent narrative about why NEAR fits the project, and something that can be demoed live. NEAR's positioning as "The Blockchain for AI" maps directly onto PCC's multi-agent architecture. The most defensible integration: PCC agents using NEAR Intents for cross-chain settlement — i.e., a capability contract can be funded from any chain via NEAR Intents, and the agent resolves the payment without managing bridges manually.

Prior research (`near-intents-pcc-integration-plan.md`) already mapped this out in detail. The integration plan was written March 19 — 9 days ago. The design work is done.

### Minimum Viable Integration

**NEAR Agent Identity + 1Click Payment Intent (most coherent story):**

1. **Register a NEAR named account for PCC**: `pcc-gateway.near` (testnet: `pcc-gateway.testnet`) using `near-api-js`. This establishes PCC as a first-class NEAR participant.

2. **New gateway route `POST /api/near/intent`**: Accepts `{fromChain, fromAsset, amount, workflowId}` — creates a NEAR payment intent so a client on any chain can fund a PCC escrow contract.

3. **1Click quote call**: Route calls `POST https://1click.chaindefuser.com/v0/quote` to get a solver quote, returns it to the caller.

4. **Wire into A2A payment flow**: The `SettlementAgent` can optionally route through NEAR Intents when the counterparty is on a non-EVM chain (NEAR native, Aurora, etc.).

5. **Demo**: Show an agent submitting a cross-chain payment intent from a NEAR testnet account to fund a PCC milestone escrow. Logs the intent ID and settlement status.

The minimum that counts: a working NEAR testnet account for PCC + one live intent call that shows up in the NEAR explorer. Everything else is polish.

**What already exists in PCC that helps:**
- `packages/agent-runtime/src/` — AgentWallet (viem), can be extended with a NEAR signer
- `packages/a2a/` — A2A intents infrastructure, can add a `near_payment_intent` intent type
- Existing NEAR research doc already maps the integration touchpoints
- `packages/payments/` — x402 + Meteora payment rails, NEAR is an additive rail

### Time Estimate

- NEAR testnet account setup + fund from faucet: 30 min
- `npm install near-api-js @defuse-protocol/one-click-sdk-typescript`: 15 min
- New gateway route `packages/gateway/src/routes/near.ts`: 1-2 hrs (~150 lines)
- Integration test + demo transaction: 1 hr
- A2A intent type `near_payment_intent` in `packages/a2a/`: 30-60 min
- Dashboard display (intent status page): 30 min
- **Total: 4-6 hours**

### Risk

- **NEAR testnet is stable.** The `intents.near` contract is battle-tested. Low infrastructure risk.
- **near-api-js is TypeScript-native.** No shim or adaptation layer needed.
- **1Click API may require JWT auth.** The SDK docs show `OpenAPI.TOKEN = 'YOUR_JWT_TOKEN'` — need to check if testnet requires registration or if there's an open endpoint. If gated, fall back to direct WebSocket solver relay (open).
- **Cross-chain demo complexity.** A full cross-chain intent (e.g., from Base to NEAR) requires testnet bridge funding. For demo purposes, a NEAR-to-NEAR intent (same chain swap) is simpler and still shows the integration.
- **$500 bounty is solid ROI.** Even a lightweight integration (NEAR account + 1 live intent call) likely qualifies.

### Verdict: DO IT

This is the cleanest integration. The prior research is done, the SDK is TypeScript-native, the testnet is free, and the "PCC agents pay across chains via NEAR Intents" narrative is genuinely compelling. NEAR's positioning as "the blockchain for AI" and PCC's positioning as "AWS for physical AI" are mutually reinforcing stories.

**Start here.** Should be completable in one focused 5-6 hour block.

---

## 3. Flow ($1,000 bounty — highest ROI)

### What It Is

Flow is a Layer-1 blockchain originally built by the CryptoKitties team. As of the Crescendo upgrade (2024), it runs **two parallel environments**: Cadence (Flow's native smart contract language, resource-oriented) and **Flow EVM** (a full EVM-equivalent environment embedded as a Cadence smart contract). Flow EVM uses the go-ethereum codebase, is post-Pectra compatible (EIP-1559, EIP-4844), and supports Hardhat, Foundry, Remix, viem, and ethers.js without modification.

Key specs:
- **Flow EVM Testnet RPC**: `https://testnet.evm.nodes.onflow.org`
- **Flow EVM Testnet Chain ID**: 545
- **Flow EVM Mainnet RPC**: `https://mainnet.evm.nodes.onflow.org`
- **Flow EVM Mainnet Chain ID**: 747
- **Testnet block explorer**: https://evm-testnet.flowscan.io
- **Mainnet block explorer**: https://evm.flowscan.io
- **Testnet faucet**: https://faucet.flow.com/fund-account (grants enough for millions of txns)
- **Gas**: FLOW token, sub-cent per transaction
- **Solidity**: full EVM equivalence. "If it works on another EVM-equivalent blockchain, it should work on Flow EVM."

Ali Serag is DevRel Lead at Flow. The Flow Challenge offers $10,000 split among 10 teams ($1,000 each) — meaning the bar is deliberately low. They want 10 winners, not 1.

### API/SDK Available

- **viem** (already in PCC): works directly with Flow EVM, just needs a `defineChain` entry
- **ethers.js**: works
- **Hardhat**: works (full config docs at https://developers.flow.com/build/evm/about)
- **Foundry**: works (forge deploy with `--rpc-url https://testnet.evm.nodes.onflow.org --chain-id 545`)
- **Flow-specific JS SDK** (`@onflow/fcl`): for Cadence environment, not needed for EVM path
- **Docs**: https://developers.flow.com/build/evm/about

### What the Bounty Actually Requires

Ali Serag (DevRel Lead) is the judge. 10 teams each win $1,000. This is the most accessible bounty structure in the entire hackathon. The minimum bar is: **deploy a real smart contract to Flow EVM and demonstrate it does something**. The PCC `MilestoneEscrow.sol` is already audited-ish, battle-tested on Sepolia + Base Sepolia, and can be deployed to Flow EVM testnet in under an hour.

The ideal pitch: "PCC is now chain-agnostic — capability escrow contracts run on Flow EVM, bringing low-cost (<$0.01/tx) settlement to physical capability markets." With 10 winner slots, you don't need to be the best — you just need to ship something real.

### Minimum Viable Integration

**Deploy MilestoneEscrow + MockUSDC to Flow EVM Testnet (exact same pattern as Base Sepolia):**

**Step 1: Add Flow EVM to `packages/contracts/ts/chain-config.ts`**
```typescript
import { defineChain } from "viem";

export const flowEVMTestnet = defineChain({
  id: 545,
  name: "Flow EVM Testnet",
  nativeCurrency: { name: "Flow", symbol: "FLOW", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testnet.evm.nodes.onflow.org"] },
    public:  { http: ["https://testnet.evm.nodes.onflow.org"] },
  },
  blockExplorers: {
    default: { name: "Flow EVM Testnet Explorer", url: "https://evm-testnet.flowscan.io" },
  },
  testnet: true,
});

export const flowEVMMainnet = defineChain({
  id: 747,
  name: "Flow EVM",
  nativeCurrency: { name: "Flow", symbol: "FLOW", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://mainnet.evm.nodes.onflow.org"] },
    public:  { http: ["https://mainnet.evm.nodes.onflow.org"] },
  },
  blockExplorers: {
    default: { name: "Flow EVM Explorer", url: "https://evm.flowscan.io" },
  },
});
```

Add `"flow-evm-testnet"` and `"flow-evm"` entries to the `deployments` object — same shape as `"base-sepolia"`.

**Step 2: Copy and adapt `scripts/deploy-base-sepolia.ts` → `scripts/deploy-flow-evm.ts`**
- Change `chain: baseSepolia` → `chain: flowEVMTestnet`
- Change `rpcUrl` to `https://testnet.evm.nodes.onflow.org`
- Change `RPC_URL` default
- Fund deployer wallet from https://faucet.flow.com/fund-account
- Run: `DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-flow-evm.ts`

The deploy script already uses pure viem with `deployContract` — zero changes to the contract deployment logic. The entire change is ~40 lines.

**Step 3: Add `"flow-evm-testnet"` to the gateway's supported chains list**
- Update `packages/gateway/src/routes/escrow.ts` (or wherever chain selection is exposed) to list Flow EVM testnet as a supported settlement chain.
- This makes it selectable in the UI.

**Step 4 (optional polish): Add Flow to the UI chain selector**
- `apps/ui` — wherever the chain/network selector lives, add Flow EVM testnet
- Show deployed contract address with link to evm-testnet.flowscan.io

**Total code change**: ~50-80 lines of TypeScript, 0 lines of new Solidity.

### Time Estimate

- Get FLOW testnet tokens from faucet: 15 min
- Add `flowEVMTestnet` chain to `chain-config.ts`: 20 min
- Write `scripts/deploy-flow-evm.ts` (copy + 5 line changes): 30 min
- Run `forge build` to ensure artifacts are fresh: 10 min
- Deploy + verify on testnet explorer: 30-45 min
- Update gateway chain list: 30 min
- UI chain selector (optional): 30-60 min
- **Total: 3-4 hours** (without UI polish), 4-5 hours (with UI)

### Risk

- **Essentially zero technical risk.** The Solidity contracts are identical — EVM equivalence is the whole point. The viem deploy script already handles `defineChain`. The only failure mode is if the faucet is broken or the testnet RPC is down.
- **One known gotcha**: Block hash calculation differs from standard go-ethereum. This does NOT affect contract deployment or execution — only matters if you're doing `eth_getBlockByHash` comparisons locally. Not relevant for PCC's use case.
- **FLOW tokens for gas**: The faucet gives "enough for millions of transactions." No funding risk.
- **The 10-winner structure is deliberate.** They explicitly want broad adoption. Completing a real deployment is almost certainly sufficient.

### Verdict: DO IT FIRST

This is the highest-ROI item in the entire hackathon. $1,000 for ~3-4 hours of work, using code and infrastructure that already exists. The risk is near-zero. The only new code is a `defineChain` config and a copy of an existing deploy script. Do this before anything else.

---

## Execution Order

Given 72 hours remaining:

**Day 1 (today):**
1. Flow EVM — 3-4 hrs. Deploy MilestoneEscrow + MockUSDC to Flow EVM testnet. Add chain to gateway. Done.
2. NEAR Protocol — 4-6 hrs. Register PCC testnet account. Write `/api/near/intent` gateway route. Wire 1Click quote call. Demo a live intent.

**Day 2 (tomorrow, buffer for hackathon submission):**
3. Impulse AI — 3-5 hrs IF buffer exists. Train sensor anomaly classifier, wire `/api/impulse/predict` route.
4. Submission prep, testing, writeup.

**Skip if behind**: Drop Impulse AI entirely if NEAR runs long. The $300 does not justify risking NEAR ($500) or the main PCC submission.

---

## Reuse Map (What Already Exists)

| Existing Asset | Reuse For |
|---------------|-----------|
| `packages/contracts/ts/chain-config.ts` | Add Flow EVM chain entries |
| `scripts/deploy-base-sepolia.ts` | Copy → `deploy-flow-evm.ts` (5 line change) |
| `packages/contracts/src/MilestoneEscrow.sol` | Deploy as-is to Flow EVM |
| `packages/contracts/src/MockUSDC.sol` | Deploy as-is to Flow EVM |
| `packages/gateway/src/routes/` | Add `near.ts` and optionally `impulse.ts` |
| `packages/a2a/` | Add `near_payment_intent` intent type |
| `ai/research/near-intents-comprehensive.md` | NEAR architecture reference |
| `ai/research/near-intents-pcc-integration-plan.md` | NEAR integration design (already done) |

---

## Key Links

**Flow:**
- EVM Docs: https://developers.flow.com/build/evm/about
- Testnet RPC: https://testnet.evm.nodes.onflow.org (chain ID 545)
- Faucet: https://faucet.flow.com/fund-account
- Testnet Explorer: https://evm-testnet.flowscan.io

**NEAR:**
- near-api-js: https://github.com/near/near-api-js
- 1Click API: https://docs.near-intents.org
- 1Click endpoint: https://1click.chaindefuser.com/v0/quote
- NEAR Testnet: https://explorer.testnet.near.org
- npm: `near-api-js`, `@defuse-protocol/one-click-sdk-typescript`

**Impulse AI:**
- Docs: https://docs.impulselabs.ai/
- SDK: `pip install impulse-api-sdk-python`
- Inference: https://inference.impulselabs.ai
- Judge: @eshanchordia on X
