// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title PCCForwarder
 * @notice Payment-Gated Transaction Relay (ERC-8194) forwarder for PCC.
 *
 * ── SECURITY REWRITE (audit P0: C-04 + H-01) — REVIEW ONLY, NOT DEPLOYED ──
 *
 * This is a corrected forwarder authored for the P0 remediation review. It is
 * NOT an upgrade of the deployed contract — adopting it requires a NEW
 * deployment (see the migration TODOs at the bottom). The two verified bugs it
 * fixes:
 *
 *   C-04 (Critical) — In the previous version the ONLY signature was the
 *   EIP-3009 `transferWithAuthorization` sig, whose signed struct is
 *   `(from, to, value, validAfter, validBefore, nonce)`. `target` and
 *   `callData` were NEVER signed — the contract computed a local `receiptHash`
 *   over them but used it only for replay bookkeeping, never verifying a payer
 *   signature over it. A rogue/compromised authorized relayer could therefore
 *   take a valid payer payment authorization and pair it with ANY other
 *   trusted target + arbitrary calldata, executing an unintended action under
 *   the payer's identity (`pgtrSender()`).
 *
 *   H-01 (High → Critical at volume) — USDC was pulled to `address(this)` and
 *   the contract had NO withdraw / sweep / refund / payout / approve of any
 *   kind. Every nonzero payment was permanently trapped; not even the owner
 *   could rescue it.
 *
 * ── The fix ──────────────────────────────────────────────────────────────
 *
 * 1. The payer now signs a versioned EIP-712 `ExecutionIntent` binding
 *    {payer, token, recipient, target, keccak256(callData), amount, nonce,
 *    deadline}. `chainId` and `verifyingContract` are bound via the EIP-712
 *    domain. The forwarder verifies this signature BEFORE moving money or
 *    executing, and requires `keccak256(callData) == intent.callDataHash`.
 *    => Changing any of {target, one calldata byte, amount, token, recipient,
 *       chain, forwarder} changes the digest and invalidates the signature.
 *
 * 2. The intent digest is consumed in `usedIntents` (effects-before-
 *    interactions), so a signed intent executes at most once — no replay.
 *
 * 3. USDC is pulled with EIP-3009 `receiveWithAuthorization` (which requires
 *    `msg.sender == to`, so the authorization cannot be front-run away from
 *    this contract) and then routed to the signed `recipient` in the same
 *    transaction. If the target call reverts, the whole transaction reverts
 *    and the payment unwinds — payment and action are atomic. => Funds are
 *    never trapped; every settled payment is attributable to a `recipient`.
 *
 * 4. A governed `sweepStuckTokens` exists ONLY to rescue genuinely-stuck
 *    balances (e.g. tokens sent directly to the contract). It is not the
 *    payment path: in normal operation the forwarder holds ~0 between
 *    transactions because each relay forwards atomically.
 *
 * The domain is versioned ("2"). The legacy EIP-3009-only flow is structurally
 * rejected: `relay` cannot execute without a valid v2 `ExecutionIntent`
 * signature, and no such signature exists for the old scheme.
 *
 * Retained from the previous version: multiple authorized relayers, a trusted
 * target allowlist, a reentrancy guard, and owner-managed relayer/target lists.
 */
contract PCCForwarder is IPGTRForwarder {
    using SafeERC20 for IERC20;

    // ── Types ────────────────────────────────────────────────────────────

    /**
     * @notice The payer-signed, EIP-712-typed authorization for a single
     *         payment-gated call. Every field is bound by the signature.
     * @param payer        Signer + source of the USDC payment (EIP-3009 `from`).
     * @param token        The ERC-20 used to pay. MUST equal `usdc`.
     * @param recipient    Who receives the USDC. Prevents trapped funds (H-01).
     * @param target       The contract to call (must be a trusted target).
     * @param callDataHash keccak256 of the exact calldata to execute (C-04).
     * @param amount       USDC amount to move payer -> recipient.
     * @param nonce        Unique per authorization; also the EIP-3009 nonce.
     * @param deadline     Unix time after which the intent is invalid.
     */
    struct ExecutionIntent {
        address payer;
        address token;
        address recipient;
        address target;
        bytes32 callDataHash;
        uint256 amount;
        bytes32 nonce;
        uint256 deadline;
    }

    // ── EIP-712 constants ────────────────────────────────────────────────

    /// @notice Human-readable domain name (bound into every signature).
    string public constant DOMAIN_NAME = "PCCForwarder";

    /// @notice Domain version. v2 is the signed-intent scheme; the unsafe
    ///         EIP-3009-only v1 flow is not accepted by this contract.
    string public constant DOMAIN_VERSION = "2";

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant EXECUTION_INTENT_TYPEHASH = keccak256(
        "ExecutionIntent(address payer,address token,address recipient,address target,bytes32 callDataHash,uint256 amount,bytes32 nonce,uint256 deadline)"
    );

    /// @dev Cached domain separator + the chain id it was built for. Rebuilt
    ///      on the fly if the chain forks (chainid changes).
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

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

    /// @notice Consumed intent digests — a signed intent executes at most once.
    ///         Keyed by the full EIP-712 digest (covers amount==0 intents too,
    ///         where USDC's own nonce is never spent).
    mapping(bytes32 => bool) public usedIntents;

    // ── Events ───────────────────────────────────────────────────────────

    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted for every nonzero payment, making it attributable to a
    ///         recipient on-chain (H-01: no unaccounted / trapped funds).
    event PaymentRouted(
        address indexed payer,
        address indexed recipient,
        address indexed token,
        uint256 amount,
        bytes32 nonce
    );

    /// @notice Emitted when the owner rescues a genuinely-stuck token balance.
    event TokensSwept(address indexed token, address indexed to, uint256 amount);

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

        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
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
        // A trusted target must never be the token or this contract itself —
        // that would let a relayed call move the forwarder's own balance or
        // re-enter admin surface. Defense-in-depth alongside the per-relay check.
        require(target != address(usdc), "PCCForwarder: target is token");
        require(target != address(this), "PCCForwarder: target is self");
        trustedTargets[target] = true;
        emit TargetAdded(target);
    }

    function removeTarget(address target) external onlyOwner {
        trustedTargets[target] = false;
        emit TargetRemoved(target);
    }

    /**
     * @notice Owner rescue for genuinely-stuck token balances (e.g. tokens
     *         transferred directly to this contract, or a legacy balance).
     * @dev NOT the payment path. In normal operation the forwarder holds ~0
     *      between transactions because each relay() forwards to `recipient`
     *      atomically, so there is no in-flight user money for the owner to
     *      take here.
     *
     *      TODO(audit P0 follow-up, Wave 2): if this logic is ever deployed to
     *      an address that already holds legacy trapped USDC, decide governance
     *      (timelock/multisig owner) and a per-recipient refund accounting for
     *      those specific legacy balances rather than a single owner sweep.
     */
    function sweepStuckTokens(IERC20 token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "PCCForwarder: zero sweep recipient");
        require(amount > 0, "PCCForwarder: zero sweep amount");
        token.safeTransfer(to, amount);
        emit TokensSwept(address(token), to, amount);
    }

    // ── EIP-712 helpers (public for off-chain signers / tests) ───────────

    /// @notice The EIP-712 domain separator for the current chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (block.chainid == _CACHED_CHAIN_ID) {
            return _CACHED_DOMAIN_SEPARATOR;
        }
        return _buildDomainSeparator();
    }

    /// @notice The exact digest the payer must sign for a given intent. Lets
    ///         off-chain signers and tests reproduce verification input.
    function hashIntent(ExecutionIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_INTENT_TYPEHASH,
                intent.payer,
                intent.token,
                intent.recipient,
                intent.target,
                intent.callDataHash,
                intent.amount,
                intent.nonce,
                intent.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(DOMAIN_NAME)),
                keccak256(bytes(DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    // ── Relay ────────────────────────────────────────────────────────────

    // TODO(audit P0 follow-up, Wave 2): architectural remainder NOT done in this pass —
    //  (1) MIGRATION: this is a new contract, not an upgrade. Adopting it is a fresh
    //      deployment + a new `verifyingContract`; any legacy forwarder's trapped USDC
    //      must be rescued/refunded out-of-band before decommissioning it.
    //  (2) OFF-CHAIN: the `relay` ABI, `usedNonces`->`usedIntents`, and the new
    //      ExecutionIntent struct change the generated ABI. Regenerate
    //      packages/contracts/ts/abi/PCCForwarder.ts and update every TS/relayer caller
    //      + the payer signing SDK to produce the EIP-712 ExecutionIntent AND the
    //      EIP-3009 receiveWithAuthorization signature. (abi.test.ts will need updating.)
    //  (3) TESTS: MockUSDC does NOT implement EIP-3009 (receiveWithAuthorization) — add a
    //      mock that does, then add Foundry tests asserting the acceptance criteria
    //      (mutate target/1 calldata byte/amount/token/chain/verifyingContract -> reverts;
    //      replay -> reverts; recipient receives funds; amount==0 identity path).
    //  (4) ALTERNATIVE to consider in review: a single-signature variant using
    //      transferFrom + a prior payer approve (or Permit2) would route payer->recipient
    //      directly (no transient custody) at the cost of the EIP-3009 gasless model.
    //  (5) INDEPENDENT CONTRACT REVIEW REQUIRED before any deployment (see notes).

    /**
     * @notice Relay a payment-gated transaction against a payer-signed intent.
     *
     * @param intent    The payer-signed ExecutionIntent (see struct docs).
     * @param callData  The exact calldata to forward to `intent.target`.
     *                  MUST hash to `intent.callDataHash` (C-04 binding).
     * @param intentV   ExecutionIntent EIP-712 signature `v` (payer's key).
     * @param intentR   ExecutionIntent EIP-712 signature `r`.
     * @param intentS   ExecutionIntent EIP-712 signature `s`.
     * @param payV      EIP-3009 `receiveWithAuthorization` signature `v`.
     * @param payR      EIP-3009 signature `r`.
     * @param payS      EIP-3009 signature `s`.
     *
     * @return result   The return data from the target contract call.
     *
     * @dev Two payer signatures are required and are bound to each other by the
     *      forwarder passing `intent.{payer,amount,nonce,deadline}` verbatim
     *      into the USDC authorization:
     *        - `intentV/R/S` — over the EIP-712 ExecutionIntent (verified here);
     *          this is what binds target + callData + recipient (C-04).
     *        - `payV/R/S` — over EIP-3009 ReceiveWithAuthorization (verified by
     *          USDC); this is what actually moves the money. USDC's signed
     *          struct cannot carry target/callData, which is exactly why the
     *          separate ExecutionIntent is necessary.
     */
    function relay(
        ExecutionIntent calldata intent,
        bytes calldata callData,
        uint8 intentV,
        bytes32 intentR,
        bytes32 intentS,
        uint8 payV,
        bytes32 payR,
        bytes32 payS
    ) external onlyRelayer nonReentrant returns (bytes memory result) {
        // ── Validate intent shape ──
        require(intent.payer != address(0), "PCCForwarder: zero payer");
        require(intent.recipient != address(0), "PCCForwarder: zero recipient"); // H-01: funds must have a home
        require(intent.token == address(usdc), "PCCForwarder: unexpected token");
        require(trustedTargets[intent.target], "PCCForwarder: untrusted target");
        require(intent.target != address(usdc), "PCCForwarder: target is token");
        require(intent.target != address(this), "PCCForwarder: target is self");
        require(block.timestamp <= intent.deadline, "PCCForwarder: expired");
        // C-04: the executed calldata is exactly what the payer signed.
        require(keccak256(callData) == intent.callDataHash, "PCCForwarder: calldata mismatch");

        // ── C-04 core: verify the payer's EIP-712 ExecutionIntent signature ──
        bytes32 digest = hashIntent(intent);
        address signer = _recover(digest, intentV, intentR, intentS);
        require(signer != address(0) && signer == intent.payer, "PCCForwarder: bad intent signature");

        // ── Bind + consume nonce (no replay). Effects before interactions. ──
        require(!usedIntents[digest], "PCCForwarder: intent already used");
        usedIntents[digest] = true;

        // ── Pull the payment and route it to the signed recipient (H-01) ──
        if (intent.amount > 0) {
            uint256 balBefore = usdc.balanceOf(address(this));

            // EIP-3009 receiveWithAuthorization requires msg.sender == `to`, so
            // this authorization can only be consumed by THIS contract — it
            // cannot be front-run into a bare transfer that decouples payment
            // from the gated action. Called low-level so IERC20 need not
            // declare the EIP-3009 surface (matches USDC's real ABI).
            (bool ok, ) = address(usdc).call(
                abi.encodeWithSignature(
                    "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
                    intent.payer,      // from
                    address(this),     // to (must be msg.sender == this)
                    intent.amount,     // value
                    uint256(0),        // validAfter (immediate)
                    intent.deadline,   // validBefore
                    intent.nonce,      // nonce (USDC's own replay protection)
                    payV, payR, payS   // EIP-3009 signature
                )
            );
            require(ok, "PCCForwarder: USDC auth failed");

            uint256 received = usdc.balanceOf(address(this)) - balBefore;
            require(received >= intent.amount, "PCCForwarder: short receive");

            // Forward to the payer-signed recipient. Never retained here.
            usdc.safeTransfer(intent.recipient, intent.amount);
            emit PaymentRouted(intent.payer, intent.recipient, intent.token, intent.amount, intent.nonce);
        }

        // ── Execute the exact signed action under the payer identity ──
        _currentSender = intent.payer;
        bool success;
        (success, result) = intent.target.call(callData);
        _currentSender = address(0);
        // On failure the whole tx reverts, unwinding the payment above:
        // payment and action are atomic.
        require(success, "PCCForwarder: target call failed");

        bytes4 selector = callData.length >= 4 ? bytes4(callData[0:4]) : bytes4(0);
        emit PaymentGatedCall(intent.payer, intent.target, selector, intent.amount);

        return result;
    }

    // ── ECDSA recovery (self-contained, mirrors PCCVerificationOracle) ────

    /**
     * @dev Recover the signer from (v, r, s). Returns address(0) on a malleable
     *      (upper-half s) or malformed (v not in {27,28}) signature, so the
     *      caller's `signer == payer` check fails closed.
     */
    function _recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) private pure returns (address) {
        // Reject s-values in the upper half (malleability guard, EIP-2).
        if (
            uint256(s) >
            0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        ) {
            return address(0);
        }
        if (v != 27 && v != 28) {
            return address(0);
        }
        return ecrecover(hash, v, r, s);
    }
}
