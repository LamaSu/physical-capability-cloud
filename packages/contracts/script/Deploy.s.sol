// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";

/**
 * @title Deploy
 * @notice Deploys MockUSDC + a sample MilestoneEscrow instance.
 *
 * Usage:
 *   # Local (anvil must be running on 8545):
 *   forge script script/Deploy.s.sol --broadcast --rpc-url http://127.0.0.1:8545
 *
 *   # Base Sepolia:
 *   forge script script/Deploy.s.sol --broadcast --rpc-url https://sepolia.base.org \
 *     --private-key $DEPLOYER_PRIVATE_KEY --verify --etherscan-api-key $BASESCAN_API_KEY
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)); // anvil default
        address deployer = vm.addr(deployerKey);
        address arbiter = vm.envOr("ARBITER_ADDRESS", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy MockUSDC (not needed on mainnet — use real USDC)
        MockUSDC usdc = new MockUSDC(1_000_000e6);
        console.log("MockUSDC deployed at:", address(usdc));

        // 2. Mint some tokens to deployer for testing
        usdc.mint(deployer, 100_000e6);
        console.log("Minted 100,000 mUSDC to deployer");

        // 3. Deploy a sample escrow (for demo — normally created per-workflow)
        bytes32 cwmId = keccak256("demo-workflow-001");
        MilestoneEscrow escrow = new MilestoneEscrow(deployer, arbiter, address(usdc), cwmId);
        console.log("MilestoneEscrow deployed at:", address(escrow));

        vm.stopBroadcast();

        // Output for chain-config.ts
        console.log("\n--- Add to chain-config.ts ---");
        console.log("mockUSDC:", address(usdc));
        console.log("sampleEscrow:", address(escrow));
    }
}
