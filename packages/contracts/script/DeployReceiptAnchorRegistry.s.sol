// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/ReceiptAnchorRegistry.sol";

/**
 * @title DeployReceiptAnchorRegistry
 * @notice Deploys ReceiptAnchorRegistry — on-chain anchor for Phase-2
 *         InvocationReceipts (aggregator gateway).
 *
 * Design doc: ai/scoping/onchain-receipt-anchoring-2026-05-23.md §10.2
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY      — deployer wallet private key
 *   RECEIPT_GATEWAY_ORACLE_ADDRESS — EOA the gateway uses to submit anchors
 *                                    (RECEIPT_GATEWAY_ORACLE_KEY pubkey).
 *                                    Per scoping §11.3, this should be a
 *                                    SEPARATE key from CaptureClassRegistry's
 *                                    gatewayOracle (blast-radius reduction).
 *
 * Optional env vars:
 *   PCC_NETWORK — if "base-sepolia" or "base", writes deployments/<net>/
 *                 ReceiptAnchorRegistry.json for downstream consumers
 *                 (subgraph, gateway, chain-config.ts).
 *
 * Usage:
 *   # Base Sepolia (Phase-2 test target):
 *   forge script script/DeployReceiptAnchorRegistry.s.sol:DeployReceiptAnchorRegistry \
 *     --rpc-url base_sepolia --broadcast --verify -vvvv
 *
 *   # Base mainnet (Phase-2 prod target, after dual-write window):
 *   forge script script/DeployReceiptAnchorRegistry.s.sol:DeployReceiptAnchorRegistry \
 *     --rpc-url base --broadcast --verify -vvvv
 *
 *   # Local anvil (smoke):
 *   anvil &
 *   forge script script/DeployReceiptAnchorRegistry.s.sol:DeployReceiptAnchorRegistry \
 *     --rpc-url localhost --broadcast
 */
contract DeployReceiptAnchorRegistry is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address gatewayOracle = vm.envAddress("RECEIPT_GATEWAY_ORACLE_ADDRESS");

        require(gatewayOracle != address(0), "RECEIPT_GATEWAY_ORACLE_ADDRESS must be set");

        console2.log("Deployer:", deployer);
        console2.log("Gateway Oracle (immutable):", gatewayOracle);

        vm.startBroadcast(deployerKey);
        ReceiptAnchorRegistry registry = new ReceiptAnchorRegistry(gatewayOracle);
        console2.log("ReceiptAnchorRegistry deployed at:", address(registry));
        vm.stopBroadcast();

        // Post-deploy invariant check (pure view, no gas).
        require(registry.gatewayOracle() == gatewayOracle, "gatewayOracle mismatch post-deploy");

        // Persist deployment record for known target networks.
        string memory network = vm.envOr("PCC_NETWORK", string(""));
        bytes32 networkHash = keccak256(bytes(network));
        if (networkHash == keccak256(bytes("base-sepolia"))) {
            _writeDeploymentJson("deployments/base-sepolia/ReceiptAnchorRegistry.json", address(registry), gatewayOracle);
        } else if (networkHash == keccak256(bytes("base"))) {
            _writeDeploymentJson("deployments/base/ReceiptAnchorRegistry.json", address(registry), gatewayOracle);
        }

        console2.log("\n--- Add to chain-config.ts (under contracts) ---");
        console2.log('receiptAnchorRegistry: "');
        console2.logAddress(address(registry));
        console2.log('"');
        console2.log("\n--- Add to gateway .env ---");
        console2.log("RECEIPT_ANCHOR_CONTRACT_ADDRESS=");
        console2.logAddress(address(registry));
        console2.log("PCC_RECEIPT_ANCHOR_ENABLED=false  # flip to true after dual-write smoke");
    }

    function _writeDeploymentJson(string memory path, address contractAddr, address gatewayOracle) internal {
        string memory json = "deployment";
        vm.serializeAddress(json, "address", contractAddr);
        vm.serializeAddress(json, "gatewayOracle", gatewayOracle);
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "blockNumber", block.number);
        string memory finalJson = vm.serializeString(json, "contract", "ReceiptAnchorRegistry");
        vm.writeJson(finalJson, path);
        console2.log("Wrote", path);
    }
}
