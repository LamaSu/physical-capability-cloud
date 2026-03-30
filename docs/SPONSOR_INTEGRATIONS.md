# Sponsor Integrations — Technical Reference

This document describes exactly how each sponsor technology is wired into the Physical Capability Cloud protocol. Each section covers what the technology does, which code paths use it, and how to verify it works.

---

## Storacha / Filecoin

### What It Does

Storacha is the w3up network — a decentralized IPFS-based storage layer backed by Filecoin for durability. Content is addressed by CIDv1 (sha2-256 + raw codec), meaning the same bytes always produce the same identifier and the content is tamper-evident by construction.

### How PCC Uses It

Every evidence bundle produced during job execution needs permanent, verifiable storage. PCC uses Storacha as the production evidence archive. Two storage backends are supported and selected via a factory:

1. **Helia** (default) — an in-process IPFS node. No external account required. Good for development and testing.
2. **Storacha** (production) — uploads to the w3up network via `@storacha/client`. Bundles land on Filecoin for long-term durability. Activated by setting `EVIDENCE_STORAGE=storacha`.

For each evidence bundle (plain or encrypted), two CIDs are produced:
- **Bundle CID** — the full JSON blob, including all event data.
- **Metadata CID** — a stripped-down public record (bundle ID, job ID, hash, event count, timestamp) with no sensitive fields, safe for public indexing.

In real mode, the `StorachaStorageService` authenticates with a UCAN delegation proof (`STORACHA_PROOF` env var), parses it with `@storacha/client/proof`, adds the delegated space, and sets it as the active space before uploading. Blobs are uploaded as `Blob` objects via `client.uploadFile()`. Retrieval in real mode fetches from `https://w3s.link/ipfs/<cid>` — the Storacha IPFS gateway.

### Files

| File | Role |
|------|------|
| `packages/kernel/src/storacha-storage.ts` | `StorachaStorageService` — full w3up integration |
| `packages/kernel/src/evidence-storage.ts` | `EvidenceStorageService` — Helia fallback |
| `packages/kernel/src/evidence-storage-factory.ts` | `createEvidenceStorage()` — selects backend at runtime |
| `packages/kernel/src/__tests__/storacha-storage.test.ts` | Tests for mock and real-mode CID generation |

### Key Code Path

```
job execution
  → EvidenceEmitter.finalizeBundle()
  → createEvidenceStorage()                     # selects helia or storacha
  → StorachaStorageService.archiveBundle(bundle)
  → client.uploadFile(bundleBlob)              # real mode
  → returns { cid, metadataCid }
  → stored on EvidenceBundle.ipfsCid
```

### How to Verify

**Mock mode** (no credentials needed):
```bash
# The test suite exercises CID generation end-to-end
pnpm --filter @pcc/kernel test
```

**Real mode**:
```bash
EVIDENCE_STORAGE=storacha \
STORACHA_PROOF=<base64-ucan-delegation> \
npx tsx scripts/sovereign-e2e-simulation.ts
# Look for "archived to IPFS" log lines with CIDs
```

The sovereign E2E simulation (`scripts/sovereign-e2e-simulation.ts`) runs a full 9-phase pipeline including IPFS archival. CIDs are printed to stdout after each bundle is archived.

---

## Starknet

### What It Does

Starknet is a ZK-rollup L2 with a Cairo-based smart contract environment. PCC uses it specifically for on-chain commitment anchoring: ZK proof hashes and Merkle roots are committed to Starknet Sepolia so they can be independently verified by anyone with access to the chain. The raw evidence never touches the chain — only a cryptographic hash of it.

### How PCC Uses It

After an evidence bundle passes verification, the pipeline:

1. Builds a Merkle commitment tree from all bundle hashes (via `CommitmentService`).
2. Generates ZK-style inclusion and tier compliance proofs (via `ZKProofService`).
3. Anchors the proof hash on Starknet Sepolia (via `StarknetProofAnchoringService`).

The `StarknetProofAnchoringService` computes a canonical SHA-256 hash of the proof (`proofId:proofType:proofBytes`), truncates it to 248 bits (31 bytes — a valid felt252 field element), and submits it to the `ProofRegistry` contract as a transaction calldata argument. The contract's `anchor_proof` entrypoint stores the felt on-chain.

For Merkle roots, the service hashes `root:depth=N` and submits to the `anchor_merkle_root` entrypoint on the same contract. This allows a single transaction to commit an entire batch of evidence bundles.

After submission, callers poll `getAnchorStatus(txHash)` to confirm finality. The real implementation fetches a transaction receipt from the Starknet JSON-RPC node and maps `SUCCEEDED`/`REVERTED` to the `AnchorStatus` type. Mock mode simulates block progression: the anchor is `accepted` after two status polls.

The service uses lazy-loaded `starknet.js` imports (`await import("starknet")`) so the package builds cleanly without forcing a starknet.js peer dependency on consumers that don't need real-mode.

### Files

| File | Role |
|------|------|
| `packages/verifier/src/starknet-proof-service.ts` | `StarknetProofAnchoringService` — anchor + status polling |
| `packages/verifier/src/zk-proof-service.ts` | `ZKProofService` — generates proofs that get anchored |
| `packages/verifier/src/commitment-service.ts` | `CommitmentService` — Merkle tree construction |
| `packages/verifier/src/noir-proof-service.ts` | Noir circuit integration (upgrade path) |
| `packages/verifier/src/__tests__/starknet-proof-service.test.ts` | Integration tests |
| `packages/gateway/src/routes/zk-proofs.ts` | REST: `POST /api/zk/anchor`, `GET /api/zk/status/:txHash` |

### Key Code Path

```
evidence verified
  → CommitmentService.buildTree(commitments)
  → ZKProofService.proveEvidenceInclusion(tree, index, bundleHash)
  → StarknetProofAnchoringService.anchorProof(zkProof)
      → computeProofHash(proof)          # sha256(id:type:proof)
      → felt = "0x" + hashHex.slice(0,62) # 248-bit felt252
      → account.execute([{               # real mode
          contractAddress: PROOF_REGISTRY,
          entrypoint: "anchor_proof",
          calldata: [felt]
        }])
      → returns StarknetAnchor { txHash, blockNumber, proofHash, chain }
```

### Contract

- **Registry address** (Starknet Sepolia): `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7`
- **RPC node** (default): `https://starknet-sepolia.public.blastapi.io/rpc/v0_7`

### How to Verify

**Mock mode**:
```bash
pnpm --filter @pcc/verifier test
# Runs starknet-proof-service.test.ts — exercises anchorProof, anchorMerkleRoot, getAnchorStatus
```

**Real mode**:
```bash
STARKNET_ACCOUNT=0x... \
STARKNET_PRIVATE_KEY=0x... \
STARKNET_NETWORK=goerli \
npx tsx scripts/sovereign-e2e-simulation.ts
# Prints Starknet tx hashes for each anchored proof
```

The gateway also exposes the anchor pipeline via REST:
```bash
curl -X POST https://capability.network/api/zk/anchor \
  -H "Content-Type: application/json" \
  -d '{"proofId": "...", "proofType": "evidence_inclusion"}'
```

---

## Lit Protocol

### What It Does

Lit Protocol is a decentralized key management network. When data is encrypted with Lit, the decryption key is threshold-split across Lit node operators — no single node holds the full key. Decryption shares are released only when the caller satisfies `UnifiedAccessControlConditions` evaluated on-chain by the Lit nodes. This creates programmable encryption: access conditions can be any on-chain state.

### How PCC Uses It

Evidence bundles contain sensitive operational data (sensor readings, calibration records, photos). This data must be encrypted so that:
- The escrow buyer can access it (to verify the work was done correctly).
- Accredited verifiers can access it (to adjudicate disputes).
- No one else can.

PCC wires Lit conditions directly to the `MilestoneEscrow` smart contract state. The access condition chain is:

```
(caller address == escrow.getBuyer(jobId))
OR
(escrow.getVerifierReputation(caller) >= 100)
```

These are real `UnifiedAccessControlCondition` objects compatible with the Lit SDK. They are stored in the `EncryptedEvidenceBundle` alongside the ciphertext and `litDataToEncryptHash`, so any Lit-aware client can reconstruct the decryption request.

Two implementations exist:

**`LitEncryptionService`** (`lit-encryption-service.ts`) — the mock/development service. Uses real AES-256-GCM encryption. The same interface, types, and access condition generation as the real service, but key shares are held in an in-process `Map` rather than the Lit network. This allows full pipeline testing without Lit network access. The generated `UnifiedAccessControlCondition` arrays are real Lit-compatible objects that would work with the production SDK.

**`RealLitEncryptionService`** (`lit-encryption-real.ts`) — the production service. Uses `@lit-protocol/lit-node-client` v6, connecting to the `datil-test` Lit network. Encryption calls `client.encrypt()` with the Lit network's public key; decryption calls `client.decrypt()` with either `SessionSigs` (SIWE-based, preferred) or a bare `AuthSig`. Key shares are never stored locally.

The factory pattern (`createEvidenceStorage`) and environment variable `LIT_PROTOCOL_REAL=true` switch between mock and real modes at runtime.

### Files

| File | Role |
|------|------|
| `packages/kernel/src/lit-encryption-service.ts` | Mock service with real AES-256-GCM, full interface |
| `packages/kernel/src/lit-encryption-real.ts` | Real service — `@lit-protocol/lit-node-client` v6 |

### Key Types on `EncryptedEvidenceBundle`

```typescript
litCiphertext?: string;            // base64 ciphertext from Lit SDK
litDataToEncryptHash?: string;     // SHA-256 of plaintext (integrity)
litAccessConditions?: object[];    // UnifiedAccessControlCondition[]
litNetwork?: string;               // "datil-test" | "datil"
```

### Key Code Path

```
job finalized
  → LitEncryptionService.connect()
  → buildAccessConditions(escrowAddress, jobId)
      → buyer condition: evmContract.getBuyer(jobId) == :userAddress
      → OR operator
      → verifier condition: evmContract.getVerifierReputation(:userAddress) >= 100
  → encryptBundle(bundle, escrowAddress, jobId)
      → mock: AES-256-GCM with local key storage
      → real:  client.encrypt({ dataToEncrypt, unifiedAccessControlConditions })
  → returns EncryptedEvidenceBundle with litCiphertext + litAccessConditions

// Decryption (buyer side):
  → LitEncryptionService.decryptBundle(encrypted, authSig)
      → mock: retrieves key from Map, decrypts with AES-256-GCM
      → real:  client.decrypt({ ciphertext, dataToEncryptHash, chain, unifiedAccessControlConditions, sessionSigs })
```

### How to Verify

**Mock mode** (always available):
```bash
# Demo script shows encrypt → decrypt round-trip with access condition inspection
npx tsx scripts/lit-protocol-demo.ts

# Unit tests
pnpm --filter @pcc/kernel test
```

**Real mode** (requires Lit datil-test network):
```bash
LIT_PROTOCOL_REAL=true npx tsx scripts/lit-protocol-demo.ts
# Connects to datil-test, performs real threshold encryption
```

The mock service's access conditions are valid Lit SDK objects. You can verify the structure:
```bash
npx tsx -e "
import { LitEncryptionService } from './packages/kernel/dist/lit-encryption-service.js';
const svc = new LitEncryptionService();
await svc.connect();
const conds = svc.buildAccessConditions('0x9e81f5...', 'job_abc123');
console.log(JSON.stringify(conds, null, 2));
"
```

---

## Integration Map

The three sponsors wire together in the verification pipeline:

```
evidence bundle finalized
       │
       ▼
Lit Protocol encrypt(bundle, accessConditions)
       │ litCiphertext + litDataToEncryptHash + litAccessConditions
       ▼
Storacha.archiveEncryptedBundle(encryptedBundle)
       │ { cid, metadataCid }
       ▼
CommitmentService.buildTree([bundleHash, ...])
       │ merkleRoot
       ▼
ZKProofService.proveEvidenceInclusion(tree, index, bundleHash)
       │ ZKProof { proof, publicInputs }
       ▼
StarknetProofAnchoringService.anchorProof(zkProof)
       │ StarknetAnchor { txHash, chain: "starknet-sepolia" }
       ▼
escrow condition met → settlement
```

This chain gives PCC five guarantees for every job:
1. The evidence exists and is retrievable (Storacha CID).
2. The evidence was not modified after archival (content-addressed CID).
3. The evidence was included in a specific commitment batch (Merkle proof).
4. The commitment is recorded permanently on a public chain (Starknet anchor).
5. Access to the evidence is governed by programmable on-chain conditions (Lit Protocol).

---

## NEAR Protocol — Chain Abstraction

### What It Does

NEAR's chain abstraction layer lets agents initiate payments on any chain from any source asset, without managing bridges or cross-chain token approvals. PCC integrates the [1Click API](https://1click.chaindefuser.com/v0/) — a solver network that routes atomic cross-chain swaps using NEAR as the settlement layer. A PCC agent can request a manufacturing job priced in Base USDC and pay for it with NEAR-native USDC in a single API call.

### How PCC Uses It

The flow is:

1. A User or Broker agent determines that an escrow contract on a given destination chain needs funding.
2. The agent sends a `near_payment_intent` A2A message to the gateway.
3. The gateway calls `POST /api/near/quote` → 1Click returns an atomic cross-chain quote with output amount, fee, and a validity window.
4. The agent confirms (or auto-accepts) the quote and calls `POST /api/near/intent` to submit the intent to the solver network.
5. The gateway polls `GET /api/near/intent/:id` until the status reaches `settled`.

No SDK dependency — the integration uses plain `fetch()` against the 1Click REST API.

### Files

| File | Role |
|------|------|
| `packages/gateway/src/routes/near.ts` | 4 REST routes: status, quote, intent, intent status |
| `packages/gateway/src/contracts/near-client.ts` | 1Click API client with mock mode for testing |
| `packages/gateway/src/__tests__/near.test.ts` | 25 tests covering all routes + full e2e flow |
| `packages/a2a/src/types.ts` | `NearPaymentIntentRequest`, `NearPaymentQuoteResult`, `NearPaymentSubmit`, `NearPaymentSettled` |

### Key Code Path

```
User/Broker Agent: near_payment_intent message
       │ { workflowId, fromChain, fromAsset, toChain, toAsset, amount }
       ▼
POST /api/near/quote
       │ → 1Click POST /v0/quote
       │ ← { quoteId, toAmount, estimatedFee, validUntil }
       ▼
POST /api/near/intent
       │ → 1Click POST /v0/intent  (quoteId + workflowId)
       │ ← { intentId, status: "submitted", txHash }
       ▼
GET /api/near/intent/:intentId (poll)
       │ ← { status: "settled", settlementTxHash }
       ▼
escrow on destination chain is funded → job execution begins
```

### A2A Intent Types

```typescript
// User agent requests a cross-chain payment
NearPaymentIntentRequest {
  type: "near_payment_intent";
  workflowId: string;
  fromChain: string;   // "near"
  fromAsset: string;   // "USDC"
  toChain: string;     // "base"
  toAsset: string;     // "USDC"
  amount: string;      // smallest denomination
}

// Gateway responds with solver quote
NearPaymentQuoteResult {
  type: "near_payment_quote_result";
  quoteId: string;
  fromAmount: string;
  toAmount: string;
  estimatedFee: string;
  validUntil: string;
}

// Agent confirms and submits
NearPaymentSubmit { type: "near_payment_submit"; quoteId: string; workflowId: string; }

// Gateway confirms settlement
NearPaymentSettled { type: "near_payment_settled"; intentId: string; status: "settled"; txHash?: string; }
```

### How to Verify

**Mock mode** (always available):
```bash
pnpm --filter @pcc/gateway test
# Runs near.test.ts — 25 tests covering quote, intent, status, e2e flow
```

**Live API** (points at real 1Click solver network):
```bash
# Check integration status
curl https://capability.network/api/near/status

# Get a quote (NEAR USDC → Base USDC, 1 USDC = 1_000_000 micro-USDC)
curl -X POST https://capability.network/api/near/quote \
  -H "Content-Type: application/json" \
  -d '{"fromChain":"near","fromAsset":"USDC","toChain":"base","toAsset":"USDC","amount":"1000000"}'
```
