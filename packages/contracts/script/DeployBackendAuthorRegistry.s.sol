// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/BackendAuthorRegistry.sol";

/**
 * @title  DeployBackendAuthorRegistry
 * @notice Generic deployment script for the vendor-agnostic
 *         BackendAuthorRegistry. Each vendor (PyLabRobot, Hamilton Venus,
 *         Trilobio, future) deploys their own instance by setting the
 *         NAMESPACE + MODULE_PATH_PATTERN env vars to their values.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY       deployer wallet key
 *   CONTRIBUTOR_NFT_ADDRESS    deployed ContributorNFT address
 *   SCHEDULE_REGISTRY_ADDRESS  deployed RateScheduleRegistry address
 *   NAMESPACE                  vendor namespace prefix; MUST end in ":"
 *                              by convention. Examples: "pylabrobot:",
 *                              "hamilton:", "trilobio:". 1..32 bytes.
 *   MODULE_PATH_PATTERN        regex hint describing the expected
 *                              modulePath shape. Stored on-chain but
 *                              NOT enforced. Examples:
 *                                "pylabrobot\\.[a-zA-Z0-9_]+(\\.[a-zA-Z0-9_]+)+"
 *                                "venus\\.[a-zA-Z0-9_]+(\\.[a-zA-Z0-9_]+)+"
 *
 * Optional env vars:
 *   GOVERNANCE_MULTISIG_ADDRESS  governance multisig (default 0x0 = no
 *                                recovery path). Phase 1 ships the hook;
 *                                multisig deployment + attestation flow
 *                                live in the per-vendor bridge repo docs.
 *
 * Usage:
 *   # Base Sepolia (staging) — PyLabRobot example:
 *   NAMESPACE="pylabrobot:" \
 *   MODULE_PATH_PATTERN="pylabrobot\\..+" \
 *   forge script script/DeployBackendAuthorRegistry.s.sol:DeployBackendAuthorRegistry \
 *     --rpc-url https://sepolia.base.org --broadcast --verify -vvvv
 *
 *   # Base mainnet (production) — Hamilton example:
 *   NAMESPACE="hamilton:" \
 *   MODULE_PATH_PATTERN="venus\\..+" \
 *   forge script script/DeployBackendAuthorRegistry.s.sol:DeployBackendAuthorRegistry \
 *     --rpc-url https://mainnet.base.org --broadcast --verify -vvvv
 */
contract DeployBackendAuthorRegistry is Script {
    function run() external returns (BackendAuthorRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address contributorNFT = vm.envAddress("CONTRIBUTOR_NFT_ADDRESS");
        address scheduleRegistry = vm.envAddress("SCHEDULE_REGISTRY_ADDRESS");
        address governanceMultisig = vm.envOr(
            "GOVERNANCE_MULTISIG_ADDRESS",
            address(0)
        );
        string memory namespace = vm.envString("NAMESPACE");
        string memory modulePathPattern = vm.envString("MODULE_PATH_PATTERN");

        console.log("Deployer:", deployer);
        console.log("ContributorNFT:", contributorNFT);
        console.log("RateScheduleRegistry:", scheduleRegistry);
        console.log("GovernanceMultisig:", governanceMultisig);
        console.log("Namespace:", namespace);
        console.log("ModulePathPattern:", modulePathPattern);

        require(contributorNFT != address(0), "Zero CONTRIBUTOR_NFT_ADDRESS");
        require(
            scheduleRegistry != address(0),
            "Zero SCHEDULE_REGISTRY_ADDRESS"
        );
        require(bytes(namespace).length > 0, "Empty NAMESPACE");
        require(bytes(namespace).length <= 32, "NAMESPACE too long");

        // Soft validation off-chain: namespace SHOULD end in ":". The
        // on-chain constructor does not enforce this so vendors can
        // experiment, but for the standard deployment path we want to
        // catch typos.
        bytes memory nsBytes = bytes(namespace);
        require(
            nsBytes[nsBytes.length - 1] == ":",
            "NAMESPACE should end in ':'"
        );

        vm.startBroadcast(deployerKey);
        registry = new BackendAuthorRegistry(
            contributorNFT,
            scheduleRegistry,
            governanceMultisig,
            namespace,
            modulePathPattern
        );
        vm.stopBroadcast();

        console.log(
            "BackendAuthorRegistry deployed at:",
            address(registry)
        );
        console.log("\n--- Add to chain-config.ts ---");
        console.log("backendAuthorRegistry:", address(registry));
        console.log("(namespace:", namespace, ")");
    }
}
