// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/**
 * @title RegisterEASSchema
 * @notice Registers the `pcc.evidence.v1` EAS schema on-chain and logs the returned UID.
 *
 * Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 6).
 * GATED on-chain action (migration gate G1). DO NOT broadcast inside the /go wave.
 *
 * The schema string MUST match, byte-for-byte, the decode tuple in
 * MilestoneEscrowV2.submitAttestation and the SchemaEncoder string in the gateway's
 * oracle-client. A wrong string here poisons every downstream check.
 *
 * Schema:
 *   string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified
 *
 * Resolver: address(0) (no resolver — trusted-attester enforcement is in the escrow read).
 * Revocable: true (oracle can revoke a bad attestation; escrow checks revocationTime == 0).
 *
 * The resulting UID = keccak256(abi.encodePacked(schemaString, address(0), true)). The SAME
 * triple yields the SAME UID on Base Sepolia and Base mainnet. Re-registering the same triple
 * reverts (AlreadyExists). Hard-code the logged UID as:
 *   - MilestoneEscrowV2 / PCCProtocolV2 PCC_EVIDENCE_SCHEMA_UID immutable (via DeployProtocolV2)
 *   - chain-config.ts `pccEvidenceSchemaUid`
 *   - the gateway PCC_EVIDENCE_SCHEMA_UID env var
 *
 * Required env vars:
 *   PCC_GATEWAY_PRIVATE_KEY — funded signer on the target chain
 *
 * Usage (only when authorized — spends gas, writes a permanent on-chain schema):
 *   forge script script/RegisterEASSchema.s.sol:RegisterEASSchema \
 *     --rpc-url https://sepolia.base.org --broadcast -vvvv
 */
interface ISchemaRegistry {
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
}

contract RegisterEASSchema is Script {
    /// @notice EAS SchemaRegistry — Base Sepolia + OP-Stack predeploy.
    /// @dev WARNING: Base MAINNET EAS is NOT this predeploy — verify before mainnet use.
    address constant SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

    /// @notice The `pcc.evidence.v1` schema string. MUST match the V2 decode tuple + gateway encoder.
    string constant SCHEMA_STRING =
        "string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified";

    function run() external {
        uint256 signerKey = vm.envUint("PCC_GATEWAY_PRIVATE_KEY");
        address signer = vm.addr(signerKey);

        console2.log("Signer:", signer);
        console2.log("SchemaRegistry:", SCHEMA_REGISTRY);
        console2.log("Schema string:", SCHEMA_STRING);
        console2.log("Resolver: address(0)  Revocable: true");

        vm.startBroadcast(signerKey);

        bytes32 uid = ISchemaRegistry(SCHEMA_REGISTRY).register(SCHEMA_STRING, address(0), true);

        vm.stopBroadcast();

        console2.log("--- pcc.evidence.v1 schema registered ---");
        console2.logBytes32(uid);
        console2.log("Hard-code the UID above as PCC_EVIDENCE_SCHEMA_UID (V2 immutable + chain-config + gateway env).");
    }
}
