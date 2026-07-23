// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementLib, FeeSchedule} from "../src/libraries/VNextSettlementLib.sol";

/// @dev External wrapper so `vm.expectRevert` / try-catch can observe VNextSettlementLib's
///      INTERNAL reverts (an inlined internal revert in the same frame would not be caught).
contract LibHarness {
    function checkInvariants(FeeSchedule memory s) external pure {
        VNextSettlementLib.checkV1Invariants(s);
    }
}

/// @dev External JSON-path probe. Raw `vm.parseJson` returns the abi-encoded bytes of whatever value
///      a path resolves to, and returns EMPTY bytes when the path is absent (the RAW variant does not
///      revert — only the typed `parseJson*` variants do). It probes the ELEMENT path (`.vectors[idx]`),
///      NOT a sub-field, so an appended element is detected as PRESENT via a NON-EMPTY return even if it
///      is malformed / missing `.name` — closing the structure-dependent evasion. Callers assert
///      `.length == 0` at index == declared count to prove EXACT length; entries appended without
///      bumping `._meta.count` yield a non-empty return and fail loudly.
contract JsonProbe {
    Vm private constant _vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function vectorAt(string calldata json, uint256 idx) external pure returns (bytes memory) {
        return _vm.parseJson(json, string.concat(".vectors[", _vm.toString(idx), "]"));
    }

    function sensitivityAt(string calldata json, uint256 idx) external pure returns (bytes memory) {
        return _vm.parseJson(json, string.concat(".feeScheduleHashSensitivity[", _vm.toString(idx), "]"));
    }
}

/// @title  Step10GoldenParityTest — M2 cross-language golden-parity gate
/// @notice Binds the escrow's `VNextSettlementLib` byte-for-byte to the EVIDENCE lane's
///         conformance fixtures (`test/fixtures/step10-{negative,signed}-v1.json`,
///         DRAFT-CONFORMANCE-v0.2.5, authored by session `92dc40cb`). Required pre-gate per
///         seam §17.12(e) + bulletins #409/#412.
///
/// SCOPE (what this suite proves against the pure library):
///   • `computeFeeScheduleHash`  — canonical + zero-fee + all invariant/identity/schema/replay
///     vectors' schedules reproduce the fixtures' pinned hashes BYTE-EXACT.
///   • `computeSettlementUnitId` — the E1 derivation reproduces every signed vector's unitId BYTE-EXACT.
///   • `checkV1Invariants`       — every `invariant`-class vector is rejected; encoding-class values pass.
///   • all 13 `feeScheduleHashSensitivity` single-field mutations reproduced BYTE-EXACT, fields pinned in order.
///   Loop bounds are read from `._meta.count`; a probe asserts each array has EXACTLY that many entries,
///   so appended entries are not silently skipped, and an unknown vector `class` FAILS the suite.
///
/// NOT COVERED here (out of scope for the pure lib — a SEPARATE escrow `release()` test owns these):
///   • Runtime REJECTION of the identity / schema / replay defects (wrong settlementUnitId mapping,
///     unsupported verdictSchemaVersion, unit reuse) — enforced in `release()` / verdict-decode / state,
///     not in `VNextSettlementLib`. This suite only asserts those vectors' fee-schedule hashes are internally
///     consistent; it does NOT assert the money-path rejects them.
///
/// Read-only: assertions against pure functions, no money-path change.
contract Step10GoldenParityTest is Test {
    string internal negJson;
    string internal signedJson;
    LibHarness internal harness;
    JsonProbe internal probe;

    string internal constant CANON = "._meta.feeHashEncoding.canonicalTestValues";
    string internal constant ZEROFEE = "._meta.feeHashEncoding.zeroFeeTestValues";

    function setUp() public {
        negJson = vm.readFile("./test/fixtures/step10-negative-v1.json");
        signedJson = vm.readFile("./test/fixtures/step10-signed-v1.json");
        harness = new LibHarness();
        probe = new JsonProbe();
    }

    function _readSchedule(string memory base) internal view returns (FeeSchedule memory s) {
        s.domainVersion      = uint8(vm.parseJsonUint(negJson, string.concat(base, ".domainVersion")));
        s.chainId            = vm.parseJsonUint(negJson, string.concat(base, ".chainId"));
        s.escrow             = vm.parseJsonAddress(negJson, string.concat(base, ".escrow"));
        s.settlementUnitId   = vm.parseJsonBytes32(negJson, string.concat(base, ".settlementUnitId"));
        s.feeBasis           = uint8(vm.parseJsonUint(negJson, string.concat(base, ".feeBasis")));
        s.g                  = vm.parseUint(vm.parseJsonString(negJson, string.concat(base, ".G")));
        s.f                  = vm.parseUint(vm.parseJsonString(negJson, string.concat(base, ".F")));
        s.n                  = vm.parseUint(vm.parseJsonString(negJson, string.concat(base, ".N")));
        s.feeBps             = uint16(vm.parseJsonUint(negJson, string.concat(base, ".feeBps")));
        s.denominator        = vm.parseJsonUint(negJson, string.concat(base, ".denominator"));
        s.roundingRule       = uint8(vm.parseJsonUint(negJson, string.concat(base, ".roundingRule")));
        s.feeRecipient       = vm.parseJsonAddress(negJson, string.concat(base, ".feeRecipient"));
        s.feeSplitConfigHash = vm.parseJsonBytes32(negJson, string.concat(base, ".feeSplitConfigHash"));
    }

    /// Replace exactly one field of a schedule (drives the sensitivity table).
    function _mutate(FeeSchedule memory s, string memory field, string memory val)
        internal
        pure
        returns (FeeSchedule memory)
    {
        bytes32 f = keccak256(bytes(field));
        if (f == keccak256("domainVersion")) s.domainVersion = uint8(vm.parseUint(val));
        else if (f == keccak256("chainId")) s.chainId = vm.parseUint(val);
        else if (f == keccak256("escrow")) s.escrow = vm.parseAddress(val);
        else if (f == keccak256("settlementUnitId")) s.settlementUnitId = vm.parseBytes32(val);
        else if (f == keccak256("feeBasis")) s.feeBasis = uint8(vm.parseUint(val));
        else if (f == keccak256("G")) s.g = vm.parseUint(val);
        else if (f == keccak256("F")) s.f = vm.parseUint(val);
        else if (f == keccak256("N")) s.n = vm.parseUint(val);
        else if (f == keccak256("feeBps")) s.feeBps = uint16(vm.parseUint(val));
        else if (f == keccak256("denominator")) s.denominator = vm.parseUint(val);
        else if (f == keccak256("roundingRule")) s.roundingRule = uint8(vm.parseUint(val));
        else if (f == keccak256("feeRecipient")) s.feeRecipient = vm.parseAddress(val);
        else if (f == keccak256("feeSplitConfigHash")) s.feeSplitConfigHash = vm.parseBytes32(val);
        else revert(string.concat("unknown sensitivity field: ", field));
        return s;
    }

    /// Drift guard: assert `.vectors` has EXACTLY `declared` entries — index `declared` must be
    /// absent (empty parseJson return), structure-independently.
    function _assertVectorsExactLength(string memory json, uint256 declared) internal view {
        assertEq(
            probe.vectorAt(json, declared).length,
            0,
            "stale ._meta.count: a .vectors element exists beyond the declared count (would be skipped)"
        );
    }

    // ─── Anchor feeScheduleHash byte-parity ─────────────────────────────────────

    function test_canonical_feeScheduleHash_byteExact() public view {
        assertEq(
            VNextSettlementLib.computeFeeScheduleHash(_readSchedule(CANON)),
            vm.parseJsonBytes32(negJson, "._meta.feeHashEncoding.canonicalFeeScheduleHash"),
            "canonical feeScheduleHash != evidence golden vector"
        );
    }

    function test_zeroFee_feeScheduleHash_byteExact() public view {
        assertEq(
            VNextSettlementLib.computeFeeScheduleHash(_readSchedule(ZEROFEE)),
            vm.parseJsonBytes32(negJson, "._meta.feeHashEncoding.zeroFeeScheduleHash"),
            "zero-fee feeScheduleHash != evidence golden vector"
        );
    }

    function test_canonical_and_zeroFee_passInvariants() public view {
        harness.checkInvariants(_readSchedule(CANON));
        harness.checkInvariants(_readSchedule(ZEROFEE));
    }

    // ─── settlementUnitId E1 derivation parity (from the signed fixture) ─────────

    function test_settlementUnitId_E1_derivation_byteExact() public {
        uint256 declared = vm.parseJsonUint(signedJson, "._meta.count");
        assertGt(declared, 0, "signed vector count must be > 0");
        _assertVectorsExactLength(signedJson, declared);
        for (uint256 i = 0; i < declared; i++) {
            string memory vp = string.concat(".vectors[", vm.toString(i), "].verdict");
            string memory jobId = vm.parseJsonString(signedJson, string.concat(vp, ".jobId"));
            uint256 milestoneIndex = vm.parseJsonUint(signedJson, string.concat(vp, ".milestoneIndex"));
            bytes32 stepId = vm.parseJsonBytes32(signedJson, string.concat(vp, ".stepId"));
            bytes32 want = vm.parseJsonBytes32(signedJson, string.concat(vp, ".settlementUnitId"));
            uint256 chainId = vm.parseJsonUint(signedJson, string.concat(vp, ".settlementDomain.chainId"));
            address escrow = vm.parseJsonAddress(signedJson, string.concat(vp, ".settlementDomain.escrowAddress"));

            bytes32 got = VNextSettlementLib.computeSettlementUnitId(
                chainId, escrow, keccak256(bytes(jobId)), milestoneIndex, stepId
            );
            assertEq(got, want, string.concat("settlementUnitId E1 derivation mismatch for jobId=", jobId));
        }
    }

    // ─── Reject-reason parity spot-checks ───────────────────────────────────────

    function test_reject_reason_NplusF_neq_G() public {
        FeeSchedule memory s = _readSchedule(CANON);
        s.n += 1;
        vm.expectRevert(bytes("V1: N+F!=G"));
        harness.checkInvariants(s);
    }

    function test_reject_reason_feeBps_over_max() public {
        FeeSchedule memory s = _readSchedule(CANON);
        s.feeBps = 1500;
        vm.expectRevert(bytes("V1: feeBps>MAX"));
        harness.checkInvariants(s);
    }

    // ─── Meta-test: the drift probe is structure-independent (sol caveat, closed) ───

    /// Proves the exact-length guard detects element PRESENCE regardless of element shape, so a
    /// malformed appended element (missing `.name`) is NOT misread as "absent" and thus skipped.
    function test_driftProbe_isStructureIndependent() public view {
        string memory j = '{"vectors":[{"x":1},{"y":2}],"feeScheduleHashSensitivity":[{"z":3}]}';
        // Present elements carry NO `.name`/`.mutatedField`, yet must be seen as PRESENT (non-empty):
        assertGt(probe.vectorAt(j, 0).length, 0, "present vectors[0] must be non-empty");
        assertGt(probe.vectorAt(j, 1).length, 0, "present vectors[1] must be non-empty");
        assertGt(probe.sensitivityAt(j, 0).length, 0, "present sensitivity[0] must be non-empty");
        // Absent indices must be EMPTY — this is exactly what the exact-length guards rely on:
        assertEq(probe.vectorAt(j, 2).length, 0, "absent vectors[2] must be empty");
        assertEq(probe.sensitivityAt(j, 1).length, 0, "absent sensitivity[1] must be empty");
    }

    // ─── ALL negative vectors (count read from fixture), dispatched by class ─────

    function test_allNegativeVectors() public {
        uint256 declared = vm.parseJsonUint(negJson, "._meta.count");
        assertGt(declared, 0, "negative vector count must be > 0");
        _assertVectorsExactLength(negJson, declared);
        for (uint256 i = 0; i < declared; i++) {
            string memory vp = string.concat(".vectors[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(negJson, string.concat(vp, ".name"));
            string memory cls = vm.parseJsonString(negJson, string.concat(vp, ".class"));
            bytes32 c = keccak256(bytes(cls));
            bytes32 attested = vm.parseJsonBytes32(negJson, string.concat(vp, ".attestedFeeScheduleHash"));
            FeeSchedule memory s = _readSchedule(string.concat(vp, ".feeSchedule"));
            bytes32 h = VNextSettlementLib.computeFeeScheduleHash(s);

            if (c == keccak256("invariant")) {
                // The (invalid) schedule's hash is still correct; the defect is the invariant.
                assertEq(h, attested, string.concat("invariant vec hash mismatch: ", name));
                bool reverted;
                try harness.checkInvariants(s) {} catch { reverted = true; }
                assertTrue(reverted, string.concat("invariant vec did NOT reject: ", name));
            } else if (c == keccak256("encoding") || c == keccak256("field-order")) {
                // Deliberately wrong encoding: the correct abi.encode recompute MUST differ.
                assertTrue(h != attested, string.concat("encoding vec: recompute should differ: ", name));
                bool reverted;
                try harness.checkInvariants(s) {} catch { reverted = true; }
                assertFalse(reverted, string.concat("encoding vec values should be valid: ", name));
            } else if (c == keccak256("identity") || c == keccak256("schema") || c == keccak256("replay")) {
                // Hash is internally consistent; the REJECTION of these defects lives in
                // release()/verdict-decode/state — NOT in the pure lib (see contract NOT-COVERED note).
                assertEq(h, attested, string.concat("consistency vec hash mismatch: ", name));
            } else {
                // No silent pass-through: an unrecognised class is a coverage gap, fail loudly.
                fail(string.concat("UNKNOWN vector class '", cls, "' at ", name, " -- extend the dispatch"));
            }
        }
    }

    // ─── ALL 13 feeScheduleHashSensitivity mutations (fields pinned in order) ────

    function test_feeScheduleHashSensitivity_allFieldsBind() public {
        // The 13 fields of the feeScheduleHash pre-image are fixed by the seam §17.1 formula.
        // Pinning the order makes any field add/drop/reorder in the fixture FAIL rather than skip.
        string[13] memory EXP;
        EXP[0] = "domainVersion";
        EXP[1] = "chainId";
        EXP[2] = "escrow";
        EXP[3] = "settlementUnitId";
        EXP[4] = "feeBasis";
        EXP[5] = "G";
        EXP[6] = "F";
        EXP[7] = "N";
        EXP[8] = "feeBps";
        EXP[9] = "denominator";
        EXP[10] = "roundingRule";
        EXP[11] = "feeRecipient";
        EXP[12] = "feeSplitConfigHash";

        // Guard: the table has EXACTLY 13 entries (no 14th appended silently).
        assertEq(
            probe.sensitivityAt(negJson, 13).length,
            0,
            "feeScheduleHashSensitivity has more than the seam-fixed 13 entries"
        );

        bytes32 canonHash = vm.parseJsonBytes32(negJson, "._meta.feeHashEncoding.canonicalFeeScheduleHash");
        for (uint256 i = 0; i < 13; i++) {
            string memory sp = string.concat(".feeScheduleHashSensitivity[", vm.toString(i), "]");
            string memory field = vm.parseJsonString(negJson, string.concat(sp, ".mutatedField"));
            assertEq(field, EXP[i], string.concat("sensitivity field order/coverage drift at index ", vm.toString(i)));
            string memory val = vm.parseJsonString(negJson, string.concat(sp, ".mutatedValue"));
            bytes32 expected = vm.parseJsonBytes32(negJson, string.concat(sp, ".mutatedFeeScheduleHash"));

            FeeSchedule memory m = _mutate(_readSchedule(CANON), field, val);
            bytes32 h = VNextSettlementLib.computeFeeScheduleHash(m);

            assertEq(h, expected, string.concat("sensitivity hash mismatch on field: ", field));
            assertTrue(h != canonHash, string.concat("sensitivity must differ from canonical: ", field));
        }
    }
}
