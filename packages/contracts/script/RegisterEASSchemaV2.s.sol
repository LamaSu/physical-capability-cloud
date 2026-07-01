// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/**
 * @title RegisterEASSchemaV2
 * @notice Registers the `pcc.evidence.v2` EAS schema on-chain and logs the returned UID.
 *
 * PREREQUISITE G1 for the V3 protocol (sibling of RegisterEASSchema). V3 escrows gate Mode-B
 * releases on a 9-field `pcc.evidence.v2` attestation (the v1 7 fields PLUS `uint16 feeBps` +
 * `address feeRecipient` — V3 reads the fee FROM the attestation). Today only the v1 7-field
 * schema is registered on Base Sepolia, and `DeployProtocolV3` reads PCC_EVIDENCE_V2_SCHEMA_UID
 * from env and bakes it IMMUTABLY (with a deploy-time read-back assert). So this script MUST run
 * and its UID be wired BEFORE any V3 broadcast — otherwise every V3 release reverts on the
 * `a.schema == PCC_EVIDENCE_V2_SCHEMA_UID` check. See coord bulletins 222 / 225.
 *
 * GATED on-chain action (migration gate G1). DO NOT broadcast inside a /go wave. Run only when
 * explicitly authorized — it spends gas and writes a permanent on-chain schema.
 *
 * The schema string MUST match, byte-for-byte:
 *   - the gateway's `PCC_EVIDENCE_SCHEMA_V2` (packages/gateway/src/services/oracle-client.ts) —
 *     the string the oracle's SchemaEncoder uses to ENCODE the attestation payload; and
 *   - the `abi.decode` tuple types in MilestoneEscrowV3.submitAttestation.
 * A wrong string here yields a different UID and silently poisons every downstream release check.
 *
 * Schema (9 fields — v1 + feeBps + feeRecipient, feeBps BEFORE feeRecipient):
 *   string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid,
 *   uint8 assuranceTier, bool oracleVerified, bytes32 stepId, uint16 feeBps, address feeRecipient
 *
 * Resolver: address(0) (no resolver — trusted-attester enforcement is in the escrow read).
 * Revocable: true (oracle can revoke a bad attestation; escrow checks revocationTime == 0).
 *
 * UID = keccak256(abi.encodePacked(schemaString, address(0), true)). The SAME triple yields the
 * SAME UID on Base Sepolia and Base mainnet. Re-registering the same triple reverts (AlreadyExists).
 *
 * Wire the logged UID into ALL of these (they must agree, or releases break):
 *   - DeployProtocolV3 env  `PCC_EVIDENCE_V2_SCHEMA_UID`  (factory immutable; read-back asserted)
 *   - gateway env           `PCC_EVIDENCE_SCHEMA_V2_UID`   (oracle-client v2 emit — NOTE: the two
 *                                                           env-var names differ in V2/SCHEMA order)
 *   - chain-config.ts       `pccEvidenceSchemaUidV2`
 *
 * Required env vars:
 *   PCC_GATEWAY_PRIVATE_KEY — funded signer on the target chain (same signer as the v1 reg)
 *
 * Usage (ONLY when explicitly authorized — spends gas, writes a permanent on-chain schema):
 *   forge script script/RegisterEASSchemaV2.s.sol:RegisterEASSchemaV2 \
 *     --rpc-url https://sepolia.base.org --broadcast -vvvv
 */
interface ISchemaRegistry {
    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
}

contract RegisterEASSchemaV2 is Script {
    /// @notice EAS SchemaRegistry — Base Sepolia + OP-Stack predeploy.
    /// @dev WARNING: Base MAINNET EAS is NOT this predeploy — verify before mainnet use.
    address constant SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

    /// @notice The `pcc.evidence.v2` schema string. MUST be byte-identical to the gateway's
    ///         PCC_EVIDENCE_SCHEMA_V2 (oracle-client.ts) and align with MilestoneEscrowV3's
    ///         submitAttestation decode tuple. 9 fields = v1's 7 + uint16 feeBps + address
    ///         feeRecipient (feeBps appears BEFORE feeRecipient).
    string constant SCHEMA_STRING =
        "string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid, uint8 assuranceTier, bool oracleVerified, bytes32 stepId, uint16 feeBps, address feeRecipient";

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

        console2.log("--- pcc.evidence.v2 schema registered ---");
        console2.logBytes32(uid);
        console2.log("Wire the UID above into PCC_EVIDENCE_V2_SCHEMA_UID (DeployProtocolV3 env),");
        console2.log("PCC_EVIDENCE_SCHEMA_V2_UID (gateway env), and chain-config.ts pccEvidenceSchemaUidV2.");
    }
}
