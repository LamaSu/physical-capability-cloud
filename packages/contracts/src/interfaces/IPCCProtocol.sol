// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IPCCOracle} from "./IPCCOracle.sol";

/**
 * @title IPCCProtocol
 * @notice Interface for the PCCProtocol root contract.
 * @dev Called by MilestoneEscrow during settlement to read fee parameters
 *      and record fee accounting via an oracle-gated path.
 */
interface IPCCProtocol {
    /// @notice The immutable fee recipient address.
    function feeRecipient() external view returns (address);

    /// @notice Current protocol fee in basis points (e.g. 150 = 1.5%).
    function protocolFeeBps() external view returns (uint256);

    /// @notice The immutable oracle verifier contract address.
    function oracleVerifier() external view returns (address);

    /**
     * @notice Oracle-gated fee accounting. Called by factory-deployed escrows
     *         after transferring the fee to the fee recipient. The attestation
     *         is re-verified on-chain via the oracle verifier; settlement fails
     *         closed if the signature is invalid.
     * @param token The ERC-20 token in which the fee was collected.
     * @param fee The fee amount transferred to the fee recipient.
     * @param attestation The oracle attestation proving the settlement is verified.
     */
    function collectFeeWithAttestation(
        address token,
        uint256 fee,
        IPCCOracle.Attestation calldata attestation
    ) external;
}
