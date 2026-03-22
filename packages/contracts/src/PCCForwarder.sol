// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";

/**
 * @title PCCForwarder
 * @notice Payment-Gated Transaction Relay (ERC-8194) forwarder for PCC.
 *
 * This contract enables keyless agent authentication by bundling EIP-3009
 * USDC payment authorizations with target contract calls. The flow:
 *
 *   1. Agent signs an EIP-3009 transferWithAuthorization for USDC
 *   2. Relayer submits the signed auth + target calldata to relay()
 *   3. PCCForwarder:
 *      a. Verifies the receipt hash (payer + target + selector + amount + nonce + chainId)
 *      b. Executes the USDC transferWithAuthorization
 *      c. Sets _currentSender to the payer
 *      d. Calls the target contract
 *      e. Resets _currentSender
 *      f. Emits PaymentGatedCall event
 *
 * Improvements over reference implementation:
 *   - Multiple authorized relayers (not just one)
 *   - Trusted target whitelist (prevents relay to arbitrary contracts)
 *   - Chain ID in receipt hash (cross-chain replay protection)
 *   - Reentrancy guard
 *   - Owner-managed relayer and target lists
 */
contract PCCForwarder is IPGTRForwarder {
    // ── State ────────────────────────────────────────────────────────────

    address public owner;
    IERC20 public usdc;

    /// @notice Authorized relayers that can call relay()
    mapping(address => bool) public authorizedRelayers;

    /// @notice Trusted target contracts that can be called via relay()
    mapping(address => bool) public trustedTargets;

    /// @notice The original sender during a relay() call. Reset to address(0) after.
    address private _currentSender;

    /// @notice Reentrancy lock
    bool private _locked;

    /// @notice Used nonces to prevent replay attacks
    mapping(bytes32 => bool) public usedNonces;

    // ── Events ───────────────────────────────────────────────────────────

    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "PCCForwarder: not owner");
        _;
    }

    modifier onlyRelayer() {
        require(authorizedRelayers[msg.sender], "PCCForwarder: not authorized relayer");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "PCCForwarder: reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(address _usdc, address _owner) {
        require(_usdc != address(0), "PCCForwarder: zero USDC address");
        require(_owner != address(0), "PCCForwarder: zero owner address");
        usdc = IERC20(_usdc);
        owner = _owner;
    }

    // ── IPGTRForwarder ──────────────────────────────────────────────────

    function isPGTRForwarder() external pure override returns (bool) {
        return true;
    }

    function pgtrSender() external view override returns (address) {
        return _currentSender;
    }

    function isTrustedForwarder(address addr) external view override returns (bool) {
        return addr == address(this);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "PCCForwarder: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addRelayer(address relayer) external onlyOwner {
        require(relayer != address(0), "PCCForwarder: zero address");
        authorizedRelayers[relayer] = true;
        emit RelayerAdded(relayer);
    }

    function removeRelayer(address relayer) external onlyOwner {
        authorizedRelayers[relayer] = false;
        emit RelayerRemoved(relayer);
    }

    function addTarget(address target) external onlyOwner {
        require(target != address(0), "PCCForwarder: zero address");
        trustedTargets[target] = true;
        emit TargetAdded(target);
    }

    function removeTarget(address target) external onlyOwner {
        trustedTargets[target] = false;
        emit TargetRemoved(target);
    }

    // ── Relay ────────────────────────────────────────────────────────────

    /**
     * @notice Relay a payment-gated transaction.
     *
     * @param payer         The address authorizing the USDC payment (EIP-3009 `from`)
     * @param target        The target contract to call
     * @param callData      The encoded function call for the target
     * @param paymentAmount The USDC amount to transfer from payer to this contract
     * @param nonce         A unique nonce (EIP-3009 nonce, also used for replay protection)
     * @param expiry        Timestamp after which this relay request is invalid
     * @param v             EIP-3009 signature v
     * @param r             EIP-3009 signature r
     * @param s             EIP-3009 signature s
     *
     * @return result       The return data from the target contract call
     */
    function relay(
        address payer,
        address target,
        bytes calldata callData,
        uint256 paymentAmount,
        bytes32 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyRelayer nonReentrant returns (bytes memory result) {
        // Validate inputs
        require(payer != address(0), "PCCForwarder: zero payer");
        require(trustedTargets[target], "PCCForwarder: untrusted target");
        require(block.timestamp <= expiry, "PCCForwarder: expired");

        // Build receipt hash with chain ID for cross-chain replay protection
        bytes32 receiptHash = keccak256(abi.encodePacked(
            payer,
            target,
            bytes4(callData[:4]),
            paymentAmount,
            nonce,
            block.chainid
        ));
        require(!usedNonces[receiptHash], "PCCForwarder: receipt already used");
        usedNonces[receiptHash] = true;

        // Execute EIP-3009 transferWithAuthorization via USDC
        // This transfers USDC from payer to this contract
        if (paymentAmount > 0) {
            // Call transferWithAuthorization on USDC contract
            // EIP-3009: transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)
            (bool transferSuccess, ) = address(usdc).call(
                abi.encodeWithSignature(
                    "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                    payer,           // from
                    address(this),   // to (this contract receives the payment)
                    paymentAmount,   // value
                    uint256(0),      // validAfter (immediate)
                    expiry,          // validBefore
                    nonce,           // nonce
                    v, r, s          // signature
                )
            );
            require(transferSuccess, "PCCForwarder: USDC transfer failed");
        }

        // Set the PGTR sender so the target can identify the real caller
        _currentSender = payer;

        // Forward the call to the target contract
        bool success;
        (success, result) = target.call(callData);
        require(success, "PCCForwarder: target call failed");

        // Reset sender
        _currentSender = address(0);

        // Extract function selector for event
        bytes4 selector = bytes4(callData[:4]);

        emit PaymentGatedCall(payer, target, selector, paymentAmount);

        return result;
    }
}
