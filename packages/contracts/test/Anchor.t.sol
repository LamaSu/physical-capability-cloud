// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/Anchor.sol";

contract AnchorTest is Test {
    Anchor anchorContract;

    address owner = address(0xAA);
    address anchorer = address(0xBB);
    address otherUser = address(0xCC);
    address newAnchorer = address(0xDD);

    bytes32 root1 = keccak256("merkle-root-1");
    bytes32 root2 = keccak256("merkle-root-2");
    bytes32 root3 = keccak256("merkle-root-3");

    function setUp() public {
        anchorContract = new Anchor(owner, anchorer);
    }

    // ── Single anchor ──────────────────────────────────────────────────

    function test_singleAnchor_storesRecordAndEmits() public {
        vm.warp(1_700_000_000);

        vm.expectEmit(true, true, true, true, address(anchorContract));
        emit Anchor.LogRootAnchored(0, root1, 42, anchorer, block.timestamp);

        vm.prank(anchorer);
        uint256 index = anchorContract.anchor(root1, 42);

        assertEq(index, 0);
        assertEq(anchorContract.totalAnchors(), 1);

        Anchor.AnchorRecord memory rec = anchorContract.getAnchor(0);
        assertEq(rec.merkleRoot, root1);
        assertEq(rec.batchSize, 42);
        assertEq(rec.anchorer, anchorer);
        assertEq(rec.timestamp, block.timestamp);
    }

    // ── Multi-anchor sequence ──────────────────────────────────────────

    function test_multiAnchor_sequenceMonotonicAndIndexed() public {
        vm.startPrank(anchorer);
        uint256 i0 = anchorContract.anchor(root1, 100);
        // Advance time so the second anchor has a distinguishable timestamp.
        vm.warp(block.timestamp + 1 days);
        uint256 i1 = anchorContract.anchor(root2, 250);
        vm.warp(block.timestamp + 1 days);
        uint256 i2 = anchorContract.anchor(root3, 450);
        vm.stopPrank();

        assertEq(i0, 0);
        assertEq(i1, 1);
        assertEq(i2, 2);
        assertEq(anchorContract.totalAnchors(), 3);

        Anchor.AnchorRecord memory r0 = anchorContract.getAnchor(0);
        Anchor.AnchorRecord memory r1 = anchorContract.getAnchor(1);
        Anchor.AnchorRecord memory r2 = anchorContract.getAnchor(2);

        assertEq(r0.merkleRoot, root1);
        assertEq(r0.batchSize, 100);
        assertEq(r1.merkleRoot, root2);
        assertEq(r1.batchSize, 250);
        assertEq(r2.merkleRoot, root3);
        assertEq(r2.batchSize, 450);

        // Timestamps strictly monotonic across 1-day warps.
        assertGt(r1.timestamp, r0.timestamp);
        assertGt(r2.timestamp, r1.timestamp);
    }

    // ── Access control ────────────────────────────────────────────────

    function test_onlyAnchorer_otherUser_reverts() public {
        vm.prank(otherUser);
        vm.expectRevert(Anchor.NotAnchorer.selector);
        anchorContract.anchor(root1, 1);
    }

    function test_owner_canRotateAnchorer() public {
        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(anchorContract));
        emit Anchor.AnchorerRotated(anchorer, newAnchorer);
        anchorContract.rotateAnchorer(newAnchorer);

        assertEq(anchorContract.anchorer(), newAnchorer);

        // Old anchorer should no longer be authorized.
        vm.prank(anchorer);
        vm.expectRevert(Anchor.NotAnchorer.selector);
        anchorContract.anchor(root1, 1);

        // New anchorer can submit anchors.
        vm.prank(newAnchorer);
        uint256 idx = anchorContract.anchor(root1, 1);
        assertEq(idx, 0);
    }

    function test_nonOwner_cannotRotate() public {
        vm.prank(otherUser);
        vm.expectRevert(Anchor.NotOwner.selector);
        anchorContract.rotateAnchorer(newAnchorer);
    }

    // ── Out of range ──────────────────────────────────────────────────

    function test_getAnchor_outOfRangeReverts() public {
        // Empty registry — any read reverts.
        vm.expectRevert(abi.encodeWithSelector(Anchor.AnchorIndexOutOfRange.selector, 0, 0));
        anchorContract.getAnchor(0);

        // After one anchor, index 1 is still out of range.
        vm.prank(anchorer);
        anchorContract.anchor(root1, 1);
        vm.expectRevert(abi.encodeWithSelector(Anchor.AnchorIndexOutOfRange.selector, 1, 1));
        anchorContract.getAnchor(1);
    }
}
