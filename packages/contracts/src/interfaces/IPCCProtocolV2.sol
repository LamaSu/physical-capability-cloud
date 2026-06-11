// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPCCOracle} from "./IPCCOracle.sol";

/**
 * @title IPCCProtocolV2
 * @notice Interface for the PCCProtocolV2 root contract.
 * @dev Called by V2 factory-deployed escrows (MilestoneEscrowV2) during settlement.
 *      Mirrors IPCCProtocol but ADDS `collectFee(token, fee)` — the lightweight
 *      accounting hook used by V2 escrows whose release gate already validated an
 *      EAS attestation on-chain (no need to re-verify via IPCCOracle.Attestation).
 *      `collectFeeWithAttestation` is RETAINED for V1-parity callers / migration.
 */
interface IPCCProtocolV2 {
    /// @notice The immutable fee recipient address.
    function feeRecipient() external view returns (address);

    /// @notice Current protocol fee in basis points (e.g. 150 = 1.5%).
    function protocolFeeBps() external view returns (uint256);

    /// @notice The immutable oracle verifier contract address (V1 parity).
    function oracleVerifier() external view returns (address);

    /**
     * @notice Lightweight fee accounting for V2 escrows. The EAS release gate
     *         on the escrow already validated the oracle's attestation on-chain.
     * @param token The ERC-20 token in which the fee was collected.
     * @param fee The fee amount transferred to the fee recipient.
     */
    function collectFee(address token, uint256 fee) external;

    /**
     * @notice Oracle-gated fee accounting (V1 parity). Retained so migrations
     *         from V1 to V2 can co-exist via a shared PCCProtocolV2 root.
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
