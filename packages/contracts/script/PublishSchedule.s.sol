// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/**
 * @dev Slim view-only interface to the publish() entry point on
 *      RateScheduleRegistry. Inlined here to avoid pulling the full
 *      contract into the script's compile graph. The address-typed
 *      parameter accepts any deployment of RateScheduleRegistry.sol.
 */
interface IRateScheduleRegistry {
    function publish(bytes calldata scheduleBytes, bytes32 expectedHash)
        external
        returns (bytes32 scheduleHash);

    function exists(bytes32 scheduleHash) external view returns (bool);
}

/**
 * @title PublishSchedule
 * @notice One-shot broadcast of a single RateSchedule to a deployed
 *         RateScheduleRegistry. Used to seal the off-chain canonical-JSON
 *         bytes of a contributor's rate curve into on-chain storage so that
 *         a ContributorNFT can immediately reference its scheduleHash at
 *         mint time.
 *
 *         The pairing with MintContributor.s.sol:
 *           1. Off-chain: build canonical-JSON bytes of the schedule + hash.
 *           2. PublishSchedule.s.sol — this script — to RateScheduleRegistry.
 *           3. MintContributor.s.sol references the now-published hash.
 *
 *         Required env vars:
 *           RATE_SCHEDULE_REGISTRY_ADDRESS  — deployed registry address
 *           SCHEDULE_BYTES_HEX              — hex-encoded canonical-JSON bytes
 *                                             (with or without 0x prefix; the
 *                                             vm.parseBytes helper is lenient)
 *           EXPECTED_HASH                   — sha256 hex (as bytes32) of those
 *                                             bytes; the registry will revert
 *                                             on mismatch
 *           DEPLOYER_PRIVATE_KEY            — broadcaster
 *
 *         Optional env vars:
 *           RPC_URL                         — falls back to script CLI flag
 *
 *         Usage (Base Sepolia):
 *           SCHEDULE_BYTES='{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}'
 *           SCHEDULE_HASH=$(printf '%s' "$SCHEDULE_BYTES" | shasum -a 256 | cut -d' ' -f1)
 *           SCHEDULE_BYTES_HEX="0x$(printf '%s' "$SCHEDULE_BYTES" | xxd -p | tr -d '\n')"
 *
 *           RATE_SCHEDULE_REGISTRY_ADDRESS=0x... \
 *           SCHEDULE_BYTES_HEX="$SCHEDULE_BYTES_HEX" \
 *           EXPECTED_HASH="0x$SCHEDULE_HASH" \
 *           DEPLOYER_PRIVATE_KEY=0x... \
 *           forge script script/PublishSchedule.s.sol:PublishSchedule \
 *             --rpc-url https://sepolia.base.org \
 *             --broadcast \
 *             -vvvv
 *
 *         Usage (local Anvil):
 *           Same as above, with --rpc-url http://127.0.0.1:8545. Anvil's
 *           default unlocked key works as DEPLOYER_PRIVATE_KEY for tests.
 *
 *         Idempotency: republishing the same scheduleHash will revert with
 *         "Already published" — that's expected. Re-running this script
 *         after a successful broadcast is a no-op (failure) by design.
 *
 *         Output: the registry returns the verified scheduleHash on success
 *         (always equal to EXPECTED_HASH). The script logs both the address
 *         that broadcasted and the hash that was sealed.
 */
contract PublishSchedule is Script {
    function run() external {
        // ── Inputs ───────────────────────────────────────────────────────
        address registryAddr = vm.envAddress("RATE_SCHEDULE_REGISTRY_ADDRESS");
        bytes memory scheduleBytes = vm.envBytes("SCHEDULE_BYTES_HEX");
        bytes32 expectedHash = vm.envBytes32("EXPECTED_HASH");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        require(registryAddr != address(0), "RATE_SCHEDULE_REGISTRY_ADDRESS is zero");
        require(scheduleBytes.length > 0, "SCHEDULE_BYTES_HEX is empty");
        require(expectedHash != bytes32(0), "EXPECTED_HASH is zero");

        address broadcaster = vm.addr(deployerKey);
        console.log("Broadcaster:", broadcaster);
        console.log("Registry:", registryAddr);
        console.log("Schedule bytes length:", scheduleBytes.length);
        console.logBytes32(expectedHash);

        // ── Optional sanity gate ────────────────────────────────────────
        // If the schedule is already published, surface that BEFORE issuing
        // a tx that we know will revert. Saves gas + makes the script
        // re-runnable without a confusing on-chain revert in logs.
        IRateScheduleRegistry registry = IRateScheduleRegistry(registryAddr);
        if (registry.exists(expectedHash)) {
            console.log("Schedule already published - no-op exit (idempotent).");
            return;
        }

        // ── Broadcast ───────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        bytes32 scheduleHash = registry.publish(scheduleBytes, expectedHash);

        vm.stopBroadcast();

        // ── Output ──────────────────────────────────────────────────────
        console.log("Published scheduleHash:");
        console.logBytes32(scheduleHash);
        console.log("\n--- Add to broadcast log / deployments record ---");
        console.log("rateScheduleRegistry:", registryAddr);
        console.log("publisher:", broadcaster);
    }
}
