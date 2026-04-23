// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/MilestoneEscrow.sol";

/**
 * @title AllowStablecoin
 * @notice Operator script: add a stablecoin to a deployed MilestoneEscrow's allowlist.
 *
 * Only the escrow's payer (contract owner) can execute this. The signer of
 * DEPLOYER_PRIVATE_KEY must BE the payer for the call to succeed.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — payer/owner private key
 *   ESCROW_ADDRESS        — deployed MilestoneEscrow address (e.g. 0x4547...)
 *   TOKEN_ADDRESS         — stablecoin to allow (e.g. real USDC / USDT / DAI)
 *   ATTESTOR_ADDRESS      — who vouched for the reserves (informational)
 *   RESERVE_REPORT_URI    — URI to the reserve report (ipfs://, ar://, https://)
 *   MAX_DEVIATION_BPS     — largest tolerated deviation from 1 USD, in bps
 *
 * Usage:
 *   export DEPLOYER_PRIVATE_KEY=0x...
 *   export ESCROW_ADDRESS=0x4547ec08...
 *   export TOKEN_ADDRESS=0xf175520c52418dfe19c8098071a252da48cd1c19  # e.g. USDT on Base Sepolia (mock)
 *   export ATTESTOR_ADDRESS=0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B
 *   export RESERVE_REPORT_URI="https://tether.to/en/transparency"
 *   export MAX_DEVIATION_BPS=100
 *
 *   forge script script/AllowStablecoin.s.sol:AllowStablecoinScript \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast -vvvv
 */
contract AllowStablecoinScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address escrowAddr = vm.envAddress("ESCROW_ADDRESS");
        address tokenAddr = vm.envAddress("TOKEN_ADDRESS");
        address attestor = vm.envAddress("ATTESTOR_ADDRESS");
        string memory reportUri = vm.envString("RESERVE_REPORT_URI");
        uint256 maxDevBps = vm.envUint("MAX_DEVIATION_BPS");

        require(maxDevBps <= type(uint16).max, "MAX_DEVIATION_BPS > uint16");

        console.log("Escrow:      ", escrowAddr);
        console.log("Token:       ", tokenAddr);
        console.log("Attestor:    ", attestor);
        console.log("Report URI:  ", reportUri);
        console.log("Max dev bps: ", maxDevBps);

        vm.startBroadcast(deployerKey);
        MilestoneEscrow(escrowAddr).allowStablecoin(
            tokenAddr,
            attestor,
            reportUri,
            uint16(maxDevBps)
        );
        vm.stopBroadcast();

        console.log("Stablecoin allowlisted.");
    }
}

/**
 * @title RevokeStablecoin
 * @notice Operator script: deactivate a previously allowlisted stablecoin.
 *
 * Revocation only prevents NEW milestones — existing milestones in this token
 * will still settle normally.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — payer/owner private key
 *   ESCROW_ADDRESS        — deployed MilestoneEscrow address
 *   TOKEN_ADDRESS         — stablecoin to revoke
 */
contract RevokeStablecoinScript is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address escrowAddr = vm.envAddress("ESCROW_ADDRESS");
        address tokenAddr = vm.envAddress("TOKEN_ADDRESS");

        console.log("Escrow: ", escrowAddr);
        console.log("Token:  ", tokenAddr);

        vm.startBroadcast(deployerKey);
        MilestoneEscrow(escrowAddr).revokeStablecoin(tokenAddr);
        vm.stopBroadcast();

        console.log("Stablecoin revoked (new milestones only).");
    }
}
