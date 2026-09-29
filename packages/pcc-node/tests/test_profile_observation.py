"""pcc_node.profile_observation: the producer half of N24 (LO-SE-2).

The goldens are TS values. PROFILE_DIGEST is the pinned print-pilot digest from
packages/spec/src/__tests__/measurement-profile.test.ts, and EVENT_HASH is TS
hashEvent over the event built in test_a_built_event_hashes_as_typescript_does.
A mismatch means a Python producer's observation could never be admitted.
"""

import copy

import pytest

from pcc_node.log_capture import canonicalize, sha256_hex
from pcc_node.profile_observation import (
    PROFILE_OBSERVATION_FIELD,
    ProfileObservationError,
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
EVENT_HASH = "sha256:3ed76667b228b2ddd441d83bb83d31c35fd56c5547596ce0c466c5ebb98a7340"


def mass_profile():
    p = copy.deepcopy(PILOT)
    p["measurement"] = {"method": "load-cell", "quantity": "mass", "unit": "kg", "sampling": {"minSamples": 1}}
    return p


def observe(profile=PILOT, digest=None, **over):
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
        committed_profile(other, PROFILE_DIGEST)
    assert committed_profile(PILOT, PROFILE_DIGEST) is PILOT


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
        "profileDigest": PROFILE_DIGEST,
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
    p = copy.deepcopy(PILOT)
    p["device"]["permittedFirmwareVersions"] = ["cam-fw-2.1.0"]
    assert source_mismatches(p, stamped()) == []
    problems = source_mismatches(PILOT, stamped(device_type="thermal_camera", adapter_version="PhotoCameraAdapter-9.9.9"))
    assert [m.split(" ")[0] for m in problems] == ["deviceType", "adapterVersion", "firmwareVersion"]


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
                PILOT, PROFILE_DIGEST, primitive_id="capture.photo_nonced", sample=sample_id(b"golden capture")
            ),
        },
    }
    assert sha256_hex(canonicalize(event)) == EVENT_HASH
