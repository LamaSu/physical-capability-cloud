# Hackathon Implementation Plan

> Targets: Funding the Commons SF (Mar 14-15) + PL_Genesis ($150K, through Mar 31)
> Scope: 5 sovereign infrastructure + agentic funding integrations

## Wave 1: Foundation — IPFS Evidence Storage + W3C DIDs (Hours 0-8)

### 1A. IPFS Evidence Storage (Helia)
**Goal**: Every evidence bundle gets a content-addressed IPFS CID.

**Packages to install**:
```
pnpm add helia @helia/unixfs --filter @pcc/kernel
```

**Files to change**:
1. `packages/kernel/src/evidence-storage.ts` (NEW) — IPFS storage service
   - `archiveBundle(bundle) → { cid, metadataCid }`
   - `retrieveBundle(cid) → EncryptedEvidenceBundle`
   - Uses Helia for content-addressing
2. `packages/kernel/src/evidence-emitter.ts` — After `finalizeBundle()`, call `archiveBundle()`
3. `packages/spec/src/types/encryption.ts` — Add `ipfsCid?: string` to `EncryptedEvidenceBundle`
4. `packages/gateway/src/routes/evidence-encrypted.ts` — Add `/api/evidence/:id/ipfs` endpoint
5. `apps/dashboard/src/pages/EvidenceExplorerPage.tsx` — Show IPFS CID with link

**Tests**: Bundle → archive → retrieve → verify hash matches

### 1B. W3C DIDs for Machine Identity (Veramo)
**Goal**: Every shop kernel and agent gets a DID. Capabilities become Verifiable Credentials.

**Packages to install**:
```
pnpm add @veramo/core @veramo/did-manager @veramo/did-provider-key @veramo/credential-w3c @veramo/did-resolver @veramo/key-manager @veramo/kms-local --filter @pcc/spec
```

**Files to change**:
1. `packages/spec/src/identity/` (NEW directory)
   - `did.ts` — `createDID()`, `resolveDID()`, DIDDocument type
   - `credentials.ts` — `issueCapabilityVC()`, `verifyVC()`
2. `packages/spec/src/types/kernel.ts` — Add `did?: string` to `ShopKernel`, `KernelDevice`
3. `packages/spec/src/types/common.ts` — Add `DID` type alias
4. `packages/agent-runtime/src/base-agent.ts` — Generate DID on agent init
5. `packages/kernel/src/evidence-emitter.ts` — Sign bundles with kernel DID
6. `packages/gateway/src/routes/registry.ts` — Add `/api/registry/resolve/:did` endpoint
7. Dashboard: Show DIDs on kernel detail pages

**Tests**: Create DID → issue VC → verify VC → resolve DID

---

## Wave 2: Encryption + Payments — Lit Protocol + x402 Solana (Hours 8-20)

### 2A. Lit Protocol Evidence Encryption
**Goal**: Replace mock ECIES encryption with real decentralized encryption. Access conditions tied to on-chain escrow state.

**Packages to install**:
```
pnpm add @lit-protocol/lit-node-client @lit-protocol/constants @lit-protocol/auth-helpers --filter @pcc/kernel
pnpm add @lit-protocol/lit-node-client --filter @pcc/gateway
```

**Files to change**:
1. `packages/kernel/src/lit-encryption-service.ts` (NEW) — Lit-based encryption
   - `encryptBundle(bundle, escrowAddress, jobId) → { ciphertext, dataToEncryptHash, accessConditions }`
   - `decryptBundle(ciphertext, conditions, sessionSigs) → plaintext`
   - Access conditions: buyer address matches escrow, OR verifier with 100+ rep
2. `packages/spec/src/types/encryption.ts` — Update types:
   - Add `litCiphertext?: string`, `litDataToEncryptHash?: string` to `EncryptedEvidenceBundle`
   - Add `litAccessConditions?: object[]` to `EncryptedEvidenceBundle`
3. `packages/gateway/src/routes/evidence-encrypted.ts` — Add `/api/evidence/:id/decrypt` with Lit
4. `packages/kernel/src/evidence-emitter.ts` — Use Lit encryption after finalization
5. Dashboard: Evidence detail page shows Lit access conditions and decrypt button

**Tests**: Encrypt → store → verify conditions → decrypt (with Lit datil-test network)

### 2B. x402 Agent-to-Agent Payments on Solana
**Goal**: Agents pay each other in real USDC on Solana devnet for capability discovery, routing, and verification.

**Packages to install**:
```
pnpm add @solana/web3.js @solana/spl-token x402-solana --filter @pcc/payments
pnpm add @solana/web3.js @solana/spl-token --filter @pcc/agent-runtime
```

**Files to change**:
1. `packages/agent-runtime/src/solana-wallet.ts` (NEW) — Solana agent wallet
   - Generate Solana keypair alongside existing viem wallet
   - SPL token transfers (USDC on devnet)
   - `SolanaAgentWallet` class parallel to `AgentWallet`
2. `packages/agent-runtime/src/spending-policy.ts` (NEW) — Budget-aware spending
   - `SpendingPolicy` interface with per-tx limits, window limits, auto-approve thresholds
   - `executeWithBudget(intent, amount, txBuilder) → receipt | requiresApproval`
3. `packages/payments/src/x402-solana-middleware.ts` (NEW) — Solana x402 server
   - Replace mock facilitator with `x402-solana` facilitator
   - Real Solana devnet USDC settlement
4. `packages/payments/src/x402-solana-client.ts` (NEW) — Solana x402 client
   - Auto-pay 402 responses with SPL token transfer
5. `packages/a2a/src/types.ts` — Add new intents:
   - `RequestFundingIntent`, `DelegateBudgetIntent`, `TreasuryVoteIntent`
6. `packages/agent-broker/src/broker-agent.ts` — Price A2A intents with x402
   - `handleDiscoverCapabilities` → 402 routing fee ($0.001)
   - `handleQuoteCapability` → 402 quote fee ($0.0005)
7. `packages/spec/src/types/common.ts` — Add `Chain` type, extend `Currency`
8. Dashboard: Agent treasury view with spending history

**Tests**: Agent A → 402 → Agent B pays on Solana devnet → response delivered

---

## Wave 3: Verification — Bittensor Subnet (Hours 20-32)

### 3A. Evidence Verification Subnet
**Goal**: Bittensor subnet where miners compete to verify manufacturing evidence quality.

**New directory**: `packages/verifier/subnet/` (Python)

**Files to create**:
1. `packages/verifier/subnet/protocol.py` — Synapse definitions
   ```python
   class EvidenceVerifySynapse(bt.Synapse):
       evidence_hash: str
       evidence_data: str       # JSON-serialized bundle
       required_tier: int
       verification_score: float = 0.0
       tier_compliant: bool = False
       defects_found: list = []
   ```
2. `packages/verifier/subnet/miner.py` — Evidence verification miner
   - Hash integrity check
   - Tier compliance (required evidence types present)
   - Sensor data plausibility (range checks)
   - Returns verification score + defect list
3. `packages/verifier/subnet/validator.py` — Orchestrates verification
   - Sends evidence to N miners via dendrite
   - Scores miners against consensus + reference answers
   - Sets weights on-chain (Yuma Consensus)
4. `packages/verifier/subnet/requirements.txt` — `bittensor>=8.0`
5. `packages/verifier/subnet/Nargo.toml` — Subnet config

**TypeScript bridge** (gateway integration):
6. `packages/verifier/src/bittensor-bridge.ts` (NEW) — HTTP bridge to subnet
   - `submitForVerification(bundleHash, bundleData, requiredTier) → VerificationResult`
   - Calls validator API endpoint
   - Falls back to local verification if subnet unavailable
7. `packages/verifier/src/market.ts` — Add `BittensorVerifierPool` option
8. `packages/gateway/src/routes/zk-proofs.ts` — Add `/api/verification/subnet-status`

**Tests**: Mock synapse → miner processes → validator scores → result returned

---

## Wave 4: DePIN Economics + Governance (Hours 32-42)

### 4A. Capability Certificates as Soulbound cNFTs
**Goal**: Machines get on-chain soulbound NFTs proving their verified capabilities.

**Packages to install**:
```
pnpm add @metaplex-foundation/mpl-bubblegum @metaplex-foundation/umi @metaplex-foundation/umi-bundle-defaults --filter @pcc/contracts
```

**Files to create**:
1. `packages/contracts/src/capability-certificates.ts` (NEW) — Bubblegum v2 integration
   - `mintCapabilityCertificate(kernel, capability, tier) → cNFT`
   - Soulbound (non-transferable)
   - Metadata: capability type, tolerance specs, materials, assurance tier, calibration proof CID
2. `packages/scheduler/src/capability-router.ts` — Check for valid cNFT before routing

### 4B. DePIN Reward Emission
**Goal**: Kernels earn SPL tokens for completing verified jobs.

**Files to create**:
1. `packages/contracts/src/PCCRewards.sol` (NEW) — On-chain reward distribution
   - Epoch-based rewards
   - Score: jobs(40%) + quality(25%) + uptime(15%) + diversity(10%) + scarcity(10%)
2. `packages/contracts/src/PCCToken.sol` (NEW) — ERC-20 governance/reward token
3. `packages/gateway/src/routes/rewards.ts` (NEW) — Epoch/claim/history endpoints
4. Dashboard: Rewards page with epoch history, kernel rankings

### 4C. Agent Spending Policies + Treasury
**Goal**: BrokerAgent acts as autonomous fund manager.

**Files to create**:
1. `packages/agent-broker/src/funding-handler.ts` (NEW) — Detect unmet demand, propose grants
2. Dashboard: Agent treasury view, active proposals, spending history

---

## Wave 5: Integration + Demo Polish (Hours 42-48)

### 5A. End-to-End Demo Script
`scripts/sovereign-e2e-simulation.ts`:
1. Shop Kernel identified by DID, capability verified by cNFT
2. User Agent discovers capability (x402 on Solana, $0.001)
3. Broker Agent routes job (x402 on Solana, $0.0005)
4. Job runs → evidence bundle produced
5. Evidence encrypted via Lit Protocol (access condition: escrow milestone)
6. Evidence archived to IPFS → CID committed to Merkle tree
7. Evidence submitted to Bittensor subnet for verification
8. Verification passes → escrow milestone met → on-chain state changes
9. Buyer can now decrypt evidence (Lit conditions pass)
10. Kernel earns DePIN reward tokens

### 5B. Dashboard Integration
- DID badges on kernel/agent cards
- IPFS CID links on evidence pages
- Lit Protocol access status indicators
- Solana tx links for x402 payments
- Bittensor subnet verification status
- Reward epoch dashboard

### 5C. Presentation Prep
- README updates with sovereign architecture
- Demo recording
- Architecture diagrams

---

## Package Dependencies Summary

| New Package | Install Target | Purpose |
|-------------|---------------|---------|
| `helia`, `@helia/unixfs` | @pcc/kernel | IPFS content-addressing |
| `@veramo/core` + 6 plugins | @pcc/spec | W3C DIDs + VCs |
| `@lit-protocol/lit-node-client` + helpers | @pcc/kernel, @pcc/gateway | Decentralized encryption |
| `@solana/web3.js`, `@solana/spl-token` | @pcc/payments, @pcc/agent-runtime | Solana wallet + SPL tokens |
| `x402-solana` | @pcc/payments | x402 on Solana |
| `@metaplex-foundation/mpl-bubblegum` + umi | @pcc/contracts | Soulbound capability cNFTs |
| `bittensor>=8.0` (Python) | packages/verifier/subnet/ | Verification subnet |

## Hackathon Submission Strategy

### Funding the Commons (Mar 14-15)
- **Track 1**: Physical AI & Robotics — PCC IS this
- **Track 2**: Agentic Funding & Coordination — x402 agent payments, spending policies, treasury
- **Track 4**: Sovereign Infrastructure — DIDs, IPFS, Lit, Bittensor
- Demo: Full e2e sovereign manufacturing simulation

### PL_Genesis (through Mar 31)
- **Existing Code track** ($50K) — PCC's 18 packages + 374 tests
- **Sponsor bounties** — Protocol Labs (IPFS/Filecoin), Lit Protocol, Filecoin
- Extra time to polish Bittensor subnet + add Filecoin persistence via Synapse SDK
