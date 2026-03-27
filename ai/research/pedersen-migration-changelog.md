# Pedersen Hash Migration Changelog

**Date**: 2026-03-26
**Status**: DONE
**Iterations**: 1 of 5 (all tests passed on first iteration)

## Summary

Migrated CommitmentService from SHA-256 to Barretenberg Pedersen hash for all Merkle tree operations. The TypeScript-side tree now matches Noir's `std::hash::pedersen_hash` in the ZK circuits, using the same BN254 generator points via `@aztec/bb.js@0.58.0`.

## Changes

### New Files

| File | Purpose |
|------|---------|
| `packages/verifier/src/pedersen.ts` | Pedersen hash utility wrapping BarretenbergSync. Lazy singleton WASM init. Exports: `pedersenHash`, `pedersenHashPair`, `pedersenZeroHash`, `sha256ToField`, `hashToField` |

### Modified Files

| File | What Changed |
|------|-------------|
| `packages/spec/src/types/common.ts` | Added `PedersenHash` branded type (`pedersen:${string}`) and `HashDigest` union type (`SHA256 \| PedersenHash`) |
| `packages/spec/src/types/encryption.ts` | `EvidenceCommitment.commitmentHash`, `.merkleRoot` changed from `SHA256` to `HashDigest`. `CommitmentTree.root`, `.leaves[]` changed from `SHA256` to `HashDigest`. `bundleHash` fields remain `SHA256`. |
| `packages/spec/src/schemas/index.ts` | Added `PedersenHashSchema` (regex: `pedersen:[a-f0-9]{64}`) and `HashDigestSchema` (union of SHA256Schema and PedersenHashSchema) |
| `packages/verifier/package.json` | Added `"@aztec/bb.js": "0.58.0"` to direct dependencies (was only transitive via backend_barretenberg) |
| `packages/verifier/src/commitment-service.ts` | Complete rewrite: `createCommitment()` uses `pedersenHash([sha256ToField(bundleHash)])`. `buildTree()` uses `pedersenHashPair()` for node combining and `pedersenZeroHash()` for padding. `generateMerkleProof()` and `verifyMerkleProof()` use Pedersen throughout. All return types updated to `HashDigest`. |
| `packages/verifier/src/noir-proof-service.ts` | Added import for pedersen utilities. Replaced `sha256ToField` method with `digestToField` that handles both prefixes. `proveTierCompliance()` now computes Pedersen commitment hash and Pedersen events binding. |
| `packages/verifier/src/index.ts` | Added exports for all pedersen utility functions |
| `packages/verifier/src/__tests__/commitment-service.test.ts` | Updated all hash prefix assertions from `^sha256:` to `^pedersen:` for tree operations. Added tests for leaf hash format and proof path element format. `bundleHash` assertions remain `^sha256:`. |
| `packages/verifier/src/__tests__/noir-proof-service.test.ts` | Updated imports. Added test verifying tree root and leaves use pedersen prefix. |

### NOT Changed (by design)

| File/Field | Reason |
|------------|--------|
| `EncryptedEvidenceBundle.bundleHash` | Content addressing stays SHA-256 |
| `EvidenceBundleSchema.bundleHash` | Content addressing stays SHA-256 |
| `ZKProofService` (mock) | Legacy mock service, uses SHA-256 internally for mock proofs (still works because SHA256 is subtype of HashDigest) |
| Gateway routes | Pass values as strings, no type-level changes needed |
| DB layer | Stores strings, no schema change needed |

## Architecture

### Hash Flow (after migration)

```
EvidenceBundle.bundleHash (SHA-256, content address)
    |
    v
sha256ToField() -- reduces mod BN254
    |
    v
pedersenHash([field]) -- Barretenberg WASM
    |
    v
EvidenceCommitment.commitmentHash (pedersen:...)
    |
    v
pedersenHashPair(left, right) -- tree node combining
    |
    v
CommitmentTree.root (pedersen:...)
```

### Pedersen Utility Design

- **Lazy singleton**: `BarretenbergSync.new()` called once, cached for all subsequent calls
- **Concurrent-safe**: `initPromise` prevents duplicate WASM initialization
- **Zero hash**: `pedersenHash([0n, 0n])` cached for tree padding
- **Field conversion**: `hashToField()` handles both `sha256:` and `pedersen:` prefixes with BN254 modular reduction

## Test Results

- `@pcc/spec`: 128/128 passing
- `@pcc/verifier`: 303/303 passing
- Total: 431 tests green

## Noir Circuit Compatibility

The Pedersen hash now matches Noir's `std::hash::pedersen_hash` exactly because both use the same Barretenberg WASM library (`@aztec/bb.js@0.58.0`) with the same BN254 generator points and hash index 0. This means:

1. Merkle trees built in TypeScript produce the same roots as trees built in Noir circuits
2. Merkle proofs generated in TypeScript can be verified inside Noir circuits
3. Commitment hashes computed in TypeScript match `pedersen_hash([field])` in Noir
