// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";
import {IPCCOracle} from "../src/interfaces/IPCCOracle.sol";
import {MockPCCOracle} from "./mocks/MockPCCOracle.sol";

/**
 * @title MilestoneEscrowContributorEconomicsIntegrationTest
 * @notice End-to-end integration tests for the full contributor-economics
 *         splitPayout pipeline. Exercises realistic state transitions from
 *         milestone fund → evidence submission → attestation → challenge
 *         window → release with a real payout map → verify all N transfers
 *         emitted + balances exact + events correct.
 *
 *         Distinct from MilestoneEscrow.splitPayout.t.sol (which unit-tests
 *         each guard individually) — this file exercises the FULL flow with
 *         a protocol fee root in the loop, multiple recipients, and the
 *         TrainingManifest expansion path that buildPayoutMap() produces
 *         off-chain (Approach A — hand-built equivalent on-chain Payout[]).
 *
 *         Test cases:
 *           1. Basic 4-recipient end-to-end with protocol fee (verifier,
 *              integrator, protocol-author, model-author at 300/500/400/300
 *              bps), assert balances + events + no leak.
 *           2. TrainingManifest-expanded payout map: same flow, but the
 *              model-author single-entry expands into 3 dataset contributors
 *              via buildPayoutMap()'s recursive expansion. The on-chain
 *              Payout[] passed to setPayoutMap is the SAME shape that
 *              `buildPayoutMap` would have produced — see commit 3 (TS
 *              integration test) for the off-chain math proof.
 *           3. Dispute path bypasses payout map entirely — funds returned
 *              to payer, operator bond slashed, payout map never executed.
 */
contract MilestoneEscrowContributorEconomicsIntegrationTest is Test {
    // ── Contracts ───────────────────────────────────────────────────────
    MilestoneEscrow escrow;
    MockUSDC usdc;
    MockProtocolRoot protocolRootImpl;

    // ── Actors ──────────────────────────────────────────────────────────
    address payer = address(0x1);
    address operator = address(0x2);
    address arbiter = address(0x3);
    address challenger = address(0x4);
    address verifierOracle = address(0x5);
    address protocolFeeRecipient = address(0x999);

    // ── Payout recipients (Test 1 — 4-recipient cohort) ─────────────────
    address verifierRecipient = address(0x10);
    address integrator = address(0x11);
    address protocolAuthor = address(0x12);
    address modelAuthor = address(0x13);

    // ── Test 2 — TrainingManifest dataset contributors ──────────────────
    address dataset1Contributor = address(0x20);
    address dataset2Contributor = address(0x21);
    address dataset3Contributor = address(0x22);

    // ── Identifiers ─────────────────────────────────────────────────────
    bytes32 cwmId = keccak256("cwm-integration-001");
    bytes32 stepId1 = keccak256("step-integration-001");

    // ── Role tags (canonical keccak of role string) ─────────────────────
    bytes32 ROLE_VERIFIER = keccak256("verifier");
    bytes32 ROLE_INTEGRATOR = keccak256("integrator");
    bytes32 ROLE_PROTOCOL_AUTHOR = keccak256("protocol-author");
    bytes32 ROLE_MODEL_AUTHOR = keccak256("model-author");
    bytes32 ROLE_DATASET_CONTRIBUTOR = keccak256("dataset-contributor");

    // ── Story-style IP IDs (bytes32, distinct per role/dataset) ─────────
    bytes32 IP_VERIFIER = bytes32(uint256(0xAA01));
    bytes32 IP_INTEGRATOR = bytes32(uint256(0xAA02));
    bytes32 IP_PROTOCOL_AUTHOR = bytes32(uint256(0xAA03));
    bytes32 IP_MODEL_AUTHOR = bytes32(uint256(0xAA04));
    bytes32 IP_DATASET_1 = bytes32(uint256(0xBB01));
    bytes32 IP_DATASET_2 = bytes32(uint256(0xBB02));
    bytes32 IP_DATASET_3 = bytes32(uint256(0xBB03));

    // ── Constants for the integration scenarios ─────────────────────────
    /// @dev Protocol fee = 1.5% (PCCProtocol's 235 bps default differs from
    ///      the integration spec; we exercise 150 bps to make the math
    ///      slate-easy and to confirm the fee is read off the root rather
    ///      than hardcoded.)
    uint256 constant PROTOCOL_FEE_BPS = 150;
    uint256 constant MILESTONE_AMOUNT = 100_000_000; // 100 USDC, 6 decimals
    uint256 constant OPERATOR_BOND = 5_000_000;       // 5 USDC
    uint256 constant CHALLENGE_WINDOW = 3600;          // 1 hour

    MockPCCOracle mockOracle;

    /// @dev Build a stub attestation pinned to the test escrow. MockPCCOracle
    ///      accepts everything with verified=true and non-zero escrowAddress
    ///      so the oracle gate at submitAttestation passes. DETERMINISTIC so
    ///      submit+release rebuild the same struct (matches stored hash).
    function _makeAttestation() internal view returns (IPCCOracle.Attestation memory) {
        return IPCCOracle.Attestation({
            version: 1,
            escrowAddress: address(escrow),
            jobId: "job-integ",
            evidenceHash: keccak256("integ-evidence"),
            tier: 1,
            verified: true,
            timestamp: 1_700_000_000,
            nonce: keccak256(abi.encode("integ-nonce", address(escrow))),
            extraData: hex"",
            signature: hex""
        });
    }

    function setUp() public {
        usdc = new MockUSDC(0);
        mockOracle = new MockPCCOracle(address(0xABCD), true);
        protocolRootImpl = new MockProtocolRoot(protocolFeeRecipient, PROTOCOL_FEE_BPS, address(mockOracle));

        escrow = new MilestoneEscrow(
            payer,
            arbiter,
            address(usdc),
            cwmId,
            address(protocolRootImpl)
        );

        // Mint enough for payer (milestone amount) and operator (bond) and
        // challenger (dispute bond) — keep the math obvious. No background
        // balances on payout recipients so we can assert exact deltas.
        usdc.mint(payer, MILESTONE_AMOUNT);
        usdc.mint(operator, OPERATOR_BOND);
        usdc.mint(challenger, OPERATOR_BOND);

        // Authorize verifier oracle to attest. Operator cannot self-attest.
        vm.startPrank(arbiter);
        escrow.addVerifier(verifierOracle);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────────────────────────────
    // Test 1: Basic 4-recipient end-to-end happy path
    //
    // Cohort: verifier 300 bps, integrator 500 bps, protocol-author 400 bps,
    //         model-author 300 bps. Total cohort = 1500 bps (15%).
    // Operator residual = 8500 bps of distributable + bond returned in full.
    //
    // Math (PROTOCOL_FEE_BPS=150, amount=100_000_000):
    //   protocolFee     = 100_000_000 * 150 / 10000        =  1_500_000
    //   distributable   = 100_000_000 -  1_500_000         = 98_500_000
    //   verifier        = 98_500_000 * 300 / 10000         =  2_955_000
    //   integrator      = 98_500_000 * 500 / 10000         =  4_925_000
    //   protocol-author = 98_500_000 * 400 / 10000         =  3_940_000
    //   model-author    = 98_500_000 * 300 / 10000         =  2_955_000
    //   distributed     = 14_775_000
    //   operator gross  = 98_500_000 - 14_775_000          = 83_725_000
    //   operator total  = 83_725_000 + 5_000_000 (bond)    = 88_725_000
    //
    // Conservation check: protocol fee + distributed + operator gross =
    //                     1_500_000 + 14_775_000 + 83_725_000 = 100_000_000
    //                     (operator bond passes through orthogonally —
    //                     in then back out)
    // ──────────────────────────────────────────────────────────────────────

    function test_integration_fourRecipientEndToEnd() public {
        // ── Phase 1: payer adds milestone + sets payout map ──────────────
        vm.prank(payer);
        escrow.addMilestone(stepId1, operator, MILESTONE_AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW);

        MilestoneEscrow.Payout[] memory payouts = _fourRecipientPayoutMap();

        vm.prank(payer);
        escrow.setPayoutMap(0, payouts);
        assertTrue(escrow.payoutMapSet(0), "payout map should be registered");

        // ── Phase 2: payer funds escrow ──────────────────────────────────
        vm.startPrank(payer);
        usdc.approve(address(escrow), MILESTONE_AMOUNT);
        escrow.fund();
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(escrow)), MILESTONE_AMOUNT, "escrow holds milestone amount");
        assertEq(uint8(escrow.getMilestone(0).status), 1, "milestone Funded");

        // ── Phase 3: operator deposits bond ──────────────────────────────
        vm.startPrank(operator);
        usdc.approve(address(escrow), OPERATOR_BOND);
        escrow.depositBond(0);
        vm.stopPrank();

        assertEq(uint8(escrow.getMilestone(0).status), 2, "milestone Locked");
        assertEq(
            usdc.balanceOf(address(escrow)),
            MILESTONE_AMOUNT + OPERATOR_BOND,
            "escrow holds milestone + bond"
        );

        // ── Phase 4: operator submits evidence ───────────────────────────
        bytes32 evidenceHash = keccak256("evidence-bundle-integration-001");
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);
        assertEq(uint8(escrow.getMilestone(0).status), 3, "milestone Evidenced");

        // ── Phase 5: verifier oracle attests, opening challenge window ───
        IPCCOracle.Attestation memory att = _makeAttestation();
        vm.prank(verifierOracle);
        escrow.submitAttestation(0, att);
        assertEq(uint8(escrow.getMilestone(0).status), 4, "milestone Attested");

        // ── Phase 6: warp past challenge window, capture pre-balances ────
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        // All recipients (and operator beyond their post-bond-deposit balance)
        // must start at 0 deltas — no background USDC was minted to them.
        assertEq(usdc.balanceOf(verifierRecipient), 0, "pre: verifier zero");
        assertEq(usdc.balanceOf(integrator), 0, "pre: integrator zero");
        assertEq(usdc.balanceOf(protocolAuthor), 0, "pre: protocol-author zero");
        assertEq(usdc.balanceOf(modelAuthor), 0, "pre: model-author zero");
        assertEq(usdc.balanceOf(protocolFeeRecipient), 0, "pre: fee recipient zero");
        // Operator was minted bond, then deposited it. They should be at zero now.
        assertEq(usdc.balanceOf(operator), 0, "pre: operator zero (bond deposited)");

        // ── Phase 7: expect 4 SplitPayoutExecuted events in payout-map order
        //            then 1 MilestoneReleased. The release() loop emits the
        //            split events AFTER MilestoneReleased per the contract's
        //            CEI ordering (status mutation, MilestoneReleased emit,
        //            then _distributeWithMap loop). We assert all events
        //            fire with exact field values.
        //
        //            Order: integrator → model-author → verifier →
        //            protocol-author (i.e., the order in
        //            _fourRecipientPayoutMap), NOT the bps-allocation order
        //            given in the docstring.

        vm.expectEmit(true, false, false, true);
        emit MilestoneEscrow.MilestoneReleased(0, operator, MILESTONE_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, verifierRecipient, ROLE_VERIFIER, IP_VERIFIER, address(usdc), 2_955_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, integrator, ROLE_INTEGRATOR, IP_INTEGRATOR, address(usdc), 4_925_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, protocolAuthor, ROLE_PROTOCOL_AUTHOR, IP_PROTOCOL_AUTHOR, address(usdc), 3_940_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, modelAuthor, ROLE_MODEL_AUTHOR, IP_MODEL_AUTHOR, address(usdc), 2_955_000
        );

        // ── Phase 8: anyone calls release ────────────────────────────────
        escrow.release(0, att);

        // ── Assertions: each recipient has the expected exact balance ────
        assertEq(usdc.balanceOf(protocolFeeRecipient), 1_500_000, "fee recipient post");
        assertEq(usdc.balanceOf(verifierRecipient),    2_955_000, "verifier post");
        assertEq(usdc.balanceOf(integrator),           4_925_000, "integrator post");
        assertEq(usdc.balanceOf(protocolAuthor),       3_940_000, "protocol-author post");
        assertEq(usdc.balanceOf(modelAuthor),          2_955_000, "model-author post");
        assertEq(usdc.balanceOf(operator),            88_725_000, "operator post (residual + bond)");

        // ── Status invariants ────────────────────────────────────────────
        assertEq(uint8(escrow.getMilestone(0).status), 5, "milestone Released");

        // ── Conservation: every wei is accounted for, no leak ────────────
        // Sum across protocol fee + 4 cohort + operator
        // = 1_500_000 + 2_955_000 + 4_925_000 + 3_940_000 + 2_955_000 + 88_725_000
        // = 105_000_000  (= MILESTONE_AMOUNT + OPERATOR_BOND)
        uint256 distributedSum =
            usdc.balanceOf(protocolFeeRecipient)
            + usdc.balanceOf(verifierRecipient)
            + usdc.balanceOf(integrator)
            + usdc.balanceOf(protocolAuthor)
            + usdc.balanceOf(modelAuthor)
            + usdc.balanceOf(operator);
        assertEq(
            distributedSum,
            MILESTONE_AMOUNT + OPERATOR_BOND,
            "conservation: total out matches total in"
        );

        // Escrow contract holds nothing.
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");

        // Protocol root accounting hook fired with the exact protocol fee.
        assertEq(
            protocolRootImpl.feesCollected(address(usdc)),
            1_500_000,
            "protocol root accounting: fee recorded"
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    // ──────────────────────────────────────────────────────────────────────
    // Test 2: TrainingManifest-expanded payout map
    //
    // SAME flow as Test 1, BUT the model-author entry expands recursively
    // into 3 dataset contributors via the off-chain
    // LicensingEngine.getRoyaltyDistributionRich → buildPayoutMap pipeline.
    // The recursive expansion lives in TypeScript (see
    // packages/contracts/ts/licensing-engine.ts:expandTrainingManifest);
    // here we simulate APPROACH A — hand-build the equivalent on-chain
    // Payout[] that the off-chain pipeline WOULD have produced.
    //
    // Off-chain math (documented inline; cross-checked in Approach B's
    // TypeScript test):
    //
    //   model-author entry:  300 bps (would-have-been allocation)
    //   trainingManifest.datasets = [
    //     { datasetIpId: IP_DATASET_1, weightBps: 5000 },  // 50% mix
    //     { datasetIpId: IP_DATASET_2, weightBps: 3000 },  // 30% mix
    //     { datasetIpId: IP_DATASET_3, weightBps: 2000 },  // 20% mix
    //   ]
    //   weightBps sum = 10000 (TrainingManifest invariant)
    //
    //   Dataset bps from expandTrainingManifest:
    //     dsBps[i] = round(modelBps * weightBps[i] / 10000)
    //     d1: 300 * 5000 / 10000 = 150 bps
    //     d2: 300 * 3000 / 10000 =  90 bps
    //     d3: 300 * 2000 / 10000 =  60 bps
    //     sum = 300 — matches the model-author allocation EXACTLY
    //
    //   On-chain Payout[] passed to setPayoutMap (model-author REPLACED
    //   by the 3 dataset entries — orchestrator pre-flattens the tree):
    //
    //     [verifier=300, integrator=500, protocol-author=400,
    //      dataset-1=150, dataset-2=90, dataset-3=60]
    //
    //     totalBps = 1500 (same cohort allocation as Test 1)
    //
    // On-chain math (PROTOCOL_FEE_BPS=150, amount=100_000_000):
    //   protocolFee     = 1_500_000
    //   distributable   = 98_500_000
    //   verifier (300)  = 2_955_000
    //   integrator (500)= 4_925_000
    //   protocol-auth(400)=3_940_000
    //   dataset-1 (150) = 98_500_000 * 150 / 10000 = 1_477_500
    //   dataset-2  (90) = 98_500_000 *  90 / 10000 =   886_500
    //   dataset-3  (60) = 98_500_000 *  60 / 10000 =   591_000
    //   distributed     = 14_775_000
    //   operator gross  = 98_500_000 - 14_775_000  = 83_725_000
    //   operator total  = 83_725_000 + bond        = 88_725_000
    //
    // The model-author + dataset cohort sum is CONSERVED with Test 1:
    // expansion preserves the parent's bps allocation by construction.
    // ──────────────────────────────────────────────────────────────────────

    function test_integration_trainingManifestExpansion() public {
        // ── Phase 1: addMilestone + setPayoutMap with the expanded cohort
        vm.prank(payer);
        escrow.addMilestone(stepId1, operator, MILESTONE_AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW);

        MilestoneEscrow.Payout[] memory payouts = _expandedTrainingManifestPayoutMap();
        // Sanity: 6 entries total (verifier, integrator, protocol-author, 3 datasets)
        assertEq(payouts.length, 6, "expanded payout map: 6 entries");

        // Sanity: bps total identical to Test 1 (1500), so operator residual is conserved.
        uint256 totalBps;
        for (uint256 i = 0; i < payouts.length; i++) {
            totalBps += payouts[i].bps;
        }
        assertEq(totalBps, 1500, "expanded payout map: total bps preserved");

        vm.prank(payer);
        escrow.setPayoutMap(0, payouts);

        // ── Phase 2: fund + bond + evidence + attestation ────────────────
        vm.startPrank(payer);
        usdc.approve(address(escrow), MILESTONE_AMOUNT);
        escrow.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(escrow), OPERATOR_BOND);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("evidence-tm-001"));
        vm.stopPrank();

        IPCCOracle.Attestation memory att = _makeAttestation();
        vm.prank(verifierOracle);
        escrow.submitAttestation(0, att);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        // ── Phase 3: pre-balance baselines ───────────────────────────────
        // Datasets are fresh, no balance yet.
        assertEq(usdc.balanceOf(dataset1Contributor), 0, "pre: dataset-1 zero");
        assertEq(usdc.balanceOf(dataset2Contributor), 0, "pre: dataset-2 zero");
        assertEq(usdc.balanceOf(dataset3Contributor), 0, "pre: dataset-3 zero");
        // Model author is NOT in the expanded map (replaced by datasets).
        assertEq(usdc.balanceOf(modelAuthor), 0, "pre: model-author zero (excluded)");

        // ── Phase 4: expect events (MilestoneReleased + 6 SplitPayoutExecuted)
        vm.expectEmit(true, false, false, true);
        emit MilestoneEscrow.MilestoneReleased(0, operator, MILESTONE_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, verifierRecipient, ROLE_VERIFIER, IP_VERIFIER, address(usdc), 2_955_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, integrator, ROLE_INTEGRATOR, IP_INTEGRATOR, address(usdc), 4_925_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, protocolAuthor, ROLE_PROTOCOL_AUTHOR, IP_PROTOCOL_AUTHOR, address(usdc), 3_940_000
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, dataset1Contributor, ROLE_DATASET_CONTRIBUTOR, IP_DATASET_1, address(usdc), 1_477_500
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, dataset2Contributor, ROLE_DATASET_CONTRIBUTOR, IP_DATASET_2, address(usdc), 886_500
        );
        vm.expectEmit(true, true, true, true);
        emit MilestoneEscrow.SplitPayoutExecuted(
            0, dataset3Contributor, ROLE_DATASET_CONTRIBUTOR, IP_DATASET_3, address(usdc), 591_000
        );

        // ── Phase 5: release ─────────────────────────────────────────────
        escrow.release(0, att);

        // ── Assertions: each post-balance ────────────────────────────────
        assertEq(usdc.balanceOf(protocolFeeRecipient), 1_500_000, "fee recipient");
        assertEq(usdc.balanceOf(verifierRecipient),    2_955_000, "verifier");
        assertEq(usdc.balanceOf(integrator),           4_925_000, "integrator");
        assertEq(usdc.balanceOf(protocolAuthor),       3_940_000, "protocol-author");
        assertEq(usdc.balanceOf(dataset1Contributor),  1_477_500, "dataset-1");
        assertEq(usdc.balanceOf(dataset2Contributor),    886_500, "dataset-2");
        assertEq(usdc.balanceOf(dataset3Contributor),    591_000, "dataset-3");
        assertEq(usdc.balanceOf(operator),            88_725_000, "operator residual + bond");

        // ── Model author NEVER receives funds — they were replaced ───────
        assertEq(usdc.balanceOf(modelAuthor), 0, "post: model-author still zero");

        // ── Conservation across the expanded cohort ──────────────────────
        // Sum of 3 dataset payouts must equal what the model-author would
        // have received in Test 1 (2_955_000) — proves the expansion is
        // bps-conservative under integer truncation.
        uint256 datasetSum =
            usdc.balanceOf(dataset1Contributor)
            + usdc.balanceOf(dataset2Contributor)
            + usdc.balanceOf(dataset3Contributor);
        assertEq(
            datasetSum,
            2_955_000,
            "dataset sum equals model-author allocation from Test 1"
        );

        // Total conservation across the whole cohort
        uint256 totalOut =
            usdc.balanceOf(protocolFeeRecipient)
            + usdc.balanceOf(verifierRecipient)
            + usdc.balanceOf(integrator)
            + usdc.balanceOf(protocolAuthor)
            + datasetSum
            + usdc.balanceOf(operator);
        assertEq(
            totalOut,
            MILESTONE_AMOUNT + OPERATOR_BOND,
            "conservation: total out matches total in"
        );

        assertEq(uint8(escrow.getMilestone(0).status), 5, "milestone Released");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
        assertEq(
            protocolRootImpl.feesCollected(address(usdc)),
            1_500_000,
            "protocol root: fee recorded"
        );
    }

    // ──────────────────────────────────────────────────────────────────────
    // Test 3: dispute path bypasses the payout map
    //
    // Confirms that a payout map only takes effect on the happy path through
    // release(). When a milestone is disputed and the challenger wins:
    //
    //   - Funds are refunded to the payer (full milestone amount)
    //   - Operator's bond is slashed and routed to the challenger along
    //     with the challenger's own bond
    //   - The payout map is NEVER executed — recipients receive nothing
    //   - No SplitPayoutExecuted events are emitted
    //
    // This is the same behavior as the legacy dispute path
    // (MilestoneEscrowTest.test_dispute_challengerWins). The integration
    // adds: a payout map IS configured before disputeFile, but the
    // resolveDispute() codepath ignores it entirely (verified by reading
    // MilestoneEscrow.sol — `resolveDispute` never references
    // payoutMapSet or _payoutMap).
    //
    // Math (challenger wins):
    //   payer refund         = MILESTONE_AMOUNT     = 100_000_000
    //   challenger payout    = challengerBond + operatorBond
    //                        = 5_000_000 + 5_000_000 = 10_000_000
    //   operator final       = 0 (started with bond, deposited it, slashed)
    //   protocol fee         = 0 (no fee on dispute resolution)
    //   payout recipients    = 0 each (map ignored)
    // ──────────────────────────────────────────────────────────────────────

    function test_integration_disputeBypassesPayoutMap() public {
        uint256 challengerBond = OPERATOR_BOND;

        // ── Phase 1: addMilestone + setPayoutMap (4-recipient cohort) ────
        vm.prank(payer);
        escrow.addMilestone(stepId1, operator, MILESTONE_AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW);

        MilestoneEscrow.Payout[] memory payouts = _fourRecipientPayoutMap();
        vm.prank(payer);
        escrow.setPayoutMap(0, payouts);
        assertTrue(escrow.payoutMapSet(0), "payout map registered before dispute");

        // ── Phase 2: fund + bond + evidence + attestation ────────────────
        vm.startPrank(payer);
        usdc.approve(address(escrow), MILESTONE_AMOUNT);
        escrow.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(escrow), OPERATOR_BOND);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("evidence-dispute-001"));
        vm.stopPrank();

        vm.prank(verifierOracle);
        escrow.submitAttestation(0, _makeAttestation());
        assertEq(uint8(escrow.getMilestone(0).status), 4, "milestone Attested");

        // ── Phase 3: challenger files dispute INSIDE challenge window ────
        vm.startPrank(challenger);
        usdc.approve(address(escrow), challengerBond);
        escrow.fileDispute(
            0,
            challengerBond,
            keccak256("counter-evidence-dispute-001"),
            "Drift alert: print failed safety threshold"
        );
        vm.stopPrank();

        assertEq(uint8(escrow.getMilestone(0).status), 6, "milestone Disputed");
        // Escrow now holds milestone + operator bond + challenger bond.
        assertEq(
            usdc.balanceOf(address(escrow)),
            MILESTONE_AMOUNT + OPERATOR_BOND + challengerBond,
            "escrow holds milestone + both bonds"
        );

        // ── Phase 4: capture pre-balances; arbiter resolves (challenger wins)
        uint256 prePayer = usdc.balanceOf(payer);
        uint256 preChallenger = usdc.balanceOf(challenger);

        // Arm a recordLogs scope so we can confirm zero SplitPayoutExecuted
        // events fire during dispute resolution. The legacy events
        // (BondSlashed, DisputeResolved) are still expected and asserted via
        // direct event matchers.
        vm.recordLogs();

        vm.expectEmit(true, false, false, true);
        emit MilestoneEscrow.BondSlashed(0, operator, OPERATOR_BOND);
        vm.expectEmit(true, false, false, true);
        emit MilestoneEscrow.DisputeResolved(0, true);

        vm.prank(arbiter);
        escrow.resolveDispute(0, true);

        // ── Assertions: status + funds ───────────────────────────────────
        assertEq(uint8(escrow.getMilestone(0).status), 8, "milestone Slashed");

        // Payer refunded the full milestone amount.
        assertEq(
            usdc.balanceOf(payer) - prePayer,
            MILESTONE_AMOUNT,
            "payer refunded milestone"
        );

        // Challenger receives challenger bond + slashed operator bond.
        assertEq(
            usdc.balanceOf(challenger) - preChallenger,
            challengerBond + OPERATOR_BOND,
            "challenger receives both bonds"
        );

        // Operator received nothing (started with bond, deposited it, slashed).
        assertEq(usdc.balanceOf(operator), 0, "operator final zero (bond slashed)");

        // Payout map recipients receive ZERO — the map is bypassed.
        assertEq(usdc.balanceOf(verifierRecipient), 0, "verifier: no funds (map bypassed)");
        assertEq(usdc.balanceOf(integrator),        0, "integrator: no funds (map bypassed)");
        assertEq(usdc.balanceOf(protocolAuthor),    0, "protocol-author: no funds (map bypassed)");
        assertEq(usdc.balanceOf(modelAuthor),       0, "model-author: no funds (map bypassed)");

        // No protocol fee charged — disputes don't pass through release().
        assertEq(usdc.balanceOf(protocolFeeRecipient), 0, "protocol fee recipient zero");
        assertEq(
            protocolRootImpl.feesCollected(address(usdc)),
            0,
            "protocol root: no accounting fired during dispute"
        );

        // Escrow contract drained to zero.
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");

        // ── Confirm zero SplitPayoutExecuted events fired ────────────────
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 splitTopic = MilestoneEscrow.SplitPayoutExecuted.selector;
        uint256 splitCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == splitTopic) {
                splitCount++;
            }
        }
        assertEq(splitCount, 0, "no SplitPayoutExecuted during dispute resolution");

        // ── Conservation check ───────────────────────────────────────────
        // Sum of (payer refund + challenger payout) must equal the funds
        // that entered the escrow (milestone + operator bond + challenger bond).
        // Note: challenger's NET position is -challengerBond + (challengerBond + operatorBond) = +operatorBond
        // and payer's NET is +MILESTONE_AMOUNT (refund), starting from -MILESTONE_AMOUNT (funded).
        uint256 totalRefunded =
            (usdc.balanceOf(payer) - prePayer)
            + (usdc.balanceOf(challenger) - preChallenger);
        assertEq(
            totalRefunded,
            MILESTONE_AMOUNT + OPERATOR_BOND + challengerBond,
            "conservation: refund + challenger payout = escrow holdings"
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /// @dev Build the canonical 4-recipient payout map for Test 1.
    ///      Order: verifier, integrator, protocol-author, model-author.
    ///      Total bps: 1500 (15%).
    function _fourRecipientPayoutMap() internal view returns (MilestoneEscrow.Payout[] memory) {
        MilestoneEscrow.Payout[] memory p = new MilestoneEscrow.Payout[](4);
        p[0] = MilestoneEscrow.Payout({
            recipient: verifierRecipient,
            bps: 300,
            roleTag: ROLE_VERIFIER,
            ipId: IP_VERIFIER
        });
        p[1] = MilestoneEscrow.Payout({
            recipient: integrator,
            bps: 500,
            roleTag: ROLE_INTEGRATOR,
            ipId: IP_INTEGRATOR
        });
        p[2] = MilestoneEscrow.Payout({
            recipient: protocolAuthor,
            bps: 400,
            roleTag: ROLE_PROTOCOL_AUTHOR,
            ipId: IP_PROTOCOL_AUTHOR
        });
        p[3] = MilestoneEscrow.Payout({
            recipient: modelAuthor,
            bps: 300,
            roleTag: ROLE_MODEL_AUTHOR,
            ipId: IP_MODEL_AUTHOR
        });
        return p;
    }

    /// @dev Build the TrainingManifest-expanded payout map for Test 2.
    ///      Order: verifier, integrator, protocol-author, dataset-1,
    ///      dataset-2, dataset-3. Total bps: 1500 — identical to Test 1.
    ///      The model-author single-entry has been REPLACED by the three
    ///      dataset rows by the off-chain orchestrator
    ///      (LicensingEngine.getRoyaltyDistributionRich +
    ///      buildPayoutMap pre-flatten).
    function _expandedTrainingManifestPayoutMap()
        internal
        view
        returns (MilestoneEscrow.Payout[] memory)
    {
        MilestoneEscrow.Payout[] memory p = new MilestoneEscrow.Payout[](6);
        // Direct cohort (unchanged from Test 1)
        p[0] = MilestoneEscrow.Payout({
            recipient: verifierRecipient,
            bps: 300,
            roleTag: ROLE_VERIFIER,
            ipId: IP_VERIFIER
        });
        p[1] = MilestoneEscrow.Payout({
            recipient: integrator,
            bps: 500,
            roleTag: ROLE_INTEGRATOR,
            ipId: IP_INTEGRATOR
        });
        p[2] = MilestoneEscrow.Payout({
            recipient: protocolAuthor,
            bps: 400,
            roleTag: ROLE_PROTOCOL_AUTHOR,
            ipId: IP_PROTOCOL_AUTHOR
        });
        // Expanded model-author tree
        p[3] = MilestoneEscrow.Payout({
            recipient: dataset1Contributor,
            bps: 150, // = 300 * 5000 / 10000
            roleTag: ROLE_DATASET_CONTRIBUTOR,
            ipId: IP_DATASET_1
        });
        p[4] = MilestoneEscrow.Payout({
            recipient: dataset2Contributor,
            bps: 90, // = 300 * 3000 / 10000
            roleTag: ROLE_DATASET_CONTRIBUTOR,
            ipId: IP_DATASET_2
        });
        p[5] = MilestoneEscrow.Payout({
            recipient: dataset3Contributor,
            bps: 60, // = 300 * 2000 / 10000
            roleTag: ROLE_DATASET_CONTRIBUTOR,
            ipId: IP_DATASET_3
        });
        return p;
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Mock supporting contracts
// ──────────────────────────────────────────────────────────────────────────

/// @dev Minimal IPCCProtocol stub. Same shape as the one in
///      MilestoneEscrow.splitPayout.t.sol. Records the fee accounting
///      callback so we can assert on it from the integration test.
///      Post-v10: exposes oracleVerifier() and accepts the attestation
///      via collectFeeWithAttestation.
contract MockProtocolRoot {
    address public immutable feeRecipient;
    uint256 public immutable protocolFeeBps;
    address public immutable oracleVerifier;
    mapping(address => uint256) public feesCollected;

    constructor(address _feeRecipient, uint256 _protocolFeeBps, address _oracleVerifier) {
        feeRecipient = _feeRecipient;
        protocolFeeBps = _protocolFeeBps;
        oracleVerifier = _oracleVerifier;
    }

    function collectFeeWithAttestation(
        address tokenAddr,
        uint256 fee,
        IPCCOracle.Attestation calldata /* attestation */
    ) external {
        feesCollected[tokenAddr] += fee;
    }
}
