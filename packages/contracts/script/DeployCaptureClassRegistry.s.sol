// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/CaptureClassRegistry.sol";

/**
 * @title DeployCaptureClassRegistry
 * @notice Deploys CaptureClassRegistry — the on-chain anchor for the PCC Capture Verification Protocol.
 *
 * Design doc: ai/research/capture-verification-protocol.md §6.1
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer wallet private key
 *   GATEWAY_ORACLE_ADDRESS — EOA that the gateway process uses to submit anchors (GATEWAY_ORACLE_KEY pubkey)
 *   VERIFIER_REGISTRY_ADDRESS — address of the previously-deployed VerifierRegistry contract
 *
 * Optional env vars:
 *   PCC_NETWORK — if set to "base-sepolia", also writes the deployed address to
 *                 deployments/base-sepolia/CaptureClassRegistry.json for downstream consumers.
 *
 * Usage (Base Sepolia):
 *   forge script script/DeployCaptureClassRegistry.s.sol:DeployCaptureClassRegistry \
 *     --rpc-url base_sepolia \
 *     --broadcast --verify -vvvv
 *
 * Usage (local anvil):
 *   anvil &
 *   forge script script/DeployCaptureClassRegistry.s.sol:DeployCaptureClassRegistry \
 *     --rpc-url localhost --broadcast
 */
contract DeployCaptureClassRegistry is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address gatewayOracle = vm.envAddress("GATEWAY_ORACLE_ADDRESS");
        address verifierRegistry = vm.envAddress("VERIFIER_REGISTRY_ADDRESS");

        require(gatewayOracle != address(0), "GATEWAY_ORACLE_ADDRESS must be set");
        require(verifierRegistry != address(0), "VERIFIER_REGISTRY_ADDRESS must be set");

        console2.log("Deployer:", deployer);
        console2.log("Gateway Oracle (immutable):", gatewayOracle);
        console2.log("Verifier Registry (immutable):", verifierRegistry);

        vm.startBroadcast(deployerKey);

        CaptureClassRegistry registry = new CaptureClassRegistry(gatewayOracle, verifierRegistry);
        console2.log("CaptureClassRegistry deployed at:", address(registry));

        vm.stopBroadcast();

        // Verify the immutables were set correctly at construction time (pure view calls, no gas).
        require(registry.gatewayOracle() == gatewayOracle, "gatewayOracle mismatch post-deploy");
        require(registry.verifierRegistry() == verifierRegistry, "verifierRegistry mismatch post-deploy");

        // Write deployment record for Base Sepolia so the gateway, indexer, and chain-config
        // can pick up the address without a manual copy-paste step.
        string memory network = vm.envOr("PCC_NETWORK", string(""));
        if (keccak256(bytes(network)) == keccak256(bytes("base-sepolia"))) {
            string memory json = "deployment";
            vm.serializeAddress(json, "address", address(registry));
            vm.serializeAddress(json, "gatewayOracle", gatewayOracle);
            vm.serializeAddress(json, "verifierRegistry", verifierRegistry);
            vm.serializeUint(json, "chainId", block.chainid);
            vm.serializeUint(json, "blockNumber", block.number);
            string memory finalJson = vm.serializeString(json, "contract", "CaptureClassRegistry");
            vm.writeJson(finalJson, "deployments/base-sepolia/CaptureClassRegistry.json");
            console2.log("Wrote deployments/base-sepolia/CaptureClassRegistry.json");
        }

        // Output for chain-config.ts / gateway env
        console2.log("\n--- Add to chain-config.ts ---");
        console2.log("captureClassRegistry:", address(registry));
        console2.log("\n--- Add to gateway .env ---");
        console2.log("CAPTURE_CLASS_REGISTRY_ADDRESS=", address(registry));
    }
}
