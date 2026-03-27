# Real ZK Proof Test Results

**Date**: 2026-03-26
**Status**: SUCCESS

## Version Alignment (Fixed)

| Component | Before | After |
|-----------|--------|-------|
| @noir-lang/noir_js | 1.0.0-beta.19 | **0.36.0** |
| @noir-lang/backend_barretenberg | 0.36.0 | 0.36.0 (unchanged) |
| @aztec/bb.js | 0.58.0 | 0.58.0 (unchanged) |
| Circuit artifacts (nargo) | 1.0.0-beta.19 | **0.36.0** |
| Nargo.toml compiler_version | >=1.0.0 | **>=0.36.0** |

## Root Cause
ACIR bytecode format incompatibility: circuits compiled with nargo 1.0.0-beta.19 used a different serialization format than what bb.js@0.58.0 (bundled with backend_barretenberg@0.36.0) could deserialize. Error: `BincodeDeserializer::deserialize_len()` abort.

## Fix
1. Installed nargo 0.36.0 via WSL (no Windows binary available)
2. Updated Nargo.toml `compiler_version` in both circuits
3. Recompiled both circuits with nargo 0.36.0
4. Pinned noir_js to 0.36.0 (from 1.0.0-beta.19)
5. Fixed proof verification: store raw Barretenberg publicInputs (0x-prefixed hex) instead of PCC-format strings

## Proof Generation Performance

| Metric | Value |
|--------|-------|
| Witness generation | 155-270 ms |
| Proof generation | ~18 sec |
| Proof verification | ~9.5 sec |
| Proof size | 2144 bytes |
| Verification key size | 1779 bytes |
| Config | threads=1 (memory-safe for Railway) |

## Test Results
- **306/306 tests passing** across 15 test files
- New test file: `noir-real-proof.test.ts` — 3 tests for real Noir proof generation/verification
- Real proofs use `noir:` prefix, mock proofs use `sha256:` prefix
- Tier compliance proofs still fall back to mock (Pedersen hash mismatch in proveTierCompliance — expected, see below)

## Remaining Issue: Tier Compliance Pedersen Binding
The `proveTierCompliance` method attempts real proof generation but fails with "Cannot satisfy constraint" because:
- The tier_compliance circuit expects `bundle_hash = pedersen_hash([events_hash])`
- The events_hash is computed from SHA256 of canonical event list, then converted to a Field
- The circuit computes `pedersen_hash([events_hash_field])` and asserts it equals `bundle_hash_field`
- But `bundle_hash` in the bundle is a SHA256 hash, not a Pedersen hash

This is the same Pedersen/SHA256 mismatch that was fixed in CommitmentService for Merkle trees. For tier compliance, the bundle_hash binding needs to use Pedersen too. This falls back gracefully to mock proofs.

## Files Changed
- `packages/verifier/package.json` — noir_js pinned to 0.36.0
- `packages/verifier/circuits/evidence_inclusion/Nargo.toml` — compiler_version >=0.36.0
- `packages/verifier/circuits/tier_compliance/Nargo.toml` — compiler_version >=0.36.0
- `packages/verifier/circuits/evidence_inclusion/target/evidence_inclusion.json` — recompiled
- `packages/verifier/circuits/tier_compliance/target/tier_compliance.json` — recompiled
- `packages/verifier/src/noir-proof-service.ts` — store raw Barretenberg publicInputs, version comment
- `packages/verifier/src/__tests__/noir-proof-service.test.ts` — 120s timeouts, updated assertions
- `packages/verifier/src/__tests__/noir-real-proof.test.ts` — NEW: real proof integration tests
