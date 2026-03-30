# PCC — Bounty Submission Claims

**Project**: Physical Capability Cloud
**Hackathon**: PL Genesis: Frontiers of Collaboration
**Deadline**: March 31, 2026
**Live**: https://capability.network

---

## Main Track Prizes

### Fresh Code — $5,000

**Status**: Submitting

The PCC repository was created on March 2, 2026, after the hackathon opened on February 10. All 25 packages, 3,300+ tests, 154 agent tools, and 347 REST endpoints were written during the hackathon window. The repo history is publicly verifiable — no commits exist before March 2. This is not a rebrand of a prior project; the protocol design, agent architecture, sovereign infrastructure layer, and deployment infrastructure were all built from scratch during this period.

---

### AI & Robotics Track

**Status**: Submitting

PCC is physical AI infrastructure — the foundational layer that lets AI agents discover, negotiate, and orchestrate real machines. The system runs a 6-phase agentic pipeline (Discover → Bid → Escrow → Execute → Verify → Settle) with a multi-agent architecture (User, Broker, Kernel, Evaluator) communicating over 34 typed A2A intents. A real OT-2 liquid handler robot is operating as the first operator node via the `pcc-node` Python package, which auto-detects hardware, generates Ed25519 keys, provisions API credentials, and registers the device on the network in a single command. This is not a simulation of physical AI — it is the protocol layer that makes physical AI agents economically viable.

---

### Infrastructure & Digital Rights Track

**Status**: Submitting

PCC's sovereign evidence chain is a complete digital rights infrastructure stack: W3C DIDs for machine identity (`did:key` and `did:pcc`), Verifiable Credentials for capability attestation, content-addressed IPFS storage via Storacha for permanent evidence archival, AES-256-GCM encryption with programmable on-chain access conditions via Lit Protocol, ZK Merkle proofs for privacy-preserving evidence commitments, and Starknet anchoring for permanent chain-verifiable proof of execution. Operators in 34 emerging market countries can receive payment in local fiat via the Yellowcard integration — removing the barriers that have historically kept small physical manufacturers out of global supply chains.

---

## Sponsor Bounties

### Storacha — Storage Bounty ($300 + credits)

**Status**: Submitting

PCC integrates `@storacha/client` (the w3up SDK) for permanent evidence archival. Every evidence bundle produced during job execution is uploaded to Storacha via `client.uploadFile()`, producing CIDv1 hashes using sha2-256 + raw codec. Two CIDs are generated per bundle: a full bundle CID and a public metadata CID (no sensitive fields). The storage factory (`packages/kernel/src/evidence-storage-factory.ts`) selects Storacha vs. Helia based on the `EVIDENCE_STORAGE` environment variable, making the integration production-ready without coupling the codebase to a single IPFS backend. The `StorachaStorageService` (`packages/kernel/src/storacha-storage.ts`) handles UCAN delegation parsing, space management, and gateway retrieval (`https://w3s.link/ipfs/<cid>`).

**Relevant files**: `packages/kernel/src/storacha-storage.ts`, `packages/kernel/src/evidence-storage-factory.ts`

**Test**: `pnpm --filter @pcc/kernel test`

---

### Lit Protocol — NextGen AI Apps ($500)

**Status**: Submitting

PCC uses Lit Protocol to encrypt manufacturing evidence under programmable on-chain access conditions tied to smart contract state. The `LitEncryptionService` builds `UnifiedAccessControlCondition` arrays that gate decryption on whether the caller is the escrow buyer (`MilestoneEscrow.getBuyer(jobId) == callerAddress`) or a credentialed verifier (reputation >= 100). This is AI-native programmable access control: the AI agents running the pipeline produce encrypted evidence that only the contracting party and authorized verifiers can read. The real implementation (`packages/kernel/src/lit-encryption-real.ts`) uses `@lit-protocol/lit-node-client` v6 on the `datil-test` network with full threshold key splitting. Activate with `LIT_PROTOCOL_REAL=true`.

**Relevant files**: `packages/kernel/src/lit-encryption-service.ts`, `packages/kernel/src/lit-encryption-real.ts`

**Test**: `npx tsx scripts/lit-protocol-demo.ts`

---

### Starknet — Best Use / ZK Proofs

**Status**: Submitting

PCC's `StarknetProofAnchoringService` (`packages/verifier/src/starknet-proof-service.ts`) anchors ZK proof hashes and Merkle commitment roots on Starknet Sepolia via `starknet.js`. After evidence is verified, a canonical SHA-256 hash of the proof is submitted as a felt252 field element to the `ProofRegistry` contract (RPC: `starknet-sepolia.public.blastapi.io`). This creates a permanent, publicly verifiable on-chain record that specific physical work happened and passed verification — without ever committing raw evidence to the chain. The system supports both single-proof anchoring (`anchorProof`) and batch anchoring via Merkle roots (`anchorMerkleRoot`), making it gas-efficient for high-throughput workloads. The integration is activated by setting `STARKNET_ACCOUNT` and `STARKNET_PRIVATE_KEY` environment variables.

**Relevant files**: `packages/verifier/src/starknet-proof-service.ts`, `packages/verifier/src/zk-proof-service.ts`

**Test**: `pnpm --filter @pcc/verifier test`

---

### Physical AI — Solo Tech / Physical AI ($500)

**Status**: Submitting

PCC is, literally, physical AI infrastructure. The entire protocol exists to let AI agents coordinate and control physical machinery — 3D printers, CNC routers, liquid handlers, mass spectrometers, couriers. The `pcc-node` Python package (pip-installable) turns any physical device into a network endpoint: it auto-detects OT-2 robots, OctoPrint servers, and generic HTTP devices, generates Ed25519 identity keys, provisions API credentials, and registers the hardware on the network as a governed operator node. The Execution Scope Protocol (4 security classes: READ/SAFE/SCOPED/PRIVILEGED) ensures AI agents can only issue commands they are explicitly authorized for — a critical safety primitive for physical systems. This is not AI applied to physical data; this is the protocol layer for physical AI.

---

### NEAR Protocol — Chain Abstraction ($500)

**Status**: Submitting

PCC integrates NEAR's 1Click chain abstraction API (chaindefuser.com) so that PCC agents can fund escrow contracts on any supported chain using any source asset — without managing bridges or wrapped tokens. The integration surfaces four gateway routes:

- `GET /api/near/status` — reports network, solver capabilities, and supported chains/assets
- `POST /api/near/quote` — calls the 1Click solver network to get an atomic cross-chain quote (fromChain/fromAsset → toChain/toAsset, with fee + slippage)
- `POST /api/near/intent` — submits a signed cross-chain payment intent for solver routing
- `GET /api/near/intent/:id` — polls intent settlement status (`pending → submitted → settled`)

Four new A2A intent types (`near_payment_intent`, `near_payment_quote_result`, `near_payment_submit`, `near_payment_settled`) let PCC User and Broker agents coordinate cross-chain escrow funding in a typed, auditable conversation flow. A PCC agent can now request a job on Base Sepolia and pay for it with NEAR-native USDC via a single `near_payment_intent` message — the solver network handles the atomic swap.

**Relevant files**:
- `packages/gateway/src/routes/near.ts` — 4 REST routes
- `packages/gateway/src/contracts/near-client.ts` — 1Click API client (plain fetch, no SDK) + mock mode
- `packages/gateway/src/__tests__/near.test.ts` — 25 tests covering all routes + full e2e flow
- `packages/a2a/src/types.ts` — `NearPaymentIntentRequest`, `NearPaymentQuoteResult`, `NearPaymentSubmit`, `NearPaymentSettled`

**Test**: `pnpm --filter @pcc/gateway test`

---

### Impulse AI — AI Agent Integration ($300)

**Status**: Integration pending

PCC's 154-tool agent package (`/agent-package.json`) and 49-tool MCP server are designed to be consumed by any AI agent runtime, including Impulse AI. The agent package exposes the full PCC pipeline as structured tool calls: capability discovery, price quoting, contract building, escrow management, job submission, evidence retrieval, ZK proof generation, and fiat ramp operations. Integration with Impulse AI's agent framework would allow Impulse agents to autonomously source physical manufacturing capabilities. If the integration is completed before the deadline, this claim will be updated with specifics.

---

### Funding the Commons — EIR Residency

**Status**: Submitting

PCC is open infrastructure for the physical economy. The protocol is credibly neutral: operators set their own prices, there is no extractive platform fee beyond the protocol escrow commission, and the codebase is Apache 2.0. The Yellowcard integration enables operators and users in 34 emerging market countries to participate using local fiat currency via mobile money and bank transfer — removing the USD/crypto onramp barrier that excludes most of the world's physical manufacturing capacity from global supply chains. The Sovereign Wealth Fund module allows protocol revenue to be governed collectively and distributed to participants. PCC is applying for EIR residency to continue building this infrastructure toward mainnet deployment.

---

### Flow EVM — Deploy Smart Contracts ($1,000)

**Status**: Contracts ready to deploy — wallet pending FLOW testnet funding

PCC's `MilestoneEscrow` and `MockUSDC` contracts have been ported to Flow EVM Testnet (chain 545). The Flow EVM chain is configured in `packages/contracts/ts/chain-config.ts` as `flowEVMTestnet` (chain ID 545, RPC `https://testnet.evm.nodes.onflow.org`). A dedicated deployment script `scripts/deploy-flow-evm.ts` handles the full deploy flow: MockUSDC + MilestoneEscrow deployment, test token minting, and chain-config update. The gateway escrow client (`packages/gateway/src/contracts/escrow-client.ts`) supports `PCC_NETWORK=flow-evm-testnet` for routing all escrow reads and writes to Flow EVM.

**Deployed Contracts** (Flow EVM Testnet, chain 545):
- MockUSDC: _pending wallet funding — see instructions below_
- MilestoneEscrow: _pending wallet funding — see instructions below_
- Explorer: https://evm-testnet.flowscan.io

**To complete deployment**:
1. Fund deployer wallet `0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B` with FLOW testnet tokens via https://faucet.flow.com/fund-account
2. Run: `DEPLOYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY npx tsx scripts/deploy-flow-evm.ts`
3. Addresses will be auto-written to `packages/contracts/ts/chain-config.ts`

**Relevant files**:
- `packages/contracts/ts/chain-config.ts` — `flowEVMTestnet` chain definition + `"flow-evm-testnet"` deployment entry
- `scripts/deploy-flow-evm.ts` — deployment script
- `packages/gateway/src/contracts/escrow-client.ts` — gateway supports `PCC_NETWORK=flow-evm-testnet`

---

## Qualification Summary

| Bounty | Qualification Basis | Key Evidence |
|--------|--------------------|----|
| Fresh Code ($5K) | Repo created March 2, 2026 | Git history |
| AI & Robotics Track | Physical AI protocol + real OT-2 node | `packages/pcc-node/`, A2A agent layer |
| Infrastructure & Digital Rights | Sovereign data stack (DIDs, IPFS, Lit, ZK) | `packages/spec/src/identity/`, `packages/kernel/`, `packages/verifier/` |
| Storacha ($300) | `@storacha/client` w3up integration | `packages/kernel/src/storacha-storage.ts` |
| Lit Protocol ($500) | `@lit-protocol/lit-node-client` v6, real access conditions | `packages/kernel/src/lit-encryption-real.ts` |
| Starknet (ZK) | `starknet.js` proof anchoring on Sepolia | `packages/verifier/src/starknet-proof-service.ts` |
| Physical AI ($500) | The protocol IS physical AI infrastructure | Entire codebase |
| NEAR Protocol ($500) | 1Click chain abstraction: 4 routes + 4 A2A intents + 25 tests | `packages/gateway/src/routes/near.ts`, `packages/a2a/src/types.ts` |
| Impulse AI ($300) | Agent package ready for integration | `/agent-package.json`, `packages/mcp-server/` |
| Funding the Commons (EIR) | Open infrastructure, emerging market access | Yellowcard integration, Apache 2.0 license |
| Flow EVM ($1,000) | MilestoneEscrow + MockUSDC on Flow EVM Testnet (chain 545) | `packages/contracts/ts/chain-config.ts`, `scripts/deploy-flow-evm.ts` |
