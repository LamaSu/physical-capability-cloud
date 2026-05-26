// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReceiptAnchorRegistry.sol";

/**
 * @title ReceiptAnchorRegistryTest
 * @notice Foundry tests for ReceiptAnchorRegistry — covers anchorOne,
 *         anchorBatch, replay protection, dispute, sequence checking, and
 *         Merkle proof verification (positive + negative cases).
 *
 * Design doc: ai/scoping/onchain-receipt-anchoring-2026-05-23.md §10.3
 */
contract ReceiptAnchorRegistryTest is Test {
    ReceiptAnchorRegistry internal registry;

    address internal gatewayOracle = address(0xCAFE);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    // ── Fixtures ───────────────────────────────────────────────────────────

    bytes32 internal constant CID_A = keccak256("receipt-A");
    bytes32 internal constant CID_B = keccak256("receipt-B");
    bytes32 internal constant TOOL_HASH = keccak256("tool-id-1");
    bytes32 internal constant CALLER_HASH = keccak256("caller-agent-1");
    bytes32 internal constant TOOL_CID = keccak256("tool-content-v1");
    bytes32 internal constant UPSTREAM_KEY = keccak256("upstream-key-1");

    function setUp() public {
        registry = new ReceiptAnchorRegistry(gatewayOracle);
    }

    // ── Constructor ────────────────────────────────────────────────────────

    function test_constructorSetsGateway() public {
        assertEq(registry.gatewayOracle(), gatewayOracle);
    }

    function test_constructorRejectsZeroGateway() public {
        vm.expectRevert("zero gateway");
        new ReceiptAnchorRegistry(address(0));
    }

    // ── anchorOne — happy path ─────────────────────────────────────────────

    function test_anchorOne_setsExistsAndStruct() public {
        vm.prank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, UPSTREAM_KEY, 0);

        assertTrue(registry.exists(CID_A));
        ReceiptAnchorRegistry.ReceiptAnchor memory a = registry.getAnchor(CID_A);
        assertEq(a.anchoredAtBlock, uint64(block.number));
        assertEq(a.receiptTimestamp, 1700000000);
        assertEq(a.dccClass, 3);
        assertEq(a.toolCID, TOOL_CID);
    }

    function test_anchorOne_emitsEvent() public {
        // Topic-shape check: cidHash + toolIdHash + callerHash are indexed.
        vm.expectEmit(true, true, true, true, address(registry));
        emit ReceiptAnchorRegistry.AnchorEmitted(
            CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, UPSTREAM_KEY
        );

        vm.prank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, UPSTREAM_KEY, 0);
    }

    function test_anchorOne_allClassesAllowed() public {
        for (uint8 c = 0; c <= 5; ++c) {
            bytes32 cid = keccak256(abi.encode("cid", c));
            vm.prank(gatewayOracle);
            registry.anchorOne(cid, TOOL_HASH, CALLER_HASH, c, uint64(block.timestamp), TOOL_CID, 0, 0);
            assertEq(registry.getAnchor(cid).dccClass, c);
        }
    }

    // ── anchorOne — permission ─────────────────────────────────────────────

    function test_anchorOne_onlyGateway() public {
        vm.prank(alice);
        vm.expectRevert("only gateway");
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, UPSTREAM_KEY, 0);
    }

    // ── anchorOne — replay ─────────────────────────────────────────────────

    function test_anchorOne_replayReverts() public {
        vm.prank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, UPSTREAM_KEY, 0);

        vm.prank(gatewayOracle);
        vm.expectRevert("replay");
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, UPSTREAM_KEY, 0);
    }

    // ── anchorOne — invalid class ──────────────────────────────────────────

    function test_anchorOne_invalidClassReverts() public {
        vm.prank(gatewayOracle);
        vm.expectRevert("invalid class");
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 6, 1700000000, TOOL_CID, UPSTREAM_KEY, 0);
    }

    // ── anchorOne — sequence ───────────────────────────────────────────────

    function test_anchorOne_sequenceMonotonic() public {
        vm.startPrank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 1, 1700000000, TOOL_CID, 0, 1);
        registry.anchorOne(CID_B, TOOL_HASH, CALLER_HASH, 1, 1700000001, TOOL_CID, 0, 2);
        vm.stopPrank();

        assertEq(registry.getSequence(CALLER_HASH, TOOL_HASH), 2);
    }

    function test_anchorOne_sequenceSkipReverts() public {
        vm.startPrank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 1, 1700000000, TOOL_CID, 0, 1);
        vm.expectRevert("bad sequence");
        registry.anchorOne(CID_B, TOOL_HASH, CALLER_HASH, 1, 1700000001, TOOL_CID, 0, 3); // skipped 2
        vm.stopPrank();
    }

    function test_anchorOne_sequenceReuseReverts() public {
        vm.startPrank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 1, 1700000000, TOOL_CID, 0, 1);
        vm.expectRevert("bad sequence");
        registry.anchorOne(CID_B, TOOL_HASH, CALLER_HASH, 1, 1700000001, TOOL_CID, 0, 1); // reused
        vm.stopPrank();
    }

    function test_anchorOne_sequenceZeroSkipsCheck() public {
        vm.startPrank(gatewayOracle);
        // sequence=0 => no check. Two calls with seq=0 both succeed.
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 1, 1700000000, TOOL_CID, 0, 0);
        registry.anchorOne(CID_B, TOOL_HASH, CALLER_HASH, 1, 1700000001, TOOL_CID, 0, 0);
        vm.stopPrank();
        // Sequence counter is unchanged when seq==0 is used.
        assertEq(registry.getSequence(CALLER_HASH, TOOL_HASH), 0);
    }

    function test_anchorOne_sequencePerPairIndependent() public {
        bytes32 toolB = keccak256("tool-b");
        vm.startPrank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 1, 1700000000, TOOL_CID, 0, 1);
        // Different tool — sequence counter independent, starts fresh at 1.
        registry.anchorOne(CID_B, toolB, CALLER_HASH, 1, 1700000001, TOOL_CID, 0, 1);
        vm.stopPrank();
        assertEq(registry.getSequence(CALLER_HASH, TOOL_HASH), 1);
        assertEq(registry.getSequence(CALLER_HASH, toolB), 1);
    }

    // ── anchorBatch — happy path ───────────────────────────────────────────

    function test_anchorBatch_setsBatchAndStruct() public {
        bytes32 root = keccak256("merkle-root-1");
        bytes32 metaCID = keccak256("ipfs-batch-manifest-1");

        vm.prank(gatewayOracle);
        registry.anchorBatch(root, 100, 0, 2, metaCID);

        assertTrue(registry.batchExists(root));
        ReceiptAnchorRegistry.BatchAnchor memory b = registry.getBatch(root);
        assertEq(b.anchoredAtBlock, uint64(block.number));
        assertEq(b.count, 100);
        assertEq(b.minDccClass, 0);
        assertEq(b.maxDccClass, 2);
        assertEq(b.batchMetadataCID, metaCID);
    }

    function test_anchorBatch_emitsEvent() public {
        bytes32 root = keccak256("merkle-root-2");
        bytes32 metaCID = keccak256("ipfs-batch-manifest-2");

        vm.expectEmit(true, true, true, true, address(registry));
        emit ReceiptAnchorRegistry.BatchAnchorEmitted(root, 42, 1, 2, metaCID);

        vm.prank(gatewayOracle);
        registry.anchorBatch(root, 42, 1, 2, metaCID);
    }

    // ── anchorBatch — permission ───────────────────────────────────────────

    function test_anchorBatch_onlyGateway() public {
        vm.prank(alice);
        vm.expectRevert("only gateway");
        registry.anchorBatch(keccak256("x"), 1, 0, 0, keccak256("m"));
    }

    // ── anchorBatch — replay ───────────────────────────────────────────────

    function test_anchorBatch_replayReverts() public {
        bytes32 root = keccak256("root-replay");
        vm.startPrank(gatewayOracle);
        registry.anchorBatch(root, 10, 0, 1, keccak256("m1"));
        vm.expectRevert("batch replay");
        registry.anchorBatch(root, 20, 0, 1, keccak256("m2"));
        vm.stopPrank();
    }

    // ── anchorBatch — bounds ───────────────────────────────────────────────

    function test_anchorBatch_zeroCountReverts() public {
        vm.prank(gatewayOracle);
        vm.expectRevert("bad count");
        registry.anchorBatch(keccak256("r"), 0, 0, 0, keccak256("m"));
    }

    function test_anchorBatch_overflowCountReverts() public {
        vm.prank(gatewayOracle);
        vm.expectRevert("bad count");
        registry.anchorBatch(keccak256("r"), 4097, 0, 0, keccak256("m"));
    }

    function test_anchorBatch_maxCountAllowed() public {
        vm.prank(gatewayOracle);
        registry.anchorBatch(keccak256("r-max"), 4096, 0, 5, keccak256("m"));
        assertEq(registry.getBatch(keccak256("r-max")).count, 4096);
    }

    function test_anchorBatch_badClassRangeReverts() public {
        vm.prank(gatewayOracle);
        vm.expectRevert("bad classes");
        registry.anchorBatch(keccak256("r"), 1, 3, 2, keccak256("m")); // min > max
    }

    function test_anchorBatch_classOutOfRangeReverts() public {
        vm.prank(gatewayOracle);
        vm.expectRevert("bad classes");
        registry.anchorBatch(keccak256("r"), 1, 0, 6, keccak256("m")); // max > 5
    }

    // ── verifyInBatch — Merkle proof ───────────────────────────────────────

    /// @dev Build a small sorted-pair-keccak Merkle tree with 4 leaves and
    ///      verify proof for leaf index 1 (left-leaning).
    function test_verifyInBatch_validProofReturnsTrue() public {
        bytes32 l0 = keccak256("leaf-0");
        bytes32 l1 = keccak256("leaf-1");
        bytes32 l2 = keccak256("leaf-2");
        bytes32 l3 = keccak256("leaf-3");

        bytes32 h01 = _hashPair(l0, l1);
        bytes32 h23 = _hashPair(l2, l3);
        bytes32 root = _hashPair(h01, h23);

        vm.prank(gatewayOracle);
        registry.anchorBatch(root, 4, 0, 1, keccak256("m"));

        // Proof for l1: sibling l0, then sibling h23.
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = l0;
        proof[1] = h23;

        assertTrue(registry.verifyInBatch(l1, root, proof));
    }

    function test_verifyInBatch_invalidProofReturnsFalse() public {
        bytes32 l0 = keccak256("leaf-0");
        bytes32 l1 = keccak256("leaf-1");
        bytes32 l2 = keccak256("leaf-2");
        bytes32 l3 = keccak256("leaf-3");
        bytes32 root = _hashPair(_hashPair(l0, l1), _hashPair(l2, l3));

        vm.prank(gatewayOracle);
        registry.anchorBatch(root, 4, 0, 1, keccak256("m"));

        // Tamper with sibling.
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = keccak256("wrong-sibling");
        proof[1] = _hashPair(l2, l3);

        assertFalse(registry.verifyInBatch(l1, root, proof));
    }

    function test_verifyInBatch_unknownBatchReverts() public {
        bytes32[] memory proof = new bytes32[](0);
        vm.expectRevert("no such batch");
        registry.verifyInBatch(keccak256("x"), keccak256("never-anchored"), proof);
    }

    function test_verifyInBatch_singleLeafBatch() public {
        // Single-leaf "tree" — the leaf IS the root, proof is empty.
        bytes32 leaf = keccak256("only-leaf");
        vm.prank(gatewayOracle);
        registry.anchorBatch(leaf, 1, 0, 0, keccak256("m"));

        bytes32[] memory proof = new bytes32[](0);
        assertTrue(registry.verifyInBatch(leaf, leaf, proof));
    }

    // ── dispute ───────────────────────────────────────────────────────────

    function test_dispute_anyoneCanRaise() public {
        // anchor first (not required for dispute, but typical)
        vm.prank(gatewayOracle);
        registry.anchorOne(CID_A, TOOL_HASH, CALLER_HASH, 3, 1700000000, TOOL_CID, 0, 0);

        vm.expectEmit(true, true, false, true, address(registry));
        emit ReceiptAnchorRegistry.DisputeRaised(CID_A, bob, "wrong response body");

        vm.prank(bob);
        registry.dispute(CID_A, "wrong response body");
    }

    function test_dispute_worksEvenForUnanchored() public {
        // Disputing an unanchored cidHash is permitted — emits an event regardless.
        // (Off-chain machinery decides whether to take the dispute seriously.)
        vm.expectEmit(true, true, false, true, address(registry));
        emit ReceiptAnchorRegistry.DisputeRaised(keccak256("ghost"), bob, "claim of phantom anchor");

        vm.prank(bob);
        registry.dispute(keccak256("ghost"), "claim of phantom anchor");
    }

    // ── Sparse views ──────────────────────────────────────────────────────

    function test_getAnchor_zeroForUnknown() public {
        ReceiptAnchorRegistry.ReceiptAnchor memory a = registry.getAnchor(keccak256("unknown"));
        assertEq(a.anchoredAtBlock, 0);
        assertEq(a.toolCID, bytes32(0));
    }

    function test_getBatch_zeroForUnknown() public {
        ReceiptAnchorRegistry.BatchAnchor memory b = registry.getBatch(keccak256("unknown"));
        assertEq(b.anchoredAtBlock, 0);
        assertEq(b.count, 0);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
