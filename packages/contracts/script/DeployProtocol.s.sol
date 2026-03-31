// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PCCProtocol.sol";
import "../src/MockUSDC.sol";
import "../src/IdentityRegistry.sol";
import "../src/ReputationRegistry.sol";
import "../src/ValidationRegistry.sol";
import "../src/VerifierRegistry.sol";

/**
 * @title DeployProtocol
 * @notice Deploys the PCCProtocol root contract plus all registries.
 *
 * The fee recipient is HARDCODED to 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B
 * and cannot be changed after deployment.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — deployer/governor wallet private key
 *
 * Usage:
 *   forge script script/DeployProtocol.s.sol:DeployProtocol \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast --verify -vvvv
 */
contract DeployProtocol is Script {
    // HARDCODED — never changes
    address constant FEE_RECIPIENT = 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B;
    uint256 constant INITIAL_FEE_BPS = 235; // 2.35%

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address oracleVerifier = vm.envAddress("ORACLE_VERIFIER_ADDRESS");

        console.log("Deployer:", deployer);
        console.log("Fee Recipient (immutable):", FEE_RECIPIENT);
        console.log("Initial Fee:", INITIAL_FEE_BPS, "bps (2.35%)");
        console.log("Oracle Verifier:", oracleVerifier);

        vm.startBroadcast(deployerKey);

        // 1. Deploy PCCProtocol root
        // Governor = deployer (can be transferred to a multisig later)
        PCCProtocol pccProtocol = new PCCProtocol(
            FEE_RECIPIENT,
            INITIAL_FEE_BPS,
            deployer, // governor
            oracleVerifier // oracle verifier (immutable)
        );
        console.log("PCCProtocol deployed at:", address(pccProtocol));

        // 2. Deploy registries
        IdentityRegistry identityRegistry = new IdentityRegistry();
        console.log("IdentityRegistry deployed at:", address(identityRegistry));

        ReputationRegistry reputationRegistry = new ReputationRegistry(address(identityRegistry));
        console.log("ReputationRegistry deployed at:", address(reputationRegistry));

        ValidationRegistry validationRegistry = new ValidationRegistry(address(identityRegistry));
        console.log("ValidationRegistry deployed at:", address(validationRegistry));

        // 4. Deploy MockUSDC first (needed for VerifierRegistry stake token)
        MockUSDC mockUSDC = new MockUSDC(1_000_000e6);
        mockUSDC.mint(deployer, 100_000e6);
        console.log("MockUSDC deployed at:", address(mockUSDC));

        VerifierRegistry verifierRegistry = new VerifierRegistry(address(mockUSDC));
        console.log("VerifierRegistry deployed at:", address(verifierRegistry));

        // 3. Wire registries into protocol
        pccProtocol.setRegistries(
            address(identityRegistry),
            address(reputationRegistry),
            address(validationRegistry),
            address(verifierRegistry)
        );

        vm.stopBroadcast();

        // Output for chain-config.ts
        console.log("\n--- Add to chain-config.ts ---");
        console.log("pccProtocol:", address(pccProtocol));
        console.log("identityRegistry:", address(identityRegistry));
        console.log("reputationRegistry:", address(reputationRegistry));
        console.log("validationRegistry:", address(validationRegistry));
        console.log("verifierRegistry:", address(verifierRegistry));
        console.log("mockUSDC:", address(mockUSDC));
    }
}
