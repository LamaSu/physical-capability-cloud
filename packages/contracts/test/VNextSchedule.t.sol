// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";
import {DeployVNextSettlement} from "../script/DeployVNextSettlement.s.sol";
import {SCHEDULE_IS_TESTNET, SCHEDULE_ID, SCHEDULE_WORK_MARGIN} from "vnext-schedule/VNextSchedule.sol";

/// @dev Exposes the production deploy guard without reading deployment inputs or broadcasting.
contract VNextScheduleDeployHarness is DeployVNextSettlement {
    function assertScheduleChain() external view {
        _assertScheduleChain();
    }
}

contract VNextScheduleTest is Test {
    string internal constant TESTNET_CHAIN_GUARD = "testnet schedule is restricted to Base Sepolia or anvil";

    VNextScheduleDeployHarness internal deploy;

    function setUp() public {
        deploy = new VNextScheduleDeployHarness();
    }

    /// @notice Pins the constants the settlement money path actually uses, for the requested build.
    /// @dev The default expectation deliberately stays mainnet even when FOUNDRY_PROFILE=testnet. The
    ///      testnet invocation must opt in with VNEXT_EXPECT_SCHEDULE=testnet, making both mismatches
    ///      usable as negative controls against a remapping that silently selected the wrong schedule.
    function test_ScheduleMatchesExpectedBuild() public {
        string memory expected = vm.envOr("VNEXT_EXPECT_SCHEDULE", string("mainnet"));
        bytes32 expectedHash = keccak256(bytes(expected));
        if (expectedHash == keccak256("mainnet")) {
            assertEq(VNextSettlementLib.CHALLENGE_WINDOW, 2 days, "mainnet challenge window");
            assertEq(VNextSettlementLib.APPEAL_WINDOW, 5 days, "mainnet appeal window");
            assertEq(VNextSettlementLib.BACKUP_WINDOW, 2 days, "mainnet backup window");
            assertEq(VNextSettlementLib.EMERGENCY_REVIEW_WINDOW, 5 days, "mainnet emergency review window");
            assertEq(VNextSettlementLib.MIN_RECLAIM_DELAY, 10 days, "mainnet minimum reclaim delay");
            assertFalse(SCHEDULE_IS_TESTNET, "mainnet schedule marker");
            assertEq(SCHEDULE_ID, bytes32("vnext-mainnet-v1"), "mainnet schedule identity");
        } else if (expectedHash == keccak256("testnet")) {
            assertEq(VNextSettlementLib.CHALLENGE_WINDOW, 600, "testnet challenge window");
            // Mainnet's 2:5 ordering is retained; reclaim includes the unchanged 30-minute work margin.
            assertEq(VNextSettlementLib.APPEAL_WINDOW, 1500, "testnet appeal window");
            assertEq(VNextSettlementLib.BACKUP_WINDOW, 600, "testnet backup window");
            assertEq(VNextSettlementLib.EMERGENCY_REVIEW_WINDOW, 1500, "testnet emergency review window");
            assertEq(VNextSettlementLib.MIN_RECLAIM_DELAY, 4500, "testnet minimum reclaim delay");
            assertTrue(SCHEDULE_IS_TESTNET, "testnet schedule marker");
            assertEq(SCHEDULE_ID, bytes32("vnext-testnet-short-v1"), "testnet schedule identity");
        } else {
            fail("VNEXT_EXPECT_SCHEDULE must be mainnet or testnet");
        }
        assertEq(VNextSettlementLib.MAX_RECLAIM_DELAY, 365 days, "maximum reclaim delay remains one year");
    }

    function test_Schedule_WorkMarginIsPositive() public pure {
        assertGt(SCHEDULE_WORK_MARGIN, 0, "work margin must be positive");
    }

    function test_Schedule_ChallengeDoesNotExceedAppeal() public pure {
        assertLe(VNextSettlementLib.CHALLENGE_WINDOW, VNextSettlementLib.APPEAL_WINDOW, "challenge <= appeal");
    }

    function test_Schedule_ChallengePrecedesEmergencyReview() public pure {
        assertLt(
            VNextSettlementLib.CHALLENGE_WINDOW, VNextSettlementLib.EMERGENCY_REVIEW_WINDOW, "challenge < emergency"
        );
    }

    function test_Schedule_ReclaimFloorIncludesMarginAndWindows() public pure {
        assertEq(
            VNextSettlementLib.MIN_RECLAIM_DELAY,
            SCHEDULE_WORK_MARGIN + VNextSettlementLib.CHALLENGE_WINDOW + VNextSettlementLib.APPEAL_WINDOW
                + VNextSettlementLib.BACKUP_WINDOW,
            "minimum reclaim delay = margin + challenge + appeal + backup"
        );
    }

    function test_Schedule_ReclaimFloorDoesNotExceedCeiling() public pure {
        assertLe(VNextSettlementLib.MIN_RECLAIM_DELAY, VNextSettlementLib.MAX_RECLAIM_DELAY, "minimum <= maximum");
    }

    function test_DeployGuard_BaseMainnet() public {
        vm.chainId(8453);
        if (SCHEDULE_IS_TESTNET) vm.expectRevert(bytes(TESTNET_CHAIN_GUARD));
        deploy.assertScheduleChain();
    }

    function test_DeployGuard_BaseSepolia() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(84532);
        deploy.assertScheduleChain();
    }

    function test_DeployGuard_Anvil() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(31337);
        deploy.assertScheduleChain();
    }

    function test_DeployGuard_OtherChain() public {
        vm.chainId(1);
        if (SCHEDULE_IS_TESTNET) vm.expectRevert(bytes(TESTNET_CHAIN_GUARD));
        deploy.assertScheduleChain();
    }

    /// @dev Checks the real canonical entrypoint, before its deployment env reads or any broadcast.
    function test_DeployGuard_RunAbortsBeforeDeploymentInputs() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(8453);
        vm.expectRevert(bytes(TESTNET_CHAIN_GUARD));
        deploy.run();
    }

    /// @dev Checks the real provisional entrypoint before it can deploy its throwaway token.
    function test_DeployGuard_ProvisionalAbortsBeforeDeploymentInputs() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(1);
        vm.expectRevert(bytes(TESTNET_CHAIN_GUARD));
        deploy.provisional();
    }

    function test_DeployGuard_PredictAbortsBeforeDeploymentInputs() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(8453);
        vm.expectRevert(bytes(TESTNET_CHAIN_GUARD));
        deploy.predict();
    }

    function test_DeployGuard_VerifyAbortsBeforeFactoryRead() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(8453);
        vm.expectRevert(bytes(TESTNET_CHAIN_GUARD));
        deploy.verify(address(0));
    }

    // As with the run/provisional abort tests, prediction tests run with deployment inputs absent.
    // Reaching the first input read proves that these chains passed the production entrypoint guard.
    function test_DeployGuard_PredictBaseSepoliaPassesGuard() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(84532);
        vm.expectRevert(bytes('vm.envAddress: environment variable "VNEXT_EAS" not found'));
        deploy.predict();
    }

    function test_DeployGuard_PredictAnvilPassesGuard() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(31337);
        vm.expectRevert(bytes('vm.envAddress: environment variable "VNEXT_EAS" not found'));
        deploy.predict();
    }

    function test_DeployGuard_VerifyBaseSepoliaPassesGuard() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(84532);
        vm.expectRevert(bytes("verify: no code at the factory address"));
        deploy.verify(address(0));
    }

    function test_DeployGuard_VerifyAnvilPassesGuard() public {
        vm.skip(!SCHEDULE_IS_TESTNET, "testnet profile only");
        vm.chainId(31337);
        vm.expectRevert(bytes("verify: no code at the factory address"));
        deploy.verify(address(0));
    }
}
