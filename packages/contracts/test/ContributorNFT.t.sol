// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ContributorNFT.sol";
import "../src/RateScheduleRegistry.sol";

/**
 * @title ContributorNFTTest
 * @notice Tests for ContributorNFT (ERC-721 + ERC-2981 + sealed metadata).
 *
 *         Coverage matrix (15 tests):
 *           1.  mint assigns token + emits Transfer + ContributorMinted
 *           2.  mint reverts on zero `to` address
 *           3.  mint reverts on zero role tag
 *           4.  mint reverts on zero scheduleHash
 *           5.  mint reverts when scheduleHash is not published in registry
 *           6.  balanceOf increments correctly across multiple mints
 *           7.  dataOf returns the sealed payload exactly as supplied
 *           8.  transferFrom moves ownership and balances
 *           9.  approve + transferFrom by approved address
 *           10. setApprovalForAll + transferFrom by operator
 *           11. supportsInterface ERC-165 / ERC-721 / ERC-721-Metadata / ERC-2981
 *           12. royaltyInfo returns owner + 5% fallback
 *           13. metadata immutability (no setter exists; mint result is sealed)
 *           14. tokenURI returns metadataUri stored at mint
 *           15. fuzz: many mints with distinct ids, balances, sealed dataOf
 */
contract ContributorNFTTest is Test {
    RateScheduleRegistry registry;
    ContributorNFT nft;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    bytes constant SCHED_BYTES =
        bytes('{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":50}]}');
    bytes32 SCHED_HASH;

    bytes32 ROLE_INTEGRATOR = keccak256("integrator");
    bytes32 ROLE_MODEL_AUTHOR = keccak256("model-author");

    function setUp() public {
        registry = new RateScheduleRegistry();
        nft = new ContributorNFT(address(registry));

        SCHED_HASH = sha256(SCHED_BYTES);
        registry.publish(SCHED_BYTES, SCHED_HASH);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _mintTo(address to) internal returns (uint256) {
        return nft.mint(to, ROLE_INTEGRATOR, SCHED_HASH, bytes32(uint256(0xAA)), "ipfs://docs/integrator");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 1. test_mint_assignsTokenAndEmits
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_assignsTokenAndEmits() public {
        // Pre: nextTokenId == 0, alice has zero balance.
        assertEq(nft.nextTokenId(), 0);
        assertEq(nft.balanceOf(alice), 0);

        // Expect both Transfer (mint) and ContributorMinted with the right fields.
        vm.expectEmit(true, true, true, true);
        emit ContributorNFT.Transfer(address(0), alice, 1);

        vm.expectEmit(true, true, true, true);
        emit ContributorNFT.ContributorMinted(
            1,
            alice,
            ROLE_INTEGRATOR,
            SCHED_HASH,
            bytes32(uint256(0xAA)),
            "ipfs://docs/integrator"
        );

        uint256 tokenId = _mintTo(alice);

        assertEq(tokenId, 1);
        assertEq(nft.nextTokenId(), 1);
        assertEq(nft.ownerOf(1), alice);
        assertEq(nft.balanceOf(alice), 1);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 2. test_mint_revertsWhenZeroAddress
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_revertsWhenZeroAddress() public {
        vm.expectRevert("Zero address");
        nft.mint(address(0), ROLE_INTEGRATOR, SCHED_HASH, bytes32(0), "ipfs://x");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 3. test_mint_revertsWhenZeroRole
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_revertsWhenZeroRole() public {
        vm.expectRevert("Zero role");
        nft.mint(alice, bytes32(0), SCHED_HASH, bytes32(0), "ipfs://x");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 4. test_mint_revertsWhenZeroScheduleHash
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_revertsWhenZeroScheduleHash() public {
        vm.expectRevert("Zero scheduleHash");
        nft.mint(alice, ROLE_INTEGRATOR, bytes32(0), bytes32(0), "ipfs://x");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 5. test_mint_revertsWhenScheduleNotPublished
    //    The registry's `exists()` check is the sole gate on scheduleHash —
    //    if the hash hasn't been published yet, mint must revert.
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_revertsWhenScheduleNotPublished() public {
        bytes32 ghostHash = keccak256("never-published-schedule");
        // Sanity: ghostHash genuinely not in registry.
        assertFalse(registry.exists(ghostHash));

        vm.expectRevert("Schedule not registered");
        nft.mint(alice, ROLE_INTEGRATOR, ghostHash, bytes32(0), "ipfs://x");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 6. test_mint_balanceOfIncrements
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_balanceOfIncrements() public {
        _mintTo(alice);
        _mintTo(alice);
        _mintTo(bob);
        _mintTo(alice);

        assertEq(nft.balanceOf(alice), 3);
        assertEq(nft.balanceOf(bob), 1);
        assertEq(nft.balanceOf(carol), 0);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 7. test_mint_dataOfReturnsCorrect
    //    Every sealed-at-mint field must round-trip through dataOf().
    // ──────────────────────────────────────────────────────────────────────

    function test_mint_dataOfReturnsCorrect() public {
        bytes32 ipId = bytes32(uint256(0xCAFE));
        string memory uri = "ipfs://bafkreieyz/integrator-v3";

        vm.warp(1_700_500_000);
        uint256 tokenId = nft.mint(alice, ROLE_MODEL_AUTHOR, SCHED_HASH, ipId, uri);

        (
            bytes32 role,
            bytes32 scheduleHash,
            bytes32 storedIpId,
            string memory storedUri,
            uint64 mintedAt
        ) = nft.dataOf(tokenId);

        assertEq(role, ROLE_MODEL_AUTHOR);
        assertEq(scheduleHash, SCHED_HASH);
        assertEq(storedIpId, ipId);
        assertEq(storedUri, uri);
        assertEq(uint256(mintedAt), 1_700_500_000);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 8. test_transferFrom_works
    // ──────────────────────────────────────────────────────────────────────

    function test_transferFrom_works() public {
        uint256 tokenId = _mintTo(alice);

        vm.expectEmit(true, true, true, true);
        emit ContributorNFT.Transfer(alice, bob, tokenId);

        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        assertEq(nft.ownerOf(tokenId), bob);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(bob), 1);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 9. test_approve_thenTransferByApproved
    //    Single-token approve grants transfer rights to a non-owner.
    // ──────────────────────────────────────────────────────────────────────

    function test_approve_thenTransferByApproved() public {
        uint256 tokenId = _mintTo(alice);

        vm.prank(alice);
        nft.approve(bob, tokenId);

        assertEq(nft.getApproved(tokenId), bob);

        vm.prank(bob);
        nft.transferFrom(alice, carol, tokenId);

        assertEq(nft.ownerOf(tokenId), carol);
        // Approval cleared on transfer
        assertEq(nft.getApproved(tokenId), address(0));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 10. test_setApprovalForAll_thenTransferByOperator
    //     Operator approval grants transfer rights for all owner's tokens.
    // ──────────────────────────────────────────────────────────────────────

    function test_setApprovalForAll_thenTransferByOperator() public {
        uint256 t1 = _mintTo(alice);
        uint256 t2 = _mintTo(alice);

        vm.expectEmit(true, true, false, true);
        emit ContributorNFT.ApprovalForAll(alice, bob, true);

        vm.prank(alice);
        nft.setApprovalForAll(bob, true);

        assertTrue(nft.isApprovedForAll(alice, bob));

        // Bob can move both alice tokens
        vm.startPrank(bob);
        nft.transferFrom(alice, carol, t1);
        nft.transferFrom(alice, carol, t2);
        vm.stopPrank();

        assertEq(nft.ownerOf(t1), carol);
        assertEq(nft.ownerOf(t2), carol);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(carol), 2);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 11. test_supportsInterface_returnsTrueForExpectedIds
    // ──────────────────────────────────────────────────────────────────────

    function test_supportsInterface_returnsTrueForExpectedIds() public view {
        // ERC-165
        assertTrue(nft.supportsInterface(0x01ffc9a7));
        // ERC-721
        assertTrue(nft.supportsInterface(0x80ac58cd));
        // ERC-721 Metadata
        assertTrue(nft.supportsInterface(0x5b5e139f));
        // ERC-2981
        assertTrue(nft.supportsInterface(0x2a55205a));
        // Random unrelated id
        assertFalse(nft.supportsInterface(0xdeadbeef));
        // ERC-721 Enumerable (we deliberately do NOT implement it)
        assertFalse(nft.supportsInterface(0x780e9d63));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 12. test_royaltyInfo_returnsOwnerAndConstantFallback
    //     5% of sale price, addressed to current owner.
    // ──────────────────────────────────────────────────────────────────────

    function test_royaltyInfo_returnsOwnerAndConstantFallback() public {
        uint256 tokenId = _mintTo(alice);

        (address receiver, uint256 amount) = nft.royaltyInfo(tokenId, 10_000);
        assertEq(receiver, alice);
        assertEq(amount, 500); // 10000 * 500 / 10000 = 500

        // After transfer, royaltyInfo follows the new owner.
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        (receiver, amount) = nft.royaltyInfo(tokenId, 1_000_000);
        assertEq(receiver, bob);
        assertEq(amount, 50_000); // 1_000_000 * 500 / 10000

        // Reverts for non-existent token
        vm.expectRevert("Token does not exist");
        nft.royaltyInfo(999, 1_000);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 13. test_metadataIsImmutable
    //     No setter is defined for any sealed field. We cannot in-Solidity
    //     "prove" the absence of a function, so we encode the intent:
    //       (a) the public storage struct stays unchanged across transfers,
    //           burns (n/a — no burn either), or any other path
    //       (b) the contract bytecode does not expose a `set*` method by
    //           checking via call to a guessed selector — left as a static
    //           expectation captured in the contract's design
    //     Path (a) is the actionable test.
    // ──────────────────────────────────────────────────────────────────────

    function test_metadataIsImmutable() public {
        bytes32 ipId = bytes32(uint256(0x1234));
        uint256 tokenId = nft.mint(alice, ROLE_INTEGRATOR, SCHED_HASH, ipId, "ipfs://orig");

        // Snapshot at mint
        (
            bytes32 r0,
            bytes32 s0,
            bytes32 i0,
            string memory u0,
            uint64 t0
        ) = nft.dataOf(tokenId);

        // Pass through several state transitions — none of which should mutate dataOf.
        vm.prank(alice);
        nft.transferFrom(alice, bob, tokenId);

        vm.prank(bob);
        nft.approve(carol, tokenId);

        vm.prank(bob);
        nft.setApprovalForAll(carol, true);

        // Re-read dataOf and verify all five fields are byte-identical.
        (
            bytes32 r1,
            bytes32 s1,
            bytes32 i1,
            string memory u1,
            uint64 t1
        ) = nft.dataOf(tokenId);

        assertEq(r0, r1, "role mutated");
        assertEq(s0, s1, "scheduleHash mutated");
        assertEq(i0, i1, "ipId mutated");
        assertEq(u0, u1, "metadataUri mutated");
        assertEq(uint256(t0), uint256(t1), "mintedAt mutated");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 14. test_tokenURI_returnsMetadataUri
    // ──────────────────────────────────────────────────────────────────────

    function test_tokenURI_returnsMetadataUri() public {
        uint256 tokenId = nft.mint(alice, ROLE_INTEGRATOR, SCHED_HASH, bytes32(0), "ipfs://CID/integrator");
        assertEq(nft.tokenURI(tokenId), "ipfs://CID/integrator");

        // Reverts for non-existent token
        vm.expectRevert("Token does not exist");
        nft.tokenURI(999);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 15. testFuzz_manyMintsDistinctTokens
    //     Mint up to 64 tokens to fuzzed receivers; assert ids are unique,
    //     monotonically increasing, balances accumulate correctly, and
    //     dataOf round-trips.
    // ──────────────────────────────────────────────────────────────────────

    function testFuzz_manyMintsDistinctTokens(uint8 mintCount) public {
        // Bound to a reasonable range; >0 so we have at least one mint.
        uint256 n = uint256(mintCount) % 64 + 1;

        // Track expected balances for two recipients alternating.
        uint256 aliceCount;
        uint256 bobCount;

        for (uint256 i = 0; i < n; i++) {
            address to = (i % 2 == 0) ? alice : bob;
            bytes32 ipId = bytes32(i);
            uint256 tokenId = nft.mint(to, ROLE_INTEGRATOR, SCHED_HASH, ipId, "ipfs://fuzz");

            // Monotonic token ids starting at 1
            assertEq(tokenId, i + 1);
            assertEq(nft.ownerOf(tokenId), to);

            // Per-token sealed data round-trips
            (bytes32 role, bytes32 sh, bytes32 storedIpId,, ) = nft.dataOf(tokenId);
            assertEq(role, ROLE_INTEGRATOR);
            assertEq(sh, SCHED_HASH);
            assertEq(storedIpId, ipId);

            if (to == alice) aliceCount++; else bobCount++;
        }

        assertEq(nft.balanceOf(alice), aliceCount);
        assertEq(nft.balanceOf(bob), bobCount);
        assertEq(nft.nextTokenId(), n);
    }
}
