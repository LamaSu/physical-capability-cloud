// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";

/**
 * @title DeployLocalScript
 * @notice Deploys MockUSDC + MilestoneEscrow to a local Anvil instance.
 *         Uses Anvil's default account (no private key env var needed).
 *
 * Usage:
 *   # Start Anvil in another terminal:
 *   anvil
 *
 *   # Deploy:
 *   forge script script/DeployLocal.s.sol:DeployLocalScript \
 *     --rpc-url http://127.0.0.1:8545 \
 *     --broadcast -vvvv
 */
contract DeployLocalScript is Script {
    // Anvil default account #0
    uint256 constant ANVIL_DEFAULT_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        address deployer = vm.addr(ANVIL_DEFAULT_KEY);
        address arbiter = deployer; // deployer acts as arbiter locally

        console.log("Deployer (Anvil #0):", deployer);

        vm.startBroadcast(ANVIL_DEFAULT_KEY);

        // 1. Deploy MockUSDC with 1M initial supply
        MockUSDC usdc = new MockUSDC(1_000_000e6);
        console.log("MockUSDC deployed at:", address(usdc));

        // 2. Mint extra tokens for testing
        usdc.mint(deployer, 100_000e6);
        console.log("Minted 100,000 mUSDC to deployer");

        // 3. Deploy sample escrow
        bytes32 cwmId = keccak256("local-workflow-001");
        MilestoneEscrow escrow = new MilestoneEscrow(deployer, arbiter, address(usdc), cwmId);
        console.log("MilestoneEscrow deployed at:", address(escrow));

        vm.stopBroadcast();

        console.log("\n--- Local deployment complete ---");
        console.log("mockUSDC:", address(usdc));
        console.log("sampleEscrow:", address(escrow));
    }
}
