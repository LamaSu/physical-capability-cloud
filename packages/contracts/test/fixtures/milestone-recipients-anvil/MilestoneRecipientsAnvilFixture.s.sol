// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {MilestoneEscrowV2} from "../../../src/MilestoneEscrowV2.sol";
import {MilestoneEscrowV3} from "../../../src/MilestoneEscrowV3.sol";
import {MockUSDC} from "../../../src/MockUSDC.sol";
import {Clones} from "../../../src/libraries/Clones.sol";
import {MockEAS} from "../../mocks/MockEAS.sol";

/**
 * @title MilestoneRecipientsAnvilFixture
 * @notice TEST FIXTURE for `ts/__tests__/milestone-recipients.anvil.test.ts` (N102): deploys
 *         the REAL `MilestoneEscrowV2` and `MilestoneEscrowV3` (clone + initialize, exactly
 *         as `MilestoneEscrowV2.t.sol` / `MilestoneEscrowV3.t.sol` do) onto a LOCAL anvil
 *         chain, with a MockUSDC and a MockEAS, so the new TypeScript
 *         `readMilestoneRecipients` reader can be checked against the real contracts
 *         themselves — including the actual token-balance deltas `release()` produces.
 * @dev    Never a deployment: it refuses any chain but anvil's. protocolRoot is address(0)
 *         for both clones (standalone) — V2's "no root" fee path is already covered by the
 *         stub unit tests; this fixture's job is the split/truncation/release money-path,
 *         identically exercisable with or without a root. Logs the addresses + the fixed
 *         actor/schema constants the TS test mirrors exactly.
 */
contract MilestoneRecipientsAnvilFixture is Script {
    address internal constant PAYER = address(0x1111);
    address internal constant OPERATOR = address(0x2222);
    address internal constant ARBITER = address(0x3333);
    address internal constant ORACLE = address(0x6666);

    bytes32 internal constant SCHEMA_V2_UID = bytes32(uint256(0xAAAA));
    bytes32 internal constant SCHEMA_V3_UID = bytes32(uint256(0xBBBB));

    function run() external {
        require(block.chainid == 31337, "MilestoneRecipientsAnvilFixture: local anvil only");
        vm.startBroadcast();

        MockUSDC usdc = new MockUSDC(0);
        MockEAS eas = new MockEAS();

        address implV2 = address(new MilestoneEscrowV2(address(eas), SCHEMA_V2_UID, ORACLE));
        MilestoneEscrowV2 escrowV2 = MilestoneEscrowV2(Clones.clone(implV2));
        escrowV2.initialize(PAYER, ARBITER, address(usdc), keccak256("milestone-recipients-anvil-v2"), address(0));

        address implV3 = address(new MilestoneEscrowV3(address(eas), SCHEMA_V3_UID, ORACLE));
        MilestoneEscrowV3 escrowV3 = MilestoneEscrowV3(Clones.clone(implV3));
        escrowV3.initialize(PAYER, ARBITER, address(usdc), keccak256("milestone-recipients-anvil-v3"), address(0));

        vm.stopBroadcast();

        console2.log("TOKEN", address(usdc));
        console2.log("EAS", address(eas));
        console2.log("ESCROW_V2", address(escrowV2));
        console2.log("ESCROW_V3", address(escrowV3));
    }
}
