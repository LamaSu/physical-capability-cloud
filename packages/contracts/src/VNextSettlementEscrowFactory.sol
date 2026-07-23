// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "./libraries/Clones.sol";
import {VNextSettlementEscrow} from "./VNextSettlementEscrow.sol";

/**
 * @title VNextSettlementEscrowFactory
 * @notice Deploys the V-next settlement-escrow implementation once (initializer-locked) and clones it
 *         per job via EIP-1167 CREATE2. Each clone gets a unique, deterministic address derived from the
 *         job identity — the deployment-incarnation binding for the frozen-spec §10.12 H1 replay model
 *         (a per-job, non-selfdestructing clone ⇒ no CREATE2 address reuse on post-Cancun Base).
 * @dev    The factory deploys the implementation in its constructor, so the implementation's `factory`
 *         immutable == this factory; `initialize()` is therefore factory-gated to this contract only.
 */
contract VNextSettlementEscrowFactory {
    /// @notice The shared, initializer-locked escrow implementation every clone delegatecalls.
    address public immutable implementation;

    event EscrowCreated(address indexed escrow, address indexed payer, bytes32 indexed jobIdHash, bytes32 salt);

    /// @param usdc / eas / oracle / o5SchemaUid / o5TypeHash — the implementation immutables shared by every clone.
    constructor(address usdc, address eas, address oracle, bytes32 o5SchemaUid, bytes32 o5TypeHash) {
        implementation = address(new VNextSettlementEscrow(usdc, eas, oracle, o5SchemaUid, o5TypeHash));
    }

    /// @notice Clone + initialize a per-job escrow atomically. Permissionless: a fresh clone holds no
    ///         funds until the payer funds it (`fund()` is payer-gated), so creating one is harmless.
    ///         A duplicate `(payer, jobIdHash, termsHash)` reverts (CREATE2 collision) — one escrow per job.
    function createEscrow(address payer, address arbiter, bytes32 jobIdHash, bytes32 termsHash)
        external
        returns (address escrow)
    {
        bytes32 salt = _salt(payer, jobIdHash, termsHash);
        escrow = Clones.cloneDeterministic(implementation, salt);
        VNextSettlementEscrow(escrow).initialize(payer, arbiter, jobIdHash, termsHash);
        emit EscrowCreated(escrow, payer, jobIdHash, salt);
    }

    /// @notice Precompute the clone address for a job before it is created.
    function predictEscrow(address payer, bytes32 jobIdHash, bytes32 termsHash) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(payer, jobIdHash, termsHash), address(this));
    }

    function _salt(address payer, bytes32 jobIdHash, bytes32 termsHash) private pure returns (bytes32) {
        return keccak256(abi.encode(payer, jobIdHash, termsHash));
    }
}
