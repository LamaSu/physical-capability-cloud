// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneEscrowV2} from "./MilestoneEscrowV2.sol";
import {IPCCOracle} from "./interfaces/IPCCOracle.sol";
import {Clones} from "./libraries/Clones.sol";

/**
 * @title PCCProtocolV2
 * @notice Root protocol factory for the EAS-gated Physical Capability Cloud escrows.
 *
 * Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 3).
 * See ai/research/eas-migration-design.md §3.6.
 *
 * PCCProtocolV2 mirrors `PCCProtocol` (same immutable fee recipient, the same fee
 * bounds + governance machinery, the same `isProtocolEscrow` / `collectFee` accounting)
 * but its factory method `createEscrowV2` deploys each `MilestoneEscrowV2` as an
 * EIP-1167 minimal-proxy CLONE of a single shared implementation, then `initialize`s
 * the clone with its per-escrow config.
 *
 * FAULT ISOLATION (the reason for the clone refactor): every escrow is its own
 * address with its own storage and its own USDC balance. A bug or exploit that drains
 * or bricks escrow A delegatecalls into the shared logic but operates ONLY on A's
 * storage/balance — it physically cannot reach escrow B's funds. The shared EAS wiring
 * (EAS address + `pcc.evidence.v1` schema UID + authorized oracle) lives in the
 * implementation's code as immutables and is read identically by every clone; the
 * per-escrow config (payer/arbiter/token/cwmId) is written to each clone's own storage
 * by `initialize`.
 *
 * GAS: the prior design deployed a full MilestoneEscrowV2 per escrow (~4M gas).
 * A clone is ~45 bytes of runtime behind ~55 bytes of init code, so `createEscrowV2`
 * now costs tens-of-thousands of gas. The factory NO LONGER embeds the child initcode,
 * so its own runtime shrinks well under the 24,576-byte EIP-170 limit.
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

    // ── Clone Implementation ─────────────────────────────────────────

    /// @notice The shared MilestoneEscrowV2 implementation that every escrow clones.
    /// @dev Deployed ONCE by this factory's constructor (not passed in), so the
    ///      implementation's EAS wiring is guaranteed to match the factory's own
    ///      (eas / pccEvidenceSchemaUid / easOracle). `createEscrowV2` deploys EIP-1167
    ///      minimal proxies of this address — each its own isolated storage/balance — so
    ///      a bug in one escrow cannot reach another's funds. The implementation is
    ///      LOCKED (its constructor set `_initialized = true`), so it can never be
    ///      initialized or used directly; only clones are usable.
    address public immutable escrowImplementation;

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
     *
     * @dev The constructor deploys ONE shared, LOCKED MilestoneEscrowV2 implementation
     *      with the same EAS wiring it advertises (eas / schemaUid / oracle). Every escrow
     *      from `createEscrowV2` is an EIP-1167 clone of that implementation. Deploying the
     *      implementation here (rather than accepting it as a parameter) guarantees the
     *      clones' immutable EAS wiring can never drift from the factory's. The constructor
     *      arg list is intentionally UNCHANGED from the pre-clone factory so existing deploy
     *      scripts/ABIs keep working; the implementation is an internal deployment detail.
     *      The `new MilestoneEscrowV2(...)` initcode lives in the factory's CREATION code
     *      only, so it does NOT count against the factory's EIP-170 runtime-size limit.
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
        // MilestoneEscrowV2's own constructor re-asserts this on the implementation below.
        require(_pccEvidenceSchemaUid != bytes32(0), "Schema UID unset");

        feeRecipient = _feeRecipient;
        protocolFeeBps = _initialFeeBps;
        governor = _governor;
        oracleVerifier = _oracleVerifier;

        eas = _eas;
        pccEvidenceSchemaUid = _pccEvidenceSchemaUid;
        easOracle = _easOracle;

        // Deploy the ONE shared implementation every escrow clones. Its constructor
        // bakes the EAS wiring into the shared code as immutables and LOCKS it
        // (`_initialized = true`) so the implementation can never be initialized directly.
        escrowImplementation = address(
            new MilestoneEscrowV2(_eas, _pccEvidenceSchemaUid, _easOracle)
        );
    }

    // ── Factory ──────────────────────────────────────────────────────

    /**
     * @notice Deploy a new MilestoneEscrowV2 as an EIP-1167 clone of the shared
     *         implementation, then initialize it with this protocol as root and the
     *         caller-supplied per-escrow config. The EAS wiring is inherited from the
     *         implementation's immutables (identical for every escrow).
     *
     * @dev FAULT ISOLATION: the clone has its own address, storage, and token balance.
     *      An exploit on this escrow cannot reach any other escrow's funds.
     *
     *      The clone is deployed via CREATE2 (deterministic) so its address is
     *      predictable off-chain via `predictEscrowAddress(cwmId, getEscrowCount())`.
     *      The salt mixes `cwmId` with the current escrow count so a repeated `cwmId`
     *      can never cause a CREATE2 address collision (which would revert the call).
     *
     * @param payer The payer address (funds the escrow).
     * @param arbiter The arbiter address (resolves disputes).
     * @param token The ERC-20 token for payments (e.g. USDC).
     * @param cwmId Canonical Workflow Model ID.
     * @return escrow The address of the newly deployed MilestoneEscrowV2 clone.
     */
    function createEscrowV2(
        address payer,
        address arbiter,
        address token,
        bytes32 cwmId
    ) external returns (address escrow) {
        require(payer != address(0), "Zero payer");
        require(token != address(0), "Zero token");

        // Salt = cwmId mixed with the escrow index → unique per clone, collision-free,
        // and predictable off-chain (the index is getEscrowCount() before this call).
        bytes32 salt = keccak256(abi.encode(cwmId, allEscrows.length));
        escrow = Clones.cloneDeterministic(escrowImplementation, salt);

        // Per-escrow config is written to the clone's OWN storage (including protocolRoot =
        // this factory, so release() routes fees here). The shared EAS wiring
        // (eas / schemaUid / oracle) is read from the implementation code via delegatecall.
        MilestoneEscrowV2(escrow).initialize(payer, arbiter, token, cwmId, address(this));

        isProtocolEscrow[escrow] = true;
        allEscrows.push(escrow);

        emit EscrowCreated(escrow, payer, arbiter, token, cwmId);
    }

    /**
     * @notice Predict the deterministic address a clone will be deployed at, given the
     *         `cwmId` and the escrow index it will occupy (== `getEscrowCount()` at the
     *         moment `createEscrowV2` is called).
     * @dev Pure off-chain helper for callers that want the escrow address before the tx
     *      lands. Uses the same salt derivation as `createEscrowV2`.
     * @param cwmId       Canonical Workflow Model ID the clone will be created with.
     * @param escrowIndex The escrow index the clone will occupy (getEscrowCount() pre-call).
     * @return The address the clone will live at.
     */
    function predictEscrowAddress(bytes32 cwmId, uint256 escrowIndex) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(cwmId, escrowIndex));
        return Clones.predictDeterministicAddress(escrowImplementation, salt, address(this));
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
