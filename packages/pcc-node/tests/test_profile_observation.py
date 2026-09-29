"""pcc_node.profile_observation: the producer half of N24 (LO-SE-2).

The goldens are TS values. PROFILE_DIGEST is the pinned print-pilot digest from
packages/spec/src/__tests__/measurement-profile.test.ts, and EVENT_HASH is TS
hashEvent over the event built in test_a_built_event_hashes_as_typescript_does.
A mismatch means a Python producer's observation could never be admitted.

The pinned pilot itself cannot admit anything (its firmware pin is a pattern),
so observations are built under ADMISSIBLE, the pilot with exact pins and a
window of event types.
"""

import copy
import re
from pathlib import Path

import pytest

from pcc_node.log_capture import canonicalize, sha256_hex
from pcc_node.profile_observation import (
    EVIDENCE_DEVICE_TYPES,
    PROFILE_OBSERVATION_FIELD,
    ProfileObservationError,
    profile_admission_blockers,
    build_profile_observation,
    committed_profile,
    compute_measurement_profile_digest,
    sample_id,
    source_mismatches,
    stamp_source,
)

PILOT = {
    "profileVersion": 1,
    "profileId": "pcc://profiles/document-printing/inspected-page/v1",
    "outcome": {
        "capabilityType": "document-printing",
        "statement": "The submitted document was printed on paper and the printed page was photographed.",
        "objectIdentity": {"kind": "documentHash", "value": "sha256:" + "a" * 64},
    },
    "device": {
        "deviceId": "dev-hp-3301-0D253A",
        "kind": "camera",
        "adapterType": "photo",
        "permittedAdapterVersions": ["PhotoCameraAdapter-1.0.0"],
        "permittedFirmwareVersions": ["*-unpinned-pilot"],
    },
    "measurement": {
        "method": "optical-capture",
        "quantity": "printed-page-image",
        "unit": "none",
        "sampling": {"minSamples": 1},
    },
    "capture": {
        "startCondition": "printer_job_verified",
        "endCondition": "capture_complete",
        "coverage": {"policy": "one-shot", "minFraction": 1},
    },
    "calibration": {"required": False},
    "interpretation": {
        "evidenceTypeIds": ["capture.photo_nonced", "receipt.kernel_signed"],
        "acceptanceLevel": "inspected_output",
        "onDeviceFailure": "reject",
    },
    "simulationProhibited": True,
    "witnesses": {"requiredRoles": [], "independentOfClaimant": False},
    "onMissingData": "reject",
    "onContradiction": "reject",
}
# TS computeMeasurementProfileDigest(printPilotProfile()), pinned in measurement-profile.test.ts.
PROFILE_DIGEST = "0x7efecb6c05ae4241a87dc5082f7c9d1bac9158060a78beb01dcdfb2496e9bb6a"
# TS hashEvent of the event built below (computed with packages/spec/src/util/canonical.ts).
EVENT_HASH = "sha256:51417c57dd282fe0efec9a6e859b39b2b1c2a1b9d1f8c1f31112483788126ba6"

ADMISSIBLE = copy.deepcopy(PILOT)
ADMISSIBLE["device"]["permittedFirmwareVersions"] = ["cam-fw-2.1.0"]
ADMISSIBLE["capture"] = {"startCondition": "execution_completed", "endCondition": "open", "coverage": {"policy": "one-shot", "minFraction": 1}}
ADMISSIBLE_DIGEST = "0x5fa560602eabd22ee4ac6850f178612b6385b512ace356427313152a41c622a3"


def mass_profile():
    p = copy.deepcopy(ADMISSIBLE)
    p["measurement"] = {"method": "load-cell", "quantity": "mass", "unit": "kg", "sampling": {"minSamples": 1}}
    return p


def observe(profile=ADMISSIBLE, digest=None, **over):
    args = {"primitive_id": "capture.photo_nonced", "sample": sample_id(b"capture-1")}
    args.update(over)
    return build_profile_observation(profile, digest or compute_measurement_profile_digest(profile), **args)


# ── the committed digest ─────────────────────────────────────────────────────


def test_the_profile_digest_is_byte_identical_to_typescript():
    assert compute_measurement_profile_digest(PILOT) == PROFILE_DIGEST


def test_any_changed_term_changes_the_digest():
    for path, value in [(("measurement", "unit"), "kg"), (("device", "deviceId"), "dev-other"), (("onMissingData",), "hold")]:
        p = copy.deepcopy(PILOT)
        target = p
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        assert compute_measurement_profile_digest(p) != PROFILE_DIGEST, path


def test_a_profile_that_is_not_the_committed_one_is_refused():
    other = mass_profile()
    with pytest.raises(ProfileObservationError, match="refusing to collect"):
        committed_profile(other, ADMISSIBLE_DIGEST)
    assert compute_measurement_profile_digest(ADMISSIBLE) == ADMISSIBLE_DIGEST
    assert committed_profile(ADMISSIBLE, ADMISSIBLE_DIGEST) is ADMISSIBLE


# ── profile terms admission fails closed on (adk review F1, mirrors TS unverifiableProfileTerms) ──


def _with(path, value):
    p = copy.deepcopy(ADMISSIBLE)
    target = p
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return p


BLOCKED = [
    ("a version pin written as a pattern", ("device", "permittedFirmwareVersions"), ["*-unpinned-pilot"], "exact strings"),
    ("a numeric tolerance", ("measurement", "tolerance"), {"comparator": ">=", "target": 0.9}, "measurement.tolerance"),
    ("a kind no evidence source can carry", ("device", "kind"), "machine", "device.kind"),
    ("maxIntervalMs", ("measurement", "sampling"), {"minSamples": 1, "maxIntervalMs": 1000}, "maxIntervalMs"),
    ("required calibration", ("calibration",), {"required": True, "procedureId": "cal-1", "validityWindowSeconds": 3600}, "calibration.required"),
    ("required witnesses", ("witnesses",), {"requiredRoles": ["inspector"], "independentOfClaimant": True}, "witnesses.requiredRoles"),
    ("continuous coverage", ("capture", "coverage"), {"policy": "continuous", "minFraction": 0.9}, "coverage.policy"),
    ("one-shot coverage below 1", ("capture", "coverage"), {"policy": "one-shot", "minFraction": 0.5}, "coverage.minFraction"),
]


def test_an_admissible_profile_has_no_blockers():
    assert profile_admission_blockers(ADMISSIBLE) == []


@pytest.mark.parametrize("name, path, value, term", BLOCKED, ids=[b[0] for b in BLOCKED])
def test_a_profile_admission_fails_closed_on_is_refused_at_capture(name, path, value, term):
    p = _with(path, value)
    assert any(term in b for b in profile_admission_blockers(p))
    with pytest.raises(ProfileObservationError, match="cannot admit any observation"):
        committed_profile(p, compute_measurement_profile_digest(p))


def test_the_pinned_pilot_itself_cannot_admit_anything():
    with pytest.raises(ProfileObservationError, match="exact strings"):
        committed_profile(PILOT, PROFILE_DIGEST)


def test_device_types_match_the_typescript_vocabulary():
    ts = (Path(__file__).resolve().parents[2] / "spec" / "src" / "types" / "evidence.ts").read_text(encoding="utf-8")
    block = ts[ts.index("export const EVIDENCE_DEVICE_TYPES = [") : ts.index("] as const", ts.index("export const EVIDENCE_DEVICE_TYPES = ["))]
    assert tuple(re.findall(r'"([^"]+)"', block)) == EVIDENCE_DEVICE_TYPES


@pytest.mark.parametrize("bad", ["sha256:" + PROFILE_DIGEST[2:], PROFILE_DIGEST.upper().replace("0X", "0x"), PROFILE_DIGEST[:-1], None, 7])
def test_a_committed_digest_outside_the_0x_family_is_refused(bad):
    with pytest.raises(ProfileObservationError, match="0x \\+ 64 lowercase hex"):
        committed_profile(PILOT, bad)


def test_a_profile_that_is_not_an_object_is_refused():
    with pytest.raises(ProfileObservationError, match="JSON object"):
        compute_measurement_profile_digest([PILOT])


# ── the observation record ───────────────────────────────────────────────────


def test_the_record_restates_the_committed_terms():
    record = observe()
    assert record == {
        "profileDigest": ADMISSIBLE_DIGEST,
        "primitiveId": "capture.photo_nonced",
        "object": {"kind": "documentHash", "value": "sha256:" + "a" * 64},
        "method": "optical-capture",
        "quantity": "printed-page-image",
        "unit": "none",
        "sampleId": sample_id(b"capture-1"),
    }


def test_the_record_is_built_only_under_the_committed_profile():
    with pytest.raises(ProfileObservationError, match="refusing to collect"):
        observe(digest="0x" + "0" * 64)


def test_a_primitive_the_profile_does_not_list_is_refused():
    with pytest.raises(ProfileObservationError, match="evidenceTypeIds"):
        observe(primitive_id="artifact.hash")


def test_a_numeric_unit_carries_its_value_as_a_decimal_string():
    p = mass_profile()
    assert observe(p, value="12.5")["value"] == "12.5"
    assert observe(p, value="-0.5")["value"] == "-0.5"


@pytest.mark.parametrize("bad", [None, 12.5, "1e-7", "01.5", "+3", "12.", ".5", " 12.5"])
def test_a_numeric_value_that_is_not_a_plain_decimal_string_is_refused(bad):
    with pytest.raises(ProfileObservationError, match="decimal string"):
        observe(mass_profile(), value=bad)


def test_a_non_numeric_observation_carries_no_value():
    assert "value" not in observe()
    with pytest.raises(ProfileObservationError, match='unit is "none"'):
        observe(value="3")


@pytest.mark.parametrize("bad", ["frame-7", "sha256:" + "A" * 64, "sha256:" + "a" * 63, None])
def test_a_sample_id_that_is_not_a_sha256_digest_is_refused(bad):
    with pytest.raises(ProfileObservationError, match="sampleId"):
        observe(sample=bad)


def test_one_capture_has_one_sample_id():
    assert sample_id(b"capture-1") == sample_id(bytearray(b"capture-1"))
    assert sample_id(b"capture-1") != sample_id(b"capture-2")
    for bad in (b"", "capture-1", None):
        with pytest.raises(ProfileObservationError, match="raw capture bytes"):
            sample_id(bad)


# ── the source ───────────────────────────────────────────────────────────────


SOURCE = {"deviceId": "dev-hp-3301-0D253A", "kernelId": "kernel-golden-1"}


def stamped(**over):
    args = {
        "device_type": "camera",
        "adapter_type": "photo",
        "adapter_version": "PhotoCameraAdapter-1.0.0",
        "firmware_version": "cam-fw-2.1.0",
    }
    args.update(over)
    return stamp_source(SOURCE, **args)


def test_stamping_adds_the_four_checked_fields_without_touching_the_input():
    s = stamped()
    assert s == {**SOURCE, "deviceType": "camera", "adapterType": "photo", "adapterVersion": "PhotoCameraAdapter-1.0.0", "firmwareVersion": "cam-fw-2.1.0"}
    assert SOURCE == {"deviceId": "dev-hp-3301-0D253A", "kernelId": "kernel-golden-1"}


@pytest.mark.parametrize("field", ["device_type", "adapter_type", "adapter_version", "firmware_version"])
def test_every_stamped_field_must_be_a_non_empty_string(field):
    for bad in ("", "  ", None, 7):
        with pytest.raises(ProfileObservationError, match="non-empty string"):
            stamped(**{field: bad})


def test_source_mismatches_names_every_term_the_device_fails():
    assert source_mismatches(ADMISSIBLE, stamped()) == []
    problems = source_mismatches(ADMISSIBLE, stamped(device_type="thermal_camera", adapter_version="PhotoCameraAdapter-9.9.9"))
    assert [m.split(" ")[0] for m in problems] == ["deviceType", "adapterVersion"]


def test_source_mismatches_blames_the_profile_when_no_device_could_match():
    problems = source_mismatches(PILOT, stamped())
    assert problems[0].startswith("profile: ") and "exact strings" in problems[0]


# ── the event, as TypeScript hashes it ───────────────────────────────────────


def test_a_built_event_hashes_as_typescript_does():
    event = {
        "type": "cv_inspection_result",
        "timestamp": "2026-09-28T12:00:20.000Z",
        "source": stamped(),
        "payload": {
            "jobId": "job-golden-1",
            "passed": True,
            PROFILE_OBSERVATION_FIELD: build_profile_observation(
                ADMISSIBLE, ADMISSIBLE_DIGEST, primitive_id="capture.photo_nonced", sample=sample_id(b"golden capture")
            ),
        },
    }
    assert sha256_hex(canonicalize(event)) == EVENT_HASH
