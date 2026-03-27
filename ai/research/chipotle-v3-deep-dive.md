# Lit Protocol Chipotle v3 -- Deep Dive for PCC Architectural Decision

**Date**: 2026-03-26
**Researcher**: Claude Opus 4.6 (1M context)
**Purpose**: Determine whether Lit Protocol Chipotle v3 should replace, supplement, or be abandoned in favor of PCC's existing ECIES + AES-256-GCM encryption service.
**Related**: `ai/research/lit-alternatives.md` (hackathon-focused assessment from earlier today)

---

## Table of Contents

1. [What Chipotle v3 Actually Provides](#1-what-chipotle-v3-actually-provides)
2. [Trust Model and Threshold Decryption](#2-trust-model-and-threshold-decryption)
3. [Access Control Conditions](#3-access-control-conditions)
4. [SDK and API Surface](#4-sdk-and-api-surface)
5. [Network Topology](#5-network-topology)
6. [Cost and Payment Model](#6-cost-and-payment-model)
7. [Security Guarantees: Lit vs. Local ECIES](#7-security-guarantees-lit-vs-local-ecies)
8. [Risks of Depending on Lit Protocol](#8-risks-of-depending-on-lit-protocol)
9. [Comparison Matrix: PCC EncryptionService vs. Lit Chipotle](#9-comparison-matrix)
10. [Recommendation](#10-recommendation)

---

## 1. What Chipotle v3 Actually Provides

### Overview

Chipotle is Lit Protocol's **v3 -- a ground-up rebuild** of the network. It replaces both Datil (v0, shut down Feb 25, 2026) and Naga (v1, sunsetting March 25, 2026). The name follows Lit's naming convention (Cayenne, Habanero, Manzano, Datil, Naga, Chipotle -- all chili peppers).

### Core Architecture Change: Threshold -> TEE

The fundamental architectural shift in Chipotle is **from threshold cryptography to TEE-based execution**:

| Aspect | Datil/Naga (v0/v1) | Chipotle (v3) |
|--------|---------------------|---------------|
| **Execution model** | Multi-node threshold coordination (2/3 of nodes must participate) | Single TEE enclave per request |
| **Key management** | DKG key shares across all nodes | On-chain KMS with TEE root of trust |
| **TEE role** | Hosts key shares + JS runtime | IS the security boundary (sole executor) |
| **Coordination** | Every operation requires multi-node consensus | No multi-node coordination needed |
| **Coupling** | Lit Actions engine + KMS tightly coupled | Lit Actions engine DECOUPLED from KMS |
| **Client interface** | SDK required (complex) | REST API (HTTP), SDK optional |
| **Auth model** | Wallet signatures (AuthSig, SessionSigs) | API keys |
| **Payment** | Capacity Credits (NFT reservations) | Pay-per-request with LITKEY on Base |

### What Chipotle Delivers

1. **Lit Actions**: Immutable JavaScript (Deno sandbox) serverless functions that govern signing and decryption. Same concept as before, but decoupled from KMS.
2. **Signing**: ECDSA (secp256k1), Schnorr, EdDSA. Sub-second on Naga; expected faster on Chipotle (single TEE, no coordination).
3. **Encryption/Decryption**: Identity-Based Encryption using BLS threshold keys. Access conditions gate who can obtain decryption shares.
4. **PKPs (Programmable Key Pairs)**: Distributed keys that no single party controls. Used for wallets, signing, and programmatic key management.
5. **Groups**: New v3 primitive -- bundles wallets, permitted actions, and API keys into a single logical unit. Enables scoped API keys restricted to specific Lit Actions.
6. **REST API**: Standard HTTP endpoints at `api.dev.litprotocol.com`. OpenAPI spec available for auto-generating clients in any language.
7. **Dashboard**: Web GUI at `dashboard.dev.litprotocol.com` for managing actions, keys, groups, and billing.

### Architecture Diagram (Conceptual)

```
Chipotle v3 Architecture:

  Client (any HTTP client)
    |
    | REST API + API Key auth
    v
  +-----------------------+
  | TEE Enclave           |  <-- Phala TEE (AMD SEV-SNP)
  | +---------+           |
  | |Lit Action| (Deno JS)|
  | +---------+           |
  |     |                 |
  |     v                 |
  | Key Management        |  <-- On-chain KMS (key orchestration)
  | (decoupled)           |
  +-----------------------+
    |
    v
  On-chain (Base L2)
  - Access control verification
  - Key release gating
  - Multisig authorization
  - LITKEY payment settlement
```

### Status and Timeline

| Date | Event |
|------|-------|
| Mar 2026 | Dev environment live (`api.dev.litprotocol.com`) |
| ~Mar 25, 2026 | Production launch (target, exact date TBA) |
| Mar 25 - Apr 1, 2026 | Naga sunset window |
| Apr 1, 2026 | Naga completely dead |
| TBD | Migration tooling, docs, and hands-on support |

**Critical note**: As of March 26, 2026, Chipotle production launch has NOT been confirmed. The dev environment is live, but production deployment date is still "TBA" with "minimum 2 weeks notice."

---

## 2. Trust Model and Threshold Decryption

### How Lit's Encryption Actually Works (Pre-Chipotle)

Lit uses **Identity-Based Encryption (IBE)** built on **BLS (Boneh-Lynn-Shacham) threshold signatures**:

1. **Distributed Key Generation (DKG)**: At network genesis, nodes collectively generate a BLS keypair. No single node holds the full private key -- each holds a share.

2. **Encryption (client-side, no network call)**:
   - User defines Access Control Conditions (ACCs)
   - User constructs an identity parameter from ACCs + data hash
   - User encrypts data using the **BLS network public key** + identity parameter
   - Result: ciphertext + metadata (ACCs, data hash)
   - Performance: ~2ms (entirely local)

3. **Decryption (requires network)**:
   - Requester presents ciphertext metadata + proof of identity (wallet sig)
   - Each Lit node independently verifies:
     a. The wallet signature is valid
     b. The wallet satisfies the Access Control Conditions (checks on-chain state)
   - If satisfied, each node signs the identity parameter with its BLS key share
   - Requester collects signature shares (needs 2/3 of nodes)
   - Assembled BLS signature = decryption key
   - Requester decrypts locally

### How Chipotle Changes the Trust Model

**Key difference**: Chipotle moves from distributed threshold consensus to **single-TEE execution** with on-chain key management.

| Trust Property | Naga (Threshold) | Chipotle (TEE) |
|----------------|-------------------|-----------------|
| **Key exposure** | No single node sees full key | TEE enclave sees full key, but hardware prevents extraction |
| **Consensus requirement** | 2/3 of nodes must agree | Single TEE enclave processes request |
| **Failure mode** | Tolerates up to 1/3 malicious nodes | Trust in hardware (AMD SEV-SNP) + attestation |
| **Who you trust** | Distributed set of independent operators | AMD hardware, Phala TEE infrastructure, Lit's code |
| **Collusion resistance** | Requires 2/3 nodes colluding | Requires breaking AMD SEV-SNP (hardware attack) |
| **Verification** | Threshold math (provable) | Remote attestation (hardware-backed) |
| **Access condition enforcement** | Each node checks independently | TEE checks, verified by on-chain KMS |

### Trust Assumptions in Chipotle

You are trusting:
1. **AMD SEV-SNP hardware** is not compromised (side-channel attacks exist in research but are impractical at scale)
2. **Phala Network's TEE infrastructure** is correctly configured and attested
3. **Lit's code** running inside the TEE is correct (verifiable via deterministic builds)
4. **On-chain KMS** correctly gates key release
5. **The TEE enclave** cannot be modified by the node operator (hardware guarantee)

The SDK automatically validates attestations against AMD certificates. If a node operator attempted to modify the software or extract key material, attestation would fail and the SDK would reject that node.

### Honest Assessment

The threshold model (Naga) provides **information-theoretic security** -- even if some nodes are compromised, the key cannot be reconstructed without 2/3 threshold. The TEE model (Chipotle) provides **hardware-backed security** -- the key exists in one place but hardware prevents access. These are fundamentally different security models:

- **Threshold**: Security degrades gracefully with node compromise. An adversary needs to compromise a supermajority.
- **TEE**: Binary -- either the hardware is secure or it isn't. If AMD SEV-SNP is broken, all bets are off.

For PCC's evidence encryption, the relevant question is: **do you need to protect against a single-party compromise?** If so, the threshold model is stronger. If TEE guarantees are sufficient (they are for most applications), Chipotle's model is fine.

---

## 3. Access Control Conditions

### What They Are

Access Control Conditions (ACCs) are the rules that determine who can decrypt data. They are evaluated on-chain by Lit nodes before releasing decryption shares/keys.

### Condition Types

| Type | Description | PCC Relevance |
|------|-------------|---------------|
| `evmBasic` | Standard ERC-20/721/1155 balance checks | Low -- PCC doesn't token-gate |
| `evmContract` | **Custom contract function calls** | **HIGH** -- gate on escrow state |
| `solRpc` | Solana RPC calls | Low |
| `cosmos` | Cosmos chain queries | None |
| `unified` | Cross-chain composable conditions | Medium |

### Custom Contract Calls (evmContract) -- The Key Feature for PCC

This is what PCC's `LitEncryptionService` already implements in mock form. The real version looks like:

```javascript
const accessControlConditions = [
  {
    conditionType: "evmContract",
    contractAddress: "0x9e81f5fd...MilestoneEscrow",
    chain: "baseSepolia",
    functionName: "getBuyer",
    functionParams: [":jobId"],
    functionAbi: {
      name: "getBuyer",
      inputs: [{ name: "jobId", type: "string" }],
      outputs: [{ name: "", type: "address" }],
      stateMutability: "view",
      type: "function"
    },
    returnValueTest: {
      comparator: "=",
      value: ":userAddress"  // Magic variable: requesting user's address
    }
  },
  { operator: "or" },
  {
    conditionType: "evmContract",
    contractAddress: "0x9e81f5fd...MilestoneEscrow",
    chain: "baseSepolia",
    functionName: "getVerifierReputation",
    functionParams: [":userAddress"],
    functionAbi: {
      name: "getVerifierReputation",
      inputs: [{ name: "verifier", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
      stateMutability: "view",
      type: "function"
    },
    returnValueTest: {
      comparator: ">=",
      value: "100"
    }
  }
];
```

### Boolean Operators

Conditions can be composed with `and` / `or` operators, alternating in the array:
```
[condition1, { operator: "or" }, condition2, { operator: "and" }, condition3]
```

### Can They Gate on Escrow Status?

**Yes.** This is the primary value proposition of Lit for PCC. The conditions can call ANY view function on ANY EVM contract. For PCC's MilestoneEscrow, you could gate on:

- `getBuyer(jobId)` -- only the buyer can decrypt
- `getVerifierReputation(address)` -- only reputable verifiers
- `getMilestoneStatus(jobId, milestoneIndex)` -- only if milestone is completed
- `isDisputed(jobId)` -- allow arbitrator access during disputes
- Custom compound conditions: buyer OR (verifier with rep >= 100) AND (milestone completed)

### Supported Chains for Conditions

Lit supports reading state from most EVM chains including: Ethereum, Polygon, Arbitrum, Optimism, Base (PCC's chain), BSC, Avalanche, Celo, and many others. Solana and Cosmos are also supported.

### What Changes in Chipotle

The blog post states that Chipotle uses "gating logic in plain JavaScript" within Lit Actions, which suggests access control conditions might be expressible as arbitrary JS code (not just the structured condition format). This would be more flexible but needs verification once production docs are available.

---

## 4. SDK and API Surface

### Naga (Current/Sunsetting) -- SDK v7/v8

**Packages** (all `@lit-protocol/*` on npm):

| Package | Purpose |
|---------|---------|
| `@lit-protocol/lit-node-client` | Universal (browser + Node.js) client |
| `@lit-protocol/lit-node-client-nodejs` | Node.js-only client |
| `@lit-protocol/constants` | Network constants, LIT_NETWORK enum |
| `@lit-protocol/types` | TypeScript type definitions |
| `@lit-protocol/contracts-sdk` | On-chain contract interactions |
| `@lit-protocol/auth` | Authentication helpers |
| `@lit-protocol/wrapped-keys` | Key import/export/signing |
| `@lit-protocol/wasm` | WebAssembly cryptographic components |

**SDK v8 additions**: Wrapped-keys support (generatePrivateKey, importPrivateKey, exportPrivateKey, signMessageWithEncryptedKey, signTransactionWithEncryptedKey), delegation auth patterns.

**Requirements**: Node.js v19+, Rust v1.70+ (for WASM compilation).

**Repo**: [github.com/LIT-Protocol/js-sdk](https://github.com/LIT-Protocol/js-sdk) -- 158 stars, 89 forks, 3,459 commits.

### Chipotle (v3) -- REST API + Light SDK

**Fundamental change**: The SDK is no longer required. The primary interface is a REST API.

```bash
# Encrypt (example -- actual endpoints TBD in production docs)
curl -X POST https://api.dev.litprotocol.com/v1/encrypt \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "data": "base64-encoded-data",
    "accessControlConditions": [...],
    "chain": "baseSepolia"
  }'

# Decrypt
curl -X POST https://api.dev.litprotocol.com/v1/decrypt \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "ciphertext": "...",
    "dataToEncryptHash": "...",
    "accessControlConditions": [...]
  }'
```

**Available interfaces**:
1. **REST API** -- `api.dev.litprotocol.com` (dev), production URL TBD
2. **Dashboard** -- `dashboard.dev.litprotocol.com` (web GUI)
3. **Light JS SDK** -- Optional, wraps REST API
4. **OpenAPI Spec** -- Machine-readable, can auto-generate clients in any language
5. **cURL** -- Direct HTTP calls

**Auth**: API keys (account keys + usage keys with scoped permissions), replacing wallet-based auth (AuthSig/SessionSigs).

**Key API concepts**:
- **Account**: Top-level entity, holds API keys
- **Usage Keys**: Scoped to specific groups/actions
- **Groups**: Bundle of PKPs + Lit Actions + usage keys
- **IPFS Actions**: Immutable Lit Actions stored by content ID

### PCC Integration Implications

For PCC, Chipotle's REST API model would be a major simplification compared to the current `RealLitEncryptionService` which uses the full JS SDK:

**Current PCC Lit integration** (broken, targets dead Datil):
```typescript
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_NETWORK } from "@lit-protocol/constants";

const client = new LitNodeClient({ litNetwork: LIT_NETWORK.DatilDev });
await client.connect();
const { ciphertext, dataToEncryptHash } = await client.encrypt({
  dataToEncrypt: new TextEncoder().encode(plaintext),
  unifiedAccessControlConditions: conditions,
});
```

**Chipotle equivalent** (hypothetical -- exact API TBD):
```typescript
const response = await fetch("https://api.litprotocol.com/v1/encrypt", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    data: Buffer.from(plaintext).toString("base64"),
    accessControlConditions: conditions,
    chain: "baseSepolia",
  }),
});
const { ciphertext, dataToEncryptHash } = await response.json();
```

No SDK installation, no WASM compilation, no Rust toolchain, no Node.js v19 requirement.

---

## 5. Network Topology

### Naga (v1) -- Current Network (Sunsetting)

| Property | Value |
|----------|-------|
| **Node operators** | 7-8 (selected via Stake Weight Contest, Dec 2025) |
| **Operators** | 1kx, HireNodes, Streamr, Hypha, Lit Protocol, Emblem Vault, Terminal3, 01node |
| **Constraint** | 1 node per operator (threshold requirement) |
| **Threshold** | 2/3 (so ~5 of 7-8 nodes must agree) |
| **TEE** | AMD SEV-SNP confidential compute |
| **DKG** | Performed Dec 17, 2025 |
| **Networks** | naga-dev (centralized testnet), naga-test (decentralized testnet), naga mainnet |
| **Consensus** | Chronicle (replicated state across TEE nodes) |
| **Supported sigs** | ECDSA (sub-second), Schnorr (incl. ZK variants), EdDSA |
| **Scaling plan** | Realms + Shadow Splicing (future) |

### Chipotle (v3) -- New Architecture

| Property | Value |
|----------|-------|
| **TEE provider** | Phala Network (not same operators as Naga) |
| **TEE hardware** | AMD SEV-SNP |
| **Execution model** | Single TEE enclave per request |
| **KMS** | On-chain, decoupled from execution |
| **Scaling** | Horizontal -- add more TEE enclaves independently |
| **Attestation** | Hardware remote attestation, on-chain verification |
| **Build verification** | Deterministic builds, "proof of cloud" |

### Uptime SLA

**There is no published SLA.** Lit Protocol does not guarantee uptime. This is a significant risk for production systems.

Historical data points:
- Datil operated for ~2 years (2024-Feb 2026) with no widely-reported extended outages
- Naga launched Jan 2026, being sunsetted ~2 months later
- Chipotle is brand new -- zero production track record

The network is fundamentally a startup project, not an enterprise cloud service. There is no 99.9% uptime guarantee, no SLA credits, and no contractual reliability commitment.

---

## 6. Cost and Payment Model

### Naga (v1) -- Capacity Credits

The existing model uses **Capacity Credits** -- NFTs representing reserved compute:
- Mint a Capacity Credit specifying requests/second over a time period
- Pay upfront in LITKEY
- Gas on Lit Chain is very low (also LITKEY)
- PKP minting has a fixed fee

### Chipotle (v3) -- Pay-Per-Request

Chipotle introduces a fundamentally different payment model:

**Payment currency**: LITKEY token on Base L2

**Dynamic pricing** (three-tier):
- **Base price**: Floor during low demand
- **Max price**: Ceiling at full capacity
- **Current price**: Real-time between base and max

**Cost formula**:
```
total_cost = product_price_per_node * threshold_nodes
threshold_nodes = floor(total_nodes * 2/3), minimum 3
```

Example: 8 nodes, 5-node threshold, 0.01 LITKEY per-node = 0.05 LITKEY per request.

**Billable operations**:
| Operation | Components |
|-----------|------------|
| PKP Sign | Per-request |
| Encrypted Sign | Per-request |
| Sign Session Key | Per-request |
| Lit Action execution | Base + runtime (per-sec, max 5min) + memory (per-MB, max 256MB) + code length (per-MB, max 16MB) + response (per-MB, max 1MB) + signatures (max 30) + broadcasts (max 30) + contract calls (max 50) + decrypts + fetches (max 75) |
| PKP Minting | Fixed fee |

**LITKEY token price** (as of late March 2026): Volatile -- varies with crypto market.

**Free tier**: None documented. No mention of free credits or developer tier.

**USDC support**: Mentioned as "potential" but not confirmed for launch.

**Bottom line**: Every decrypt operation costs LITKEY tokens. For PCC, this means every time a buyer or verifier decrypts evidence, it costs money. The ECIES approach costs nothing per operation.

---

## 7. Security Guarantees: Lit vs. Local ECIES

### PCC's Current EncryptionService (ECIES + AES-256-GCM)

**Implementation**: `packages/kernel/src/encryption-service.ts`

| Property | Details |
|----------|---------|
| **Symmetric cipher** | AES-256-GCM (Node.js `crypto`) |
| **Asymmetric** | ECIES: secp256k1 (ephemeral keypair) + HKDF-SHA256 + XOR key wrap |
| **Library** | `@noble/curves` + `@noble/hashes` (Trail of Bits audited) |
| **Key management** | Server-side: in-memory `kernelKeyStore` + DB |
| **Per-recipient** | Each recipient gets a unique KeyCapsule (ECIES envelope) |
| **Access control** | Application-level (gateway decides who gets capsules) |
| **Network dependency** | None |
| **Decryption requires** | Recipient's secp256k1 private key + their capsule |

**Threat model**:
- STRONG against: network eavesdropping, storage compromise (ciphertext + capsules are useless without private keys), unauthorized recipients
- WEAK against: gateway compromise (server holds AES keys in memory/DB), single point of failure for key management

### Lit Protocol (Chipotle v3)

| Property | Details |
|----------|---------|
| **Encryption scheme** | Identity-Based Encryption (IBE) over BLS threshold keys |
| **Symmetric layer** | AES-256-GCM (managed internally by Lit) |
| **Key management** | On-chain KMS + TEE execution (no single party holds full key) |
| **Per-recipient** | N/A -- access determined by conditions, not per-recipient keys |
| **Access control** | Cryptographic -- enforced by Lit nodes checking on-chain state |
| **Network dependency** | FULL -- requires Lit network to decrypt |
| **Decryption requires** | Wallet satisfying access conditions + Lit network availability |

**Threat model**:
- STRONG against: server compromise (server never sees decryption keys), single-point-of-failure key management, unauthorized access (on-chain condition enforcement)
- WEAK against: Lit network unavailability (zero redundancy), AMD SEV-SNP vulnerabilities, Lit Protocol team compromise/abandonment, network cost changes

### Side-by-Side Security Comparison

| Threat | PCC ECIES | Lit Chipotle |
|--------|-----------|--------------|
| Eavesdropper on network | Protected (AES-GCM + ECIES) | Protected (IBE + AES-GCM) |
| Compromised storage | Protected (ciphertext useless without keys) | Protected (ciphertext useless without Lit network) |
| Gateway server compromise | **VULNERABLE** (server holds AES keys) | Protected (server never sees keys) |
| Unauthorized recipient | App-level enforcement (can be bypassed if gateway is compromised) | Cryptographic enforcement (on-chain conditions) |
| Network availability | **Not a factor** (fully local) | **Single point of failure** (Lit must be up) |
| Key management failure | If key store is lost, data is lost | If Lit network dies, data is **irrecoverable** |
| Vendor lock-in | None (standard crypto primitives) | **Total** (data encrypted with Lit can ONLY be decrypted by Lit) |
| Cost | Zero per operation | LITKEY tokens per decrypt |
| Quantum resistance | Neither (both use secp256k1/BLS) | Neither |

### The Fundamental Tradeoff

**ECIES**: You control everything. Security depends on your server not being compromised. No external dependency. No recurring cost. Data remains accessible as long as you have keys.

**Lit**: You outsource key management to a decentralized network. Security depends on Lit's TEE + on-chain KMS. External dependency on every decrypt. Recurring cost. Data is irrecoverable if Lit Protocol disappears.

---

## 8. Risks of Depending on Lit Protocol

### Risk 1: Network Instability (CRITICAL)

Lit has undergone **three network transitions in one month**:
- Datil (v0) shut down Feb 25, 2026
- Naga (v1) launched ~Jan 2026, sunsetting March 25, 2026 (lived ~2 months)
- Chipotle (v3) launching ~March 25, 2026

This is an unprecedented pace of breaking changes. PKPs do not migrate between networks. Any data encrypted on a dead network is **irrecoverable**.

### Risk 2: Data Irrecoverability (CRITICAL)

If Lit Protocol shuts down, changes encryption schemes, or loses key material, ALL data encrypted through Lit is permanently lost. There is no escape hatch. This is the most severe risk of any external encryption dependency.

With ECIES, if PCC's server dies, you lose access to in-memory keys -- but the ECIES capsules remain valid as long as recipients have their private keys. The data is self-contained.

With Lit, the decryption key only exists as distributed shares held by Lit's network. No network = no key = no data.

### Risk 3: Vendor Lock-in (HIGH)

Data encrypted with Lit Protocol's IBE scheme can ONLY be decrypted by the Lit Protocol network. You cannot export the encryption to another provider. You cannot self-host. You cannot migrate.

### Risk 4: Cost Uncertainty (MEDIUM)

- LITKEY token price is volatile
- Pricing is dynamic (base/max range)
- No free tier documented
- Every decrypt costs tokens
- PCC's evidence decryption could be high-frequency (buyers checking evidence, verifiers reviewing, disputes pulling history)
- Cost scales linearly with usage -- no ceiling

### Risk 5: SDK/API Immaturity (MEDIUM)

- Chipotle's REST API docs are incomplete (dev docs return 404s as of today)
- No production track record
- OpenAPI spec not yet publicly available
- The "light JS SDK" for Chipotle has not been published to npm
- Migration from v7/v8 SDK to Chipotle REST is a full rewrite

### Risk 6: Regulatory/Compliance (MEDIUM)

- Evidence data traverses Lit's network (even if encrypted in transit to TEE, the TEE processes plaintext)
- For regulated manufacturing data, this may require compliance review
- No SOC 2, ISO 27001, or similar certifications published
- Node operator jurisdictions: 1kx (EU), HireNodes (?), Streamr (Finland), etc. -- multi-jurisdictional data processing

### Risk 7: Small Network Size (MEDIUM)

- Naga has only 7-8 node operators
- Chipotle's operator set is unclear (Phala TEE infrastructure, not same operators)
- Small networks have higher correlated failure risk
- One operator running multiple nodes in different jurisdictions does not help with threshold security

### Risk 8: Token Dependency (LOW-MEDIUM)

- Must hold LITKEY tokens to use the service
- LITKEY liquidity is limited (small-cap token)
- Gas on Base L2 is cheap, but LITKEY acquisition adds friction
- Token price crash could make the network uneconomical for operators
- Token price spike could make the service uneconomical for users

---

## 9. Comparison Matrix

| Dimension | PCC EncryptionService (ECIES+AES) | Lit Chipotle (v3) |
|-----------|-----------------------------------|-------------------|
| **Works today** | YES | Dev only (production TBD) |
| **Network dependency** | None | Full (Lit network must be up) |
| **Cost per operation** | Zero | LITKEY tokens per decrypt |
| **Key management** | Server-side (single point of failure) | Decentralized (TEE + on-chain KMS) |
| **Access control** | Application-level | Cryptographic (on-chain conditions) |
| **Per-recipient keys** | Yes (KeyCapsule per recipient) | No (condition-based, any qualifying wallet) |
| **Data recoverability** | Keys + capsules are self-contained | Requires Lit network (irrecoverable if down) |
| **Vendor lock-in** | None (standard primitives) | Total |
| **Libraries** | @noble/curves (audited), Node.js crypto | Lit SDK (unaudited) or REST API |
| **Escrow-state gating** | Not cryptographic (app-level) | Yes, cryptographic (on-chain checks) |
| **Hackathon viability** | Already working | Too early, too risky |
| **Post-hackathon value** | Good baseline, could layer threshold on top | High value IF network stabilizes |
| **Effort to integrate** | 0 hours (already done) | 15-20 hours (new service, new auth, new payment) |
| **SDK complexity** | Zero (standard fetch/crypto) | Low with REST API (vs. high with old SDK) |
| **Security audit** | @noble/curves audited by Trail of Bits | No public audit of Lit Protocol |

---

## 10. Recommendation

### For the Hackathon (Deadline April 1, 2026)

**Do NOT use Lit Protocol Chipotle v3.** The reasoning:

1. Chipotle production has not launched yet (as of March 26)
2. The dev environment docs are incomplete (many 404s)
3. There is no published SDK for Chipotle
4. You would be integrating against a system that launched days ago with zero production track record
5. If Chipotle has issues during the hackathon, your decryption pipeline breaks with no fallback
6. The existing ECIES+AES service already works and is deployed on Railway

**Keep the existing `EncryptionService` as the sole encryption backend.**

### For Post-Hackathon (3-6 Month Horizon)

Lit Protocol Chipotle v3 is worth revisiting **once these conditions are met**:

1. **Production is live and stable for 2+ months** (target: June 2026)
2. **Production docs are complete** (REST API reference, encryption/decryption guides)
3. **The SDK or REST API has been used by at least 10 production applications** (community validation)
4. **Pricing is published and stable** (actual LITKEY costs per operation)
5. **A public security audit has been performed** on the Chipotle architecture

If/when those conditions are met, the integration would look like:

**Hybrid model**: Use Lit Chipotle for the access-control-condition layer (escrow-state gating) while keeping ECIES as the fallback/offline encryption layer.

```
Encryption pipeline (future):
  1. Encrypt evidence with AES-256-GCM (local)
  2. Wrap AES key with ECIES for each known recipient (local, immediate)
  3. ALSO encrypt AES key with Lit IBE + access conditions (network, for condition-based access)
  4. Store both capsules[] (ECIES) and litCiphertext (Lit)

Decryption:
  - Fast path: Use ECIES capsule if you have one (no network call)
  - Condition path: Use Lit to decrypt if you meet access conditions but don't have a capsule
  - Fallback: If Lit is down, ECIES capsules still work
```

This hybrid model gives PCC the best of both worlds:
- **ECIES**: Zero-latency, zero-cost, always-available decryption for known recipients
- **Lit**: Cryptographic access control for dynamic authorization (new verifiers, dispute arbitrators) without pre-issuing capsules

### Specific Value Lit Adds (That ECIES Cannot)

The one thing Lit provides that PCC's current system genuinely cannot do:

**Dynamic, on-chain-enforced decryption authorization without pre-provisioning.**

With ECIES: To grant a new verifier access, the gateway must retrieve the AES key from its key store and create a new capsule. This requires the gateway to be online, have the key, and execute the grant. If the gateway is compromised, an attacker could grant themselves access.

With Lit: A verifier who meets the on-chain reputation threshold can decrypt WITHOUT the gateway's involvement. The Lit network reads the smart contract state directly. No pre-provisioning needed. The gateway cannot be a vector for unauthorized access.

This is a real security improvement -- but it only matters when PCC reaches a scale where gateway compromise is a realistic threat model.

---

## Sources

### Lit Protocol Official
- [Introducing Lit Protocol v3 - Chipotle](https://spark.litprotocol.com/introducing-lit-protocol-v3-chipotle/) -- Primary Chipotle announcement
- [Naga Network Sunset & Lit v3 Transition](https://spark.litprotocol.com/naga-network-sunset/) -- Sunset timeline
- [Lit v1 Update and Next Phase](https://spark.litprotocol.com/v1-and-next-phase/) -- v1 technical details
- [Now Live: Lit Protocol V1](https://spark.litprotocol.com/v1-live/) -- Naga launch details
- [2025 Cryptography Roadmap](https://spark.litprotocol.com/2025-cryptography-roadmap/) -- Planned crypto schemes
- [Lit JS SDK V3: Introducing ID Encrypt](https://spark.litprotocol.com/id-encrypt/) -- IBE details
- [Introduction to Decentralized Access Control](https://spark.litprotocol.com/introduction-to-decentralized-access-control/) -- ACC overview
- [Lit Protocol: A Primer](https://spark.litprotocol.com/lit-protocol-a-primer/) -- General overview
- [What's Next for Lit Protocol?](https://spark.litprotocol.com/whats-next-for-lit-protocol/) -- Roadmap
- [Staking Contest Results](https://spark.litprotocol.com/announcing-the-lit-staking-contest-results/) -- Node operators
- [Sunsetting Datil](https://spark.litprotocol.com/sunsetting-lit-v0-datil-migrate-to-v1-naga-within-30-days/) -- Datil EOL

### Lit Protocol Documentation
- [Chipotle Dev Docs](https://docs.dev.litprotocol.com) -- v3 developer documentation (incomplete)
- [Naga Developer Docs](https://developer.litprotocol.com/) -- v1 documentation
- [Payment Model](https://litprotocol.mintlify.app/learning-lit/pricing/payment-model) -- Pricing details
- [Current Prices](https://litprotocol.mintlify.app/learning-lit/pricing/current-prices) -- Dynamic pricing

### Lit Protocol GitHub
- [JS SDK (v7)](https://github.com/LIT-Protocol/js-sdk) -- 158 stars, 89 forks
- [JS SDK Changelog](https://github.com/LIT-Protocol/js-sdk/blob/master/CHANGELOG.md)

### PCC Files Referenced
- `packages/kernel/src/encryption-service.ts` -- ECIES + AES-256-GCM implementation
- `packages/kernel/src/lit-encryption-service.ts` -- Mock Lit service
- `packages/kernel/src/lit-encryption-real.ts` -- Real Lit SDK v7 (targets dead Datil)
- `packages/kernel/src/lit-encryption-factory.ts` -- Factory switching mock/real
- `packages/spec/src/types/encryption.ts` -- Type definitions
- `ai/research/lit-alternatives.md` -- Prior alternatives research
