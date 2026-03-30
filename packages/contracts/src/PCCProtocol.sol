// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {MilestoneEscrow} from "./MilestoneEscrow.sol";

/**
 * @title PCCProtocol
 * @notice Root protocol contract for Physical Capability Cloud.
 *
 * Collects 1.5% from ALL PCC escrow settlements. The fee recipient address
 * is IMMUTABLE — it is set at deployment and can never be changed.
 *
 * Fee bounds:
 *   - Minimum: 10 bps (0.1%) — fee can NEVER be set to zero
 *   - Maximum: 500 bps (5%)
 *   - Default: 150 bps (1.5%)
 *
 * Only escrows deployed by this factory can call collectFee(). This makes
 * it structurally impossible for PCC activity to bypass the fee without
 * leaving the protocol entirely.
 */
contract PCCProtocol {
    // ── Constants ────────────────────────────────────────────────────

    uint256 public constant FEE_BPS_MIN = 10;   // 0.1% floor
    uint256 public constant FEE_BPS_MAX = 500;  // 5% ceiling

    // ── Immutable State ──────────────────────────────────────────────

    /// @notice The fee recipient address. IMMUTABLE — hardcoded at deployment, cannot change.
    address public immutable feeRecipient;

    // ── Governance-Adjustable State ──────────────────────────────────

    /// @notice Protocol fee in basis points (150 = 1.5%). Bounded [10, 500].
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

    // ── Constructor ──────────────────────────────────────────────────

    /**
     * @param _feeRecipient IMMUTABLE fee recipient address — cannot be changed after deployment.
     * @param _initialFeeBps Initial fee in basis points (150 = 1.5%). Must be in [10, 500].
     * @param _governor Governor address (can adjust fee % and registries, not recipient).
     */
    constructor(
        address _feeRecipient,
        uint256 _initialFeeBps,
        address _governor
    ) {
        require(_feeRecipient != address(0), "Zero fee recipient");
        require(_governor != address(0), "Zero governor");
        require(_initialFeeBps >= FEE_BPS_MIN && _initialFeeBps <= FEE_BPS_MAX, "Fee out of bounds");

        feeRecipient = _feeRecipient;
        protocolFeeBps = _initialFeeBps;
        governor = _governor;
    }

    // ── Factory ──────────────────────────────────────────────────────

    /**
     * @notice Deploy a new MilestoneEscrow with this protocol as the root.
     * @param payer The payer address (funds the escrow).
     * @param arbiter The arbiter address (resolves disputes).
     * @param token The ERC-20 token for payments (e.g. USDC).
     * @param cwmId Canonical Workflow Model ID.
     * @return escrow The address of the newly deployed MilestoneEscrow.
     */
    function createEscrow(
        address payer,
        address arbiter,
        address token,
        bytes32 cwmId
    ) external returns (address escrow) {
        require(payer != address(0), "Zero payer");
        require(token != address(0), "Zero token");

        MilestoneEscrow newEscrow = new MilestoneEscrow(payer, arbiter, token, cwmId, address(this));
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
