// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneEscrowV2} from "./MilestoneEscrowV2.sol";
import {IPCCOracle} from "./interfaces/IPCCOracle.sol";

/**
 * @title PCCProtocolV2
 * @notice Root protocol factory for the EAS-gated Physical Capability Cloud escrows.
 *
 * Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 3).
 * See ai/research/eas-migration-design.md §3.6.
 *
 * PCCProtocolV2 mirrors `PCCProtocol` (same immutable fee recipient, the same fee
 * bounds + governance machinery, the same `isProtocolEscrow` / `collectFee` accounting)
 * but its factory method `createEscrowV2` deploys `MilestoneEscrowV2` instances and
 * threads the EAS wiring (EAS address + `pcc.evidence.v1` schema UID + authorized oracle)
 * through to each child as construction immutables.
 *
 * WHY A NEW FACTORY: `PCCProtocol.createEscrow` does `new MilestoneEscrow(...)` against
 * the compile-time-bound concrete V1 type — there is no implementation pointer or proxy to
 * swap. The existing immutable `PCCProtocol` on Base Sepolia cannot deploy a V2. V2 is
 * therefore additive: a NEW factory deployed alongside, leaving all V1 instances untouched.
 *
 * Fee bounds (identical to V1):
 *   - Minimum: 10 bps (0.1%) — fee can NEVER be set to zero
 *   - Maximum: 500 bps (5%)
 *   - Default: 235 bps (2.35%)
 *
 * The EAS-gated settlement supersedes the V1 `IPCCOracle` fee-gating path functionally.
 * The `oracleVerifier` immutable + `collectFeeWithAttestation` are RETAINED for parity with
 * V1 (so V2-deployed escrows can still call `collectFee` and the protocol exposes the same
 * surface), but the on-chain release gate now lives in `MilestoneEscrowV2.submitAttestation`
 * via the EAS attester check. `easOracle` is the EAS-attester identity threaded to children.
 */
contract PCCProtocolV2 {
    // ── Constants ────────────────────────────────────────────────────

    uint256 public constant FEE_BPS_MIN = 10;   // 0.1% floor
    uint256 public constant FEE_BPS_MAX = 500;  // 5% ceiling

    // ── Immutable State ──────────────────────────────────────────────

    /// @notice The fee recipient address. IMMUTABLE — hardcoded at deployment, cannot change.
    address public immutable feeRecipient;

    /// @notice The PCC Verification Oracle verifier contract. IMMUTABLE.
    /// @dev Retained for V1 parity (collectFeeWithAttestation). The EAS release gate lives in
    ///      the child escrow's submitAttestation; this is not consulted there.
    address public immutable oracleVerifier;

    // ── EAS Wiring (immutables, threaded to children) ────────────────

    /// @notice The EAS contract threaded to every child escrow.
    /// @dev Base + Base Sepolia predeploy 0x4200000000000000000000000000000000000021.
    address public immutable eas;

    /// @notice The `pcc.evidence.v1` schema UID threaded to every child escrow.
    bytes32 public immutable pccEvidenceSchemaUid;

    /// @notice The authorized oracle signer (EAS attester) threaded to every child escrow.
    address public immutable easOracle;

    // ── Governance-Adjustable State ──────────────────────────────────

    /// @notice Protocol fee in basis points (235 = 2.35%). Bounded [10, 500].
    uint256 public protocolFeeBps;

    /// @notice Governor address. Can adjust fee % and registry addresses. Cannot change fee recipient.
    address public governor;

    // ── Registry Addresses ───────────────────────────────────────────

    address public identityRegistry;
    address public reputationRegistry;
    address public validationRegistry;
    address public verifierRegistry;

    // ── Escrow Factory State ─────────────────────────────────────────

    /// @notice True if this escrow was deployed by this protocol factory.
    mapping(address => bool) public isProtocolEscrow;

    /// @notice All escrow addresses deployed by this factory.
    address[] public allEscrows;

    // ── Fee Accounting ───────────────────────────────────────────────

    /// @notice Total fees collected across all time (in token units).
    /// @dev Tracked per-token if multiple tokens are used; this is a simplified aggregate.
    mapping(address => uint256) public totalFeesCollectedByToken;

    /// @notice Fees collected from each individual escrow (in token units).
    mapping(address => uint256) public feesFromEscrow;

    // ── Events ───────────────────────────────────────────────────────

    event EscrowCreated(
        address indexed escrow,
        address indexed payer,
        address indexed arbiter,
        address token,
        bytes32 cwmId
    );
    event FeeCollected(address indexed escrow, address indexed token, uint256 fee);
    event ProtocolFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event GovernorTransferred(address indexed oldGovernor, address indexed newGovernor);
    event RegistriesUpdated(
        address identityRegistry,
        address reputationRegistry,
        address validationRegistry,
        address verifierRegistry
    );

    // ── Modifiers ────────────────────────────────────────────────────

    modifier onlyGovernor() {
        require(msg.sender == governor, "Only governor");
        _;
    }

    modifier onlyProtocolEscrow() {
        require(isProtocolEscrow[msg.sender], "Only protocol escrow");
        _;
    }

    modifier requiresOracle(IPCCOracle.Attestation calldata attestation) {
        require(
            oracleVerifier != address(0),
            "PCC: oracle verifier not set"
        );
        require(
            IPCCOracle(oracleVerifier).verifyAttestation(attestation),
            "PCC: invalid oracle attestation"
        );
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────

    /**
     * @param _feeRecipient        IMMUTABLE fee recipient address — cannot be changed after deployment.
     * @param _initialFeeBps       Initial fee in basis points (235 = 2.35%). Must be in [10, 500].
     * @param _governor            Governor address (can adjust fee % and registries, not recipient).
     * @param _oracleVerifier      IMMUTABLE oracle verifier contract address (V1 parity).
     * @param _eas                 The EAS contract threaded to children (Base + Base Sepolia: 0x42...0021).
     * @param _pccEvidenceSchemaUid The `pcc.evidence.v1` schema UID threaded to children.
     * @param _easOracle           The authorized oracle signer (EAS attester) threaded to children.
     */
    constructor(
        address _feeRecipient,
        uint256 _initialFeeBps,
        address _governor,
        address _oracleVerifier,
        address _eas,
        bytes32 _pccEvidenceSchemaUid,
        address _easOracle
    ) {
        require(_feeRecipient != address(0), "Zero fee recipient");
        require(_governor != address(0), "Zero governor");
        require(_initialFeeBps >= FEE_BPS_MIN && _initialFeeBps <= FEE_BPS_MAX, "Fee out of bounds");
        require(_oracleVerifier != address(0), "Zero oracle verifier");
        require(_eas != address(0), "Zero EAS");
        require(_easOracle != address(0), "Zero EAS oracle");
        // SECURITY (review H1): a zero schema UID threads into every child escrow and
        // silently breaks its release gate (a.schema == 0 never matches) → permanent
        // fund-lock. The value is immutable here and in the children — reject at construction.
        require(_pccEvidenceSchemaUid != bytes32(0), "Schema UID unset");

        feeRecipient = _feeRecipient;
        protocolFeeBps = _initialFeeBps;
        governor = _governor;
        oracleVerifier = _oracleVerifier;

        eas = _eas;
        pccEvidenceSchemaUid = _pccEvidenceSchemaUid;
        easOracle = _easOracle;
    }

    // ── Factory ──────────────────────────────────────────────────────

    /**
     * @notice Deploy a new MilestoneEscrowV2 with this protocol as the root and the
     *         factory's EAS wiring threaded through as child immutables.
     * @param payer The payer address (funds the escrow).
     * @param arbiter The arbiter address (resolves disputes).
     * @param token The ERC-20 token for payments (e.g. USDC).
     * @param cwmId Canonical Workflow Model ID.
     * @return escrow The address of the newly deployed MilestoneEscrowV2.
     */
    function createEscrowV2(
        address payer,
        address arbiter,
        address token,
        bytes32 cwmId
    ) external returns (address escrow) {
        require(payer != address(0), "Zero payer");
        require(token != address(0), "Zero token");

        MilestoneEscrowV2 newEscrow = new MilestoneEscrowV2(
            payer,
            arbiter,
            token,
            cwmId,
            address(this),
            eas,
            pccEvidenceSchemaUid,
            easOracle
        );
        escrow = address(newEscrow);

        isProtocolEscrow[escrow] = true;
        allEscrows.push(escrow);

        emit EscrowCreated(escrow, payer, arbiter, token, cwmId);
    }

    // ── Fee Collection ───────────────────────────────────────────────

    /**
     * @notice Called by child escrows during settlement to record fee accounting.
     * @dev The escrow transfers the fee directly to feeRecipient. This function
     *      is called after the transfer for accounting purposes. Only callable
     *      by factory-deployed escrows.
     * @param token The ERC-20 token in which the fee was collected.
     * @param fee The fee amount collected.
     */
    function collectFee(address token, uint256 fee) external onlyProtocolEscrow {
        feesFromEscrow[msg.sender] += fee;
        totalFeesCollectedByToken[token] += fee;
        emit FeeCollected(msg.sender, token, fee);
    }

    // ── Governance ───────────────────────────────────────────────────

    /**
     * @notice Adjust the protocol fee. Bounded between FEE_BPS_MIN and FEE_BPS_MAX.
     *         The fee can NEVER be set to 0. Only governor can call.
     * @param newFeeBps New fee in basis points. Must be in [10, 500].
     */
    function setProtocolFeeBps(uint256 newFeeBps) external onlyGovernor {
        require(newFeeBps >= FEE_BPS_MIN, "Fee below minimum (10 bps)");
        require(newFeeBps <= FEE_BPS_MAX, "Fee above maximum (500 bps)");
        emit ProtocolFeeBpsUpdated(protocolFeeBps, newFeeBps);
        protocolFeeBps = newFeeBps;
    }

    /**
     * @notice Update registry addresses. Only governor can call.
     */
    function setRegistries(
        address _identityRegistry,
        address _reputationRegistry,
        address _validationRegistry,
        address _verifierRegistry
    ) external onlyGovernor {
        identityRegistry = _identityRegistry;
        reputationRegistry = _reputationRegistry;
        validationRegistry = _validationRegistry;
        verifierRegistry = _verifierRegistry;
        emit RegistriesUpdated(
            _identityRegistry,
            _reputationRegistry,
            _validationRegistry,
            _verifierRegistry
        );
    }

    /**
     * @notice Transfer governance to a new address. Only current governor can call.
     */
    function transferGovernor(address newGovernor) external onlyGovernor {
        require(newGovernor != address(0), "Zero governor");
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    // ── Oracle-Gated Settlement (V1 parity) ────────────────────────

    /**
     * @notice Verify an oracle attestation. Can be called by anyone (view).
     *         Returns true if the attestation is valid per the oracle verifier.
     * @dev Retained for V1 parity. The EAS release gate lives in the child escrow.
     * @param attestation The oracle attestation to verify.
     * @return valid True if the attestation passes verification.
     */
    function verifyOracleAttestation(
        IPCCOracle.Attestation calldata attestation
    ) external view returns (bool valid) {
        if (oracleVerifier == address(0)) {
            return false;
        }
        return IPCCOracle(oracleVerifier).verifyAttestation(attestation);
    }

    /**
     * @notice Oracle-gated fee collection. Called by child escrows during settlement.
     *         Requires a valid oracle attestation before recording fee accounting.
     *         Only callable by factory-deployed escrows.
     * @dev Retained for V1 parity.
     * @param token The ERC-20 token in which the fee was collected.
     * @param fee The fee amount collected.
     * @param attestation The oracle attestation proving the settlement is verified.
     */
    function collectFeeWithAttestation(
        address token,
        uint256 fee,
        IPCCOracle.Attestation calldata attestation
    ) external onlyProtocolEscrow requiresOracle(attestation) {
        feesFromEscrow[msg.sender] += fee;
        totalFeesCollectedByToken[token] += fee;
        emit FeeCollected(msg.sender, token, fee);
    }

    // ── Views ────────────────────────────────────────────────────────

    /**
     * @notice Total number of escrows deployed by this factory.
     */
    function getEscrowCount() external view returns (uint256) {
        return allEscrows.length;
    }

    /**
     * @notice Calculate the protocol fee for a given amount.
     * @param amount The gross settlement amount.
     * @return fee The fee that will be deducted.
     */
    function calculateFee(uint256 amount) external view returns (uint256) {
        return (amount * protocolFeeBps) / 10000;
    }

    /**
     * @notice Total fees collected for a given token across all escrows.
     */
    function getTotalFeesForToken(address token) external view returns (uint256) {
        return totalFeesCollectedByToken[token];
    }
}
