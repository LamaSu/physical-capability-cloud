// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "./libraries/Clones.sol";
import {VNextSettlementEscrow, IERC1271} from "./VNextSettlementEscrow.sol";
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
    ///         either party) and by `acceptPolicy` (funding a generation retires it AND every older
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
    // ── Wave 4a: the bilateral-acceptance errors, verbatim from the escrow ────────────────────────
    // A custom error's selector is `keccak256("Name()")[0:4]` — it carries no contract identity — and a
    // failed high-level external call bubbles its revert data through unchanged. So `fund()` still reverts
    // with EXACTLY these four selectors after the verification moved here; the escrow keeps the matching
    // declarations for ABI/decoder stability. This is a relocation, not a redefinition.
    /// @notice `arbiter == payer` or `arbiter == operator` without both parties signing a policy saying so.
    error SelfAdjudicationNotAccepted();
    /// @notice The acceptance's own expiry has passed.
    error PolicyExpired();
    /// @notice A delegated funder supplied a payer signature that does not validate for `payer`.
    error BadSignature();
    /// @notice The operator's acceptance signature does not validate for `operator`.
    error BadOperatorSignature();

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

    /// @notice Verify the BILATERAL ACCEPTANCE of a policy AND consume its nonce, atomically — step 8 of
    ///         the §8.2 H-1 sequence, called by the clone from inside `fund()` before any funds move.
    ///         Callable ONLY by the clone CREATE2 places at that exact policy's predicted address, which is
    ///         why it can be permissionless without becoming a griefing lever: no third party can raise
    ///         another job's floor or spend another job's acceptance, because no third party can be at that
    ///         address. Consuming sets the floor above the funded nonce, so (a) this generation can never be
    ///         re-funded and (b) every OLDER generation is invalidated — "a newer nonce invalidates older
    ///         ones", enforced on-chain rather than by convention.
    ///
    /// @dev    WAVE 4a — WHY THE VERIFICATION LIVES HERE AND NOT IN THE ESCROW.
    ///         The escrow implementation is the size-scarce artifact (one EIP-170-bounded runtime shared by
    ///         every clone); the factory is deployed once per incarnation and its size is amortized over
    ///         every job. Moving the EIP-712 machinery here costs NOTHING in trust because all three
    ///         preconditions were already true before Wave 4a:
    ///           1. the escrow ALREADY called this function on the funding path (nonce consumption), so
    ///              there is no new call, no new dependency and no new liveness surface;
    ///           2. the escrow ALREADY trusts this factory unconditionally — `factory` is an implementation
    ///              immutable and `initialize()` is gated to it;
    ///           3. `msg.sender == _predict(p)` is a SELF-CONSISTENCY PROOF, unchanged from rev-3: the only
    ///              CREATE2 this factory ever performs is `cloneDeterministic(implementation, salt)`, so the
    ///              init-code hash is fixed and an address matching the prediction can only hold the
    ///              EIP-1167 proxy delegating to `implementation`. The caller therefore provably runs the
    ///              trusted implementation code, and `p` provably IS that clone's own stored identity.
    ///         (3) is what makes the two escrow-derived arguments safe: `unitsRoot` is a pure function of
    ///         the configs whose keccak the escrow just checked against `p.prePolicyRoot` (which is inside
    ///         the salt), and `funder` is the `fund()` caller as reported by that same proven code.
    ///
    ///         The digest is still the ESCROW's: `verifyingContract == msg.sender` (the clone) and the
    ///         domain name/version are the shared pins in {VNextSettlementLib}. Every signature that
    ///         validated before Wave 4a validates now, byte for byte — no off-chain builder changes.
    ///
    ///         NON-SKIPPABLE: `fund()` reaches a funded state only through this call, and this call reverts
    ///         unless both legs verify. The check order is the pre-Wave-4a order verbatim (self-adjudication
    ///         -> expiry -> nonce floor + consume -> payer leg -> operator leg); any revert rolls the whole
    ///         funding transaction back, so "verifies both signatures AND consumes the nonce atomically"
    ///         remains structural rather than sequential.
    ///
    /// @param p                      the clone's bilateral policy identity (proven to be its own by (3)).
    /// @param unitsRoot              the rolling commitment over the settlementUnitIds the clone just froze.
    /// @param funder                 the `fund()` caller. The payer leg is implicit ONLY when it IS the
    ///                               payer; every other funder must carry an explicit payer signature.
    /// @param expiry                 the acceptance's own deadline (inside the signed hash).
    /// @param allowSelfAdjudication  both parties' deliberate acceptance of arbiter == payer/operator
    ///                               (inside the signed hash, so it can never be supplied by the sender
    ///                               alone).
    /// @return jobPolicyHash the EIP-712 struct hash both parties authenticated; the clone stores it as its
    ///         on-chain record that acceptance happened.
    function acceptPolicy(
        PolicyIdentity calldata p,
        bytes32 unitsRoot,
        address funder,
        uint256 expiry,
        bool allowSelfAdjudication,
        bytes calldata payerSignature,
        bytes calldata operatorSignature
    ) external returns (bytes32 jobPolicyHash) {
        address escrow = _predict(p);
        if (msg.sender != escrow) revert NotThePolicyEscrow();

        // "Address inequality is not independence": an arbiter that IS one of the parties is a costless
        // veto (or a self-release), so it is rejected unless BOTH parties signed a policy that says so.
        // The flag lives inside the signed hash, so it can never be supplied by whoever sends the tx alone.
        if (!allowSelfAdjudication && (p.arbiter == p.payer || p.arbiter == p.operator)) {
            revert SelfAdjudicationNotAccepted();
        }
        if (block.timestamp > expiry) revert PolicyExpired();

        bytes32 k = VNextSettlementLib.computePolicyKey(p.payer, p.operator, p.jobIdHash);
        if (p.policyNonce < policyNonceFloor[k]) revert PolicyNoLongerValid();
        policyNonceFloor[k] = p.policyNonce + 1; // checked (0.8)
        emit PolicyNonceConsumed(k, escrow, p.policyNonce);

        jobPolicyHash = _hashJobPolicy(p, escrow, unitsRoot, allowSelfAdjudication, expiry);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(escrow), jobPolicyHash));
        // Delegated/agent funding: an absent payer signature was already rejected as `OnlyPayer` at the
        // escrow's entry; a present one must actually validate. A direct payer-sent tx authenticates itself.
        if (funder != p.payer && !_isValidSignature(p.payer, digest, payerSignature)) revert BadSignature();
        // The operator NEVER sends this transaction, so its acceptance is always an explicit signature —
        // ECDSA for an EOA, ERC-1271 for a smart account (both handled by `_isValidSignature`).
        if (!_isValidSignature(p.operator, digest, operatorSignature)) revert BadOperatorSignature();
    }

    /// @notice Validate `signer`'s EIP-712 signature over `structHash` in the CALLING CLONE's domain —
    ///         the residual signature surface (`approveByBuyer`, `rotateClaimDestination`) that Wave 4a's
    ///         `acceptPolicy` move left behind in the escrow.
    /// @dev    Same lever, same trust: the escrow implementation is the EIP-170-bounded per-clone artifact
    ///         and `factory` is one of its immutables, so this is a call it could already make and to a
    ///         contract it already trusts unconditionally. `verifyingContract` is `msg.sender`, i.e. the
    ///         clone itself, so the digest is byte-identical to the one the clone computed for itself
    ///         before Wave 4a and every signature that validated then validates now.
    ///
    ///         Deliberately a PREDICATE, not an authorization. It returns a bool, writes nothing, and
    ///         reads no escrow state — the caller keeps ownership of which error a `false` means and of
    ///         every binding/nonce/expiry check around it, all of which stay in the clone. It is `view`
    ///         and permissionless because it can only ever restate what its caller already holds: a
    ///         signature, and the hash that signature is over.
    function verifyCloneSignature(address signer, bytes32 structHash, bytes calldata signature)
        external
        view
        returns (bool)
    {
        return _isValidSignature(
            signer, keccak256(abi.encodePacked("\x19\x01", _domainSeparator(msg.sender), structHash)), signature
        );
    }

    /// @dev EIP-712 struct hash of the frozen policy, over the CLONE's domain. Split into two
    ///      `abi.encode` calls to avoid stack-too-deep; all 16 words are static, so
    ///      `bytes.concat(abi.encode(..), abi.encode(..))` equals `abi.encode(all 16)` and the EIP-712 hash
    ///      is identical. This is the pre-Wave-4a `VNextSettlementEscrow._hashJobPolicy` verbatim, with
    ///      `address(this)`/`implementation` now read from the factory and the clone address passed in.
    function _hashJobPolicy(
        PolicyIdentity calldata p,
        address escrow,
        bytes32 unitsRoot,
        bool allowSelfAdjudication,
        uint256 expiry
    ) private view returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    VNextSettlementLib.JOB_POLICY_TYPEHASH,
                    block.chainid,
                    address(this),
                    implementation,
                    escrow,
                    VNextSettlementLib.POLICY_VERSION_V1,
                    p.payer,
                    p.operator
                ),
                abi.encode(
                    p.arbiter, p.jobIdHash, p.termsHash, p.policyNonce, p.prePolicyRoot, unitsRoot,
                    allowSelfAdjudication, expiry
                )
            )
        );
    }

    /// @dev The CLONE's EIP-712 domain — `verifyingContract` is the escrow, not this factory, so the
    ///      digest is unchanged from rev-3 and a signature is still bound to one specific clone.
    function _domainSeparator(address escrow) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                VNextSettlementLib.EIP712_DOMAIN_TYPEHASH,
                VNextSettlementLib.EIP712_NAME_HASH,
                VNextSettlementLib.EIP712_VERSION_HASH,
                block.chainid,
                escrow
            )
        );
    }

    /// @dev Validate `signer`'s signature over `digest`: ERC-1271 for contracts (strict 32-byte magic
    ///      word, rejecting dirty padding), malleability-guarded ECDSA for EOAs. Verbatim from the
    ///      pre-Wave-4a escrow — the escrow retains its own copy for `approveByBuyer` /
    ///      `rotateClaimDestination`, whose digests are still verified in the clone.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            return ok && ret.length == 32 && abi.decode(ret, (bytes32)) == bytes32(VNextSettlementLib.ERC1271_MAGIC);
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 vByte;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            vByte := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > VNextSettlementLib.ECDSA_S_MAX) return false;
        if (vByte != 27 && vByte != 28) return false;
        address recovered = ecrecover(digest, vByte, r, s);
        return recovered != address(0) && recovered == signer;
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
