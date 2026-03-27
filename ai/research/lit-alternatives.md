# Research: Lit Protocol Alternatives for Evidence Bundle Encryption

**Date**: 2026-03-26
**Researcher**: Claude Opus 4.6 (1M context)
**Context**: PCC uses Lit Protocol for threshold-encrypted evidence bundles (access-controlled decryption gated on escrow state). Datil networks were used, which are now shut down. The codebase has three encryption implementations: (1) `EncryptionService` -- real ECIES + AES-256-GCM with per-recipient key capsules, (2) `LitEncryptionService` -- mock Lit with local AES, (3) `RealLitEncryptionService` -- real Lit SDK v7 on Datil (broken). Goal: determine the best path forward for the hackathon deadline (April 1, 2026).

---

## Executive Summary

**PCC already has a working, production-quality encryption system (`EncryptionService`) that does NOT depend on Lit Protocol.** The `EncryptionService` in `packages/kernel/src/encryption-service.ts` implements real ECIES (secp256k1 + HKDF-SHA256) for asymmetric key wrapping and AES-256-GCM for symmetric encryption. It works today, on Railway, with zero external dependencies.

The Lit Protocol situation is messy: Datil was shut down Feb 25, 2026. Naga (v1) launched but is **already being sunsetted on March 25, 2026** in favor of Chipotle (v3). This means Lit has had three network transitions in one month. For a hackathon, this is unacceptable instability.

**Recommendation: Drop Lit Protocol entirely. Use the existing `EncryptionService` (ECIES + AES-256-GCM) as the primary encryption layer. It's already real, already works, and already deployed.**

---

## 1. Lit Protocol Status Assessment

### Timeline of Chaos

| Date | Event |
|------|-------|
| Dec 17, 2025 | Naga (v1) DKG performed with 7 node operators |
| Jan 2026 | Naga (v1) mainnet launches |
| Feb 25, 2026 | **Datil (v0) shut down** -- all three networks (dev, test, mainnet) |
| Mar 25, 2026 | **Naga (v1) sunsets** -- replaced by Chipotle (v3) |
| Mar 25, 2026 | Chipotle (v3) production launch (target date) |
| Apr 1, 2026 | Naga completely dead |

**Analysis**: Lit Protocol is NOT dead -- it's in aggressive transition. But the transition pace makes it unsuitable for production use right now:

- **Datil**: Dead as of Feb 25. PCC's `RealLitEncryptionService` targets Datil. **Completely broken.**
- **Naga**: Launched January, but sunset starts March 25 (TOMORROW). Only lived for ~2 months.
- **Chipotle (v3)**: Launching March 25. Developer preview at `docs.dev.litprotocol.com`. New SDK (`@lit-protocol/lit-client`), new auth model, new payment model. Would require a full rewrite of `RealLitEncryptionService`.

### What Chipotle v3 Changes

- New packages: `@lit-protocol/lit-client`, `@lit-protocol/networks`, `@lit-protocol/auth`
- PKPs not migrated -- must mint new ones
- "Radically simpler" developer experience
- New payment model
- Built for AI agents (relevant to PCC, but not for hackathon)

### Verdict on Lit

**Do NOT use Lit Protocol for the hackathon.** The network you'd target (Chipotle v3) launched literally yesterday (March 25). The SDK is brand new. There's no migration guide. Even if it works, you'd be debugging Lit SDK issues instead of building PCC features.

**For post-hackathon**: Chipotle v3 could be worth revisiting once it's stable (maybe May/June 2026). The access-control-conditions model is genuinely useful for PCC's escrow-gated decryption.

---

## 2. Alternative Analysis

### Option A: Local ECIES + AES-256-GCM (ALREADY IMPLEMENTED)

**This is what PCC already has and should use.**

`packages/kernel/src/encryption-service.ts` implements:

1. **Symmetric layer**: AES-256-GCM via Node.js `crypto` -- random 32-byte key, 12-byte IV, authentication tag
2. **Asymmetric layer**: ECIES via `@noble/curves` (secp256k1) + HKDF-SHA256
   - Ephemeral keypair per encryption
   - ECDH shared secret
   - HKDF key derivation
   - XOR key wrapping (AES key ^ derived key)
3. **Per-recipient capsules**: Each recipient gets their own `KeyCapsule` with encrypted AES key
4. **Key store**: Local in-memory key store for granting access to new recipients

**Strengths**:
- Zero external dependencies (pure Node.js crypto + `@noble/curves`)
- Works on Railway, Docker, any environment
- Already tested, already deployed
- Real cryptography, not mock
- `@noble/curves` is audited by Trail of Bits

**Weaknesses**:
- Key management is server-side (gateway holds keys in memory/DB)
- No threshold decryption (single point of failure at the gateway)
- No on-chain access condition enforcement (access control is application-level)

**Effort**: 0 hours. It's done.

### Option B: TACo (Threshold Access Control) by Threshold Network

**What it is**: Decentralized threshold cryptography from the team behind tBTC. Proxy re-encryption + threshold decryption.

| Aspect | Details |
|--------|---------|
| Package | `@nucypher/taco` |
| Version | v0.6.0 (May 2025) |
| Stars | 34 |
| Status | "Active development, expect breaking changes" |
| Network | Requires Threshold Network (node operators) |
| TypeScript | Yes, monorepo with TypeScript client |

**How it works**:
1. Encrypt data with a public key + access conditions
2. Threshold Network nodes hold key shares
3. When conditions are met, nodes release shares for decryption
4. No single party can decrypt alone

**PCC Fit**:
- Could replace Lit Protocol's threshold model
- Access conditions could gate on escrow contract state
- Similar developer model to Lit

**Problems for hackathon**:
- Only 34 GitHub stars -- tiny community
- "Expect breaking changes" -- not stable
- Requires running against the Threshold Network (external dependency)
- TACo Threshold Signing is only available on DEVNET
- Would require rewriting the entire encryption layer

**Verdict**: Not viable for hackathon. Interesting post-hackathon but less mature than Lit.

### Option C: Medusa (Anoma)

**What it is**: Threshold encryption protocol from the Anoma ecosystem.

**Status**: Research/pre-production. No npm package found. No TypeScript SDK. The protocol spec exists but implementations are academic.

**Verdict**: Not viable. No shipping code to integrate.

### Option D: Fhenix (FHE)

**What it is**: Fully Homomorphic Encryption L2 for Ethereum. Compute on encrypted data without decryption.

| Aspect | Details |
|--------|---------|
| Type | Arbitrum L2 with FHE coprocessor |
| SDK | Solidity libraries + coFHE coprocessor |
| Status | Testnet |

**How it works**:
- Smart contracts operate on encrypted variables natively
- `FHE.asEuint32(encryptedInput)` in Solidity
- Computations happen on ciphertext, results are encrypted

**PCC Fit**:
- Overkill. PCC needs encrypt/decrypt, not computation on encrypted data
- Would require deploying to Fhenix L2, which is a different chain
- Not applicable to evidence bundle encryption

**Verdict**: Wrong tool for the job. FHE is for on-chain computation privacy, not storage encryption.

### Option E: eciesjs (npm package)

**What it is**: Pure TypeScript ECIES implementation with secp256k1/curve25519 support.

| Aspect | Details |
|--------|---------|
| Package | `eciesjs` |
| Version | 0.3.x (stable) |
| Weekly downloads | Significant |
| Dependencies | `noble-curves`, `noble-hashes`, `noble-ciphers` (all audited) |
| Platforms | Node.js, Bun, Deno, Browser, React Native |
| Native deps | None (pure TS + optional node:crypto acceleration) |

**API**:
```typescript
import { PrivateKey, decrypt, encrypt } from "eciesjs";

const sk = new PrivateKey();
const data = new TextEncoder().encode("hello world");
const encrypted = encrypt(sk.publicKey.toBytes(), data);
const decrypted = decrypt(sk.secret, encrypted);
```

**Supported algorithms**:
- Curves: secp256k1 (default), x25519, ed25519
- Symmetric: AES-256-GCM (default), XChaCha20-Poly1305
- KDF: HKDF-SHA256

**PCC Fit**:
- PCC's `EncryptionService` already implements the exact same thing manually using `@noble/curves` + `@noble/hashes`
- `eciesjs` uses the same underlying libraries
- Switching to `eciesjs` would simplify the code slightly but add a dependency

**Verdict**: PCC already has this. Not worth switching. The existing implementation is fine and uses the same audited primitives.

### Option F: Plain AES-256-GCM with Server-Side Key Management

**What it is**: Simplest possible encryption -- AES-GCM with keys stored in environment variables or a KMS.

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encrypt(data: Buffer, key: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
```

**PCC already does this** as the inner layer of `EncryptionService`. The ECIES layer wraps the AES key for per-recipient access.

**Verdict**: PCC already has this as part of the existing implementation.

---

## 3. Decision Matrix

| Option | Works Today | No External Deps | Threshold/Decentral | Hackathon Viable | Effort |
|--------|-----------|------------------|---------------------|-----------------|--------|
| **A: Existing ECIES+AES** | YES | YES | No | YES | 0h |
| B: TACo | No | No (network) | Yes | No | 20h+ |
| C: Medusa | No | N/A | Yes | No | N/A |
| D: Fhenix | No | No (L2) | N/A | No | 40h+ |
| E: eciesjs | Yes | Yes | No | Yes | 2h |
| F: Plain AES | Yes | Yes | No | Yes | 0h |
| Lit Chipotle v3 | Maybe | No (network) | Yes | Risky | 15h+ |

---

## 4. Recommendation: Use What You Have

### Immediate (Hackathon)

**Keep `EncryptionService` (ECIES + AES-256-GCM) as the sole encryption backend.**

The existing implementation at `packages/kernel/src/encryption-service.ts` is:
- Real cryptography (not mock)
- Battle-tested (`@noble/curves` is audited)
- Zero external network dependencies
- Already working on Railway
- Already integrated with the evidence pipeline

**Changes to make**:

1. **Remove `LitEncryptionService` from production code paths**. Keep it as dead code or delete it. The mock Lit service is confusing -- it's real AES-GCM pretending to be Lit.

2. **Remove `RealLitEncryptionService`** or gate it behind a feature flag that's permanently off. The Datil networks it targets are dead. The code references `@lit-protocol/lit-node-client` v7 which is for Datil.

3. **Update the `lit-encryption-factory.ts`** to always return `EncryptionService` instead of trying Lit:

```typescript
// packages/kernel/src/lit-encryption-factory.ts
import { EncryptionService } from "./encryption-service.js";

// Lit Protocol is disabled -- Datil networks shut down Feb 2026,
// Naga sunsets Mar 2026. Using local ECIES + AES-256-GCM instead.
export function createEncryptionService(): EncryptionService {
  return new EncryptionService();
}
```

4. **Update CLAUDE.md** to remove the `LIT_PROTOCOL_REAL=true` env var reference.

5. **Clean up package.json**: Remove `@lit-protocol/*` packages from dependencies where present.

### Post-Hackathon Roadmap

If decentralized/threshold encryption becomes a requirement:

1. **Wait for Lit Chipotle v3 to stabilize** (2-3 months after launch, ~June 2026)
2. **Evaluate TACo** once it exits "expect breaking changes" phase
3. **Consider Shamir Secret Sharing** as a lightweight threshold option:
   ```typescript
   import { split, combine } from "shamir-secret-sharing";

   // Split AES key into 5 shares, require 3 to reconstruct
   const shares = await split(aesKey, 5, 3);
   // Distribute shares to verifier nodes
   // On decryption: collect 3+ shares, reconstruct key
   const reconstructedKey = await combine(shares.slice(0, 3));
   ```
   This gives threshold properties without an external network, but requires trust in the share holders. The `shamir-secret-sharing` npm package is pure JS, no native deps.

### Architecture Note: Why Threshold Encryption Matters for PCC (Later)

PCC's threat model for evidence bundles:
- **Current (ECIES)**: Gateway server holds AES keys. If gateway is compromised, all evidence is readable.
- **With threshold**: No single party holds the full key. Decryption requires N-of-M nodes to cooperate, enforced by cryptography.

For a hackathon, the ECIES model is fine. For production with real manufacturing IP at stake, threshold encryption would strengthen the security story. But this is a post-hackathon concern.

---

## 5. Comparison of What PCC Has vs. What It Needs

### Already Working (No Changes Needed)

| Feature | Implementation | File |
|---------|---------------|------|
| AES-256-GCM bundle encryption | Real, Node.js crypto | `encryption-service.ts` |
| ECIES key wrapping (secp256k1) | Real, @noble/curves | `encryption-service.ts` |
| Per-recipient key capsules | Real | `encryption-service.ts` |
| Access grants for new recipients | Real | `encryption-service.ts` |
| Encrypted evidence API endpoints | Real | `evidence-encrypted.ts` |
| Key store (in-memory) | Real | `key-store.ts` |
| DB persistence for encrypted bundles | Real | `db/schema/encryption.ts` |

### Should Remove/Disable

| Feature | Why | File |
|---------|-----|------|
| `LitEncryptionService` (mock) | Confusing mock of a dead service | `lit-encryption-service.ts` |
| `RealLitEncryptionService` | Targets dead Datil network | `lit-encryption-real.ts` |
| `@lit-protocol/*` dependencies | Dead network, huge bundle size | `package.json` |
| `LIT_PROTOCOL_REAL=true` env var | No longer applicable | `CLAUDE.md`, `.env.example` |

### Not Needed for Hackathon

| Feature | Why |
|---------|-----|
| Threshold encryption | No decentralized node network available |
| On-chain access conditions | ECIES with app-level access control is sufficient |
| Browser-side SessionSigs | PCC is server-side; browser decryption is not in scope |

---

## 6. Code Example: Clean Encryption Flow for PCC

Here's how the evidence encryption pipeline should work with just the existing `EncryptionService`:

```typescript
import { EncryptionService } from "@pcc/kernel";
import type { EvidenceBundle, Address } from "@pcc/spec";

const encryptionService = new EncryptionService();

// === Encrypt a bundle for buyer + verifiers ===
async function encryptEvidence(
  bundle: EvidenceBundle,
  buyerAddress: Address,
  buyerPublicKey: string, // 66-char compressed secp256k1
  verifierAddresses: Array<{ address: Address; publicKey: string }>,
) {
  const recipients = [
    { address: buyerAddress, publicKey: buyerPublicKey },
    ...verifierAddresses,
  ];

  const encrypted = await encryptionService.encryptBundle(bundle, recipients);
  // encrypted.capsules has one KeyCapsule per recipient
  // Each capsule has a unique ECIES ephemeral key
  return encrypted;
}

// === Decrypt (buyer side) ===
async function decryptEvidence(
  encrypted: EncryptedEvidenceBundle,
  buyerAddress: Address,
  buyerPrivateKey: string, // 64-char hex secp256k1 private key
) {
  // Find the capsule for this buyer
  const capsule = encrypted.capsules.find(c => c.recipientAddress === buyerAddress);
  if (!capsule) throw new Error("No capsule for this recipient");

  return encryptionService.decryptBundle(encrypted, capsule, buyerPrivateKey);
}

// === Grant access to a new verifier after the fact ===
async function grantVerifierAccess(
  bundleId: string,
  verifierAddress: Address,
  verifierPublicKey: string,
) {
  // Uses the stored AES key to create a new capsule
  return encryptionService.grantAccess(
    bundleId,
    new Uint8Array(0), // will be looked up from key store
    verifierAddress,
    "full",
    verifierPublicKey,
  );
}
```

This is real, working, production-quality encryption. No mocks. No external networks. No instability.

---

## Sources

- [Lit Protocol - Sunsetting Datil](https://spark.litprotocol.com/sunsetting-lit-v0-datil-migrate-to-v1-naga-within-30-days/)
- [Lit Protocol - Naga Network Sunset & v3 Transition](https://spark.litprotocol.com/naga-network-sunset/)
- [Lit Protocol - v1 Update and Next Phase](https://spark.litprotocol.com/v1-and-next-phase/)
- [Lit Protocol - Introducing Chipotle v3](https://spark.litprotocol.com/introducing-lit-protocol-v3-chipotle/)
- [Lit Protocol - Naga Dev and SDK v8](https://spark.litprotocol.com/new-release-naga-dev-and-sdk-v8/)
- [TACo (Threshold Access Control) - GitHub](https://github.com/nucypher/taco-web)
- [TACo SDK Documentation](https://docs.taco.build/for-developers/taco-sdk)
- [eciesjs - GitHub](https://github.com/ecies/js)
- [Fhenix - FHE for Ethereum](https://www.fhenix.io/)
- [Threshold Network - TACo](https://threshold.network/build/taco/)
- [Node.js AES-256-GCM Guide](https://medium.com/@tony.infisical/guide-to-nodes-crypto-module-for-encryption-decryption-65c077176980)
