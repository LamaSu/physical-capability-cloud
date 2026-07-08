// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/MilestoneEscrowV2.sol";
import "../src/MockUSDC.sol";
import {IEAS, EASAttestation} from "../src/interfaces/IEAS.sol";
import {MockEAS} from "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";

/**
 * @title SettlementKeeperForkFixture
 * @notice DEPLOYABLE fixture for the settlement-keeper live-chain fork test
 *         (Settlement pivot Step 2). Deployed once via viem to a local anvil; the
 *         REAL gateway TypeScript crank (`driveSettlement`) + keeper then drive the
 *         resulting escrow. This is the empirical proof that the crank — until now
 *         only unit-verified against a MOCKED escrow — works against a real
 *         MilestoneEscrowV2 deploy.
 *
 * Why Solidity does the setup: the clone (EIP-1167 `Clones.clone`) and the EAS
 * attestation payload encoding are painful from viem but trivial here. The fixture
 * (as msg.sender) is BOTH payer and operator, so it can `addMilestone` (onlyPayer),
 * `fund` (onlyPayer), and `submitEvidence` (operator). The gateway signer (an
 * external anvil key) then calls the permissionless `submitAttestation` + `release`
 * via the TS crank — exactly the production split.
 *
 * Two shapes, chosen by `disputeIt`:
 *   - false → left at Evidenced with the attestation UID registered. The TS crank
 *             attests it, and the TS keeper releases it past the challenge window.
 *   - true  → driven all the way to Disputed. The TS keeper must report it
 *             terminal_other (settled=false) and NOT release it.
 *
 * Deploy/attestation pattern mirrors EscrowDedupInvariant.t.sol (Step 0's fork test).
 *
 * AGENT_NAME: keeper-opus
 */
contract SettlementKeeperForkFixture {
    // ── Deployed pieces (public getters for the TS test) ─────────────────────
    MilestoneEscrowV2 public escrow;
    MockUSDC public usdc;
    MockEAS public eas;
    bytes32 public uid;
    bytes32 public stepId;
    address public oracle;

    // ── Constants (mirror the dedup fork test's fixture) ─────────────────────
    bytes32 internal constant SCHEMA_UID = bytes32(uint256(0xDEAD));
    bytes32 internal constant CWM_ID = keccak256("cwm-keeper-fork-001");
    string internal constant JOB_ID = "job-keeper-fork-001";
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence-bundle-keeper-fork-001");
    bytes32 internal constant KERNEL_ID = keccak256("kernel-keeper-fork-001");
    uint8 internal constant REQUIRED_TIER = 0;

    /**
     * @param amount          milestone payment (6-dec USDC units).
     * @param challengeWindow challenge-window seconds (nonzero → the crank attests
     *                        and stops at the open window; the keeper releases after
     *                        the test advances chain time past it).
     * @param oracle_         authorized oracle address baked into the escrow's
     *                        immutable `authorizedOracle`; the registered attestation
     *                        is signed by it.
     * @param disputeIt       when true, drive the milestone to Disputed.
     */
    constructor(uint256 amount, uint256 challengeWindow, address oracle_, bool disputeIt) {
        oracle = oracle_;
        stepId = keccak256("step-keeper-fork-001");

        usdc = new MockUSDC(1_000_000e6);
        eas = new MockEAS();

        // Clone pattern: the impl constructor calls `_disableInitializers`, so only
        // a fresh clone (zeroed storage) can be initialize()'d.
        MilestoneEscrowV2 impl = new MilestoneEscrowV2(address(eas), SCHEMA_UID, oracle_);
        escrow = MilestoneEscrowV2(Clones.clone(address(impl)));
        // This fixture is payer AND arbiter AND operator; protocolRoot = address(0)
        // (standalone mode → no protocol fee, so release pays the full amount).
        escrow.initialize(address(this), address(this), address(usdc), CWM_ID, address(0));

        // Fund the milestone: bond 0 so `release` pays exactly `amount` (no bond wash).
        escrow.addMilestone(stepId, address(this), amount, 0, challengeWindow, REQUIRED_TIER, JOB_ID);
        usdc.approve(address(escrow), amount);
        escrow.fund();

        // Evidence submitted by the operator (this fixture) → status Evidenced.
        escrow.submitEvidence(0, EVIDENCE_HASH);

        // Register the oracle-signed EAS attestation the escrow will validate on
        // submitAttestation (recipient == escrow, attester == oracle, matching payload).
        uid = keccak256("keeper-fork-uid-001");
        bytes memory data = eas.encodeData(JOB_ID, KERNEL_ID, EVIDENCE_HASH, "", REQUIRED_TIER, true, stepId);
        eas.setAttestation(
            uid,
            EASAttestation({
                uid: uid,
                schema: SCHEMA_UID,
                time: uint64(block.timestamp),
                expirationTime: 0,
                revocationTime: 0,
                refUID: bytes32(0),
                recipient: address(escrow),
                attester: oracle_,
                revocable: true,
                data: data
            })
        );

        if (disputeIt) {
            // Drive to Disputed: attest (opens the window), then file a dispute
            // inside the window. The keeper must never release a Disputed milestone.
            escrow.submitAttestation(0, uid);
            uint256 bond = 1e6;
            usdc.approve(address(escrow), bond);
            escrow.fileDispute(0, bond, keccak256("challenger-evidence"), "fork-test dispute");
        }
    }
}
