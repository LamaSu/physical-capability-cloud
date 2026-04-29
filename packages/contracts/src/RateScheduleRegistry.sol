// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CanonicalRegistry} from "./CanonicalRegistry.sol";

/**
 * @title RateScheduleRegistry
 * @notice Content-addressed immutable storage for contributor RateSchedules.
 *
 *         A RateSchedule is the off-chain Segment[] DSL defined in
 *         packages/spec/src/types/rate-schedule.ts. Contributors publish a
 *         schedule once via {publish}, where it is keyed by the sha256 hash
 *         of its canonical-JSON encoding (matching the off-chain hashing
 *         algorithm). Once stored, an entry NEVER mutates — re-publishing
 *         the same hash reverts. This is the on-chain anchor that lets a
 *         ContributorNFT commit to an immutable rate curve at mint time.
 *
 *         Why sha256 (not keccak256)?
 *           The off-chain spec hashes canonical JSON with `node:crypto.createHash("sha256")`.
 *           The on-chain encoding must produce the SAME 32-byte digest for the SAME
 *           bytes so that a ContributorNFT's `scheduleHash` field can be verified
 *           against either source. Solidity 0.8 exposes `sha256(bytes)` natively.
 *
 *         Storage shape:
 *           bytes32 (sha256 of canonical JSON) → bytes (the canonical JSON itself)
 *           bytes32 → address (publisher of record)
 *           bytes32 → uint64  (publish timestamp)
 *
 *         Invariants:
 *           1. Identity: keys are the sha256 of their stored bytes (verified at write).
 *           2. Immutability: a key, once set, is never overwritten.
 *           3. Permissionless: any address may publish any schedule.
 *           4. Cheap reads: existence + raw bytes via {exists}/{get}.
 *
 *         Shared invariant primitives:
 *           Hash-binding and replay-prevention checks are factored into
 *           {CanonicalRegistry} so the same pattern can be reused by future
 *           content-addressed registries. {CaptureClassRegistry} (CVP) shares
 *           the conceptual pattern — a future PR may unify its replay revert
 *           wording so it can also call into the library. See
 *           `ai/research/contributor-economics/13-canonical-registry-extraction.md`.
 */
contract RateScheduleRegistry {
    // ── State ────────────────────────────────────────────────────────────

    /// @notice Map scheduleHash → raw canonical-JSON bytes of the schedule.
    /// @dev Private + read via {get} so the return is a clean memory copy,
    ///      mirroring MilestoneEscrow's `_payoutMap` accessor pattern.
    mapping(bytes32 => bytes) private _schedules;

    /// @notice Address that first published the schedule under this hash.
    /// @dev Public so off-chain indexers can attribute schedules without
    ///      re-walking event logs.
    mapping(bytes32 => address) public publisher;

    /// @notice Block timestamp at which the schedule was published.
    /// @dev uint64 is sufficient until year 2554; matches the
    ///      Milestone.challengeWindowEnd packing convention.
    mapping(bytes32 => uint64) public publishedAt;

    // ── Events ───────────────────────────────────────────────────────────

    /// @notice Emitted exactly once per unique scheduleHash.
    /// @param scheduleHash sha256 of the canonical-JSON schedule bytes.
    /// @param publisher    Address that published the schedule.
    /// @param size         Length of the stored bytes payload (informational).
    event SchedulePublished(
        bytes32 indexed scheduleHash,
        address indexed publisher,
        uint256 size
    );

    // ── Mutations ────────────────────────────────────────────────────────

    /**
     * @notice Publish a RateSchedule. Stored permanently under its sha256 hash.
     * @dev    The caller asserts the off-chain-computed `expectedHash`. The
     *         contract recomputes sha256(scheduleBytes) via the shared
     *         {CanonicalRegistry.verifyCanonicalHash} helper and reverts if
     *         the two disagree — this catches both encoding mismatches and
     *         tampered calldata. {CanonicalRegistry.requireUnclaimed} then
     *         enforces immutability: any future {publish} of the same hash
     *         reverts with "Already published".
     *
     *         CEI ordering: all checks first (in the library), then the single
     *         state mutation, then the event. No external calls. No reentrancy
     *         surface.
     *
     * @param scheduleBytes Canonical-JSON bytes (the same bytes that were
     *                      sha256'd off-chain to derive `scheduleHash`).
     * @param expectedHash  Off-chain-computed sha256 of `scheduleBytes`.
     *                      Reverts if `sha256(scheduleBytes) != expectedHash`.
     * @return scheduleHash The verified hash under which the schedule is now
     *                      stored. Always equals `expectedHash` on success.
     */
    function publish(bytes calldata scheduleBytes, bytes32 expectedHash)
        external
        returns (bytes32 scheduleHash)
    {
        scheduleHash = CanonicalRegistry.verifyCanonicalHash(scheduleBytes, expectedHash);
        CanonicalRegistry.requireUnclaimed(_schedules[scheduleHash].length > 0);

        _schedules[scheduleHash] = scheduleBytes;
        publisher[scheduleHash] = msg.sender;
        publishedAt[scheduleHash] = uint64(block.timestamp);

        emit SchedulePublished(scheduleHash, msg.sender, scheduleBytes.length);
    }

    // ── Views ────────────────────────────────────────────────────────────

    /**
     * @notice Retrieve the raw canonical-JSON bytes for a published schedule.
     * @dev    Returns an empty `bytes` when the hash has never been published —
     *         use {exists} for a cheap presence check before {get} on hot paths.
     */
    function get(bytes32 scheduleHash) external view returns (bytes memory) {
        return _schedules[scheduleHash];
    }

    /**
     * @notice Cheap existence check — true iff the hash has been published.
     * @dev    O(1). Used by ContributorNFT.mint() to gate scheduleHash refs.
     */
    function exists(bytes32 scheduleHash) external view returns (bool) {
        return _schedules[scheduleHash].length > 0;
    }
}
