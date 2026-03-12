# Sovereign Infrastructure Integration — Technical Design

> PCC (Physical Capability Cloud) as sovereign manufacturing infrastructure:
> no centralized gatekeepers for identity, compute verification, data storage, or access control.

## 1. Problem Statement

PCC currently relies on centralized components for critical functions:
- **Identity**: Machine/operator identities are local strings or single Ethereum addresses
- **Storage**: Evidence bundles exist only in-memory; no durable, tamper-evident storage
- **Compute verification**: Quality verification is centralized (single verifier market)
- **Access control**: Evidence encryption uses centralized key management
- **Key management**: Single private keys per agent, no HSM/MPC/threshold signing

For PCC to be credibly neutral manufacturing infrastructure, these components must be **sovereign** — operating without centralized gatekeepers, resilient to single points of failure, and verifiable by any participant.

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    PCC Control Plane                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Identity  │ │ Evidence │ │ Compute  │ │  Access   │  │
│  │  (DIDs)   │ │  (IPFS)  │ │ (Verify) │ │  (Lit)    │  │
│  └─────┬────┘ └─────┬────┘ └─────┬────┘ └─────┬─────┘  │
│        │            │            │             │         │
│  ┌─────▼────────────▼────────────▼─────────────▼─────┐  │
│  │              Settlement Layer (On-Chain)            │  │
│  │  MilestoneEscrow │ ReputationRegistry │ DAO Gov    │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │              │              │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │ Kernel  │   │ Kernel  │   │ Kernel  │
    │  (AZ-1) │   │  (AZ-2) │   │  (AZ-3) │
    └─────────┘   └─────────┘   └─────────┘
```

## 3. Decentralized Identity (DIDs for Machines & Operators)

### 3.1 Current State
- `packages/contracts/src/IdentityRegistry.sol` — on-chain entity registration (Agent, Machine, Operator, Verifier)
- `packages/agent-runtime/src/wallet.ts` — local viem wallets, single address per agent
- `packages/spec/src/types/kernel.ts` — `ShopKernel.id` is a plain string (`kernel_xxx`)

### 3.2 Design: W3C DID Integration

Every machine, operator, and agent gets a **W3C Decentralized Identifier (DID)**:

```
did:pcc:kernel:kernel_dev_001          — Shop Kernel identity
did:pcc:operator:0x1234...abcd         — Operator (human)
did:pcc:agent:agent_broker_001         — AI Agent
did:pcc:device:device_prusa_mk4_001    — Individual machine
```

**DID Document** (stored on-chain or IPFS, resolved by gateway):
```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:pcc:kernel:kernel_dev_001",
  "verificationMethod": [{
    "id": "did:pcc:kernel:kernel_dev_001#key-1",
    "type": "EcdsaSecp256k1VerificationKey2019",
    "controller": "did:pcc:kernel:kernel_dev_001",
    "publicKeyHex": "0x04..."
  }],
  "service": [{
    "id": "#capabilities",
    "type": "PCCCapabilityEndpoint",
    "serviceEndpoint": "https://kernel-001.pcc.network/capabilities"
  }],
  "capabilityDelegation": ["did:pcc:operator:0x1234...abcd"]
}
```

### 3.3 Verifiable Credentials for Capabilities

Machines issue **Verifiable Credentials (VCs)** proving their capabilities:

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "CapabilityCredential"],
  "issuer": "did:pcc:kernel:kernel_dev_001",
  "credentialSubject": {
    "id": "did:pcc:device:device_prusa_mk4_001",
    "capability": "fdm_printing",
    "parameters": {
      "buildVolume": [250, 210, 210],
      "layerResolution": [0.05, 0.30],
      "materials": ["PLA", "PETG", "ABS", "ASA"]
    },
    "assuranceTier": 2,
    "calibrationDate": "2026-03-01T00:00:00Z",
    "calibrationProof": "ipfs://QmXyz..."
  },
  "proof": {
    "type": "EcdsaSecp256k1Signature2019",
    "verificationMethod": "did:pcc:kernel:kernel_dev_001#key-1",
    "proofValue": "0x..."
  }
}
```

### 3.4 Integration Points

| File | Current | Change |
|------|---------|--------|
| `packages/spec/src/types/kernel.ts` | `id: KernelId` (string) | Add `did: string`, `didDocument?: DIDDocument` |
| `packages/spec/src/types/kernel.ts` | `KernelDevice.id` (string) | Add `did: string`, `credentials: VerifiableCredential[]` |
| `packages/agent-runtime/src/wallet.ts` | `WalletConfig` | Add `didMethod?: string`, `didDocument?: DIDDocument` |
| `packages/agent-runtime/src/base-agent.ts` | constructor | Generate DID on init, register with `IdentityRegistry` |
| `packages/contracts/src/IdentityRegistry.sol` | `Entity` struct | Add `did: string`, `credentialRoot: bytes32` |
| `packages/gateway/src/routes/registry.ts` | Mock data | Real DID resolution, `/api/registry/resolve/:did` endpoint |

### 3.5 Implementation: `did:pcc` Method

```typescript
// packages/spec/src/identity/did.ts
export interface DIDDocument {
  id: string;                          // did:pcc:kernel:kernel_dev_001
  verificationMethod: VerificationMethod[];
  service?: ServiceEndpoint[];
  capabilityDelegation?: string[];     // DIDs that can act on behalf
  capabilityInvocation?: string[];     // DIDs that can invoke capabilities
}

export function createDID(type: "kernel" | "operator" | "agent" | "device", id: string): string {
  return `did:pcc:${type}:${id}`;
}

export function resolveDID(did: string): Promise<DIDDocument> {
  // 1. Check on-chain IdentityRegistry
  // 2. Fallback to IPFS-stored DID document
  // 3. Verify signatures
}
```

---

## 4. Decentralized Evidence Storage (IPFS + Filecoin)

### 4.1 Current State
- `packages/kernel/src/evidence-emitter.ts` — evidence bundles finalized in-memory, SHA-256 hashed
- `packages/spec/src/types/encryption.ts` — AES-256-GCM encryption with ECIES key capsules
- `packages/verifier/src/commitment-service.ts` — Merkle trees for batch commitments
- No persistent storage beyond mock SQLite

### 4.2 Design: Content-Addressed Evidence Archive

Every evidence bundle gets archived to **IPFS** with optional **Filecoin** deals for long-term storage:

```
Evidence Event → Bundle → Encrypt (AES-256-GCM) → IPFS pin → Filecoin deal
                   │
                   ├── bundleHash (SHA-256) → on-chain commitment
                   ├── ipfsCid (content address) → immutable retrieval
                   └── filecoinDealId → guaranteed storage duration
```

### 4.3 Storage Architecture

```typescript
// packages/kernel/src/evidence-storage.ts
import { create } from 'ipfs-http-client';

export interface EvidenceArchive {
  bundleHash: string;           // SHA-256 of plaintext
  encryptedCid: string;         // IPFS CID of encrypted bundle
  metadataCid: string;          // IPFS CID of public metadata (no secrets)
  filecoinDealId?: string;      // Filecoin storage deal
  storageProof?: StorageProof;  // Filecoin proof-of-storage
}

export interface StorageProof {
  dealId: string;
  proverId: string;
  sectorId: number;
  expirationEpoch: number;
  verified: boolean;
}

export class EvidenceStorageService {
  private ipfs: IPFSHTTPClient;

  async archiveBundle(bundle: EncryptedEvidenceBundle): Promise<EvidenceArchive> {
    // 1. Pin encrypted bundle to IPFS
    const encryptedCid = await this.ipfs.add(JSON.stringify(bundle));

    // 2. Pin public metadata (bundle ID, tier, timestamp, hash — no encrypted data)
    const metadata = {
      bundleId: bundle.bundleId,
      tier: bundle.assuranceTier,
      timestamp: bundle.timestamp,
      bundleHash: bundle.bundleHash,
      eventCount: bundle.encryptedEvents.length,
    };
    const metadataCid = await this.ipfs.add(JSON.stringify(metadata));

    // 3. Optionally create Filecoin deal for long-term storage
    const filecoinDealId = await this.createFilecoinDeal(encryptedCid);

    return {
      bundleHash: bundle.bundleHash,
      encryptedCid: encryptedCid.toString(),
      metadataCid: metadataCid.toString(),
      filecoinDealId,
    };
  }

  async retrieveBundle(cid: string): Promise<EncryptedEvidenceBundle> {
    const chunks = [];
    for await (const chunk of this.ipfs.cat(cid)) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
}
```

### 4.4 Integration Points

| File | Change |
|------|--------|
| `packages/spec/src/types/encryption.ts` | Add `ipfsCid?: string`, `filecoinDealId?: string`, `storageProof?: StorageProof` to `EncryptedEvidenceBundle` |
| `packages/kernel/src/evidence-emitter.ts` | After `finalizeBundle()`, call `evidenceStorage.archiveBundle()` |
| `packages/gateway/src/routes/evidence-encrypted.ts` | Add `/api/evidence/:id/retrieve` that fetches from IPFS |
| `packages/verifier/src/commitment-service.ts` | Commit IPFS CIDs (not just hashes) to Merkle trees |

### 4.5 Lighthouse.storage Integration (Filecoin + IPFS simplified)

For hackathon speed, use **Lighthouse** (lighthouse.storage) which wraps IPFS + Filecoin:

```typescript
import lighthouse from '@lighthouse-web3/sdk';

// Upload encrypted evidence bundle
const response = await lighthouse.uploadEncrypted(
  bundleBuffer,
  lighthouseApiKey,
  agentPublicKey,
  signedMessage
);
// response.data.Hash → IPFS CID with Filecoin deal auto-created
```

---

## 5. Decentralized Access Control (Lit Protocol)

### 5.1 Current State
- `packages/spec/src/types/encryption.ts` — `KeyCapsule` with ECIES-wrapped keys
- `packages/spec/src/types/encryption.ts` — `AccessGrant` with simple address/role/expiry
- `packages/kernel/src/encryption-service.ts` — centralized key management

### 5.2 Design: Programmable Access Control with Lit Protocol

Replace centralized key capsules with **Lit Protocol's Programmable Key Pairs (PKPs)** and **Lit Actions**:

```
Evidence Bundle → Encrypt with Lit PKP → Access Conditions on-chain
                                              │
                                              ├── "Tier 3 verifier with 100+ rep"
                                              ├── "Job buyer who paid escrow"
                                              ├── "After challenge window closes"
                                              └── "Kernel operator (always)"
```

### 5.3 Access Condition Language

```typescript
// Lit Protocol access conditions for evidence bundles
const accessConditions = [
  // Condition 1: Must be the job buyer
  {
    conditionType: "evmBasic",
    contractAddress: MILESTONE_ESCROW_ADDRESS,
    standardContractType: "",
    chain: "baseSepolia",
    method: "getBuyer",
    parameters: [":jobId"],
    returnValueTest: {
      comparator: "=",
      value: ":userAddress"
    }
  },
  // OR Condition 2: Must be a Tier 3 verifier with sufficient reputation
  { operator: "or" },
  {
    conditionType: "evmContract",
    contractAddress: REPUTATION_REGISTRY_ADDRESS,
    functionName: "getReputation",
    functionParams: [":userAddress"],
    functionAbi: REPUTATION_ABI,
    chain: "baseSepolia",
    returnValueTest: {
      comparator: ">=",
      value: "100"
    }
  }
];
```

### 5.4 Lit Actions for Evidence Decryption

```javascript
// Lit Action: decrypt evidence bundle with programmable conditions
const litActionCode = `
  const go = async () => {
    // Verify the requester meets access conditions
    const escrow = new ethers.Contract(escrowAddress, escrowAbi, provider);
    const buyer = await escrow.getBuyer(jobId);

    // Check: is requester the buyer, a verified verifier, or the kernel operator?
    const isAuthorized =
      requesterAddress === buyer ||
      (await reputationRegistry.getReputation(requesterAddress)) >= 100 ||
      requesterAddress === kernelOperator;

    if (!isAuthorized) {
      return LitActions.setResponse({ response: JSON.stringify({ error: "unauthorized" }) });
    }

    // Decrypt and return the symmetric key
    const decryptedKey = await Lit.Actions.decryptAndCombine({
      accessControlConditions,
      ciphertext,
      dataToEncryptHash,
      authSig,
      chain: "baseSepolia",
    });

    LitActions.setResponse({ response: decryptedKey });
  };
  go();
`;
```

### 5.5 Integration Points

| File | Change |
|------|--------|
| `packages/spec/src/types/encryption.ts` | Add `litPkpPublicKey?: string`, `litAccessConditions?: LitAccessCondition[]` to `EncryptedEvidenceBundle` |
| `packages/spec/src/types/encryption.ts` | Replace `KeyCapsule.wrappedKey` with `litCiphertext` + `litDataToEncryptHash` |
| `packages/kernel/src/encryption-service.ts` | Add `encryptWithLit()` method using `@lit-protocol/lit-node-client` |
| `packages/gateway/src/routes/evidence-encrypted.ts` | Add `/api/evidence/:id/decrypt` that orchestrates Lit decryption |

---

## 6. Decentralized Compute Verification (Bittensor Subnets)

### 6.1 Current State
- `packages/verifier/src/market.ts` — centralized verifier market, stake-weighted random selection
- `packages/verifier/src/evidence-verifier.ts` — local verification of evidence bundles
- `packages/verifier/src/noir-proof-service.ts` — Noir ZK circuits (evidence_inclusion, tier_compliance)

### 6.2 Design: Bittensor Subnet for Manufacturing Quality Verification

Create a **Bittensor subnet** where miners compete to verify manufacturing evidence quality:

```
Evidence Bundle → Submit to Subnet → Miners verify → Consensus → On-chain result
                                          │
                                          ├── Miner 1: Check dimensional accuracy
                                          ├── Miner 2: Verify sensor data integrity
                                          ├── Miner 3: Validate process parameters
                                          └── Consensus: 2/3 agree → verified
```

### 6.3 Subnet Architecture

```python
# Bittensor subnet for PCC evidence verification
# Validators (orchestrate verification tasks)
class PCCValidator(bt.Subnet):
    def forward(self, synapse: EvidenceVerificationSynapse):
        """Send evidence bundle to miners for verification"""
        responses = self.dendrite.query(
            axons=self.metagraph.axons,
            synapse=synapse,
            timeout=30.0
        )
        # Weighted consensus based on miner scores
        return self.aggregate_responses(responses)

# Miners (perform actual verification)
class PCCMiner(bt.Subnet):
    def forward(self, synapse: EvidenceVerificationSynapse):
        """Verify evidence bundle quality"""
        bundle = synapse.evidence_bundle

        # Check 1: Hash integrity
        hash_valid = verify_bundle_hash(bundle)

        # Check 2: Tier compliance
        tier_valid = check_tier_requirements(bundle, synapse.required_tier)

        # Check 3: Sensor data plausibility
        sensor_valid = verify_sensor_readings(bundle)

        # Check 4: ZK proof verification (Noir circuits)
        zk_valid = verify_noir_proof(bundle.proof)

        return VerificationResult(
            hash_valid=hash_valid,
            tier_valid=tier_valid,
            sensor_valid=sensor_valid,
            zk_valid=zk_valid,
            confidence=calculate_confidence(bundle)
        )
```

### 6.4 Integration Points

| File | Change |
|------|--------|
| `packages/verifier/src/market.ts` | Add `BittensorVerifierPool` alongside existing `VerifierMarket` |
| `packages/verifier/src/evidence-verifier.ts` | Add `submitToSubnet()` for decentralized verification |
| `packages/gateway/src/routes/zk-proofs.ts` | Add `/api/verification/subnet-status` for subnet health |
| `packages/spec/src/types/verifier.ts` | Add `subnetUID?: number`, `minerHotkey?: string` to `Verifier` type |

### 6.5 Hackathon Scope

For the hackathon, the realistic scope is:
- Register a test subnet on Bittensor testnet
- Build a simple miner that verifies evidence bundle hash integrity
- Build a validator that aggregates miner responses
- Gateway endpoint that submits verification requests to the subnet
- Dashboard display of subnet verification status

---

## 7. Hardware Attestation (TEE Integration)

### 7.1 Design: Trusted Execution for Evidence Integrity

Shop kernels running on TEE-capable hardware (Intel SGX, ARM TrustZone) can provide **hardware-attested evidence**:

```typescript
// packages/kernel/src/tee-attestation.ts
export interface TEEAttestation {
  platform: "sgx" | "trustzone" | "sev";
  quote: string;              // Hardware attestation quote
  measurementHash: string;    // MRENCLAVE/MRSIGNER
  timestamp: string;
  publicKey: string;          // Enclave's ephemeral key
}

export interface AttestedEvidence extends EvidenceBundle {
  teeAttestation: TEEAttestation;
  // Evidence was produced inside the TEE — cannot be tampered
}
```

### 7.2 Integration with Assurance Tiers

| Tier | Current Requirement | + Sovereign Requirement |
|------|--------------------|-----------------------|
| 0 (Basic) | Hash only | Hash only |
| 1 (Standard) | + Sensor data | + IPFS-archived evidence |
| 2 (Verified) | + Verifier attestation | + Bittensor subnet verification |
| 3 (Sovereign) | + TEE attestation | + TEE + Lit access control + Filecoin deal |

---

## 8. Implementation Priority (Hackathon-Scoped)

### Must-Have (Demo-Ready in 48h)
1. **DID generation** for kernels and agents (did:pcc method, local resolution)
2. **IPFS pinning** of evidence bundles via Lighthouse SDK
3. **Lit Protocol** access conditions for encrypted evidence (replace centralized key capsules)
4. **Dashboard integration**: show DID, IPFS CID, Lit access status on evidence pages

### Nice-to-Have (If Time Permits)
5. **Bittensor testnet** subnet with basic hash verification miner
6. **Filecoin deals** via Lighthouse for long-term archival
7. **Verifiable Credentials** for machine capabilities

### Post-Hackathon
8. Full TEE attestation pipeline
9. Production Bittensor subnet with multi-check miners
10. Cross-chain DID resolution
11. Governance-controlled access policies

---

## 9. Dependencies & Packages

| Package | Purpose | Install |
|---------|---------|---------|
| `@lit-protocol/lit-node-client` | Lit Protocol encryption/decryption | `pnpm add @lit-protocol/lit-node-client` |
| `@lighthouse-web3/sdk` | IPFS + Filecoin storage | `pnpm add @lighthouse-web3/sdk` |
| `did-resolver` | W3C DID resolution | `pnpm add did-resolver` |
| `did-jwt-vc` | Verifiable Credentials | `pnpm add did-jwt-vc` |
| `bittensor` | Bittensor subnet SDK (Python) | Separate service |

---

## 10. Security Considerations

- **Key rotation**: DIDs support key rotation via DID Document updates; revocation via `deactivated: true`
- **IPFS persistence**: Content-addressed = immutable, but availability requires pinning or Filecoin deals
- **Lit Protocol availability**: Lit network is decentralized but early; implement fallback to centralized key capsules
- **Bittensor Sybil resistance**: Stake-weighted mining prevents Sybil attacks on verification
- **TEE side-channels**: TEE attestation proves code integrity, not freedom from side-channel attacks — combine with ZK proofs for defense in depth
