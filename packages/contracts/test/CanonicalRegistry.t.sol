// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CanonicalRegistry.sol";

/**
 * @title CanonicalRegistryHarness
 * @notice Thin external-call harness that exposes the pure internal library
 *         helpers so Foundry's `vm.expectRevert` can intercept their reverts
 *         (cheatcode revert expectations only resolve at the EXTERNAL call
 *         boundary in Foundry; calling an `internal pure` library helper
 *         directly from a test contract bypasses that boundary).
 */
contract CanonicalRegistryHarness {
    function verifyCanonicalHash(bytes calldata payload, bytes32 expectedHash)
        external
        pure
        returns (bytes32)
    {
        return CanonicalRegistry.verifyCanonicalHash(payload, expectedHash);
    }

    function requireUnclaimed(bool currentlyExists) external pure {
        CanonicalRegistry.requireUnclaimed(currentlyExists);
    }

    function requireUnclaimedWith(bool currentlyExists, string calldata message) external pure {
        CanonicalRegistry.requireUnclaimedWith(currentlyExists, message);
    }
}

/**
 * @title CanonicalRegistryTest
 * @notice Isolated tests for the CanonicalRegistry library. These test the
 *         invariant primitives in isolation; consumer-side regression is
 *         covered by RateScheduleRegistry.t.sol (no behavior change there,
 *         same revert strings).
 *
 *         Coverage matrix:
 *           1. publish: hash + payload match → returns hash
 *           2. publish: hash mismatch → reverts with "Schedule hash mismatch"
 *           3. publish: empty payload → reverts with "Empty schedule"
 *           4. requireUnclaimed: false → no revert (passthrough)
 *           5. requireUnclaimed: true → reverts with "Already published"
 *           6. requireUnclaimedWith: custom revert string honored
 *           7. Fuzz: arbitrary non-empty bytes round-trip cleanly
 */
contract CanonicalRegistryTest is Test {
    CanonicalRegistryHarness harness;

    bytes constant SAMPLE_PAYLOAD =
        bytes('{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":50}]}');

    function setUp() public {
        harness = new CanonicalRegistryHarness();
    }

    // ──────────────────────────────────────────────────────────────────────
    // 1. test_verifyCanonicalHash_returnsHashOnMatch
    //    Happy path: sha256(payload) == expectedHash → returns the hash.
    // ──────────────────────────────────────────────────────────────────────

    function test_verifyCanonicalHash_returnsHashOnMatch() public view {
        bytes32 expected = sha256(SAMPLE_PAYLOAD);
        bytes32 returned = harness.verifyCanonicalHash(SAMPLE_PAYLOAD, expected);
        assertEq(returned, expected, "library must return the verified hash");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 2. test_verifyCanonicalHash_revertsOnMismatch
    //    expectedHash != sha256(payload) → strict revert with stable message.
    // ──────────────────────────────────────────────────────────────────────

    function test_verifyCanonicalHash_revertsOnMismatch() public {
        bytes32 wrongHash = bytes32(uint256(0xDEADBEEF));
        // Sanity invariant: the wrong hash genuinely differs.
        assertTrue(wrongHash != sha256(SAMPLE_PAYLOAD), "test fixture invariant");

        vm.expectRevert("Schedule hash mismatch");
        harness.verifyCanonicalHash(SAMPLE_PAYLOAD, wrongHash);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 3. test_verifyCanonicalHash_revertsOnEmpty
    //    Zero-length payload is rejected before sha256 is computed.
    // ──────────────────────────────────────────────────────────────────────

    function test_verifyCanonicalHash_revertsOnEmpty() public {
        bytes memory empty = new bytes(0);
        bytes32 emptyHash = sha256(empty);

        // Even with a "correct" sha256 of empty, the empty-payload guard fires first.
        vm.expectRevert("Empty schedule");
        harness.verifyCanonicalHash(empty, emptyHash);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 4. test_requireUnclaimed_passesWhenFalse
    //    `currentlyExists == false` → no revert, function returns cleanly.
    // ──────────────────────────────────────────────────────────────────────

    function test_requireUnclaimed_passesWhenFalse() public view {
        // No revert expected. Successful return = pass.
        harness.requireUnclaimed(false);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 5. test_requireUnclaimed_revertsWhenTrue
    //    `currentlyExists == true` → revert with "Already published".
    // ──────────────────────────────────────────────────────────────────────

    function test_requireUnclaimed_revertsWhenTrue() public {
        vm.expectRevert("Already published");
        harness.requireUnclaimed(true);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 6. test_requireUnclaimedWith_honorsCustomMessage
    //    Caller-supplied revert message is surfaced verbatim. This is the
    //    extension hook that lets future consumers (e.g. CVP's
    //    CaptureClassRegistry) preserve their historical "replay" wording
    //    without sacrificing the shared invariant.
    // ──────────────────────────────────────────────────────────────────────

    function test_requireUnclaimedWith_honorsCustomMessage() public {
        // Passes through cleanly when not yet claimed.
        harness.requireUnclaimedWith(false, "anything");

        // And reverts with the EXACT message supplied.
        vm.expectRevert("replay");
        harness.requireUnclaimedWith(true, "replay");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 7. testFuzz_verifyCanonicalHash_arbitraryBytes
    //    Round-trip: for arbitrary non-empty bytes, sha256 + verify yields
    //    the recomputed hash; mutating expectedHash by 1 bit reverts.
    // ──────────────────────────────────────────────────────────────────────

    function testFuzz_verifyCanonicalHash_arbitraryBytes(bytes calldata data) public {
        vm.assume(data.length > 0);
        bytes32 expected = sha256(data);

        // Happy path
        bytes32 returned = harness.verifyCanonicalHash(data, expected);
        assertEq(returned, expected);

        // 1-bit mutation must revert. XOR'ing with a non-zero mask yields a
        // different bytes32 deterministically (no need for vm.assume).
        bytes32 mutated = expected ^ bytes32(uint256(1));
        // Sanity: confirm mutated != expected (should always hold; if the XOR
        // yielded the same value, our flip mask was zero — impossible here).
        assertTrue(mutated != expected);

        vm.expectRevert("Schedule hash mismatch");
        harness.verifyCanonicalHash(data, mutated);
    }
}
