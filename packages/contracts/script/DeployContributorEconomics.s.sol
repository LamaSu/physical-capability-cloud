// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/RateScheduleRegistry.sol";
import "../src/ContributorNFT.sol";

/**
 * @title DeployContributorEconomics
 * @notice Deploys the on-chain pieces of the contributor-economics stack:
 *           1. RateScheduleRegistry (no constructor args)
 *           2. ContributorNFT (constructor: scheduleRegistry address)
 *         The two contracts are deployed in a single broadcast so the NFT can
 *         immediately reference the freshly-deployed registry.
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY  — deployer wallet private key
 *
 *         Usage (Base Sepolia):
 *           forge script script/DeployContributorEconomics.s.sol:DeployContributorEconomics \
 *             --rpc-url https://sepolia.base.org \
 *             --broadcast --verify -vvvv
 *
 *         Usage (local Anvil):
 *           DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
 *             forge script script/DeployContributorEconomics.s.sol:DeployContributorEconomics \
 *             --rpc-url http://127.0.0.1:8545 --broadcast -vvvv
 *
 *         Output: deployer address, registry address, NFT address — paste into
 *         packages/contracts/ts/chain-config.ts under the appropriate network.
 */
contract DeployContributorEconomics is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerKey);

        // 1. Deploy the content-addressed schedule registry first.
        //    Permissionless storage — no admin, no constructor args.
        RateScheduleRegistry registry = new RateScheduleRegistry();
        console.log("RateScheduleRegistry deployed at:", address(registry));

        // 2. Deploy the contributor identity NFT, wired to the registry.
        //    The NFT's `mint()` will refuse any scheduleHash not first
        //    published into this registry instance (immutable wiring).
        ContributorNFT nft = new ContributorNFT(address(registry));
        console.log("ContributorNFT deployed at:", address(nft));
        console.log("ContributorNFT.scheduleRegistry:", nft.scheduleRegistry());

        vm.stopBroadcast();

        // Output for chain-config.ts
        console.log("\n--- Add to chain-config.ts ---");
        console.log("rateScheduleRegistry:", address(registry));
        console.log("contributorNFT:", address(nft));
    }
}
