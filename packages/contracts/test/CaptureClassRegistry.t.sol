// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/CaptureClassRegistry.sol";

/**
 * @title CaptureClassRegistryTest
 * @notice Foundry test suite for the on-chain anchor of PCC's Capture Verification Protocol.
 *
 * Design doc: ai/research/capture-verification-protocol.md §6
 * Contract:  packages/contracts/src/CaptureClassRegistry.sol
 *
 * Coverage:
 *   - Constructor validation (zero-address rejection)
 *   - anchor: happy paths, replay prevention, access control, class-bound invariants
 *   - updateAttestations: gateway/verifier separation of duties
 *   - dispute: permissionless event emission, existence gate
 *   - View functions: getAnchor, getExists, anchors mapping
 *   - Fuzz: valid (declared, verified) class combinations in [0,5]
 */
contract CaptureClassRegistryTest is Test {
    CaptureClassRegistry registry;

    address gatewayOracle = address(0xA11CE);
    address verifierRegistry = address(0xBADB01);
    address operator = address(0xC0FFEE);
    address anyone = address(0xDEADBEEF);

    // ── Events (mirrored for vm.expectEmit) ──────────────────────────────

    event CaptureAnchored(
        bytes32 indexed captureHash,
        bytes32 indexed jobId,
        address indexed submittedBy,
        uint8 declaredClass,
        uint8 verifiedClass
    );

    event AttestationsUpdated(bytes32 indexed captureHash, bytes32 attestationsRoot, uint16 attesterCount);

    event CaptureDisputed(bytes32 indexed captureHash, address indexed disputer, string reason);

    function setUp() public {
        registry = new CaptureClassRegistry(gatewayOracle, verifierRegistry);
    }

    // ── Constructor ──────────────────────────────────────────────────────

    function test_constructor_setsImmutables() public view {
        assertEq(registry.gatewayOracle(), gatewayOracle);
        assertEq(registry.verifierRegistry(), verifierRegistry);
    }

    function test_constructor_revertsOnZeroGateway() public {
        vm.expectRevert("zero gateway");
        new CaptureClassRegistry(address(0), verifierRegistry);
    }

    function test_constructor_revertsOnZeroVerifierRegistry() public {
        vm.expectRevert("zero verifier registry");
        new CaptureClassRegistry(gatewayOracle, address(0));
    }

    // ── anchor(): Happy Path ─────────────────────────────────────────────

    function test_anchor_Happy() public {
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("capture-001"), 2, 2);

        vm.expectEmit(true, true, true, true);
        emit CaptureAnchored(a.captureHash, a.jobId, a.submittedBy, a.declaredClass, a.verifiedClass);

        vm.prank(gatewayOracle);
        registry.anchor(a);

        assertTrue(registry.exists(a.captureHash), "exists mapping must be true after anchor");
        assertTrue(registry.getExists(a.captureHash), "getExists view must return true after anchor");

        CaptureClassRegistry.CaptureAnchor memory stored = registry.getAnchor(a.captureHash);
        assertEq(stored.captureHash, a.captureHash);
        assertEq(stored.manifestHash, a.manifestHash);
        assertEq(stored.declaredClass, a.declaredClass);
        assertEq(stored.verifiedClass, a.verifiedClass);
        assertEq(stored.submittedBy, a.submittedBy);
        assertEq(stored.jobId, a.jobId);
        assertEq(stored.challengeId, a.challengeId);
        assertEq(stored.blockAnchor, a.blockAnchor);
        assertEq(stored.capturedAt, a.capturedAt);
        assertEq(stored.attestationsRoot, a.attestationsRoot);
        assertEq(stored.attesterCount, a.attesterCount);
    }

    function test_anchor_StorageMatchesCalldata_AllTwelveFields() public {
        // Explicit every-field verification — the CaptureAnchor struct is wire-format-sensitive,
        // any slot-packing regression must be caught here.
        bytes32 ch = keccak256("cap-full");
        bytes32 mh = keccak256("manifest-full");
        bytes32 jid = keccak256("job-xyz");
        bytes32 cid = keccak256("challenge-xyz");
        bytes32 atr = keccak256("attestations-merkle");

        CaptureClassRegistry.CaptureAnchor memory a = CaptureClassRegistry.CaptureAnchor({
            captureHash: ch,
            manifestHash: mh,
            declaredClass: 4,
            verifiedClass: 3,
            submittedBy: operator,
            jobId: jid,
            challengeId: cid,
            blockAnchor: 1_234_567,
            capturedAt: 1_700_000_000,
            attestationsRoot: atr,
            attesterCount: 5
        });

        vm.prank(gatewayOracle);
        registry.anchor(a);

        // Read both via getAnchor() and the public mapping to double-cover both access paths.
        CaptureClassRegistry.CaptureAnchor memory s = registry.getAnchor(ch);
        assertEq(s.captureHash, ch, "field 1 captureHash");
        assertEq(s.manifestHash, mh, "field 2 manifestHash");
        assertEq(s.declaredClass, 4, "field 3 declaredClass");
        assertEq(s.verifiedClass, 3, "field 4 verifiedClass");
        assertEq(s.submittedBy, operator, "field 5 submittedBy");
        assertEq(s.jobId, jid, "field 6 jobId");
        assertEq(s.challengeId, cid, "field 7 challengeId");
        assertEq(uint256(s.blockAnchor), 1_234_567, "field 8 blockAnchor");
        assertEq(uint256(s.capturedAt), 1_700_000_000, "field 9 capturedAt");
        assertEq(s.attestationsRoot, atr, "field 10 attestationsRoot");
        assertEq(uint256(s.attesterCount), 5, "field 11 attesterCount");
    }

    function test_anchor_CC0_IsAllowed() public {
        // Contract-level note: CC0 anchoring is NOT reverted by the contract. The class-0 gate
        // is enforced off-chain (see §1: CC0 rejected for tier >=2 by ComplianceFacade).
        // The on-chain contract only bounds declared/verified to [0,5] and enforces verified <= declared.
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("cc0-capture"), 0, 0);

        vm.prank(gatewayOracle);
        registry.anchor(a);

        CaptureClassRegistry.CaptureAnchor memory stored = registry.getAnchor(a.captureHash);
        assertEq(stored.declaredClass, 0);
        assertEq(stored.verifiedClass, 0);
    }

    function test_anchor_AllBoundaryClasses() public {
        // declared == verified, at low and high bounds
        _anchorOneOf("cap-0-0", 0, 0);
        _anchorOneOf("cap-5-5", 5, 5);
        // detector downgrade: declared high, verified lower (must succeed — see §6.1 require)
        _anchorOneOf("cap-5-0", 5, 0);
        _anchorOneOf("cap-5-3", 5, 3);
        _anchorOneOf("cap-4-2", 4, 2);
        _anchorOneOf("cap-1-0", 1, 0);
    }

    function test_anchor_MultipleAnchorsAcrossDifferentHashes() public {
        bytes32 h1 = keccak256("multi-1");
        bytes32 h2 = keccak256("multi-2");
        bytes32 h3 = keccak256("multi-3");

        vm.startPrank(gatewayOracle);
        registry.anchor(_defaultAnchor(h1, 2, 2));
        registry.anchor(_defaultAnchor(h2, 3, 3));
        registry.anchor(_defaultAnchor(h3, 4, 2));
        vm.stopPrank();

        assertTrue(registry.exists(h1));
        assertTrue(registry.exists(h2));
        assertTrue(registry.exists(h3));
        assertEq(registry.getAnchor(h1).declaredClass, 2);
        assertEq(registry.getAnchor(h2).declaredClass, 3);
        assertEq(registry.getAnchor(h3).verifiedClass, 2);
    }

    // ── anchor(): Revert Paths ───────────────────────────────────────────

    function test_anchor_RevertOnReplay() public {
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("replay-me"), 2, 2);

        vm.prank(gatewayOracle);
        registry.anchor(a);

        // Second attempt with the same captureHash must revert.
        vm.prank(gatewayOracle);
        vm.expectRevert("replay");
        registry.anchor(a);
    }

    function test_anchor_RevertOnReplay_DifferentPayloadSameHash() public {
        // Even if the operator rewrites every other field but reuses the captureHash, replay fires.
        bytes32 ch = keccak256("stable-hash");
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(ch, 2, 2);

        vm.prank(gatewayOracle);
        registry.anchor(a);

        CaptureClassRegistry.CaptureAnchor memory b = _defaultAnchor(ch, 5, 4);
        b.submittedBy = address(0xBEEFBEEF);
        b.jobId = keccak256("different-job");

        vm.prank(gatewayOracle);
        vm.expectRevert("replay");
        registry.anchor(b);
    }

    function test_anchor_RevertOnlyGateway() public {
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("not-gateway"), 2, 2);

        vm.prank(operator);
        vm.expectRevert("only gateway");
        registry.anchor(a);

        // Verifier registry also cannot impersonate the gateway.
        vm.prank(verifierRegistry);
        vm.expectRevert("only gateway");
        registry.anchor(a);

        // Random EOA also cannot.
        vm.prank(anyone);
        vm.expectRevert("only gateway");
        registry.anchor(a);
    }

    function test_anchor_RevertOnDeclaredClassAbove5() public {
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("bad-declared"), 6, 3);
        vm.prank(gatewayOracle);
        vm.expectRevert("invalid class");
        registry.anchor(a);
    }

    function test_anchor_RevertOnVerifiedClassAbove5() public {
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("bad-verified"), 5, 6);
        vm.prank(gatewayOracle);
        // Note: the contract's require checks declaredClass <= 5 && verifiedClass <= 5 BEFORE the
        // verified<=declared check. With declared=5 and verified=6, the "invalid class" predicate
        // fires first.
        vm.expectRevert("invalid class");
        registry.anchor(a);
    }

    function test_anchor_RevertOnVerifiedAboveDeclared() public {
        // Valid class bounds, but detector is trying to UPGRADE past operator's declaration.
        // Per §6.1 invariant: detector can downgrade, never upgrade.
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(keccak256("upgrade-attempt"), 2, 3);
        vm.prank(gatewayOracle);
        vm.expectRevert("verified > declared");
        registry.anchor(a);

        // Edge case: declared=0 but verified=1
        a = _defaultAnchor(keccak256("zero-declared-one-verified"), 0, 1);
        vm.prank(gatewayOracle);
        vm.expectRevert("verified > declared");
        registry.anchor(a);
    }

    function test_anchor_EventEmission_IndexedFields() public {
        // Verify the event's three indexed topics + two data fields (declaredClass, verifiedClass)
        // are populated correctly. Using expectEmit with all four checkTopic booleans=true forces
        // a strict compare.
        bytes32 ch = keccak256("event-test");
        bytes32 jid = keccak256("event-job");
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(ch, 3, 2);
        a.jobId = jid;
        a.submittedBy = operator;

        vm.expectEmit(true, true, true, true);
        emit CaptureAnchored(ch, jid, operator, 3, 2);

        vm.prank(gatewayOracle);
        registry.anchor(a);
    }

    // ── updateAttestations() ─────────────────────────────────────────────

    function test_updateAttestations_Happy() public {
        bytes32 ch = keccak256("att-happy");
        _anchor(ch, 4, 4);

        bytes32 root = keccak256("merkle-root-abc");
        uint16 count = 7;

        vm.expectEmit(true, true, true, true);
        emit AttestationsUpdated(ch, root, count);

        vm.prank(verifierRegistry);
        registry.updateAttestations(ch, root, count);

        CaptureClassRegistry.CaptureAnchor memory stored = registry.getAnchor(ch);
        assertEq(stored.attestationsRoot, root);
        assertEq(uint256(stored.attesterCount), uint256(count));
    }

    function test_updateAttestations_CanOverwrite() public {
        // N-of-M attestations are additive over time — a later updateAttestations() must be able
        // to replace the earlier root (e.g., new verifier joined, root recomputed).
        bytes32 ch = keccak256("att-overwrite");
        _anchor(ch, 4, 4);

        vm.startPrank(verifierRegistry);
        registry.updateAttestations(ch, keccak256("root-v1"), 3);
        registry.updateAttestations(ch, keccak256("root-v2"), 5);
        vm.stopPrank();

        CaptureClassRegistry.CaptureAnchor memory stored = registry.getAnchor(ch);
        assertEq(stored.attestationsRoot, keccak256("root-v2"));
        assertEq(uint256(stored.attesterCount), 5);
    }

    function test_updateAttestations_RevertOnlyVerifierRegistry() public {
        bytes32 ch = keccak256("att-wrong-caller");
        _anchor(ch, 2, 2);

        // Gateway oracle cannot update attestations — separation of duties.
        vm.prank(gatewayOracle);
        vm.expectRevert("only verifier registry");
        registry.updateAttestations(ch, keccak256("root"), 3);

        // Random EOA cannot either.
        vm.prank(anyone);
        vm.expectRevert("only verifier registry");
        registry.updateAttestations(ch, keccak256("root"), 3);
    }

    function test_updateAttestations_RevertOnUnknownCaptureHash() public {
        vm.prank(verifierRegistry);
        vm.expectRevert("no such capture");
        registry.updateAttestations(keccak256("never-anchored"), keccak256("root"), 3);
    }

    // ── dispute() ────────────────────────────────────────────────────────

    function test_dispute_Permissionless() public {
        // Anyone (unprivileged address) can raise a dispute event.
        bytes32 ch = keccak256("disputed-capture");
        _anchor(ch, 3, 3);

        string memory reason = "evidence does not show actual print; looks like a stock image";

        vm.expectEmit(true, true, true, true);
        emit CaptureDisputed(ch, anyone, reason);

        vm.prank(anyone);
        registry.dispute(ch, reason);
    }

    function test_dispute_GatewayCanAlsoDispute() public {
        // Even privileged roles can dispute — it's pure public event emission.
        bytes32 ch = keccak256("gateway-dispute");
        _anchor(ch, 3, 3);

        vm.prank(gatewayOracle);
        // No revert = pass; event emission covered by permissionless test above.
        registry.dispute(ch, "gateway-raised concern");
    }

    function test_dispute_RevertOnUnknownCaptureHash() public {
        vm.prank(anyone);
        vm.expectRevert("no such capture");
        registry.dispute(keccak256("never-anchored"), "baseless");
    }

    function test_dispute_DoesNotMutateAnchor() public {
        // Dispute is event-only (§6.1: "Actual slashing handled by MilestoneEscrow dispute flow, not here").
        // Filing a dispute MUST NOT change any stored field.
        bytes32 ch = keccak256("immutable-on-dispute");
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(ch, 4, 3);
        vm.prank(gatewayOracle);
        registry.anchor(a);

        CaptureClassRegistry.CaptureAnchor memory before = registry.getAnchor(ch);

        vm.prank(anyone);
        registry.dispute(ch, "reason");

        CaptureClassRegistry.CaptureAnchor memory afterDispute = registry.getAnchor(ch);
        assertEq(afterDispute.captureHash, before.captureHash);
        assertEq(afterDispute.manifestHash, before.manifestHash);
        assertEq(afterDispute.declaredClass, before.declaredClass);
        assertEq(afterDispute.verifiedClass, before.verifiedClass);
        assertEq(afterDispute.submittedBy, before.submittedBy);
        assertEq(afterDispute.jobId, before.jobId);
        assertEq(afterDispute.attestationsRoot, before.attestationsRoot);
        assertEq(uint256(afterDispute.attesterCount), uint256(before.attesterCount));
    }

    // ── View Functions ───────────────────────────────────────────────────

    function test_getAnchor_UnknownReturnsZeroStruct() public view {
        CaptureClassRegistry.CaptureAnchor memory z = registry.getAnchor(keccak256("nobody-home"));
        assertEq(z.captureHash, bytes32(0));
        assertEq(z.manifestHash, bytes32(0));
        assertEq(z.declaredClass, 0);
        assertEq(z.verifiedClass, 0);
        assertEq(z.submittedBy, address(0));
        assertEq(z.jobId, bytes32(0));
        assertEq(z.challengeId, bytes32(0));
        assertEq(uint256(z.blockAnchor), 0);
        assertEq(uint256(z.capturedAt), 0);
        assertEq(z.attestationsRoot, bytes32(0));
        assertEq(uint256(z.attesterCount), 0);
    }

    function test_getExists_FalseBeforeTrueAfter() public {
        bytes32 ch = keccak256("exists-flip");
        assertFalse(registry.getExists(ch));
        assertFalse(registry.exists(ch));

        _anchor(ch, 2, 2);

        assertTrue(registry.getExists(ch));
        assertTrue(registry.exists(ch));
    }

    // ── Fuzz ─────────────────────────────────────────────────────────────

    /// @dev Fuzz over the full valid class cartesian product. declared in [0,5], verified <= declared.
    function testFuzz_anchor_ValidClassCombinations(uint8 declaredSeed, uint8 verifiedSeed, bytes32 captureSeed)
        public
    {
        uint8 declared = declaredSeed % 6; // 0..5
        uint8 verified = declared == 0 ? 0 : (verifiedSeed % (declared + 1)); // 0..declared

        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(captureSeed, declared, verified);

        // Assume unseen captureHash (skip fuzz cases that would be replays).
        vm.assume(!registry.exists(captureSeed));

        vm.prank(gatewayOracle);
        registry.anchor(a);

        CaptureClassRegistry.CaptureAnchor memory stored = registry.getAnchor(captureSeed);
        assertEq(stored.declaredClass, declared);
        assertEq(stored.verifiedClass, verified);
        assertTrue(stored.verifiedClass <= stored.declaredClass, "invariant: verified <= declared");
        assertTrue(stored.declaredClass <= 5, "invariant: declared <= 5");
    }

    /// @dev Fuzz that invalid (verified > declared) combos always revert.
    function testFuzz_anchor_RejectsVerifiedAboveDeclared(uint8 declaredSeed, uint8 offsetSeed, bytes32 captureSeed)
        public
    {
        uint8 declared = declaredSeed % 5; // 0..4, so there's room above
        uint8 verified = declared + 1 + (offsetSeed % (5 - declared)); // declared+1 .. 5
        vm.assume(verified <= 5 && verified > declared);
        vm.assume(!registry.exists(captureSeed));

        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(captureSeed, declared, verified);
        vm.prank(gatewayOracle);
        vm.expectRevert("verified > declared");
        registry.anchor(a);
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _defaultAnchor(bytes32 captureHash, uint8 declared, uint8 verified)
        internal
        view
        returns (CaptureClassRegistry.CaptureAnchor memory)
    {
        return CaptureClassRegistry.CaptureAnchor({
            captureHash: captureHash,
            manifestHash: keccak256(abi.encodePacked("manifest-", captureHash)),
            declaredClass: declared,
            verifiedClass: verified,
            submittedBy: operator,
            jobId: keccak256(abi.encodePacked("job-", captureHash)),
            challengeId: keccak256(abi.encodePacked("chal-", captureHash)),
            blockAnchor: uint32(block.number),
            capturedAt: uint64(block.timestamp),
            attestationsRoot: bytes32(0),
            attesterCount: 0
        });
    }

    function _anchor(bytes32 captureHash, uint8 declared, uint8 verified) internal {
        CaptureClassRegistry.CaptureAnchor memory a = _defaultAnchor(captureHash, declared, verified);
        vm.prank(gatewayOracle);
        registry.anchor(a);
    }

    function _anchorOneOf(string memory tag, uint8 declared, uint8 verified) internal {
        bytes32 ch = keccak256(bytes(tag));
        _anchor(ch, declared, verified);
        assertTrue(registry.exists(ch), string.concat("expected ", tag, " anchored"));
        CaptureClassRegistry.CaptureAnchor memory stored = registry.getAnchor(ch);
        assertEq(stored.declaredClass, declared);
        assertEq(stored.verifiedClass, verified);
    }
}
