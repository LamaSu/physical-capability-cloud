// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PLRBackendRegistry.sol";

/**
 * @title  DeployPLRBackendRegistry
 * @notice Deploys PLRBackendRegistry to Base mainnet (Q2 validated) or
 *         Base Sepolia for staging. Caller passes pre-deployed addresses
 *         of ContributorNFT, RateScheduleRegistry, and the governance
 *         multisig as env vars.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY       deployer wallet key
 *   CONTRIBUTOR_NFT_ADDRESS    deployed ContributorNFT address
 *   SCHEDULE_REGISTRY_ADDRESS  deployed RateScheduleRegistry address
 *
 * Optional env vars:
 *   GOVERNANCE_MULTISIG_ADDRESS  governance multisig (default 0x0 = no
 *                                recovery path). Phase 1 is the hook;
 *                                multisig deployment + attestation flow
 *                                live in PLR_BACKEND_AUTHORS.md.
 *
 * Usage:
 *   # Base Sepolia (staging):
 *   forge script script/DeployPLRBackendRegistry.s.sol:DeployPLRBackendRegistry \
 *     --rpc-url https://sepolia.base.org --broadcast --verify -vvvv
 *
 *   # Base mainnet (production — Q2 validated):
 *   forge script script/DeployPLRBackendRegistry.s.sol:DeployPLRBackendRegistry \
 *     --rpc-url https://mainnet.base.org --broadcast --verify -vvvv
 */
contract DeployPLRBackendRegistry is Script {
    function run() external returns (PLRBackendRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address contributorNFT = vm.envAddress("CONTRIBUTOR_NFT_ADDRESS");
        address scheduleRegistry = vm.envAddress("SCHEDULE_REGISTRY_ADDRESS");
        address governanceMultisig = vm.envOr(
            "GOVERNANCE_MULTISIG_ADDRESS",
            address(0)
        );

        console.log("Deployer:", deployer);
        console.log("ContributorNFT:", contributorNFT);
        console.log("RateScheduleRegistry:", scheduleRegistry);
        console.log("GovernanceMultisig:", governanceMultisig);

        require(contributorNFT != address(0), "Zero CONTRIBUTOR_NFT_ADDRESS");
        require(
            scheduleRegistry != address(0),
            "Zero SCHEDULE_REGISTRY_ADDRESS"
        );

        vm.startBroadcast(deployerKey);
        registry = new PLRBackendRegistry(
            contributorNFT,
            scheduleRegistry,
            governanceMultisig
        );
        vm.stopBroadcast();

        console.log("PLRBackendRegistry deployed at:", address(registry));
        console.log("\n--- Add to chain-config.ts ---");
        console.log("plrBackendRegistry:", address(registry));
    }
}
