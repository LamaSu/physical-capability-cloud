// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/RateScheduleRegistry.sol";

/**
 * @title RateScheduleRegistryTest
 * @notice Tests for the content-addressed RateScheduleRegistry.
 *
 *         Coverage matrix:
 *           1. Happy path:       publish → storage + event + view accessors
 *           2. Hash mismatch:    expectedHash != sha256(bytes) → revert
 *           3. Re-publish:       same hash a second time → revert
 *           4. Empty payload:    zero-length bytes → revert
 *           5. Read-side:        get() / exists() / publisher / publishedAt
 *           6. Distinct schedules coexist (no key collision)
 *           7. Fuzz:             random bytes round-trip through publish/get
 *           8. Publisher record: msg.sender preserved on publish
 *           9. Timestamp record: block.timestamp captured at publish
 */
contract RateScheduleRegistryTest is Test {
    RateScheduleRegistry registry;

    address alice = address(0xA11CE);
    address bob   = address(0xB0B);

    // A representative canonical-JSON schedule, copied from the off-chain
    // RateSchedule example: {"version":1,"segments":[{"kind":"constant",...}]}.
    // Determinism does NOT require this to be valid JSON for the registry —
    // the registry is byte-blind. We use realistic JSON purely so test
    // failures read sensibly in the trace.
    bytes constant SAMPLE_SCHEDULE_BYTES =
        bytes(
            '{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":50}]}'
        );

    function setUp() public {
        registry = new RateScheduleRegistry();
    }

    // ──────────────────────────────────────────────────────────────────────
    // 1. test_publish_storesAndEmits
    //    Happy path: bytes match expectedHash → schedule stored, event emitted,
    //    return value equals the verified hash.
    // ──────────────────────────────────────────────────────────────────────

    function test_publish_storesAndEmits() public {
        bytes32 hash = sha256(SAMPLE_SCHEDULE_BYTES);

        vm.expectEmit(true, true, false, true);
        emit RateScheduleRegistry.SchedulePublished(hash, alice, SAMPLE_SCHEDULE_BYTES.length);

        vm.prank(alice);
        bytes32 returned = registry.publish(SAMPLE_SCHEDULE_BYTES, hash);

        assertEq(returned, hash, "publish() return must equal verified hash");
        assertTrue(registry.exists(hash), "exists() must be true after publish");
        assertEq(registry.get(hash), SAMPLE_SCHEDULE_BYTES, "get() must round-trip bytes");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 2. test_publish_revertsWhenHashMismatch
    //    The contract recomputes sha256(bytes) and rejects if it disagrees with
    //    expectedHash. We pass deliberately-wrong expectedHash → revert.
    // ──────────────────────────────────────────────────────────────────────

    function test_publish_revertsWhenHashMismatch() public {
        bytes32 wrongHash = bytes32(uint256(0xDEADBEEF));
        // Sanity: wrongHash must NOT collide with the real sha256.
        assertTrue(wrongHash != sha256(SAMPLE_SCHEDULE_BYTES), "test setup invariant");

        vm.expectRevert("Schedule hash mismatch");
        registry.publish(SAMPLE_SCHEDULE_BYTES, wrongHash);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 3. test_publish_revertsWhenAlreadyPublished
    //    Immutability: the second publish of the same hash reverts even when
    //    the bytes are byte-identical.
    // ──────────────────────────────────────────────────────────────────────

    function test_publish_revertsWhenAlreadyPublished() public {
        bytes32 hash = sha256(SAMPLE_SCHEDULE_BYTES);

        vm.prank(alice);
        registry.publish(SAMPLE_SCHEDULE_BYTES, hash);

        // Second publish — same caller, same bytes — must revert.
        vm.prank(alice);
        vm.expectRevert("Already published");
        registry.publish(SAMPLE_SCHEDULE_BYTES, hash);

        // Different caller, same bytes — must also revert.
        vm.prank(bob);
        vm.expectRevert("Already published");
        registry.publish(SAMPLE_SCHEDULE_BYTES, hash);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 4. test_publish_revertsWhenEmptyBytes
    //    Zero-length payload is rejected; otherwise exists() would conflate
    //    "stored empty schedule" with "never published" because the existence
    //    check is `length > 0`.
    // ──────────────────────────────────────────────────────────────────────

    function test_publish_revertsWhenEmptyBytes() public {
        bytes memory empty = new bytes(0);
        bytes32 hash = sha256(empty);

        vm.expectRevert("Empty schedule");
        registry.publish(empty, hash);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 5. test_get_returnsBytesForKnownHash
    //    Round-trip: bytes pulled out via get() must equal bytes pushed in.
    // ──────────────────────────────────────────────────────────────────────

    function test_get_returnsBytesForKnownHash() public {
        bytes32 hash = sha256(SAMPLE_SCHEDULE_BYTES);

        registry.publish(SAMPLE_SCHEDULE_BYTES, hash);

        bytes memory got = registry.get(hash);
        assertEq(got.length, SAMPLE_SCHEDULE_BYTES.length);
        assertEq(got, SAMPLE_SCHEDULE_BYTES);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 6. test_get_returnsEmptyForUnknownHash
    //    An unpublished hash returns empty bytes (Solidity default for absent
    //    mapping entries). exists() should be false.
    // ──────────────────────────────────────────────────────────────────────

    function test_get_returnsEmptyForUnknownHash() public view {
        bytes32 unknownHash = keccak256("never published");
        bytes memory got = registry.get(unknownHash);
        assertEq(got.length, 0);
        assertFalse(registry.exists(unknownHash));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 7. test_exists_truthyForKnownHash_falsyForUnknown
    //    Crisp boolean check used by ContributorNFT.mint().
    // ──────────────────────────────────────────────────────────────────────

    function test_exists_truthyForKnownHash_falsyForUnknown() public {
        bytes32 known   = sha256(SAMPLE_SCHEDULE_BYTES);
        bytes32 unknown = keccak256("ghost");

        assertFalse(registry.exists(known), "must be unknown before publish");
        assertFalse(registry.exists(unknown), "unrelated hash must be unknown");

        registry.publish(SAMPLE_SCHEDULE_BYTES, known);

        assertTrue(registry.exists(known), "must be known after publish");
        assertFalse(registry.exists(unknown), "unrelated hash still unknown");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 8. test_publisher_recordedCorrectly
    //    msg.sender at publish time becomes the persistent publisher of record.
    // ──────────────────────────────────────────────────────────────────────

    function test_publisher_recordedCorrectly() public {
        bytes32 hash = sha256(SAMPLE_SCHEDULE_BYTES);

        vm.prank(alice);
        registry.publish(SAMPLE_SCHEDULE_BYTES, hash);

        assertEq(registry.publisher(hash), alice, "publisher must equal alice");

        // Bob attempts to publish a different schedule and gets recorded for THAT
        // schedule — proves publisher is per-hash, not global.
        bytes memory other = bytes('{"version":2,"segments":[{"kind":"step","startTime":0,"endTime":null,"bps":100}]}');
        bytes32 otherHash = sha256(other);

        vm.prank(bob);
        registry.publish(other, otherHash);

        assertEq(registry.publisher(hash), alice, "alice's record must persist");
        assertEq(registry.publisher(otherHash), bob, "bob recorded for his hash");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 9. test_publishedAt_recordedCorrectly
    //    block.timestamp at publish time is captured into uint64 publishedAt.
    // ──────────────────────────────────────────────────────────────────────

    function test_publishedAt_recordedCorrectly() public {
        bytes32 hash = sha256(SAMPLE_SCHEDULE_BYTES);

        vm.warp(1_700_000_000); // anchor timestamp
        vm.prank(alice);
        registry.publish(SAMPLE_SCHEDULE_BYTES, hash);

        assertEq(uint256(registry.publishedAt(hash)), 1_700_000_000);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 10. test_publishMultipleDistinctSchedules
    //     Three structurally-distinct schedules coexist with their own
    //     storage, publisher, and timestamp. Proves no key collision.
    // ──────────────────────────────────────────────────────────────────────

    function test_publishMultipleDistinctSchedules() public {
        bytes memory s1 = bytes('{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":25}]}');
        bytes memory s2 = bytes('{"version":1,"segments":[{"kind":"step","startTime":0,"endTime":null,"bps":75}]}');
        bytes memory s3 = bytes('{"version":2,"segments":[{"kind":"linear-decay","startTime":0,"endTime":3600,"startBps":500,"endBps":50}]}');

        bytes32 h1 = sha256(s1);
        bytes32 h2 = sha256(s2);
        bytes32 h3 = sha256(s3);

        // Pre-condition: all hashes distinct
        assertTrue(h1 != h2 && h2 != h3 && h1 != h3, "fixture hashes must differ");

        vm.warp(100);
        vm.prank(alice);
        registry.publish(s1, h1);

        vm.warp(200);
        vm.prank(bob);
        registry.publish(s2, h2);

        vm.warp(300);
        vm.prank(alice);
        registry.publish(s3, h3);

        // All three exist with their own bytes
        assertEq(registry.get(h1), s1);
        assertEq(registry.get(h2), s2);
        assertEq(registry.get(h3), s3);

        // Publisher records are per-hash
        assertEq(registry.publisher(h1), alice);
        assertEq(registry.publisher(h2), bob);
        assertEq(registry.publisher(h3), alice);

        // Timestamps captured at the moment of each publish
        assertEq(uint256(registry.publishedAt(h1)), 100);
        assertEq(uint256(registry.publishedAt(h2)), 200);
        assertEq(uint256(registry.publishedAt(h3)), 300);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 11. testFuzz_publishRoundTrip
    //     For arbitrary non-empty bytes, sha256 + publish + get round-trips
    //     correctly and the entry becomes immutable.
    // ──────────────────────────────────────────────────────────────────────

    function testFuzz_publishRoundTrip(bytes calldata data) public {
        // Skip empty payloads — they are rejected by design (test #4 covers it).
        vm.assume(data.length > 0);

        bytes32 hash = sha256(data);

        // Pre-publish: not in the registry.
        assertFalse(registry.exists(hash));

        vm.prank(alice);
        bytes32 returned = registry.publish(data, hash);

        assertEq(returned, hash);
        assertTrue(registry.exists(hash));
        assertEq(registry.get(hash), data);
        assertEq(registry.publisher(hash), alice);

        // Re-publish must revert under any caller.
        vm.prank(bob);
        vm.expectRevert("Already published");
        registry.publish(data, hash);
    }
}
