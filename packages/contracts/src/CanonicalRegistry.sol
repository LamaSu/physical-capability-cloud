// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CanonicalRegistry
 * @notice Shared invariant primitives for content-addressed, immutable on-chain
 *         registries. Used by {RateScheduleRegistry}; the same pattern
 *         (sha256(canonical bytes) → bytes32 → on-chain mapping with
 *         "publish-once-or-revert" semantics) is also implemented by
 *         {CaptureClassRegistry} from the Capture Verification Protocol.
 *
 *         This library factors out the *pure invariant checks* — verifying
 *         that the off-chain-computed sha256 hash matches the recomputed
 *         on-chain hash, and rejecting double-publish attempts — so they
 *         live in one place, can be tested in isolation, and can be reused
 *         by future registries that need the same content-addressing pattern.
 *
 *         Why a library (not an abstract base contract):
 *           Each consumer registry owns a different storage shape:
 *             - {RateScheduleRegistry} stores raw `bytes` (variable-length JSON)
 *             - {CaptureClassRegistry}  stores a 12-field `CaptureAnchor` struct
 *           A shared base contract would either duplicate storage (one mapping
 *           in the base + the consumer's own) or require Solidity-untyped
 *           generics, which don't exist. A library of pure helpers preserves
 *           each consumer's storage shape while sharing the audited invariant
 *           logic. See `ai/research/contributor-economics/13-canonical-registry-extraction.md`
 *           for the design rationale.
 *
 *         Why sha256 (not keccak256):
 *           Off-chain spec code (e.g. `node:crypto.createHash("sha256")`) hashes
 *           canonical-JSON payloads with sha256. The on-chain encoding must
 *           produce the SAME 32-byte digest for the SAME bytes so that a
 *           signed off-chain attestation can be verified against the on-chain
 *           record, or vice versa. Solidity 0.8 exposes `sha256(bytes)` natively.
 *
 *         Inlined into consumer bytecode:
 *           Every function here is `internal` and `pure`. Solidity inlines
 *           internal library calls, so there's no library-deployment cost,
 *           no runtime DELEGATECALL, and no separate library address to
 *           manage.
 *
 *         Revert-string discipline:
 *           Revert strings are stable, byte-for-byte equal to the strings
 *           previously emitted inline by {RateScheduleRegistry}. Existing
 *           tests that match on these strings continue to pass without
 *           modification.
 */
library CanonicalRegistry {
    // ── Invariant: hash binding ──────────────────────────────────────────

    /**
     * @notice Verify that the recomputed sha256 of `payload` matches the
     *         caller-asserted `expectedHash`, and that `payload` is non-empty.
     * @dev    Pure helper: no storage reads or writes. Reverts on any
     *         violation; returns the verified hash on success so the caller
     *         can use it as a storage key without recomputing.
     *
     *         Empty-payload rejection is invariant-critical: existence checks
     *         in the consumer registries are typically `bytes.length > 0`, so
     *         allowing an empty stored payload would conflate "stored empty
     *         entry" with "never published".
     *
     * @param payload      Canonical bytes whose sha256 the caller is committing to.
     * @param expectedHash Off-chain-computed sha256(payload) the caller asserts.
     * @return verifiedHash The recomputed sha256 (always equals expectedHash on success).
     */
    function verifyCanonicalHash(bytes calldata payload, bytes32 expectedHash)
        internal
        pure
        returns (bytes32 verifiedHash)
    {
        require(payload.length > 0, "Empty schedule");
        verifiedHash = sha256(payload);
        require(verifiedHash == expectedHash, "Schedule hash mismatch");
    }

    // ── Invariant: replay prevention ─────────────────────────────────────

    /**
     * @notice Revert if a record under this hash already exists.
     * @dev    Caller passes the boolean result of its own existence check
     *         (e.g. `_schedules[hash].length > 0` for RateScheduleRegistry,
     *         or `exists[hash]` for CaptureClassRegistry). This keeps the
     *         library agnostic to each consumer's storage shape — it
     *         only enforces the *invariant*, not the layout.
     *
     *         Revert string is the schedule-domain wording, kept stable for
     *         tests. Future consumers that prefer a different revert string
     *         can use the longer-form helper {requireUnclaimedWith} below
     *         or simply continue to use an inline `require`.
     *
     * @param currentlyExists Caller-supplied existence status under the candidate hash.
     */
    function requireUnclaimed(bool currentlyExists) internal pure {
        require(!currentlyExists, "Already published");
    }

    /**
     * @notice Revert with a caller-supplied message if a record already exists.
     * @dev    Same semantics as {requireUnclaimed} but lets a consumer
     *         preserve its own historical revert wording (e.g. CVP's
     *         `"replay"`). Provided for future consumers to adopt the
     *         library without rewriting test expectations.
     *
     * @param currentlyExists Caller-supplied existence status under the candidate hash.
     * @param message         Revert message to surface on collision.
     */
    function requireUnclaimedWith(bool currentlyExists, string memory message) internal pure {
        require(!currentlyExists, message);
    }
}
