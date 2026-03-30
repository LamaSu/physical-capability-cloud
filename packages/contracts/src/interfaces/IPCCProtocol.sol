// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title IPCCProtocol
 * @notice Interface for the PCCProtocol root contract.
 * @dev Called by MilestoneEscrow during settlement to read fee parameters
 *      and record fee accounting.
 */
interface IPCCProtocol {
    /// @notice The immutable fee recipient address.
    function feeRecipient() external view returns (address);

    /// @notice Current protocol fee in basis points (e.g. 150 = 1.5%).
    function protocolFeeBps() external view returns (uint256);

    /**
     * @notice Called by factory-deployed escrows after transferring the fee
     *         to the fee recipient. Records fee accounting on the root contract.
     * @param token The ERC-20 token in which the fee was collected.
     * @param fee The fee amount transferred to the fee recipient.
     */
    function collectFee(address token, uint256 fee) external;
}
