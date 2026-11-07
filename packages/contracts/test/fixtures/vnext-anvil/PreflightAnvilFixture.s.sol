// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {VNextSettlementEscrowFactory} from "../../../src/VNextSettlementEscrowFactory.sol";
import {MockUSDC} from "../../../src/MockUSDC.sol";
import {MockOracleAttester} from "../../VNextSettlementEscrow.t.sol";

/**
 * @title PreflightAnvilFixture
 * @notice TEST FIXTURE for `ts/__tests__/vnext-preflight.anvil.test.ts`: deploys the REAL V-next factory (which deploys
 *         the real implementation and links the real library) onto a LOCAL anvil chain, with mock attesters and
 *         MockUSDC, so the TypeScript funding preflight can be checked against the contracts themselves.
 * @dev    Never a deployment: it refuses any chain but anvil's. It logs the addresses the test reads back.
 */
contract PreflightAnvilFixture is Script {
    function run() external {
        require(block.chainid == 31337, "PreflightAnvilFixture: local anvil only");
        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC(0);
        MockOracleAttester oracle = new MockOracleAttester(1);
        MockOracleAttester escalation = new MockOracleAttester(77);
        VNextSettlementEscrowFactory f = new VNextSettlementEscrowFactory(
            address(usdc), address(oracle), address(escalation), keccak256("test.o5.schema"), bytes32(0)
        );
        vm.stopBroadcast();
        console2.log("FACTORY", address(f));
        console2.log("IMPL", f.implementation());
        console2.log("TOKEN", address(usdc));
        console2.log("ORACLE", address(oracle));
    }
}
