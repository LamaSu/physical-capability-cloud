// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {PCCForwarder} from "../src/PCCForwarder.sol";
import {IPGTRForwarder} from "../src/interfaces/IPGTRForwarder.sol";
import {MockUSDCEIP3009} from "./mocks/MockUSDCEIP3009.sol";

/// @notice A trusted target for the forwarder to call. `ping` records the
///         payer identity it sees via pgtrSender() (proving the forwarder set
///         it); `boom` reverts (used to test payment unwind).
contract MockTarget {
    address public lastSender;
    uint256 public pings;

    function ping() external returns (string memory) {
        lastSender = IPGTRForwarder(msg.sender).pgtrSender();
        pings += 1;
        return "pong";
    }

    function boom() external pure {
        revert("MockTarget: boom");
    }
}

/// @notice ROUND-2 audit tests for PCCForwarder (C-04 action binding, H-01
///         recipient routing, review #7 self-recipient, review #8 nonce replay).
///         Uses a faithful EIP-3009 USDC mock so the two-signature path is real.
contract PCCForwarderTest is Test {
    PCCForwarder internal forwarder;
    MockUSDCEIP3009 internal usdc;
    MockTarget internal targetA;
    MockTarget internal targetB;

    uint256 internal constant PAYER_KEY = 0xA11CE;
    address internal payer;
    address internal relayer = address(0xBEEF);
    address internal recipient = address(0xCAFE);

    uint256 internal constant AMOUNT = 1_000e6;

    /// @dev A second payer identity, used to forge an EIP-3009 authorization
    ///      signed by the WRONG party — it must not settle against a valid intent.
    uint256 internal constant OTHER_KEY = 0xB0B;

    /// @dev secp256k1 group order N. For a canonical (low-s) signature, `N - s`
    ///      is the upper-half s of its malleable twin — exactly what the EIP-2
    ///      guard in PCCForwarder._recover must reject.
    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @dev Bundle of the two payer signatures relay() needs, so tests can sign
    ///      an intent ONCE, then mutate a field and submit with the stale
    ///      signatures — and to keep per-test stack depth shallow.
    struct Sigs {
        uint8 iv;
        bytes32 ir;
        bytes32 isig;
        uint8 pv;
        bytes32 pr;
        bytes32 psig;
    }

    function setUp() public {
        payer = vm.addr(PAYER_KEY);

        usdc = new MockUSDCEIP3009(10_000_000e6);
        usdc.mint(payer, 1_000_000e6);

        // This test contract is the owner.
        forwarder = new PCCForwarder(address(usdc), address(this));
        forwarder.addRelayer(relayer);

        targetA = new MockTarget();
        targetB = new MockTarget();
        forwarder.addTarget(address(targetA));
        forwarder.addTarget(address(targetB));
    }

    // ── Intent / signature helpers ─────────────────────────────────────────

    function _intent(
        address target,
        bytes memory callData,
        uint256 amount,
        bytes32 nonce,
        address to
    ) internal view returns (PCCForwarder.ExecutionIntent memory it) {
        it.payer = payer;
        it.token = address(usdc);
        it.recipient = to;
        it.target = target;
        it.callDataHash = keccak256(callData);
        it.amount = amount;
        it.nonce = nonce;
        it.deadline = block.timestamp + 1 hours;
    }

    /// @dev Sign the ExecutionIntent against a specific forwarder's domain.
    function _signIntentFor(PCCForwarder fwd, PCCForwarder.ExecutionIntent memory it)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        (v, r, s) = vm.sign(PAYER_KEY, fwd.hashIntent(it));
    }

    /// @dev Sign the EIP-3009 ReceiveWithAuthorization for a pull into `forwarder`.
    function _signPay(PCCForwarder.ExecutionIntent memory it)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                it.payer,
                address(forwarder), // to == the relaying forwarder
                it.amount,
                uint256(0), // validAfter
                it.deadline, // validBefore
                it.nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(PAYER_KEY, digest);
    }

    /// @dev Sign both signatures for the main forwarder.
    function _sign(PCCForwarder.ExecutionIntent memory it) internal view returns (Sigs memory sg) {
        (sg.iv, sg.ir, sg.isig) = _signIntentFor(forwarder, it);
        (sg.pv, sg.pr, sg.psig) = _signPay(it);
    }

    function _relayWith(PCCForwarder.ExecutionIntent memory it, bytes memory callData, Sigs memory sg)
        internal
        returns (bytes memory)
    {
        vm.prank(relayer);
        return forwarder.relay(it, callData, sg.iv, sg.ir, sg.isig, sg.pv, sg.pr, sg.psig);
    }

    function _pingCd() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockTarget.ping.selector);
    }

    // ── Happy path (H-01: funds land at recipient, nothing at forwarder) ────

    function test_relay_success_landsAmountAtRecipient_nothingTrapped() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("n1"), recipient);
        Sigs memory sg = _sign(it);

        uint256 payerBefore = usdc.balanceOf(payer);

        bytes memory ret = _relayWith(it, cd, sg);

        assertEq(usdc.balanceOf(recipient), AMOUNT, "recipient receives amount");
        assertEq(usdc.balanceOf(address(forwarder)), 0, "forwarder holds nothing (H-01)");
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT, "payer debited exactly amount");
        assertEq(targetA.lastSender(), payer, "target sees payer via pgtrSender");
        assertEq(targetA.pings(), 1, "target executed once");
        assertEq(abi.decode(ret, (string)), "pong", "target return bubbles up");
        assertTrue(forwarder.usedNonces(payer, keccak256("n1")), "nonce marked used");
    }

    // ── C-04: mutating any signed field breaks the intent (action binding) ──

    function test_mutate_target_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("t"), recipient);
        Sigs memory sg = _sign(it); // sign over targetA
        it.target = address(targetB); // still a TRUSTED target -> passes allowlist, fails signature
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_mutate_oneCalldataByte_breaksBinding() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("c"), recipient);
        Sigs memory sg = _sign(it); // callDataHash commits to `cd`

        bytes memory cd2 = _pingCd();
        cd2[cd2.length - 1] = cd2[cd2.length - 1] ^ bytes1(0x01); // flip one byte
        // C-04: executed calldata must match the signed hash.
        vm.expectRevert("PCCForwarder: calldata mismatch");
        _relayWith(it, cd2, sg);
    }

    function test_mutate_amount_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("a"), recipient);
        Sigs memory sg = _sign(it);
        it.amount = AMOUNT - 1;
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_mutate_token_rejected() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("k"), recipient);
        Sigs memory sg = _sign(it);
        it.token = address(0xDEAD); // token is bound by the == usdc guard
        vm.expectRevert("PCCForwarder: unexpected token");
        _relayWith(it, cd, sg);
    }

    function test_mutate_recipient_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("r"), recipient);
        Sigs memory sg = _sign(it);
        it.recipient = address(0x1234); // fresh, valid (not zero/self/token) -> fails on signature
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_mutate_chain_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("h"), recipient);
        Sigs memory sg = _sign(it); // signed for the current chainid
        vm.chainId(999999); // domain separator (chainId) changes -> signature invalid
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_mutate_forwarder_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("f"), recipient);

        // Sign the intent against a DIFFERENT forwarder's domain (verifyingContract),
        // then submit to the real one -> digest differs -> signature invalid.
        PCCForwarder other = new PCCForwarder(address(usdc), address(this));
        Sigs memory sg;
        (sg.iv, sg.ir, sg.isig) = _signIntentFor(other, it);
        (sg.pv, sg.pr, sg.psig) = _signPay(it);

        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    // ── review #8: replay is keyed by (payer, nonce), not the digest ────────

    function test_replay_nonzeroAmount_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("rp1"), recipient);
        Sigs memory sg = _sign(it);

        _relayWith(it, cd, sg); // first: succeeds

        vm.prank(relayer);
        vm.expectRevert("PCCForwarder: nonce already used");
        forwarder.relay(it, cd, sg.iv, sg.ir, sg.isig, sg.pv, sg.pr, sg.psig);
    }

    function test_replay_zeroAmount_reverts() public {
        bytes memory cd = _pingCd();
        bytes32 nonce = keccak256("zero-rp");
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, 0, nonce, recipient);
        Sigs memory sg = _sign(it); // pay sig unused for amount==0

        _relayWith(it, cd, sg); // first: succeeds, no EIP-3009 call
        assertEq(targetA.pings(), 1);
        assertEq(usdc.balanceOf(recipient), 0, "no funds move for amount==0");

        vm.prank(relayer);
        vm.expectRevert("PCCForwarder: nonce already used");
        forwarder.relay(it, cd, sg.iv, sg.ir, sg.isig, sg.pv, sg.pr, sg.psig);
    }

    /// @notice The precise review #8 bug: under the old digest-keyed guard, two
    ///         DIFFERENT zero-amount intents (different target -> different
    ///         digest) reusing the SAME payer nonce would BOTH execute. With the
    ///         nonce-keyed guard, the second reverts.
    function test_zeroAmount_differentIntents_sameNonce_secondReverts() public {
        bytes memory cd = _pingCd();
        bytes32 nonce = keccak256("shared-nonce");

        PCCForwarder.ExecutionIntent memory itA = _intent(address(targetA), cd, 0, nonce, recipient);
        _relayWith(itA, cd, _sign(itA)); // succeeds
        assertEq(targetA.pings(), 1);

        // A genuinely different intent (targetB) with the SAME nonce.
        PCCForwarder.ExecutionIntent memory itB = _intent(address(targetB), cd, 0, nonce, recipient);
        Sigs memory sgB = _sign(itB);
        vm.prank(relayer);
        vm.expectRevert("PCCForwarder: nonce already used");
        forwarder.relay(itB, cd, sgB.iv, sgB.ir, sgB.isig, sgB.pv, sgB.pr, sgB.psig);
        assertEq(targetB.pings(), 0, "second intent must not execute");
    }

    // ── review #7 / H-01: recipient may not be the forwarder or the token ───

    function test_recipient_self_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("self"), address(forwarder));
        Sigs memory sg = _sign(it); // fully valid signatures -> the ONLY failure is the self-recipient guard
        vm.expectRevert("PCCForwarder: recipient is self");
        _relayWith(it, cd, sg);
    }

    function test_recipient_token_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("tok"), address(usdc));
        Sigs memory sg = _sign(it);
        vm.expectRevert("PCCForwarder: recipient is token");
        _relayWith(it, cd, sg);
    }

    // ── Atomicity: a reverting target unwinds the payment (no funds move) ────

    function test_revertingTarget_unwindsPayment() public {
        bytes memory cd = abi.encodeWithSelector(MockTarget.boom.selector);
        bytes32 nonce = keccak256("boom");
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, nonce, recipient);
        Sigs memory sg = _sign(it);

        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(relayer);
        vm.expectRevert("PCCForwarder: target call failed");
        forwarder.relay(it, cd, sg.iv, sg.ir, sg.isig, sg.pv, sg.pr, sg.psig);

        // Whole tx reverted -> nothing moved anywhere.
        assertEq(usdc.balanceOf(payer), payerBefore, "payer not debited");
        assertEq(usdc.balanceOf(recipient), 0, "recipient got nothing");
        assertEq(usdc.balanceOf(address(forwarder)), 0, "forwarder got nothing");
        assertFalse(forwarder.usedNonces(payer, nonce), "nonce not burned by reverted relay");

        // And because the nonce was NOT burned, a valid relay with the same
        // nonce still works -> the unwind was complete and atomic.
        bytes memory pingCd = _pingCd();
        PCCForwarder.ExecutionIntent memory it2 = _intent(address(targetA), pingCd, AMOUNT, nonce, recipient);
        _relayWith(it2, pingCd, _sign(it2));
        assertEq(usdc.balanceOf(recipient), AMOUNT, "same nonce settles after prior unwind");
    }

    // ── Access control sanity (defense in depth around the money path) ──────

    function test_relay_onlyRelayer() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("acl"), recipient);
        Sigs memory sg = _sign(it);
        // Called by a non-relayer (this contract) -> onlyRelayer reverts.
        vm.expectRevert("PCCForwarder: not authorized relayer");
        forwarder.relay(it, cd, sg.iv, sg.ir, sg.isig, sg.pv, sg.pr, sg.psig);
    }

    function test_untrustedTarget_reverts() public {
        MockTarget rogue = new MockTarget(); // never added as a trusted target
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(rogue), cd, AMOUNT, keccak256("rogue"), recipient);
        Sigs memory sg = _sign(it);
        vm.expectRevert("PCCForwarder: untrusted target");
        _relayWith(it, cd, sg);
    }

    // ════════════════════════════════════════════════════════════════════════
    // review #6 — edge-case hardening (impl3-delta)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev Sign an EIP-3009 ReceiveWithAuthorization over ARBITRARY fields with
    ///      an arbitrary key, so a test can pair a valid ExecutionIntent with a
    ///      payment authorization that disagrees on payer / amount / nonce /
    ///      validAfter-validBefore. The forwarder always rebuilds the digest from
    ///      intent.{payer,amount,nonce,deadline} + validAfter=0, so any such
    ///      disagreement recovers a signer != payer and the EIP-3009 call fails.
    function _signPayFull(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint256 signerKey
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(forwarder),
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(signerKey, digest);
    }

    // ── Intent-field mutation: payer / nonce / deadline break the binding ────

    function test_mutate_payer_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("mp"), recipient);
        Sigs memory sg = _sign(it); // signed while payer == the real signer
        // Nonzero so the zero-payer guard passes; the digest now recovers to
        // neither the real payer nor 0xBAD -> signer != intent.payer.
        it.payer = address(0xBAD);
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_mutate_nonce_breaksSignature_originalStillSettles() public {
        bytes memory cd = _pingCd();
        bytes32 originalNonce = keccak256("orig-nonce");
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, originalNonce, recipient);
        Sigs memory sg = _sign(it);

        it.nonce = keccak256("mutated-nonce"); // digest changes -> intent sig invalid
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);

        // The reverted attempt never reached the nonce write, so the original
        // (payer, nonce) is still free and the untouched signatures still settle.
        it.nonce = originalNonce;
        _relayWith(it, cd, sg);
        assertEq(usdc.balanceOf(recipient), AMOUNT, "original nonce settles after mutated-nonce revert");
        assertTrue(forwarder.usedNonces(payer, originalNonce), "original nonce consumed exactly once");
    }

    function test_mutate_deadline_breaksSignature() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("md"), recipient);
        Sigs memory sg = _sign(it);
        // A DIFFERENT still-future deadline: the expiry guard passes, so the ONLY
        // failure is the signature binding over `deadline`.
        it.deadline = block.timestamp + 2 hours;
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_expiredIntent_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("exp"), recipient);
        Sigs memory sg = _sign(it); // signatures are fully valid...
        vm.warp(it.deadline + 1); // ...but now block.timestamp > deadline (expiry precedes the sig check)
        vm.expectRevert("PCCForwarder: expired");
        _relayWith(it, cd, sg);
    }

    // ── The two payer signatures must agree (ExecutionIntent <-> EIP-3009) ───
    // A valid intent paired with a payment authorization for the wrong
    // payer / amount / nonce / validity window must NOT settle. The forwarder
    // rebuilds the EIP-3009 digest from the intent, so a mismatched pay sig
    // recovers a non-payer signer and USDC rejects it -> "USDC auth failed".

    function test_payAuth_wrongPayer_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("wp"), recipient);
        Sigs memory sg;
        (sg.iv, sg.ir, sg.isig) = _signIntentFor(forwarder, it); // valid intent
        // Authorization signed by a DIFFERENT payer key.
        (sg.pv, sg.pr, sg.psig) =
            _signPayFull(vm.addr(OTHER_KEY), AMOUNT, 0, it.deadline, it.nonce, OTHER_KEY);
        vm.expectRevert("PCCForwarder: USDC auth failed");
        _relayWith(it, cd, sg);
    }

    function test_payAuth_wrongAmount_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("wa"), recipient);
        Sigs memory sg;
        (sg.iv, sg.ir, sg.isig) = _signIntentFor(forwarder, it);
        // Authorization over a value != intent.amount.
        (sg.pv, sg.pr, sg.psig) =
            _signPayFull(payer, AMOUNT - 1, 0, it.deadline, it.nonce, PAYER_KEY);
        vm.expectRevert("PCCForwarder: USDC auth failed");
        _relayWith(it, cd, sg);
    }

    function test_payAuth_wrongNonce_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("wn"), recipient);
        Sigs memory sg;
        (sg.iv, sg.ir, sg.isig) = _signIntentFor(forwarder, it);
        // Authorization over a nonce != intent.nonce.
        (sg.pv, sg.pr, sg.psig) =
            _signPayFull(payer, AMOUNT, 0, it.deadline, keccak256("other-nonce"), PAYER_KEY);
        vm.expectRevert("PCCForwarder: USDC auth failed");
        _relayWith(it, cd, sg);
    }

    function test_payAuth_wrongValidWindow_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("ww"), recipient);
        Sigs memory sg;
        (sg.iv, sg.ir, sg.isig) = _signIntentFor(forwarder, it);
        // Forwarder pins validAfter=0, validBefore=intent.deadline; an
        // authorization signed over a different window won't match that digest.
        (sg.pv, sg.pr, sg.psig) =
            _signPayFull(payer, AMOUNT, 1, it.deadline + 1, it.nonce, PAYER_KEY);
        vm.expectRevert("PCCForwarder: USDC auth failed");
        _relayWith(it, cd, sg);
    }

    // ── Malformed / malleable intent signatures fail closed ─────────────────

    function test_malformedIntentSig_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("bad"), recipient);
        Sigs memory sg = _sign(it);
        // Garbage r/s with a structurally valid v -> ecrecover yields junk != payer.
        sg.iv = 27;
        sg.ir = bytes32(uint256(1));
        sg.isig = bytes32(uint256(1));
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_intentSig_invalidV_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("badv"), recipient);
        Sigs memory sg = _sign(it);
        // v outside {27,28} -> _recover returns address(0) -> fail closed.
        sg.iv = 29;
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    function test_highSIntentSig_reverts() public {
        bytes memory cd = _pingCd();
        PCCForwarder.ExecutionIntent memory it = _intent(address(targetA), cd, AMOUNT, keccak256("hs"), recipient);

        (uint8 v, bytes32 r, bytes32 s) = _signIntentFor(forwarder, it); // canonical low-s
        bytes32 highS = bytes32(SECP256K1_N - uint256(s)); // malleable upper-half twin
        assertGt(uint256(highS), SECP256K1_N / 2, "twin s is in the upper half");

        Sigs memory sg;
        sg.iv = v == 27 ? 28 : 27; // the twin flips v parity...
        sg.ir = r;
        sg.isig = highS;
        (sg.pv, sg.pr, sg.psig) = _signPay(it); // valid pay sig; the intent check fails first

        // ...and the EIP-2 malleability guard in _recover rejects the upper-half s.
        vm.expectRevert("PCCForwarder: bad intent signature");
        _relayWith(it, cd, sg);
    }

    // ── sweepStuckTokens: access control + argument guards + defined behavior ─

    function test_sweep_onlyOwner() public {
        // An authorized relayer is still NOT the owner.
        vm.prank(relayer);
        vm.expectRevert("PCCForwarder: not owner");
        forwarder.sweepStuckTokens(usdc, recipient, 1);
    }

    function test_sweep_zeroRecipient_reverts() public {
        // Caller is the owner (this test contract, per setUp).
        vm.expectRevert("PCCForwarder: zero sweep recipient");
        forwarder.sweepStuckTokens(usdc, address(0), 1);
    }

    function test_sweep_zeroAmount_reverts() public {
        // Zero-amount sweep is explicitly rejected (no-op sweeps disallowed).
        vm.expectRevert("PCCForwarder: zero sweep amount");
        forwarder.sweepStuckTokens(usdc, recipient, 0);
    }

    function test_sweep_rescuesStuckTokens() public {
        // Simulate tokens sent directly to the forwarder — the H-01 stuck-funds
        // scenario the sweep exists to rescue.
        address dest = address(0x5177);
        usdc.mint(address(forwarder), 500e6);
        assertEq(usdc.balanceOf(address(forwarder)), 500e6, "forwarder holds stuck funds");

        forwarder.sweepStuckTokens(usdc, dest, 500e6); // owner rescues
        assertEq(usdc.balanceOf(dest), 500e6, "swept to destination");
        assertEq(usdc.balanceOf(address(forwarder)), 0, "forwarder emptied");
    }
}
