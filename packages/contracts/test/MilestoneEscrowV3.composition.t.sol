// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrowV3.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";

/**
 * @title MilestoneEscrowV3CompositionTest
 * @notice Composition-shaped settlement tests (Lane 2 DRAFT): ONE escrow per
 *         composition, ONE milestone per composed leg, each leg released
 *         independently on ITS OWN evidence (Mode B, oracle-attested).
 *
 * Shape per ai/research/industry-pain-points/lane2-escrow-shape-ADR.md
 * (Option A — owner sign-off pending). What these tests pin down:
 *
 *   1. Per-leg independent release — leg 0 settles (fee + operator payout)
 *      while legs 1..N stay untouched and still funded.
 *   2. C2b cross-leg confinement — an attestation carrying leg 0's stepId
 *      cannot release leg 1 ("stepId mismatch").
 *   3. Per-leg jobId binding — an attestation carrying leg 0's jobId cannot
 *      release leg 1 even with leg 1's stepId ("jobId mismatch"). The wire
 *      binds jobId = "{compositionId}:{stepIndex}" per leg.
 *   4. C1 UID single-use across legs — a UID consumed by leg 0 cannot be
 *      re-bound to leg 1 ("Attestation already used").
 *   5. Short-circuit refunds — executeComposition short-circuits on a failed
 *      step; the stranded (never-run) leg's funds return to the payer via
 *      reclaimAfterDeadline WITHOUT touching released or in-flight legs.
 *   6. Intra-leg splitPayout — a single leg MAY carry an ADR-11 Payout[] map
 *      (contributor attribution) and distributes correctly inside the
 *      composition escrow; other legs are unaffected.
 *
 * Style mirrors MilestoneEscrowV3.t.sol (MockEAS + clone deploy + 9-field
 * pcc.evidence.v2 tuple).
 *
 * Authored by: implementer-perleg-escrow (DRAFT — do not merge without the
 * ADR sign-off; this moves money).
 */
contract MilestoneEscrowV3CompositionTest is Test {
    // ── Actors ───────────────────────────────────────────────────────────────
    address internal payer        = address(0x1);
    address internal arbiter      = address(0x3);
    address internal oracle       = address(0x4);
    address internal feeRecipient = address(0xFEE);

    // Per-leg operators — the point of Option A: each leg pays ITS operator.
    address internal op0 = address(0xA0);
    address internal op1 = address(0xA1);
    address internal op2 = address(0xA2);

    // Intra-leg splitPayout recipients (test 6).
    address internal integrator = address(0xB0);
    address internal ipHolder   = address(0xB1);

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_V2_UID = bytes32(uint256(0xBEEF));
    bytes32 internal constant CWM_ID        = keccak256("pcc-comp-cmp-42");

    /// Composition id the legs bind to; per-leg jobId = "cmp-42:{stepIndex}".
    string internal constant COMPOSITION_ID = "cmp-42";

    uint256 internal constant AMOUNT_0 = 50e6;
    uint256 internal constant AMOUNT_1 = 30e6;
    uint256 internal constant AMOUNT_2 = 20e6;
    uint256 internal constant TOTAL    = 100e6;

    uint256 internal constant CHALLENGE_WINDOW = 3600;
    uint8   internal constant REQUIRED_TIER    = 1;
    uint16  internal constant FEE_BPS          = 500; // 5%

    // ── Contracts ────────────────────────────────────────────────────────────
    MilestoneEscrowV3 internal escrow;
    MockUSDC          internal usdc;
    MockEAS           internal mockEAS;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.warp(1_000_000);

        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        address impl = address(new MilestoneEscrowV3(address(mockEAS), SCHEMA_V2_UID, oracle));
        escrow = MilestoneEscrowV3(Clones.clone(impl));
        escrow.initialize(payer, arbiter, address(usdc), CWM_ID, address(0));

        usdc.mint(payer, 500_000e6);

        // One milestone per composed leg. operatorBond = 0 (the draft wire's
        // default) so submitEvidence is reachable straight from Funded.
        address[3] memory ops = [op0, op1, op2];
        uint256[3] memory amounts = [AMOUNT_0, AMOUNT_1, AMOUNT_2];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(payer);
            escrow.addMilestone(
                _legStepId(i),
                ops[i],
                amounts[i],
                0, // operatorBond
                CHALLENGE_WINDOW,
                REQUIRED_TIER,
                _legJobId(i)
            );
        }
        // NOTE: fund() is NOT called here — the splitPayout test must set the
        // map pre-fund. Every test calls _fund() (after any pre-fund config).
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /** Per-leg jobId — mirrors compose-settlement.ts legJobId(). */
    function _legJobId(uint256 stepIndex) internal pure returns (string memory) {
        return string.concat(COMPOSITION_ID, ":", vm.toString(stepIndex));
    }

    /** Per-leg bytes32 stepId — mirrors compose-settlement.ts legStepId(). */
    function _legStepId(uint256 stepIndex) internal pure returns (bytes32) {
        return keccak256(bytes(_legJobId(stepIndex)));
    }

    function _legEvidence(uint256 stepIndex) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("evidence-leg-", stepIndex));
    }

    /** Approve + fund the whole composition (payer). */
    function _fund() internal {
        vm.startPrank(payer);
        usdc.approve(address(escrow), TOTAL);
        escrow.fund();
        vm.stopPrank();
    }

    /**
     * Build + register an attestation with EXPLICIT jobId/stepId/evidence so
     * cross-leg mismatch cases can be constructed. Valid-provenance defaults:
     * right schema, right oracle, recipient = this escrow.
     */
    function _attestationWith(
        bytes32 uid,
        string memory jobId,
        bytes32 stepId,
        bytes32 evidenceHash,
        uint16 feeBps,
        address feeRecipient_
    ) internal {
        bytes memory data = abi.encode(
            jobId,
            keccak256("kernel-001"),
            evidenceHash,
            "",
            REQUIRED_TIER,
            true,
            stepId,
            feeBps,
            feeRecipient_
        );
        mockEAS.setAttestation(
            uid,
            EASAttestation({
                uid:            uid,
                schema:         SCHEMA_V2_UID,
                time:           uint64(block.timestamp),
                expirationTime: 0,
                revocationTime: 0,
                refUID:         bytes32(0),
                recipient:      address(escrow),
                attester:       oracle,
                revocable:      true,
                data:           data
            })
        );
    }

    /** Fully-correct attestation for a leg. */
    function _legAttestation(bytes32 uid, uint256 stepIndex) internal {
        _attestationWith(
            uid,
            _legJobId(stepIndex),
            _legStepId(stepIndex),
            _legEvidence(stepIndex),
            FEE_BPS,
            feeRecipient
        );
    }

    /** Drive one leg: operator submits evidence, oracle attestation binds. */
    function _evidenceAndAttest(uint256 legIndex, address operator, bytes32 uid) internal {
        vm.prank(operator);
        escrow.submitEvidence(legIndex, _legEvidence(legIndex));
        _legAttestation(uid, legIndex);
        escrow.submitAttestation(legIndex, uid);
    }

    // ── 1. Per-leg independent release ──────────────────────────────────────

    function test_composition_perLegIndependentRelease() public {
        _fund();

        bytes32 uid0 = keccak256("uid-leg-0");
        _evidenceAndAttest(0, op0, uid0);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        escrow.release(0);

        // Leg 0 settled: 5% fee to the attested recipient, rest to op0.
        uint256 fee = (AMOUNT_0 * FEE_BPS) / 10000; // 2.5e6
        assertEq(usdc.balanceOf(op0), AMOUNT_0 - fee, "op0 payout");
        assertEq(usdc.balanceOf(feeRecipient), fee, "leg-0 fee");

        // Legs 1 + 2 untouched: still Funded, operators unpaid, escrow still
        // holds exactly their combined amounts.
        assertEq(uint8(escrow.getMilestone(0).status), uint8(MilestoneEscrowV3.MilestoneStatus.Released));
        assertEq(uint8(escrow.getMilestone(1).status), uint8(MilestoneEscrowV3.MilestoneStatus.Funded));
        assertEq(uint8(escrow.getMilestone(2).status), uint8(MilestoneEscrowV3.MilestoneStatus.Funded));
        assertEq(usdc.balanceOf(op1), 0, "op1 must not be paid by leg-0 release");
        assertEq(usdc.balanceOf(op2), 0, "op2 must not be paid by leg-0 release");
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT_1 + AMOUNT_2, "remaining legs stay escrowed");
    }

    // ── 2. C2b: cross-leg stepId confinement ────────────────────────────────

    function test_composition_revert_crossLegAttestation_C2b() public {
        _fund();

        // Leg 1's operator submits leg 1's evidence…
        vm.prank(op1);
        escrow.submitEvidence(1, _legEvidence(1));

        // …but the attestation carries LEG 0's stepId (jobId + evidence match
        // leg 1, so stepId is the discriminating check).
        bytes32 uid = keccak256("uid-cross-stepid");
        _attestationWith(uid, _legJobId(1), _legStepId(0), _legEvidence(1), FEE_BPS, feeRecipient);

        vm.expectRevert(bytes("stepId mismatch"));
        escrow.submitAttestation(1, uid);
    }

    // ── 3. Per-leg jobId binding ─────────────────────────────────────────────

    function test_composition_revert_crossLegJobId() public {
        _fund();

        vm.prank(op1);
        escrow.submitEvidence(1, _legEvidence(1));

        // stepId + evidence match leg 1, but the jobId is leg 0's — the
        // per-leg jobId binding must reject it.
        bytes32 uid = keccak256("uid-cross-jobid");
        _attestationWith(uid, _legJobId(0), _legStepId(1), _legEvidence(1), FEE_BPS, feeRecipient);

        vm.expectRevert(bytes("jobId mismatch"));
        escrow.submitAttestation(1, uid);
    }

    // ── 4. C1: UID single-use across legs ────────────────────────────────────

    function test_composition_revert_uidReplayAcrossLegs_C1() public {
        _fund();

        // Leg 0 consumes uid0 (bound at submitAttestation).
        bytes32 uid0 = keccak256("uid-replay");
        _evidenceAndAttest(0, op0, uid0);

        // Leg 1 evidences, and a FULLY VALID leg-1 attestation is registered
        // under the SAME uid — C1 must reject the re-bind regardless.
        vm.prank(op1);
        escrow.submitEvidence(1, _legEvidence(1));
        _attestationWith(uid0, _legJobId(1), _legStepId(1), _legEvidence(1), FEE_BPS, feeRecipient);

        vm.expectRevert(bytes("Attestation already used"));
        escrow.submitAttestation(1, uid0);
    }

    // ── 5. Short-circuit: stranded leg reclaims, settled legs unaffected ────

    function test_composition_shortCircuit_reclaimStrandedLeg() public {
        _fund();
        uint256 payerAfterFund = usdc.balanceOf(payer);

        // Leg 0 completes + releases normally.
        bytes32 uid0 = keccak256("uid-sc-0");
        _evidenceAndAttest(0, op0, uid0);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        escrow.release(0);

        // Leg 1 failed mid-DAG → executeComposition short-circuited → leg 2
        // NEVER ran (still Funded, no evidence). After the reclaim deadline,
        // the payer claws back leg 2 ONLY.
        vm.warp(block.timestamp + escrow.DEFAULT_RECLAIM_DEADLINE() + 1);
        vm.prank(payer);
        escrow.reclaimAfterDeadline(2);

        assertEq(usdc.balanceOf(payer), payerAfterFund + AMOUNT_2, "payer refunded stranded leg only");
        assertEq(uint8(escrow.getMilestone(2).status), uint8(MilestoneEscrowV3.MilestoneStatus.Refunded));

        // Released leg unaffected; leg 1 still reclaimable/disputable later.
        assertEq(uint8(escrow.getMilestone(0).status), uint8(MilestoneEscrowV3.MilestoneStatus.Released));
        uint256 fee = (AMOUNT_0 * FEE_BPS) / 10000;
        assertEq(usdc.balanceOf(op0), AMOUNT_0 - fee, "op0 payout survives reclaim");
        assertEq(uint8(escrow.getMilestone(1).status), uint8(MilestoneEscrowV3.MilestoneStatus.Funded));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT_1, "only leg 1 remains escrowed");
    }

    // ── 6. Intra-leg splitPayout composes with per-leg milestones ───────────

    function test_composition_splitPayout_intraLegAttribution() public {
        // ADR-11 map on leg 1 ONLY, set pre-fund: integrator 20%, IP holder
        // 10% of the post-fee distributable; operator keeps the residual.
        MilestoneEscrowV3.Payout[] memory payouts = new MilestoneEscrowV3.Payout[](2);
        payouts[0] = MilestoneEscrowV3.Payout({
            recipient: integrator,
            bps: 2000,
            roleTag: keccak256("integrator"),
            ipId: bytes32(0)
        });
        payouts[1] = MilestoneEscrowV3.Payout({
            recipient: ipHolder,
            bps: 1000,
            roleTag: keccak256("ip-holder"),
            ipId: keccak256("story-ip-asset-1")
        });
        vm.prank(payer);
        escrow.setPayoutMap(1, payouts);

        _fund();

        bytes32 uid1 = keccak256("uid-split-1");
        _evidenceAndAttest(1, op1, uid1);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        escrow.release(1);

        // amount 30e6 → fee 5% = 1.5e6 → distributable 28.5e6
        //   integrator 20% = 5.7e6, ipHolder 10% = 2.85e6, op1 residual 19.95e6.
        uint256 fee = (AMOUNT_1 * FEE_BPS) / 10000;
        uint256 distributable = AMOUNT_1 - fee;
        uint256 integratorShare = (distributable * 2000) / 10000;
        uint256 ipShare = (distributable * 1000) / 10000;

        assertEq(usdc.balanceOf(feeRecipient), fee, "leg-1 fee");
        assertEq(usdc.balanceOf(integrator), integratorShare, "integrator share");
        assertEq(usdc.balanceOf(ipHolder), ipShare, "ip-holder share");
        assertEq(
            usdc.balanceOf(op1),
            distributable - integratorShare - ipShare,
            "op1 residual"
        );

        // Other legs untouched by the split leg's release.
        assertEq(uint8(escrow.getMilestone(0).status), uint8(MilestoneEscrowV3.MilestoneStatus.Funded));
        assertEq(uint8(escrow.getMilestone(2).status), uint8(MilestoneEscrowV3.MilestoneStatus.Funded));
        assertEq(usdc.balanceOf(address(escrow)), AMOUNT_0 + AMOUNT_2, "unreleased legs stay escrowed");
    }
}
