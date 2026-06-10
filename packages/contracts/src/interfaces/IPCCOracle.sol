// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPCCOracle {
    struct Attestation {
        address escrowAddress;
        string jobId;
        bytes32 evidenceHash;
        uint8 tier;
        bool verified;
        uint256 timestamp;
        bytes32 nonce;
        bytes signature;
    }

    /// @notice Verify an oracle attestation signature
    /// @param attestation The attestation to verify
    /// @return valid True if the signature is from the authorized oracle
    function verifyAttestation(
        Attestation calldata attestation
    ) external view returns (bool valid);

    /// @notice Get the oracle's signing address
    function oracleAddress() external view returns (address);
}
