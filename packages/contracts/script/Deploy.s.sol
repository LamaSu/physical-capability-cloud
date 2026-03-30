// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";

/**
 * @title Deploy
 * @notice Deploys MockUSDC + a sample MilestoneEscrow to a live network (Base Sepolia).
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — deployer wallet private key
 *
 * Optional env vars:
 *   ARBITER_ADDRESS       — arbiter address (defaults to deployer)
 *
 * Usage:
 *   # Base Sepolia (via deploy.sh wrapper):
 *   ./script/deploy.sh
 *
 *   # Or directly:
 *   forge script script/Deploy.s.sol:DeployScript \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast --verify -vvvv
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address arbiter = vm.envOr("ARBITER_ADDRESS", deployer);

        console.log("Deployer:", deployer);
        console.log("Arbiter:", arbiter);

        vm.startBroadcast(deployerKey);

        // 1. Deploy MockUSDC (not needed on mainnet — use real USDC)
        MockUSDC usdc = new MockUSDC(1_000_000e6);
        console.log("MockUSDC deployed at:", address(usdc));

        // 2. Mint some tokens to deployer for testing
        usdc.mint(deployer, 100_000e6);
        console.log("Minted 100,000 mUSDC to deployer");

        // 3. Deploy a sample escrow (for demo — normally created per-workflow)
        bytes32 cwmId = keccak256("demo-workflow-001");
        // address(0) = standalone mode (no protocol fee). Use PCCProtocol.createEscrow() for production.
        MilestoneEscrow escrow = new MilestoneEscrow(deployer, arbiter, address(usdc), cwmId, address(0));
        console.log("MilestoneEscrow deployed at:", address(escrow));

        vm.stopBroadcast();

        // Output for chain-config.ts
        console.log("\n--- Add to chain-config.ts ---");
        console.log("mockUSDC:", address(usdc));
        console.log("sampleEscrow:", address(escrow));
    }
}
