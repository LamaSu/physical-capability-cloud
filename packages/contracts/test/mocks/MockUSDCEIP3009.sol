// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/interfaces/IERC20.sol";

/**
 * @title MockUSDCEIP3009
 * @notice A USDC-faithful ERC-20 test mock that implements the EIP-3009
 *         `receiveWithAuthorization` flow PCCForwarder depends on.
 *
 *         src/MockUSDC.sol is a plain ERC-20 with no EIP-3009 surface, so it
 *         cannot exercise the forwarder's pull-payment path. Rather than modify
 *         that shared mock (used by many other test suites), this is an additive
 *         test-only mock. It:
 *           - verifies a real EIP-712 `ReceiveWithAuthorization` signature,
 *           - enforces `to == msg.sender` (the property that binds the
 *             authorization to the calling forwarder — it cannot be front-run),
 *           - tracks per-(from, nonce) authorization state (USDC's own replay
 *             protection), and
 *           - actually moves the funds,
 *         so the forwarder tests exercise the genuine two-signature flow.
 *
 *         Mirrors the authorization surface of Circle's FiatTokenV2. The EIP-712
 *         domain uses name "USD Coin" / version "2"; tests sign against
 *         `DOMAIN_SEPARATOR()` so the exact strings are not load-bearing.
 */
contract MockUSDCEIP3009 is IERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;
    uint256 private _totalSupply;

    /// @notice EIP-3009 authorization state: from => nonce => used.
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @notice Canonical EIP-3009 ReceiveWithAuthorization typehash.
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor(uint256 initialSupply) {
        _mint(msg.sender, initialSupply);
    }

    // ── IERC20 ───────────────────────────────────────────────────────────

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner_, address spender) external view override returns (uint256) {
        return _allowances[owner_][spender];
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "Insufficient allowance");
        _allowances[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ── EIP-3009 ─────────────────────────────────────────────────────────

    /// @notice EIP-712 domain separator for this token on the current chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice Receive a transfer via a payer's off-chain EIP-3009 authorization.
     * @dev Requires the caller to be the payee (`to == msg.sender`) — this is
     *      what lets the forwarder consume the authorization without a relayer
     *      front-running it into a bare transfer. The signature must recover to
     *      `from`, the (from, nonce) must be unused, and now must be within
     *      (validAfter, validBefore).
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "EIP3009: caller must be the payee");
        require(block.timestamp > validAfter, "EIP3009: authorization not yet valid");
        require(block.timestamp < validBefore, "EIP3009: authorization expired");
        require(!authorizationState[from][nonce], "EIP3009: authorization used");

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "EIP3009: invalid signature");

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
        emit AuthorizationUsed(from, nonce);
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _transfer(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "Insufficient balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        _totalSupply += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
