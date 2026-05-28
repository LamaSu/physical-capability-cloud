// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";
import "../src/RateScheduleRegistry.sol";
import "../src/ContributorNFT.sol";
import {RoleTags} from "../src/RoleTags.sol";
import {CanonicalBytes} from "./helpers/CanonicalBytes.sol";
import "./mocks/MockUSDT.sol";
import {IPCCOracle} from "../src/interfaces/IPCCOracle.sol";

/**
 * @title EndToEndContributorEconomicsTest
 * @notice Single forge transaction exercising the full contributor-economics
 *         seam end-to-end: off-chain canonical-JSON bytes → on-chain sha256 →
 *         RateScheduleRegistry.publish → ContributorNFT.mint (gated by the
 *         registry) → MilestoneEscrow.setPayoutMap (referencing the same
 *         contributor address) → fund → submitEvidence → submitAttestation
 *         → release with multi-recipient distribution.
 *
 *         Why this test:
 *           Synthetic forge tests + isolated unit tests already cover each
 *           link individually (RateScheduleRegistry.t.sol, ContributorNFT.t.sol,
 *           MilestoneEscrow.splitPayout.t.sol, MilestoneEscrow.multistable.t.sol).
 *           NONE of them prove the chain works end-to-end from canonical bytes
 *           through to per-recipient USDC balances. This file is the answer
 *           to cross-review-00's last open CRITICAL/HIGH item: a deterministic
 *           in-VM simulation of what the live system on Base Sepolia would do.
 *
 *         What this test does NOT do:
 *           - Broadcast to a real chain (no production deploy in this run)
 *           - Exercise PCCProtocol fee root (covered by the splitPayout +
 *             integration test files)
 *           - Test dispute paths (covered by integration test #3)
 *
 *         Tests:
 *           1. test_e2e_singleToken_publishMintFundReleaseSplitPayout —
 *              full happy path with the default token (USDC), 4 recipients
 *              (3 named contributors + operator residual). Asserts each
 *              recipient's balance delta is EXACT.
 *           2. test_e2e_multiToken_payoutsRouteToCorrectToken — same payout
 *              map but the milestone is overridden to USDT. Proves the
 *              SafeERC20 path correctly routes USDT (no-return-bool token)
 *              to all recipients without silently falling back to USDC.
 *              This is the regression test for the bug fixed in `14cce8e`.
 */
contract EndToEndContributorEconomicsTest is Test {
    // ── Contracts ───────────────────────────────────────────────────────
    RateScheduleRegistry registry;
    ContributorNFT nft;
    MilestoneEscrow escrow;
    MockUSDC usdc;

    // ── Actors (escrow roles) ───────────────────────────────────────────
    address payer = address(0x1);
    address operator = address(0x2);
    address arbiter = address(0x3);
    address verifierOracle = address(0x5);

    // ── Recipients (contributors) ───────────────────────────────────────
    address integrator = address(0x10);
    address protocolAuthor = address(0x11);
    address modelAuthor = address(0x12);

    // ── Identifiers ─────────────────────────────────────────────────────
    bytes32 cwmId = keccak256("cwm-e2e-001");
    bytes32 stepId = keccak256("step-e2e-001");

    // ── Schedule fixtures (250 bps constant, forever) ───────────────────
    /// @dev Pre-computed off-chain via canonicalize() + sha256:
    ///        bytes:  '{"segments":[{"bps":250,"endTime":null,"kind":"constant","startTime":0}],"version":1}'
    ///        sha256: 0xd0ba2ae3fe3c21f754281c31c6066a3214d2265f114f921ce8bfe7b186cd3d8b
    ///      Stored as a constant so we can use it as the integrator's scheduleHash
    ///      in mint() AND assert the registry's stored bytes match exactly.
    bytes32 constant EXPECTED_SCHEDULE_HASH =
        0xd0ba2ae3fe3c21f754281c31c6066a3214d2265f114f921ce8bfe7b186cd3d8b;

    // ── Constants for both tests ────────────────────────────────────────
    /// @dev 10_000 USDC milestone, 6 decimals.
    uint256 constant MILESTONE_AMOUNT = 10_000_000_000;
    /// @dev No bond required — keeps the operator-balance math obvious.
    uint256 constant OPERATOR_BOND = 0;
    uint256 constant CHALLENGE_WINDOW = 3600;

    function setUp() public {
        // 1. Deploy registry + NFT (NFT is registry-aware so mint can gate on existence).
        registry = new RateScheduleRegistry();
        nft = new ContributorNFT(address(registry));

        // 2. Deploy default-token escrow. Standalone mode (no protocol root).
        usdc = new MockUSDC(0);
        escrow = new MilestoneEscrow(payer, arbiter, address(usdc), cwmId, address(0));

        // 3. Mint USDC to payer (enough to fund the milestone). Recipients
        //    start at zero balance so post-release deltas are unambiguous.
        usdc.mint(payer, MILESTONE_AMOUNT);

        // 4. Authorize the verifier oracle — operator self-attest is blocked
        //    by the contract regardless.
        vm.startPrank(arbiter);
        escrow.addVerifier(verifierOracle);
        vm.stopPrank();
    }

    /// @dev Build a stub attestation pinned to the test escrow. In standalone
    ///      mode (protocolRoot == 0) only escrowAddress is checked by
    ///      submitAttestation, so the other fields are cosmetic.
    function _makeAttestation() internal view returns (IPCCOracle.Attestation memory) {
        return IPCCOracle.Attestation({
            version: 1,
            escrowAddress: address(escrow),
            jobId: "job-e2e",
            evidenceHash: keccak256("e2e-evidence"),
            tier: 1,
            verified: true,
            timestamp: block.timestamp,
            nonce: keccak256(abi.encode("e2e-nonce", block.timestamp)),
            extraData: hex"",
            signature: hex""
        });
    }

    // ──────────────────────────────────────────────────────────────────────
    // Test 1: single-token end-to-end.
    //
    // Flow:
    //   (a) Build canonical bytes for a constant 250bps schedule via the
    //       CanonicalBytes helper. Compute sha256 in Solidity. Assert it
    //       matches the off-chain reference vector.
    //   (b) Publish to the registry as the integrator. exists() flips true.
    //   (c) Mint a ContributorNFT to the integrator with that scheduleHash.
    //       The mint() call gates on registry.exists(scheduleHash) — proves
    //       the registry → NFT seam works.
    //   (d) Build a payout map with 3 explicit recipients (integrator,
    //       protocolAuthor, modelAuthor) and let the operator collect the
    //       residual. setPayoutMap rejects the configuration if anything
    //       in the map is malformed.
    //   (e) Walk the milestone lifecycle: fund → submitEvidence →
    //       submitAttestation → warp → release.
    //   (f) Assert each recipient's USDC balance delta is the EXACT
    //       distributable * bps / 10000 amount, and the operator gets the
    //       full residual. No bond in this test, so operator balance is
    //       purely the residual.
    //
    // Math (no protocol fee, no bond):
    //   distributable    = MILESTONE_AMOUNT (10_000_000_000) — no fee deducted
    //   integrator (250) = 10_000_000_000 * 250 / 10000  =   250_000_000 (250 USDC)
    //   protocolAuthor(100)= 10_000_000_000 * 100 / 10000 =   100_000_000 (100 USDC)
    //   modelAuthor (200)= 10_000_000_000 * 200 / 10000  =   200_000_000 (200 USDC)
    //   distributed      =                                    550_000_000
    //   operator residual = 10_000_000_000 - 550_000_000 = 9_450_000_000 (9450 USDC)
    //
    // Conservation: every wei of MILESTONE_AMOUNT lands in exactly one of
    // the four destinations. The escrow drains to zero.
    // ──────────────────────────────────────────────────────────────────────

    function test_e2e_singleToken_publishMintFundReleaseSplitPayout() public {
        // ── (a) Build canonical bytes off-chain-equivalent in Solidity ──
        // Schedule: {version:1, segments:[{kind:'constant', startTime:0,
        // endTime:null, bps:250}]} — same shape verified in CanonicalBytes
        // helper docstrings.
        bytes memory scheduleBytes = CanonicalBytes.constantOpenEnded(
            /*startTime*/ 0,
            /*bps*/ 250,
            /*version*/ 1
        );
        bytes32 scheduleHash = sha256(scheduleBytes);

        // Cross-check against the off-chain reference vector. If this assert
        // ever fails, EITHER the canonical encoding diverged from canonical.ts
        // OR the constant fixture is wrong — both are bugs that block real
        // contributors from publishing schedules consistent with off-chain
        // tooling.
        assertEq(
            scheduleHash,
            EXPECTED_SCHEDULE_HASH,
            "Solidity-built canonical bytes must hash to the off-chain reference value"
        );

        // ── (b) Integrator publishes their schedule to the registry ──────
        vm.prank(integrator);
        bytes32 publishedHash = registry.publish(scheduleBytes, scheduleHash);

        assertEq(publishedHash, scheduleHash, "publish() returns the verified hash");
        assertTrue(registry.exists(scheduleHash), "registry.exists is true after publish");
        assertEq(
            registry.publisher(scheduleHash),
            integrator,
            "registry records the integrator as publisher"
        );
        assertEq(
            registry.get(scheduleHash),
            scheduleBytes,
            "registry returns the same bytes we published"
        );

        // ── (c) Mint a ContributorNFT to the integrator referencing the schedule
        // The mint call's only schedule-related gate is registry.exists(hash).
        // Permissionless — anyone can mint (here we just use the test contract).
        uint256 tokenId = nft.mint(
            integrator,
            RoleTags.INTEGRATOR,
            scheduleHash,
            bytes32(uint256(0xCAFE)), // ipId
            "ipfs://CID/integrator-meta"
        );
        assertEq(tokenId, 1, "first mint produces token id 1");
        assertEq(nft.ownerOf(tokenId), integrator, "integrator owns the NFT");

        // Spot-check the sealed metadata round-trips via dataOf
        (bytes32 storedRole, bytes32 storedSchedHash,, ,) = nft.dataOf(tokenId);
        assertEq(storedRole, RoleTags.INTEGRATOR, "sealed role tag");
        assertEq(storedSchedHash, scheduleHash, "sealed scheduleHash");

        // ── (d) Build the payout map and register it on the milestone ────
        // Order in the array drives the order of SplitPayoutExecuted events.
        vm.prank(payer);
        escrow.addMilestone(stepId, operator, MILESTONE_AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW);

        MilestoneEscrow.Payout[] memory payouts = new MilestoneEscrow.Payout[](3);
        payouts[0] = MilestoneEscrow.Payout({
            recipient: integrator,
            bps: 250,
            roleTag: RoleTags.INTEGRATOR,
            ipId: bytes32(uint256(0xCAFE))
        });
        payouts[1] = MilestoneEscrow.Payout({
            recipient: protocolAuthor,
            bps: 100,
            roleTag: RoleTags.PROTOCOL_AUTHOR,
            ipId: bytes32(uint256(0xBEEF))
        });
        payouts[2] = MilestoneEscrow.Payout({
            recipient: modelAuthor,
            bps: 200,
            roleTag: RoleTags.MODEL_AUTHOR,
            ipId: bytes32(uint256(0xF00D))
        });

        vm.prank(payer);
        escrow.setPayoutMap(0, payouts);
        assertTrue(escrow.payoutMapSet(0), "payout map registered");

        // ── (e) Fund + submitEvidence + submitAttestation + warp ─────────
        vm.startPrank(payer);
        usdc.approve(address(escrow), MILESTONE_AMOUNT);
        escrow.fund();
        vm.stopPrank();
        assertEq(uint8(escrow.getMilestone(0).status), 1, "milestone Funded");

        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("evidence-e2e-single"));
        assertEq(uint8(escrow.getMilestone(0).status), 3, "milestone Evidenced");

        IPCCOracle.Attestation memory att = _makeAttestation();
        vm.prank(verifierOracle);
        escrow.submitAttestation(0, att);
        assertEq(uint8(escrow.getMilestone(0).status), 4, "milestone Attested");

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        // ── Pre-release balance baseline ─────────────────────────────────
        assertEq(usdc.balanceOf(integrator), 0, "pre: integrator zero");
        assertEq(usdc.balanceOf(protocolAuthor), 0, "pre: protocolAuthor zero");
        assertEq(usdc.balanceOf(modelAuthor), 0, "pre: modelAuthor zero");
        assertEq(usdc.balanceOf(operator), 0, "pre: operator zero (no bond)");

        // ── (f) Release. Anyone can call. Verify per-recipient deltas. ───
        // Expect 3 SplitPayoutExecuted events in payout-map order (integrator
        // first, then protocolAuthor, then modelAuthor) plus a MilestoneReleased.
        vm.expectEmit(true, false, false, true);
        emit MilestoneEscrow.MilestoneReleased(0, operator, MILESTONE_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, integrator, RoleTags.INTEGRATOR, bytes32(uint256(0xCAFE)), address(usdc), 250_000_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, protocolAuthor, RoleTags.PROTOCOL_AUTHOR, bytes32(uint256(0xBEEF)), address(usdc), 100_000_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, modelAuthor, RoleTags.MODEL_AUTHOR, bytes32(uint256(0xF00D)), address(usdc), 200_000_000
        );

        escrow.release(0, att);

        // ── Post-release balance assertions ──────────────────────────────
        assertEq(usdc.balanceOf(integrator), 250_000_000, "integrator: 250 USDC");
        assertEq(usdc.balanceOf(protocolAuthor), 100_000_000, "protocolAuthor: 100 USDC");
        assertEq(usdc.balanceOf(modelAuthor), 200_000_000, "modelAuthor: 200 USDC");
        assertEq(usdc.balanceOf(operator), 9_450_000_000, "operator: 9450 USDC residual");

        // Status invariant
        assertEq(uint8(escrow.getMilestone(0).status), 5, "milestone Released");

        // Conservation: every wei accounted for
        uint256 total =
            usdc.balanceOf(integrator)
            + usdc.balanceOf(protocolAuthor)
            + usdc.balanceOf(modelAuthor)
            + usdc.balanceOf(operator);
        assertEq(total, MILESTONE_AMOUNT, "conservation: total out matches total in");

        // Escrow drained
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    // ──────────────────────────────────────────────────────────────────────
    // Test 2: multi-token end-to-end via USDT override.
    //
    // Same pipeline as Test 1 — but the milestone is created with
    // addMilestoneWithToken using a freshly-deployed MockUSDT (a Tether-style
    // token whose transfer/transferFrom return NO bool). We assert:
    //
    //   (1) The schedule-publish + NFT-mint flow is unchanged — those don't
    //       care about which stablecoin is used downstream.
    //   (2) The escrow accepts the USDT override after we allowlist USDT.
    //   (3) On release, every recipient receives USDT at the right amount,
    //       and NO USDC is touched.
    //   (4) The operator's USDC balance starts AND ends at zero (sanity:
    //       no cross-token contamination).
    //
    // Math identical to Test 1 — same payout map, same per-recipient bps.
    //
    // This is the regression test for the multi-stablecoin distribution
    // bug fixed in `14cce8e` (where the prior implementation hard-coded the
    // default token in _distributeWithMap, sending USDC to recipients even
    // when the milestone was a USDT milestone — silently broken).
    // ──────────────────────────────────────────────────────────────────────

    function test_e2e_multiToken_payoutsRouteToCorrectToken() public {
        // ── (i) Deploy + allowlist USDT, mint to payer. Default token in the
        // escrow remains USDC (set in setUp); USDT is added as an allowlisted
        // override.
        MockUSDT usdt = new MockUSDT(0);
        usdt.mint(payer, MILESTONE_AMOUNT);

        vm.prank(payer);
        escrow.allowStablecoin(
            address(usdt),
            /*attestor*/ address(0xA),
            /*reportUri*/ "ipfs://usdt-reserve",
            /*maxDeviationBps*/ 50
        );
        assertTrue(escrow.isStablecoinAllowed(address(usdt)), "USDT must be allowlisted");

        // ── (ii) Publish the SAME schedule as Test 1 to the registry. We can
        // re-publish the same bytes here because we deployed a fresh registry
        // in setUp() (this test doesn't share state with Test 1).
        bytes memory scheduleBytes = CanonicalBytes.constantOpenEnded(0, 250, 1);
        bytes32 scheduleHash = sha256(scheduleBytes);
        assertEq(scheduleHash, EXPECTED_SCHEDULE_HASH, "fixture hash invariant");

        vm.prank(integrator);
        registry.publish(scheduleBytes, scheduleHash);

        // ── (iii) Mint the ContributorNFT — same fields as Test 1. ──────
        nft.mint(
            integrator,
            RoleTags.INTEGRATOR,
            scheduleHash,
            bytes32(uint256(0xCAFE)),
            "ipfs://CID/integrator-meta"
        );

        // ── (iv) Add the milestone with USDT override + payout map. ──────
        vm.prank(payer);
        escrow.addMilestoneWithToken(
            stepId,
            operator,
            MILESTONE_AMOUNT,
            OPERATOR_BOND,
            CHALLENGE_WINDOW,
            address(usdt)
        );
        assertEq(escrow.tokenForMilestone(0), address(usdt), "milestone uses USDT");

        MilestoneEscrow.Payout[] memory payouts = new MilestoneEscrow.Payout[](3);
        payouts[0] = MilestoneEscrow.Payout({
            recipient: integrator,
            bps: 250,
            roleTag: RoleTags.INTEGRATOR,
            ipId: bytes32(uint256(0xCAFE))
        });
        payouts[1] = MilestoneEscrow.Payout({
            recipient: protocolAuthor,
            bps: 100,
            roleTag: RoleTags.PROTOCOL_AUTHOR,
            ipId: bytes32(uint256(0xBEEF))
        });
        payouts[2] = MilestoneEscrow.Payout({
            recipient: modelAuthor,
            bps: 200,
            roleTag: RoleTags.MODEL_AUTHOR,
            ipId: bytes32(uint256(0xF00D))
        });
        vm.prank(payer);
        escrow.setPayoutMap(0, payouts);

        // ── (v) Fund. Approve USDT for the per-token total. The escrow uses
        // SafeERC20 internally so USDT's no-return-bool transferFrom is fine.
        vm.startPrank(payer);
        usdt.approve(address(escrow), MILESTONE_AMOUNT);
        escrow.fund();
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(escrow)), MILESTONE_AMOUNT, "escrow holds USDT");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow holds NO USDC");

        // ── (vi) submitEvidence + submitAttestation + warp ──────────────
        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("evidence-e2e-multi"));
        IPCCOracle.Attestation memory att = _makeAttestation();
        vm.prank(verifierOracle);
        escrow.submitAttestation(0, att);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        // ── Pre-release: USDT recipients all zero, USDC unchanged from setUp
        assertEq(usdt.balanceOf(integrator), 0, "pre: integrator USDT zero");
        assertEq(usdt.balanceOf(protocolAuthor), 0, "pre: protocolAuthor USDT zero");
        assertEq(usdt.balanceOf(modelAuthor), 0, "pre: modelAuthor USDT zero");
        assertEq(usdt.balanceOf(operator), 0, "pre: operator USDT zero");
        // USDC was minted to payer in setUp (10_000 USDC). Still there.
        assertEq(usdc.balanceOf(payer), MILESTONE_AMOUNT, "pre: payer USDC untouched");

        // ── (vii) Expect SplitPayoutExecuted events tagged with USDT, not USDC
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, integrator, RoleTags.INTEGRATOR, bytes32(uint256(0xCAFE)), address(usdt), 250_000_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, protocolAuthor, RoleTags.PROTOCOL_AUTHOR, bytes32(uint256(0xBEEF)), address(usdt), 100_000_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, modelAuthor, RoleTags.MODEL_AUTHOR, bytes32(uint256(0xF00D)), address(usdt), 200_000_000
        );

        escrow.release(0, att);

        // ── (viii) Post-release: every recipient holds USDT, no USDC moved
        assertEq(usdt.balanceOf(integrator), 250_000_000, "integrator: 250 USDT");
        assertEq(usdt.balanceOf(protocolAuthor), 100_000_000, "protocolAuthor: 100 USDT");
        assertEq(usdt.balanceOf(modelAuthor), 200_000_000, "modelAuthor: 200 USDT");
        assertEq(usdt.balanceOf(operator), 9_450_000_000, "operator: 9450 USDT residual");

        // No USDC contamination — the regression assertion. If the escrow
        // had silently used USDC for the payouts (the bug fixed in 14cce8e),
        // these would all be non-zero in USDC.
        assertEq(usdc.balanceOf(integrator), 0, "no USDC to integrator");
        assertEq(usdc.balanceOf(protocolAuthor), 0, "no USDC to protocolAuthor");
        assertEq(usdc.balanceOf(modelAuthor), 0, "no USDC to modelAuthor");
        assertEq(usdc.balanceOf(operator), 0, "no USDC to operator");
        assertEq(usdc.balanceOf(payer), MILESTONE_AMOUNT, "payer USDC untouched");

        // Conservation in USDT
        uint256 total =
            usdt.balanceOf(integrator)
            + usdt.balanceOf(protocolAuthor)
            + usdt.balanceOf(modelAuthor)
            + usdt.balanceOf(operator);
        assertEq(total, MILESTONE_AMOUNT, "USDT conservation: total out matches total in");

        // Escrow drained for both tokens
        assertEq(usdt.balanceOf(address(escrow)), 0, "escrow drained USDT");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained USDC (was zero anyway)");

        assertEq(uint8(escrow.getMilestone(0).status), 5, "milestone Released");
    }
}
