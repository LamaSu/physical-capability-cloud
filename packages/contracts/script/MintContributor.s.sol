// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/**
 * @dev Slim mint-only interface to the ContributorNFT contract. Inlined
 *      here so the script's compile graph stays small. The address-typed
 *      parameter accepts any deployment of ContributorNFT.sol.
 */
interface IContributorNFT {
    function mint(
        address to,
        bytes32 role,
        bytes32 scheduleHash,
        bytes32 ipId,
        string calldata metadataUri
    ) external returns (uint256 tokenId);
}

/**
 * @title MintContributor
 * @notice One-shot broadcast that mints a single ContributorNFT against a
 *         RateSchedule that has already been published into the registry
 *         the NFT was wired against at construction time.
 *
 *         Reverts (per ContributorNFT.mint):
 *           - "Zero address" when MINT_TO is unset and DEPLOYER_PRIVATE_KEY
 *             does not derive a usable broadcaster address (impossible in
 *             practice but enforced as a sanity gate).
 *           - "Zero role" when ROLE_TAG_HEX is bytes32(0).
 *           - "Zero scheduleHash" when SCHEDULE_HASH is bytes32(0).
 *           - "Schedule not registered" when the supplied SCHEDULE_HASH has
 *             never been published into the NFT's registry. The remedy is
 *             to run script/PublishSchedule.s.sol first against the same
 *             registry, then re-run this script.
 *
 *         Required env vars:
 *           CONTRIBUTOR_NFT_ADDRESS  — deployed ContributorNFT address
 *           ROLE_TAG_HEX             — bytes32 keccak256 of the role string,
 *                                      e.g. keccak256("integrator") =
 *                                      0x7fca04c084f97ed662fee1aeb0c969285c1557298812941e9d0396b1dc9b7b25
 *                                      (see packages/contracts/ts/payouts.ts
 *                                      ROLE_TAGS for all 10 canonical values)
 *           SCHEDULE_HASH            — bytes32 sha256 hash of an already-
 *                                      published RateSchedule (must exist in
 *                                      the registry the NFT was wired
 *                                      against, else mint reverts)
 *           METADATA_URI             — string URI (ipfs://, https://, etc.)
 *           DEPLOYER_PRIVATE_KEY     — broadcaster
 *
 *         Optional env vars:
 *           MINT_TO                  — recipient address. Defaults to the
 *                                      broadcaster (vm.addr(deployerKey))
 *                                      when unset.
 *           IP_ID                    — bytes32 Story Protocol IP Asset ID.
 *                                      Defaults to bytes32(0) when unset.
 *
 *         Usage (Base Sepolia):
 *           # 1. Compute the role tag off-chain:
 *           ROLE_TAG_HEX=$(cast keccak "integrator")
 *           # -> 0x7fca04c084f97ed662fee1aeb0c969285c1557298812941e9d0396b1dc9b7b25
 *
 *           # 2. Use the scheduleHash returned by PublishSchedule.s.sol:
 *           SCHEDULE_HASH=0x<from previous broadcast log>
 *
 *           # 3. Mint:
 *           CONTRIBUTOR_NFT_ADDRESS=0x... \
 *           ROLE_TAG_HEX="$ROLE_TAG_HEX" \
 *           SCHEDULE_HASH="$SCHEDULE_HASH" \
 *           METADATA_URI="ipfs://Qm.../adapter-spec.json" \
 *           IP_ID=0x0000000000000000000000000000000000000000000000000000000000000000 \
 *           DEPLOYER_PRIVATE_KEY=0x... \
 *           forge script script/MintContributor.s.sol:MintContributor \
 *             --rpc-url https://sepolia.base.org \
 *             --broadcast \
 *             -vvvv
 *
 *         Usage (local Anvil):
 *           Same env vars, with --rpc-url http://127.0.0.1:8545. Anvil's
 *           default unlocked key works as DEPLOYER_PRIVATE_KEY.
 *
 *         Output: the next-assigned tokenId. ContributorNFT auto-increments
 *         from 1; the script logs the returned id, the recipient, the role
 *         tag, the schedule hash, and the metadata URI for the deployments
 *         record.
 */
contract MintContributor is Script {
    function run() external {
        // ── Inputs ───────────────────────────────────────────────────────
        address nftAddr = vm.envAddress("CONTRIBUTOR_NFT_ADDRESS");
        bytes32 roleTag = vm.envBytes32("ROLE_TAG_HEX");
        bytes32 scheduleHash = vm.envBytes32("SCHEDULE_HASH");
        bytes32 ipId = vm.envOr("IP_ID", bytes32(0));
        string memory metadataUri = vm.envString("METADATA_URI");
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        require(nftAddr != address(0), "CONTRIBUTOR_NFT_ADDRESS is zero");
        require(roleTag != bytes32(0), "ROLE_TAG_HEX is zero");
        require(scheduleHash != bytes32(0), "SCHEDULE_HASH is zero");
        require(bytes(metadataUri).length > 0, "METADATA_URI is empty");

        address broadcaster = vm.addr(deployerKey);

        // MINT_TO defaults to the broadcaster.
        address mintTo = vm.envOr("MINT_TO", broadcaster);
        require(mintTo != address(0), "MINT_TO is zero");

        console.log("Broadcaster:", broadcaster);
        console.log("ContributorNFT:", nftAddr);
        console.log("Mint to:", mintTo);
        console.log("Role tag:");
        console.logBytes32(roleTag);
        console.log("Schedule hash:");
        console.logBytes32(scheduleHash);
        console.log("IP ID:");
        console.logBytes32(ipId);
        console.log("Metadata URI:", metadataUri);

        // ── Broadcast ────────────────────────────────────────────────────
        vm.startBroadcast(deployerKey);

        uint256 tokenId = IContributorNFT(nftAddr).mint(
            mintTo,
            roleTag,
            scheduleHash,
            ipId,
            metadataUri
        );

        vm.stopBroadcast();

        // ── Output ───────────────────────────────────────────────────────
        console.log("\n--- Mint complete ---");
        console.log("tokenId:", tokenId);
        console.log("owner:", mintTo);
        console.log("contributorNft:", nftAddr);
    }
}
