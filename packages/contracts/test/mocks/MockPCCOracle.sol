// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPCCOracle} from "../../src/interfaces/IPCCOracle.sol";

/**
 * @title MockPCCOracle
 * @notice Deterministic oracle verifier for tests. Accepts or rejects
 *         attestations based on a toggle, and can be flipped mid-test to
 *         exercise the fail-closed path.
 *
 * Do NOT deploy to production — this is a test-only stub.
 */
contract MockPCCOracle is IPCCOracle {
    address public immutable override oracleAddress;
    bool public valid;

    constructor(address _oracleAddress, bool _initialValid) {
        oracleAddress = _oracleAddress;
        valid = _initialValid;
    }

    function setValid(bool _valid) external {
        valid = _valid;
    }

    function verifyAttestation(Attestation calldata attestation)
        external
        view
        override
        returns (bool)
    {
        // Basic sanity + toggle. Requires "verified" flag to mirror what a
        // real oracle would enforce; allows empty signature when valid=true
        // so tests don't need to produce a real secp256k1 sig.
        if (!valid) return false;
        if (!attestation.verified) return false;
        if (attestation.escrowAddress == address(0)) return false;
        return true;
    }
}
