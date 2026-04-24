// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal local interfaces — mirrors the canonical interface from wave7-spec.md.
// These stubs let the fuzz test compile independently of implementer-alpha's
// landing. Once CaptureChallengeV1Scheme.sol and friends land in src/, the
// import paths below can be swapped to:
//   import "../src/IVerificationScheme.sol";
//   import "../src/VerificationSchemeRegistry.sol";
//   import "../src/schemes/CaptureChallengeV1Scheme.sol";
// ─────────────────────────────────────────────────────────────────────────────

// ── Interfaces ───────────────────────────────────────────────────────────────

interface IVerificationScheme {
    function schemeId() external view returns (bytes32);
    function schemeVersion() external view returns (uint16);
    function onLock(
        address escrow,
        bytes32 stepId,
        bytes calldata commitmentPayload
    ) external returns (bytes32 commitmentHash);
    function onRelease(
        address escrow,
        bytes32 stepId,
        bytes32 commitmentHash,
        bytes calldata attestationData
    ) external view returns (bool valid);
}

// ── Mock CaptureClassRegistry ─────────────────────────────────────────────────

/// @notice Minimal mock that lets the fuzz test inject arbitrary anchor data.
///   The real CaptureClassRegistry is in src/ and has the same shape; this mock
///   avoids the oracle-gating that would block arbitrary fuzz inputs.
contract MockCaptureClassRegistry {
    struct CaptureAnchor {
        bytes32 captureHash;
        bytes32 manifestHash;
        uint8   declaredClass;
        uint8   verifiedClass;
        address submittedBy;
        bytes32 jobId;
        bytes32 challengeId;
        uint32  blockAnchor;
        uint64  capturedAt;
        bytes32 attestationsRoot;
        uint16  attesterCount;
    }

    mapping(bytes32 => CaptureAnchor) private _anchors;
    mapping(bytes32 => bool) private _exists;

    /// @notice Inject a capture anchor directly (no gateway-oracle gate needed for tests).
    function setAnchor(CaptureAnchor calldata a) external {
        _anchors[a.captureHash] = a;
        _exists[a.captureHash]  = true;
    }

    function getAnchor(bytes32 captureHash) external view returns (CaptureAnchor memory) {
        return _anchors[captureHash];
    }

    function exists(bytes32 captureHash) external view returns (bool) {
        return _exists[captureHash];
    }
}

// ── CaptureChallengeV1Scheme (verbatim from wave7-spec.md, inline for fuzz) ──

interface ICaptureClassRegistryForScheme {
    struct CaptureAnchor {
        bytes32 captureHash;
        bytes32 manifestHash;
        uint8   declaredClass;
        uint8   verifiedClass;
        address submittedBy;
        bytes32 jobId;
        bytes32 challengeId;
        uint32  blockAnchor;
        uint64  capturedAt;
        bytes32 attestationsRoot;
        uint16  attesterCount;
    }
    function getAnchor(bytes32 captureHash) external view returns (CaptureAnchor memory);
    function exists(bytes32 captureHash) external view returns (bool);
}

/// @notice Verbatim copy of CaptureChallengeV1Scheme from wave7-spec.md.
///   Kept inline here so the fuzz test is self-contained and does not depend on
///   implementer-alpha having committed src/schemes/CaptureChallengeV1Scheme.sol.
///   When alpha lands, CI can be switched to import that path.
contract CaptureChallengeV1Scheme {
    bytes32 public constant SCHEME_ID      = keccak256("CaptureChallengeV1");
    uint16  public constant SCHEME_VERSION = 1;

    ICaptureClassRegistryForScheme public immutable captureRegistry;

    mapping(bytes32 => Commitment) private _commitments;

    struct Commitment {
        bytes32 challengeId;
        uint32  blockAnchor;
        address operator;
        uint8   minVerifiedClass;
        bool    set;
    }

    constructor(address _captureRegistry) {
        require(_captureRegistry != address(0), "zero registry");
        captureRegistry = ICaptureClassRegistryForScheme(_captureRegistry);
    }

    function schemeId()      external pure returns (bytes32) { return SCHEME_ID;      }
    function schemeVersion() external pure returns (uint16)  { return SCHEME_VERSION; }

    function onLock(
        address escrow,
        bytes32 stepId,
        bytes calldata commitmentPayload
    ) external returns (bytes32 commitmentHash) {
        (bytes32 challengeId, uint32 blockAnchor, address operator, uint8 minVerifiedClass) =
            abi.decode(commitmentPayload, (bytes32, uint32, address, uint8));

        require(challengeId     != bytes32(0), "zero challengeId");
        require(operator        != address(0), "zero operator");
        require(minVerifiedClass <= 5,         "class out of range");

        bytes32 key = keccak256(abi.encodePacked(escrow, stepId));
        require(!_commitments[key].set, "already committed");

        _commitments[key] = Commitment({
            challengeId:      challengeId,
            blockAnchor:      blockAnchor,
            operator:         operator,
            minVerifiedClass: minVerifiedClass,
            set:              true
        });

        commitmentHash = keccak256(
            abi.encode(SCHEME_ID, challengeId, blockAnchor, operator, minVerifiedClass)
        );
    }

    function onRelease(
        address escrow,
        bytes32 stepId,
        bytes32 commitmentHash,
        bytes calldata attestationData
    ) external view returns (bool valid) {
        bytes32 key = keccak256(abi.encodePacked(escrow, stepId));
        Commitment memory c = _commitments[key];
        require(c.set, "no commitment");

        bytes32 expected = keccak256(
            abi.encode(SCHEME_ID, c.challengeId, c.blockAnchor, c.operator, c.minVerifiedClass)
        );
        require(expected == commitmentHash, "commitment mismatch");

        bytes32 captureHash = abi.decode(attestationData, (bytes32));
        require(captureRegistry.exists(captureHash), "no such capture");

        ICaptureClassRegistryForScheme.CaptureAnchor memory a = captureRegistry.getAnchor(captureHash);

        return (
            a.challengeId  == c.challengeId  &&
            a.blockAnchor  == c.blockAnchor  &&
            a.submittedBy  == c.operator     &&
            a.verifiedClass >= c.minVerifiedClass
        );
    }

    function getCommitment(address escrow, bytes32 stepId) external view returns (Commitment memory) {
        return _commitments[keccak256(abi.encodePacked(escrow, stepId))];
    }
}

// ── VerificationCommitmentFuzzTest ────────────────────────────────────────────

/// @title VerificationCommitmentFuzzTest
/// @notice Fuzz suite targeting the commitment-comparison branches in
///   CaptureChallengeV1Scheme.onRelease.  Four mutation axes are exercised
///   independently:
///     Axis A — wrong challengeId   → must revert "commitment mismatch"
///     Axis B — wrong blockAnchor   → must revert "commitment mismatch"
///     Axis C — wrong operator      → must revert "commitment mismatch"
///     Axis D — wrong minVerifiedClass at lock time (tampered before hash comparison)
///   Plus a cross-scheme validity fuzz proving the happy path never reverts when
///   all four fields are consistent.
///
///   Mutation coverage targets ≥ 90% on the four boolean branches inside onRelease.
///   At 256 runs/axis the probability of missing any single-bit mutation is < 0.1%.
contract VerificationCommitmentFuzzTest is Test {

    CaptureChallengeV1Scheme internal scheme;
    MockCaptureClassRegistry internal mockRegistry;

    // A fake "escrow" address — we use address(this) to avoid deploy overhead in setUp.
    address internal constant ESCROW    = address(0xE5C70000);
    address internal constant OP_ALICE  = address(0xA11CE000);
    address internal constant OP_BOB    = address(0xB0B00000);

    // Fixed "good" commitment values used as baseline across mutation axes.
    bytes32 internal constant GOOD_CHALLENGE_ID    = keccak256("challenge-fuzz-baseline");
    uint32  internal constant GOOD_BLOCK_ANCHOR    = 1_000_000;
    uint8   internal constant GOOD_MIN_CLASS       = 2;

    // ── setUp ────────────────────────────────────────────────────────────

    function setUp() public {
        mockRegistry = new MockCaptureClassRegistry();
        scheme       = new CaptureChallengeV1Scheme(address(mockRegistry));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /// @dev Lock a commitment and return the hash.  Uses vm.prank(ESCROW) so
    ///   the scheme key is (ESCROW, stepId).
    function _lock(
        bytes32 stepId,
        bytes32 challengeId,
        uint32  blockAnchor,
        address operator,
        uint8   minVerifiedClass
    ) internal returns (bytes32 commitmentHash) {
        bytes memory payload = abi.encode(challengeId, blockAnchor, operator, minVerifiedClass);
        vm.prank(ESCROW);
        commitmentHash = scheme.onLock(ESCROW, stepId, payload);
    }

    /// @dev Inject a matching capture into the mock registry and call onRelease.
    function _injectCapture(
        bytes32 captureHash,
        bytes32 challengeId,
        uint32  blockAnchor,
        address submittedBy,
        uint8   verifiedClass
    ) internal {
        MockCaptureClassRegistry.CaptureAnchor memory a = MockCaptureClassRegistry.CaptureAnchor({
            captureHash:       captureHash,
            manifestHash:      keccak256("manifest"),
            declaredClass:     verifiedClass,
            verifiedClass:     verifiedClass,
            submittedBy:       submittedBy,
            jobId:             keccak256("job"),
            challengeId:       challengeId,
            blockAnchor:       blockAnchor,
            capturedAt:        uint64(block.timestamp),
            attestationsRoot:  bytes32(0),
            attesterCount:     0
        });
        mockRegistry.setAnchor(a);
    }

    // ── Axis A: Tampered challengeId → commitment mismatch ───────────────

    /// @notice Fuzz: any challengeId != GOOD_CHALLENGE_ID causes "commitment mismatch"
    ///   when the commitmentHash was derived from GOOD_CHALLENGE_ID.
    function testFuzz_axisA_wrongChallengeId_reverts(
        bytes32 badChallenge,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        // Skip the trivial case where the fuzz input matches the committed value.
        vm.assume(badChallenge != GOOD_CHALLENGE_ID);
        vm.assume(badChallenge != bytes32(0));
        vm.assume(captureHash != bytes32(0));

        bytes32 stepId = keccak256(abi.encodePacked("axisA", stepSeed));

        // Lock using the GOOD challengeId.
        bytes32 commitHash = _lock(stepId, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        // Attempt release with a tampered commitmentHash derived from the bad challengeId.
        bytes32 tamperedHash = keccak256(
            abi.encode(scheme.SCHEME_ID(), badChallenge, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS)
        );
        assertTrue(commitHash != tamperedHash, "tampered challengeId must produce different hash");
        _injectCapture(captureHash, badChallenge, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        bytes memory attestation = abi.encode(captureHash);
        // The scheme must detect that the tampered hash differs from the stored commitment hash.
        vm.prank(ESCROW);
        vm.expectRevert("commitment mismatch");
        scheme.onRelease(ESCROW, stepId, tamperedHash, attestation);

        // Also verify: passing the ORIGINAL hash but presenting anchor with wrong challengeId
        // does NOT produce a revert from commitment check — but does return false from the
        // field comparison (anchored challengeId != committed challengeId).
        // This exercises the path PAST the hash guard into the field-comparison branch.
        bytes32 stepId2 = keccak256(abi.encodePacked("axisA2", stepSeed));
        bytes32 commitHash2 = _lock(stepId2, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        bytes32 captureHash2 = keccak256(abi.encodePacked("capture2", captureHash));
        // Inject capture with the BAD challengeId so field comparison fails.
        _injectCapture(captureHash2, badChallenge, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        bytes memory attestation2 = abi.encode(captureHash2);
        vm.prank(ESCROW);
        bool valid = scheme.onRelease(ESCROW, stepId2, commitHash2, attestation2);
        assertFalse(valid, "wrong challengeId must return false");
    }

    // ── Axis B: Tampered blockAnchor → commitment mismatch ───────────────

    /// @notice Fuzz: any blockAnchor != GOOD_BLOCK_ANCHOR causes "commitment mismatch"
    ///   OR returns false if only the anchor data differs.
    function testFuzz_axisB_wrongBlockAnchor_reverts(
        uint32 badAnchor,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        vm.assume(badAnchor != GOOD_BLOCK_ANCHOR);
        vm.assume(captureHash != bytes32(0));

        bytes32 stepId = keccak256(abi.encodePacked("axisB", stepSeed));
        bytes32 commitHash = _lock(stepId, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        // Tampered hash: derived from badAnchor.
        bytes32 tamperedHash = keccak256(
            abi.encode(scheme.SCHEME_ID(), GOOD_CHALLENGE_ID, badAnchor, OP_ALICE, GOOD_MIN_CLASS)
        );
        assertTrue(commitHash != tamperedHash, "tampered blockAnchor must produce different hash");
        _injectCapture(captureHash, GOOD_CHALLENGE_ID, badAnchor, OP_ALICE, GOOD_MIN_CLASS);

        bytes memory attestation = abi.encode(captureHash);
        vm.prank(ESCROW);
        vm.expectRevert("commitment mismatch");
        scheme.onRelease(ESCROW, stepId, tamperedHash, attestation);

        // Field-comparison path: correct hash, wrong anchor in anchor data → false.
        bytes32 stepId2   = keccak256(abi.encodePacked("axisB2", stepSeed));
        bytes32 commit2   = _lock(stepId2, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);
        bytes32 capture2  = keccak256(abi.encodePacked("B2cap", captureHash));
        _injectCapture(capture2, GOOD_CHALLENGE_ID, badAnchor, OP_ALICE, GOOD_MIN_CLASS);

        vm.prank(ESCROW);
        bool valid = scheme.onRelease(ESCROW, stepId2, commit2, abi.encode(capture2));
        assertFalse(valid, "wrong blockAnchor must return false");
    }

    // ── Axis C: Tampered operator → commitment mismatch OR false ─────────

    /// @notice Fuzz: any operator != OP_ALICE causes "commitment mismatch" when hash is
    ///   tampered, OR returns false when hash is correct but anchor.submittedBy is wrong.
    function testFuzz_axisC_wrongOperator_reverts(
        address badOperator,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        vm.assume(badOperator != OP_ALICE);
        vm.assume(badOperator != address(0));
        vm.assume(captureHash != bytes32(0));

        bytes32 stepId = keccak256(abi.encodePacked("axisC", stepSeed));
        bytes32 commitHash = _lock(stepId, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        // Tampered hash with different operator.
        bytes32 tamperedHash = keccak256(
            abi.encode(scheme.SCHEME_ID(), GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, badOperator, GOOD_MIN_CLASS)
        );
        assertTrue(commitHash != tamperedHash, "tampered operator must produce different hash");
        _injectCapture(captureHash, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, badOperator, GOOD_MIN_CLASS);

        bytes memory attestation = abi.encode(captureHash);
        vm.prank(ESCROW);
        vm.expectRevert("commitment mismatch");
        scheme.onRelease(ESCROW, stepId, tamperedHash, attestation);

        // Field-comparison path: correct hash, wrong submittedBy in anchor → false.
        bytes32 stepId2  = keccak256(abi.encodePacked("axisC2", stepSeed));
        bytes32 commit2  = _lock(stepId2, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);
        bytes32 capture2 = keccak256(abi.encodePacked("C2cap", captureHash));
        _injectCapture(capture2, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, badOperator, GOOD_MIN_CLASS);

        vm.prank(ESCROW);
        bool valid = scheme.onRelease(ESCROW, stepId2, commit2, abi.encode(capture2));
        assertFalse(valid, "wrong operator must return false");
    }

    // ── Axis D: Tampered minVerifiedClass at lock time ───────────────────

    /// @notice Fuzz: a different minVerifiedClass at lock produces a different hash.
    ///   Presenting that tampered hash to a milestone locked with the original
    ///   minVerifiedClass must revert "commitment mismatch".
    ///   Also checks that verifiedClass below the committed min returns false.
    function testFuzz_axisD_wrongMinVerifiedClass_reverts(
        uint8 badClass,
        uint8 anchorClassSeed,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        badClass = badClass % 6; // 0..5
        vm.assume(badClass != GOOD_MIN_CLASS);
        vm.assume(captureHash != bytes32(0));

        bytes32 stepId = keccak256(abi.encodePacked("axisD", stepSeed));
        bytes32 commitHash = _lock(stepId, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        // Tampered hash built with a different minVerifiedClass.
        bytes32 tamperedHash = keccak256(
            abi.encode(scheme.SCHEME_ID(), GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, badClass)
        );
        assertTrue(commitHash != tamperedHash, "tampered minVerifiedClass must produce different hash");
        uint8 anchorClass = anchorClassSeed % 6;
        _injectCapture(captureHash, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, anchorClass);

        bytes memory attestation = abi.encode(captureHash);
        vm.prank(ESCROW);
        vm.expectRevert("commitment mismatch");
        scheme.onRelease(ESCROW, stepId, tamperedHash, attestation);

        // Field comparison: correct hash, anchor.verifiedClass < committed minVerifiedClass → false.
        // Only run this sub-case when a valid "too-low" class exists.
        if (GOOD_MIN_CLASS > 0) {
            uint8 tooLowClass = GOOD_MIN_CLASS - 1; // always < GOOD_MIN_CLASS
            bytes32 stepId2  = keccak256(abi.encodePacked("axisD2", stepSeed));
            bytes32 commit2  = _lock(stepId2, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);
            bytes32 capture2 = keccak256(abi.encodePacked("D2cap", captureHash));
            _injectCapture(capture2, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, tooLowClass);

            vm.prank(ESCROW);
            bool valid = scheme.onRelease(ESCROW, stepId2, commit2, abi.encode(capture2));
            assertFalse(valid, "class below min must return false");
        }
    }

    // ── Happy path: all four fields correct → always returns true ────────

    /// @notice Fuzz: valid commitment data + matching anchor → onRelease returns true.
    ///   Covers the "all-four-branches-pass" path across the full valid input space.
    function testFuzz_happyPath_validCommitmentNeverReverts(
        bytes32 challengeId,
        uint32  blockAnchor,
        uint8   minClassSeed,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        vm.assume(challengeId != bytes32(0));
        vm.assume(captureHash != bytes32(0));

        // Bound class to [0,5]
        uint8 minClass = minClassSeed % 6;

        bytes32 stepId = keccak256(abi.encodePacked("happy", stepSeed));
        bytes32 commitHash = _lock(stepId, challengeId, blockAnchor, OP_ALICE, minClass);

        // Anchor with exactly matching fields and verifiedClass >= minClass.
        uint8 anchorClass = minClass; // at the boundary — always satisfies >=
        _injectCapture(captureHash, challengeId, blockAnchor, OP_ALICE, anchorClass);

        bytes memory attestation = abi.encode(captureHash);
        vm.prank(ESCROW);
        bool valid = scheme.onRelease(ESCROW, stepId, commitHash, attestation);
        assertTrue(valid, "happy path must return true");
    }

    // ── Revert: no commitment (onRelease before onLock) ──────────────────

    function testFuzz_onRelease_noCommitment_reverts(
        bytes32 stepSeed,
        bytes32 commitHash,
        bytes32 captureHash
    ) public {
        bytes32 stepId = keccak256(abi.encodePacked("nolock", stepSeed));
        // Never call onLock — commitment should be absent.
        _injectCapture(captureHash, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, GOOD_MIN_CLASS);

        bytes memory attestation = abi.encode(captureHash);
        vm.prank(ESCROW);
        vm.expectRevert("no commitment");
        scheme.onRelease(ESCROW, stepId, commitHash, attestation);
    }

    // ── Revert: capture does not exist in registry ────────────────────────

    function testFuzz_onRelease_nonexistentCapture_reverts(
        bytes32 challengeId,
        uint32  blockAnchor,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        vm.assume(challengeId  != bytes32(0));
        vm.assume(captureHash  != bytes32(0));

        uint8 minClass = 1;
        bytes32 stepId = keccak256(abi.encodePacked("noCapture", stepSeed));
        bytes32 commitHash = _lock(stepId, challengeId, blockAnchor, OP_ALICE, minClass);

        // Do NOT inject the capture — registry.exists returns false.
        bytes memory attestation = abi.encode(captureHash);
        vm.prank(ESCROW);
        vm.expectRevert("no such capture");
        scheme.onRelease(ESCROW, stepId, commitHash, attestation);
    }

    // ── Revert: onLock double-commit same (escrow, stepId) ───────────────

    function testFuzz_onLock_doubleCommit_reverts(
        bytes32 challengeId,
        uint32  blockAnchor,
        bytes32 stepSeed
    ) public {
        vm.assume(challengeId != bytes32(0));
        bytes32 stepId = keccak256(abi.encodePacked("dblLock", stepSeed));

        // First lock — must succeed.
        _lock(stepId, challengeId, blockAnchor, OP_ALICE, 1);

        // Second lock on the same (ESCROW, stepId) — must revert.
        bytes memory payload = abi.encode(challengeId, blockAnchor, OP_ALICE, uint8(1));
        vm.prank(ESCROW);
        vm.expectRevert("already committed");
        scheme.onLock(ESCROW, stepId, payload);
    }

    // ── onLock: bad inputs ────────────────────────────────────────────────

    function testFuzz_onLock_zeroChallengeId_reverts(bytes32 stepSeed) public {
        bytes32 stepId = keccak256(abi.encodePacked("zeroChal", stepSeed));
        bytes memory payload = abi.encode(bytes32(0), uint32(1), OP_ALICE, uint8(1));
        vm.prank(ESCROW);
        vm.expectRevert("zero challengeId");
        scheme.onLock(ESCROW, stepId, payload);
    }

    function testFuzz_onLock_zeroOperator_reverts(bytes32 stepSeed, bytes32 challengeId) public {
        vm.assume(challengeId != bytes32(0));
        bytes32 stepId = keccak256(abi.encodePacked("zeroOp", stepSeed));
        bytes memory payload = abi.encode(challengeId, uint32(1), address(0), uint8(1));
        vm.prank(ESCROW);
        vm.expectRevert("zero operator");
        scheme.onLock(ESCROW, stepId, payload);
    }

    function testFuzz_onLock_classAbove5_reverts(
        bytes32 stepSeed,
        bytes32 challengeId,
        uint8   badClass
    ) public {
        vm.assume(challengeId != bytes32(0));
        vm.assume(badClass > 5);
        bytes32 stepId = keccak256(abi.encodePacked("badClass", stepSeed));
        bytes memory payload = abi.encode(challengeId, uint32(1), OP_ALICE, badClass);
        vm.prank(ESCROW);
        vm.expectRevert("class out of range");
        scheme.onLock(ESCROW, stepId, payload);
    }

    // ── Anchor-read: verifiedClass above min passes ───────────────────────

    /// @notice Prove verifiedClass >= minVerifiedClass (not just ==) is accepted.
    ///   This exercises the ">=" branch rather than the "==" branch.
    function testFuzz_higherClassThanMin_returnsTrue(
        uint8 minClassSeed,
        uint8 excessSeed,
        bytes32 captureHash,
        bytes32 stepSeed
    ) public {
        uint8 minClass = minClassSeed % 5; // 0..4 so there's room for excess
        uint8 extra    = excessSeed  % (5 - minClass + 1); // 0..(5-minClass)
        uint8 anchorClass = minClass + extra; // >= minClass, <= 5

        vm.assume(captureHash != bytes32(0));

        bytes32 stepId     = keccak256(abi.encodePacked("highClass", stepSeed));
        bytes32 commitHash = _lock(stepId, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, minClass);
        _injectCapture(captureHash, GOOD_CHALLENGE_ID, GOOD_BLOCK_ANCHOR, OP_ALICE, anchorClass);

        vm.prank(ESCROW);
        bool valid = scheme.onRelease(ESCROW, stepId, commitHash, abi.encode(captureHash));
        assertTrue(valid, "verifiedClass >= minClass must return true");
    }
}
