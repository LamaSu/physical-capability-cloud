// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPGTRForwarder
 * @notice ERC-8194 Payment-Gated Transaction Relay forwarder interface.
 *
 * A PGTR forwarder accepts meta-transactions bundled with EIP-3009 payment
 * authorizations. It verifies the payment, executes the USDC transfer, then
 * forwards the call to the target contract with the original payer's identity
 * available via pgtrSender().
 *
 * Target contracts call pgtrSender() to recover the actual caller address
 * instead of relying on msg.sender (which is the forwarder contract).
 */
interface IPGTRForwarder {
    /**
     * @notice Returns true to identify this contract as a PGTR forwarder.
     */
    function isPGTRForwarder() external view returns (bool);

    /**
     * @notice Returns the original sender of the current PGTR-relayed call.
     * @dev Only valid during an active relay() execution. Returns address(0) otherwise.
     */
    function pgtrSender() external view returns (address);

    /**
     * @notice Check if an address is registered as a trusted forwarder.
     * @param addr The address to check.
     */
    function isTrustedForwarder(address addr) external view returns (bool);

    /**
     * @notice Emitted when a payment-gated call is successfully relayed.
     * @param payer The address that authorized the USDC payment.
     * @param target The contract that was called.
     * @param selector The 4-byte function selector that was called.
     * @param paymentAmount The USDC amount transferred.
     */
    event PaymentGatedCall(
        address indexed payer,
        address indexed target,
        bytes4 indexed selector,
        uint256 paymentAmount
    );
}
