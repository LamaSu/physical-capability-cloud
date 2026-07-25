// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "./libraries/Clones.sol";
import {VNextSettlementEscrow} from "./VNextSettlementEscrow.sol";
import {VNextSettlementLib, PolicyIdentity} from "./libraries/VNextSettlementLib.sol";

/**
 * @title VNextSettlementEscrowFactory
 * @notice Deploys the V-next settlement-escrow implementation once (initializer-locked) and clones it
 *         per job via EIP-1167 CREATE2. Each clone gets a unique, deterministic address derived from the
 *         complete BILATERAL POLICY IDENTITY (payer, operator, arbiter, jobIdHash, termsHash, policyNonce,
 *         prePolicyRoot) — so the address both parties compute and sign over commits to every authority
 *         AND to the exact funded terms, and cannot be occupied by a front-run clone bearing different
 *         ones (H-01). It is also the deployment-incarnation binding for the frozen-spec §10.12 H1 replay
 *         model (a per-job, non-selfdestructing clone => no CREATE2 address reuse on post-Cancun Base).
 * @dev    The factory deploys the implementation in its constructor, so the implementation's `factory`
 *         immutable == this factory; `initialize()` is therefore factory-gated to this contract only.
 *
 *         H-01 §8.2 H-1 deployment sequence (this is the ONLY supported order — it is what breaks the
 *         circular escrow-address dependency):
 *           1. fix factory + implementation
 *           2. prePolicyRoot = keccak256(abi.encode(UnitConfig[]))        (address-INDEPENDENT)
 *           3. escrow = predictEscrow(identity)                          (salt binds prePolicyRoot)
 *           4. settlementUnitIds = computeSettlementUnitId(chainId, escrow, ...) from the PREDICTED address
 *           5. JobPolicyHash over {chainId, factory, impl, escrow, policyVersion, payer, operator, arbiter,
 *              jobIdHash, termsHash, policyNonce, prePolicyRoot, unitsRoot, allowSelfAdjudication, expiry}
 *           6. payer AND operator sign it
 *           7. createEscrow(identity)  -> deploys + initializes the predicted address
 *           8. fund(configs, acceptance) -> verifies both signatures AND consumes the policy nonce atomically
 */
contract VNextSettlementEscrowFactory {
    /// @notice The shared, initializer-locked escrow implementation every clone delegatecalls.
    address public immutable implementation;

    /// @notice Policy-nonce floor per (payer, operator, jobIdHash): the LOWEST nonce still fundable.
    ///         Monotonically non-decreasing — it is raised by `revokePolicy` (cancel-before-funding, by
    ///         either party) and by `consumePolicyNonce` (funding a generation retires it AND every older
    ///         one). A revoked or superseded policy therefore cannot be funded even though its clone may
    ///         already sit at its predicted address holding nothing.
    mapping(bytes32 => uint256) public policyNonceFloor;

    event EscrowCreated(
        address indexed escrow,
        address indexed payer,
        address indexed operator,
        bytes32 jobIdHash,
        address arbiter,
        uint256 policyNonce,
        bytes32 salt
    );
    event PolicyRevoked(bytes32 indexed policyKey, address indexed revoker, uint256 newFloor);
    event PolicyNonceConsumed(bytes32 indexed policyKey, address indexed escrow, uint256 policyNonce);

    /// @notice Only the payer or the operator named in a policy may cancel it.
    error NotAParty();
    /// @notice Revocation is monotone: a floor may only be raised, never lowered or restated.
    error FloorNotIncreasing();
    /// @notice The policy generation was cancelled, or a newer generation has already been funded.
    error PolicyNoLongerValid();
    /// @notice Only the clone that CREATE2 places at this policy's predicted address may consume its nonce.
    error NotThePolicyEscrow();

    /// @param usdc / oracle / escalation / o5SchemaUid / o5TypeHash — the implementation immutables shared
    ///        by every clone.
    /// @dev   P0-6: the former `eas` parameter is REMOVED. The escrow no longer reads any attestation
    ///        registry, so a factory that accepted one would advertise a money-path dependency that does
    ///        not exist. EAS now belongs solely to the cohort attester (its async provenance mirror), and
    ///        is configured there.
    ///
    ///        H-01 Wave 3: `escalation` is the PRECOMMITTED escalation cohort (backup verdicts + appeal +
    ///        Model-B emergency). It is a constructor argument rather than per-job config on purpose —
    ///        `JobPolicyHash` already binds `implementation`, so both parties signing the policy are
    ///        signing this cohort, and "no replacement authority may be installed after funding" holds
    ///        because an implementation immutable cannot be changed at all. A different escalation cohort
    ///        is a different factory + implementation, i.e. a deliberate new deployment both parties must
    ///        re-accept. The escrow's constructor rejects `escalation == oracle`.
    constructor(address usdc, address oracle, address escalation, bytes32 o5SchemaUid, bytes32 o5TypeHash) {
        implementation = address(new VNextSettlementEscrow(usdc, oracle, escalation, o5SchemaUid, o5TypeHash));
    }

    /// @notice Clone + initialize a per-job escrow atomically. Permissionless AND safe: the CREATE2 salt
    ///         commits to the COMPLETE policy identity, so the canonical address the parties compute with
    ///         `predictEscrow` can only ever be occupied by a clone initialized with the INTENDED payer,
    ///         operator, arbiter, job, terms, nonce and pre-policy root. Front-running `createEscrow` with
    ///         the exact canonical tuple therefore just deploys the clone both parties already committed
    ///         to (a permissionless pre-deploy is harmless and changes no semantics); front-running with
    ///         ANY altered value yields a DIFFERENT address neither party ever funds. A fresh clone also
    ///         holds no funds until `fund()` succeeds — which requires both signatures — so creating one
    ///         is inert. A duplicate identity reverts (CREATE2 collision): one escrow per policy identity.
    function createEscrow(PolicyIdentity calldata p) external returns (address escrow) {
        bytes32 salt = _salt(p);
        escrow = Clones.cloneDeterministic(implementation, salt);
        VNextSettlementEscrow(escrow).initialize(p);
        emit EscrowCreated(escrow, p.payer, p.operator, p.jobIdHash, p.arbiter, p.policyNonce, salt);
    }

    /// @notice Precompute the clone address for a policy before it is created — step 3 of the §8.2 H-1
    ///         sequence. The settlementUnitIds, and therefore the `JobPolicyHash` both parties sign, are
    ///         derived from THIS address.
    function predictEscrow(PolicyIdentity calldata p) external view returns (address) {
        return _predict(p);
    }

    /// @notice The CREATE2 salt for a policy identity (exposed so off-chain builders mirror it exactly).
    function saltOf(PolicyIdentity calldata p) external pure returns (bytes32) {
        return _salt(p);
    }

    /// @notice The (payer, operator, job) scope a policy nonce lives in.
    function policyKey(address payer, address operator, bytes32 jobIdHash) external pure returns (bytes32) {
        return VNextSettlementLib.computePolicyKey(payer, operator, jobIdHash);
    }

    /// @notice Cancel every policy generation up to and including `uptoNonce` BEFORE it is funded. Either
    ///         party may call: an operator who never received the counter-signature, or a payer who has
    ///         changed the terms, must both be able to walk away without the other's cooperation. Monotone
    ///         by construction — a raised floor can never be lowered, so a cancellation is irreversible.
    /// @dev    This is the only cancellation primitive: after funding, the money-out state machine owns
    ///         the unit and a "cancel" is a refund path, not a policy revocation.
    function revokePolicy(address payer, address operator, bytes32 jobIdHash, uint256 uptoNonce) external {
        if (msg.sender != payer && msg.sender != operator) revert NotAParty();
        bytes32 k = VNextSettlementLib.computePolicyKey(payer, operator, jobIdHash);
        uint256 newFloor = uptoNonce + 1; // checked (0.8): a max-nonce revocation reverts rather than wraps
        if (newFloor <= policyNonceFloor[k]) revert FloorNotIncreasing();
        policyNonceFloor[k] = newFloor;
        emit PolicyRevoked(k, msg.sender, newFloor);
    }

    /// @notice Consume a policy nonce at funding time. Callable ONLY by the clone CREATE2 places at that
    ///         exact policy's predicted address, which is why it can be permissionless without becoming a
    ///         griefing lever: no third party can raise another job's floor, because no third party can be
    ///         at that address. Consuming sets the floor above the funded nonce, so (a) this generation can
    ///         never be re-funded and (b) every OLDER generation is invalidated — "a newer nonce
    ///         invalidates older ones", enforced on-chain rather than by convention.
    /// @return impl the implementation address the clone binds into its `JobPolicyHash`, so the acceptance
    ///         signatures cannot be replayed against a clone of a different implementation.
    function consumePolicyNonce(PolicyIdentity calldata p) external returns (address impl) {
        if (msg.sender != _predict(p)) revert NotThePolicyEscrow();
        bytes32 k = VNextSettlementLib.computePolicyKey(p.payer, p.operator, p.jobIdHash);
        if (p.policyNonce < policyNonceFloor[k]) revert PolicyNoLongerValid();
        policyNonceFloor[k] = p.policyNonce + 1; // checked (0.8)
        emit PolicyNonceConsumed(k, msg.sender, p.policyNonce);
        return implementation;
    }

    function _predict(PolicyIdentity calldata p) private view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(p), address(this));
    }

    function _salt(PolicyIdentity calldata p) private pure returns (bytes32) {
        return VNextSettlementLib.computePolicySalt(
            p.payer, p.operator, p.arbiter, p.jobIdHash, p.termsHash, p.policyNonce, p.prePolicyRoot
        );
    }
}
