// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PCCProtocolV2} from "../src/PCCProtocolV2.sol";
import {MilestoneEscrowV2} from "../src/MilestoneEscrowV2.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * @title DeployProtocolV2
 * @notice Deploys the EAS-gated PCCProtocolV2 factory (and optionally a sample
 *         MilestoneEscrowV2) on the target chain.
 *
 * Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 7).
 * GATED on-chain action (migration gate G3). DO NOT broadcast inside the /go wave.
 *
 * Sibling of DeployProtocol.s.sol. The fee recipient is HARDCODED to the same address as
 * V1 (0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B) and cannot change after deployment.
 *
 * EIP-1167 CLONE ARCHITECTURE: this script deploys ONE shared MilestoneEscrowV2
 * implementation (carrying the EAS wiring as immutables, locked so it can never be
 * used directly), then deploys PCCProtocolV2 pointing at that implementation. Every
 * escrow created via `createEscrowV2` is a ~45-byte minimal-proxy clone of it — its
 * own address/storage/balance, so a bug in one escrow cannot drain another.
 *
 * The factory bakes in (immutable):
 *   - EAS = 0x4200000000000000000000000000000000000021 (Base + Base Sepolia predeploy)
 *   - pccEvidenceSchemaUid = PCC_EVIDENCE_SCHEMA_UID env (from gate G1 / RegisterEASSchema)
 *   - easOracle = the authorized oracle signer (EAS attester); defaults to ORACLE_VERIFIER_ADDRESS,
 *     overridable via EAS_ORACLE_ADDRESS
 *   - oracleVerifier = ORACLE_VERIFIER_ADDRESS (V1 parity; not consulted by the EAS release gate)
 *   - escrowImplementation = the shared MilestoneEscrowV2 implementation deployed first below
 *
 * After deploy, hand-add the printed PCCProtocolV2 address to chain-config.ts as
 * `milestoneEscrowFactoryV2` for the target network (no automated ingestion).
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY     — deployer/governor wallet private key
 *   PCC_EVIDENCE_SCHEMA_UID  — bytes32 schema UID from RegisterEASSchema (gate G1)
 *   ORACLE_VERIFIER_ADDRESS  — oracle verifier (V1 parity) + default EAS attester
 * Optional env vars:
 *   EAS_ORACLE_ADDRESS       — override the EAS attester identity (defaults to ORACLE_VERIFIER_ADDRESS)
 *   DEPLOY_SAMPLE_ESCROW     — if set to 1, also deploy a sample MilestoneEscrowV2 via createEscrowV2
 *
 * Usage (only when authorized — deploys permanent immutable contracts, spends gas):
 *   forge script script/DeployProtocolV2.s.sol:DeployProtocolV2 \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast --verify --etherscan-api-key $ETHERSCAN_API_KEY -vvvv
 */
contract DeployProtocolV2 is Script {
    // HARDCODED — same immutable fee recipient as V1, never changes.
    address constant FEE_RECIPIENT = 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B;
    uint256 constant INITIAL_FEE_BPS = 235; // 2.35%

    /// @notice EAS contract — Base Sepolia + OP-Stack predeploy.
    /// @dev WARNING: Base MAINNET EAS is NOT this predeploy — verify before mainnet use.
    address constant EAS = 0x4200000000000000000000000000000000000021;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        bytes32 schemaUid = vm.envBytes32("PCC_EVIDENCE_SCHEMA_UID");
        address oracleVerifier = vm.envAddress("ORACLE_VERIFIER_ADDRESS");
        // EAS attester identity threaded to children; defaults to the oracle verifier address.
        address easOracle = vm.envOr("EAS_ORACLE_ADDRESS", oracleVerifier);
        bool deploySample = vm.envOr("DEPLOY_SAMPLE_ESCROW", uint256(0)) == 1;

        console2.log("Deployer:", deployer);
        console2.log("Fee Recipient (immutable):", FEE_RECIPIENT);
        console2.log("Initial Fee:", INITIAL_FEE_BPS, "bps (2.35%)");
        console2.log("EAS:", EAS);
        console2.log("Oracle Verifier (V1 parity):", oracleVerifier);
        console2.log("EAS Oracle (attester):", easOracle);
        console2.log("PCC_EVIDENCE_SCHEMA_UID:");
        console2.logBytes32(schemaUid);

        vm.startBroadcast(deployerKey);

        // 1. Deploy the SHARED MilestoneEscrowV2 implementation. It carries the EAS wiring
        //    as immutables and is LOCKED by its constructor (_initialized = true) so it can
        //    never be initialized or used directly — only cloned. The per-escrow config
        //    (payer/arbiter/token/cwmId) is intentionally NOT set here.
        MilestoneEscrowV2 escrowImpl = new MilestoneEscrowV2(
            EAS,         // EAS contract (immutable, shared by every clone)
            schemaUid,   // pcc.evidence.v1 schema UID (immutable, shared by every clone)
            easOracle    // authorized oracle / EAS attester (immutable, shared by every clone)
        );
        console2.log("MilestoneEscrowV2 implementation deployed at:", address(escrowImpl));

        // 2. Deploy PCCProtocolV2 factory pointing at the implementation.
        //    Governor = deployer (can be transferred to a multisig later).
        PCCProtocolV2 protocolV2 = new PCCProtocolV2(
            FEE_RECIPIENT,
            INITIAL_FEE_BPS,
            deployer,            // governor
            oracleVerifier,      // oracle verifier (immutable, V1 parity)
            EAS,                 // EAS contract (immutable, threaded to children)
            schemaUid,           // pcc.evidence.v1 schema UID (immutable, threaded to children)
            easOracle,           // authorized oracle / EAS attester (immutable, threaded to children)
            address(escrowImpl)  // shared implementation every escrow clones
        );
        console2.log("PCCProtocolV2 deployed at:", address(protocolV2));

        // 2. Optionally deploy a sample MilestoneEscrowV2 via the factory for smoke testing.
        address sampleEscrow;
        if (deploySample) {
            MockUSDC mockUSDC = new MockUSDC(1_000_000e6);
            mockUSDC.mint(deployer, 100_000e6);
            console2.log("Sample MockUSDC deployed at:", address(mockUSDC));

            sampleEscrow = protocolV2.createEscrowV2(
                deployer,             // payer
                deployer,             // arbiter
                address(mockUSDC),    // token
                bytes32("sample-cwm") // cwmId
            );
            console2.log("Sample MilestoneEscrowV2 deployed at:", sampleEscrow);
        }

        vm.stopBroadcast();

        // ── SECURITY (review H1): deploy-time read-back of the schema UID ──
        // Confirm the factory baked in the EXACT env-provided schema UID. A mismatch (or a
        // zero UID slipping past the constructor) would silently break every child escrow's
        // release gate — fail the script here, before any funds flow.
        bytes32 deployedSchemaUid = protocolV2.pccEvidenceSchemaUid();
        console2.log("Read-back pccEvidenceSchemaUid:");
        console2.logBytes32(deployedSchemaUid);
        require(deployedSchemaUid == schemaUid, "Schema UID read-back mismatch");
        require(deployedSchemaUid != bytes32(0), "Schema UID is zero");

        // If a sample escrow was deployed, assert it inherited the same schema UID.
        if (deploySample && sampleEscrow != address(0)) {
            bytes32 escrowSchemaUid = MilestoneEscrowV2(sampleEscrow).PCC_EVIDENCE_SCHEMA_UID();
            require(escrowSchemaUid == schemaUid, "Sample escrow schema UID mismatch");
            console2.log("Sample escrow schema UID matches factory.");
        }

        // Output for chain-config.ts
        console2.log("\n--- Add to chain-config.ts ---");
        console2.log("milestoneEscrowFactoryV2:", address(protocolV2));
        if (deploySample) {
            console2.log("(sample escrow, not for chain-config):", sampleEscrow);
        }
    }
}
