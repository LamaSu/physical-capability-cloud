// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PCCProtocolV3} from "../src/PCCProtocolV3.sol";
import {MilestoneEscrowV3} from "../src/MilestoneEscrowV3.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * @title DeployProtocolV3
 * @notice Deploys the EAS-gated, fee-from-attestation PCCProtocolV3 factory (and optionally
 *         a sample MilestoneEscrowV3) on the target chain.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ GATED on-chain action. SCRIPT-ONLY — DO NOT BROADCAST.                                  │
 * │ This script is authored for review + a future, explicitly-authorized deploy. It is NOT │
 * │ run with `--broadcast` by any automated pipeline. Deploying it publishes permanent,     │
 * │ immutable contracts and spends gas. Gating it behind a deliberate manual invocation     │
 * │ (the same posture as DeployProtocolV2.s.sol) avoids accidental fire.                    │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Sibling of DeployProtocolV2.s.sol. The fee recipient is HARDCODED to the same address as
 * V1/V2 (0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B) and cannot change after deployment.
 *
 * The factory bakes in (immutable):
 *   - EAS = 0x4200000000000000000000000000000000000021 (Base + Base Sepolia predeploy)
 *   - pccEvidenceSchemaUid = PCC_EVIDENCE_V2_SCHEMA_UID env (the `pcc.evidence.v2` schema UID
 *     from gate G1 / RegisterEASSchema — DIFFERENT value from V2's `pcc.evidence.v1` UID)
 *   - easOracle = the authorized oracle signer (EAS attester); defaults to ORACLE_VERIFIER_ADDRESS,
 *     overridable via EAS_ORACLE_ADDRESS
 *   - oracleVerifier = ORACLE_VERIFIER_ADDRESS (V1/V2 parity; not consulted by the EAS release gate)
 *
 * NOTE on the V3 fee model: V3 escrows read `feeBps` / `feeRecipient` from the EAS
 * attestation payload, not from the factory. The factory's INITIAL_FEE_BPS / FEE_RECIPIENT
 * are RETAINED for parity + off-chain consumers and do not change what V3 escrows charge.
 *
 * After deploy, hand-add the printed PCCProtocolV3 address to chain-config.ts as
 * `milestoneEscrowFactoryV3` for the target network (no automated ingestion).
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY        — deployer/governor wallet private key
 *   PCC_EVIDENCE_V2_SCHEMA_UID  — bytes32 `pcc.evidence.v2` schema UID from RegisterEASSchema (gate G1)
 *   ORACLE_VERIFIER_ADDRESS     — oracle verifier (V1/V2 parity) + default EAS attester
 * Optional env vars:
 *   EAS_ORACLE_ADDRESS          — override the EAS attester identity (defaults to ORACLE_VERIFIER_ADDRESS)
 *   DEPLOY_SAMPLE_ESCROW        — if set to 1, also deploy a sample MilestoneEscrowV3 via createEscrowV3
 *
 * Usage (ONLY when explicitly authorized — deploys permanent immutable contracts, spends gas):
 *   forge script script/DeployProtocolV3.s.sol:DeployProtocolV3 \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY -vvvv
 */
contract DeployProtocolV3 is Script {
    // HARDCODED — same immutable fee recipient as V1/V2, never changes.
    address constant FEE_RECIPIENT = 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B;
    uint256 constant INITIAL_FEE_BPS = 235; // 2.35%

    /// @notice EAS contract — Base Sepolia + OP-Stack predeploy.
    /// @dev WARNING: Base MAINNET EAS is NOT this predeploy — verify before mainnet use.
    address constant EAS = 0x4200000000000000000000000000000000000021;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        // V3 gates on the `pcc.evidence.v2` schema UID (DIFFERENT value from V2's v1 UID).
        bytes32 schemaUid = vm.envBytes32("PCC_EVIDENCE_V2_SCHEMA_UID");
        address oracleVerifier = vm.envAddress("ORACLE_VERIFIER_ADDRESS");
        // EAS attester identity threaded to children; defaults to the oracle verifier address.
        address easOracle = vm.envOr("EAS_ORACLE_ADDRESS", oracleVerifier);
        bool deploySample = vm.envOr("DEPLOY_SAMPLE_ESCROW", uint256(0)) == 1;

        console2.log("Deployer:", deployer);
        console2.log("Fee Recipient (immutable):", FEE_RECIPIENT);
        console2.log("Initial Fee:", INITIAL_FEE_BPS, "bps (2.35%) [parity only - V3 fee is attested]");
        console2.log("EAS:", EAS);
        console2.log("Oracle Verifier (V1/V2 parity):", oracleVerifier);
        console2.log("EAS Oracle (attester):", easOracle);
        console2.log("PCC_EVIDENCE_V2_SCHEMA_UID:");
        console2.logBytes32(schemaUid);

        vm.startBroadcast(deployerKey);

        // 1. Deploy PCCProtocolV3 factory.
        //    Governor = deployer (can be transferred to a multisig later).
        PCCProtocolV3 protocolV3 = new PCCProtocolV3(
            FEE_RECIPIENT,
            INITIAL_FEE_BPS,
            deployer,        // governor
            oracleVerifier,  // oracle verifier (immutable, V1/V2 parity)
            EAS,             // EAS contract (immutable, threaded to children)
            schemaUid,       // pcc.evidence.v2 schema UID (immutable, threaded to children)
            easOracle        // authorized oracle / EAS attester (immutable, threaded to children)
        );
        console2.log("PCCProtocolV3 deployed at:", address(protocolV3));

        // 2. Optionally deploy a sample MilestoneEscrowV3 via the factory for smoke testing.
        address sampleEscrow;
        if (deploySample) {
            MockUSDC mockUSDC = new MockUSDC(1_000_000e6);
            mockUSDC.mint(deployer, 100_000e6);
            console2.log("Sample MockUSDC deployed at:", address(mockUSDC));

            sampleEscrow = protocolV3.createEscrowV3(
                deployer,             // payer
                deployer,             // arbiter
                address(mockUSDC),    // token
                bytes32("sample-cwm") // cwmId
            );
            console2.log("Sample MilestoneEscrowV3 deployed at:", sampleEscrow);
        }

        vm.stopBroadcast();

        // ── SECURITY (review H1): deploy-time read-back of the schema UID ──
        // Confirm the factory baked in the EXACT env-provided schema UID. A mismatch (or a
        // zero UID slipping past the constructor) would silently break every child escrow's
        // release gate — fail the script here, before any funds flow.
        bytes32 deployedSchemaUid = protocolV3.pccEvidenceSchemaUid();
        console2.log("Read-back pccEvidenceSchemaUid:");
        console2.logBytes32(deployedSchemaUid);
        require(deployedSchemaUid == schemaUid, "Schema UID read-back mismatch");
        require(deployedSchemaUid != bytes32(0), "Schema UID is zero");

        // If a sample escrow was deployed, assert it inherited the same schema UID.
        if (deploySample && sampleEscrow != address(0)) {
            bytes32 escrowSchemaUid = MilestoneEscrowV3(sampleEscrow).PCC_EVIDENCE_V2_SCHEMA_UID();
            require(escrowSchemaUid == schemaUid, "Sample escrow schema UID mismatch");
            console2.log("Sample escrow schema UID matches factory.");
        }

        // Output for chain-config.ts
        console2.log("\n--- Add to chain-config.ts ---");
        console2.log("milestoneEscrowFactoryV3:", address(protocolV3));
        if (deploySample) {
            console2.log("(sample escrow, not for chain-config):", sampleEscrow);
        }
    }
}
