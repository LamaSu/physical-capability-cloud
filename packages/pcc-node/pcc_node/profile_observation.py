"""Measurement-profile observations for pcc-node producers (N24 producer half, LO-SE-2).

A job whose accepted agreement commits a MeasurementProfile digest must be
collected under that profile: the same digest governs collection, eligibility
and verification. The admission check in ``@pcc/spec``
(``profile-admission.ts``, PR #363) counts an observation only when:

- its ``source`` names the device kind, the adapter and both versions:
  ``deviceType``, ``adapterType``, ``adapterVersion`` and ``firmwareVersion``,
  each checked against its own profile term;
- its hashed payload carries ``payload.profileObservation``, which restates the
  committed digest, a listed primitive, the object, the method, the quantity
  and the unit, a decimal-string ``value`` exactly when the unit is not
  ``"none"``, and a ``sampleId`` (the sha256 of the raw capture).

This module builds those parts. It never decides admission. It refuses to
build a record the check would reject, so a producer fails loud at capture time
rather than silently at settlement.

The profile digest is recomputed here exactly as TS
``computeMeasurementProfileDigest`` does:
``"0x" + sha256(canonicalize({domain, profile}))``, with
``log_capture.canonicalize``. A profile that does not digest to the job's
committed digest is refused, because collecting under it would be collecting
under terms nobody accepted.

The source fields are written from what the device and adapter ARE, never
copied from the profile; copying would make the admission check vacuous.
``source_mismatches`` is the pre-flight comparison, so a daemon can see before
capturing that an observation will not qualify.
"""

import hashlib
import re

from pcc_node.log_capture import canonicalize

MEASUREMENT_PROFILE_DOMAIN = "PCC:measurement-profile:v1"
PROFILE_OBSERVATION_FIELD = "profileObservation"
NON_NUMERIC_UNIT = "none"

_PROFILE_DIGEST = re.compile(r"^0x[0-9a-f]{64}$")
_TAGGED_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
# A plain decimal: no exponent, no leading zeros, no "+". JS and Python print
# some floats differently (1e-7 against 1e-07), so a measured value travels
# as a string (evidence ruling, bus #3419).
DECIMAL_VALUE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$")


class ProfileObservationError(ValueError):
    """A profile observation this module refuses to build."""


def compute_measurement_profile_digest(profile):
    """``"0x" + sha256(canonicalize({"domain": ..., "profile": profile}))``.

    Byte-identical to TS ``computeMeasurementProfileDigest`` for the same
    profile (golden in tests/test_profile_observation.py). TS refuses to
    digest an invalid profile; here a digest is only ever compared with a
    committed one, and a committed digest exists only for a profile TS
    validated.
    """
    if not isinstance(profile, dict):
        raise ProfileObservationError("a measurement profile must be a JSON object")
    canonical = canonicalize({"domain": MEASUREMENT_PROFILE_DOMAIN, "profile": profile})
    return "0x" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def committed_profile(profile, committed_digest):
    """Return ``profile`` if it is the one the job's agreement committed.

    Raises ``ProfileObservationError`` for a malformed digest (the committed
    family is ``0x`` + 64 lowercase hex, never the ``sha256:`` event family)
    or for a profile that digests to anything else.
    """
    if not isinstance(committed_digest, str) or not _PROFILE_DIGEST.match(committed_digest):
        raise ProfileObservationError(
            f"committed profile digest {committed_digest!r} is not 0x + 64 lowercase hex"
        )
    actual = compute_measurement_profile_digest(profile)
    if actual != committed_digest:
        raise ProfileObservationError(
            f"the job's profile digests to {actual}, not the committed {committed_digest}: "
            "refusing to collect under terms the agreement did not commit"
        )
    return profile


def sample_id(raw):
    """``"sha256:" + hex`` of the raw capture bytes: one physical sample, one id.

    Reissuing an observation of the same capture keeps its id, so a sample is
    counted once. It does not prove two captures are physically distinct;
    that is the primitive verifier's question.
    """
    if not isinstance(raw, (bytes, bytearray)) or len(raw) == 0:
        raise ProfileObservationError("a sample id needs the raw capture bytes (non-empty)")
    return "sha256:" + hashlib.sha256(bytes(raw)).hexdigest()


def build_profile_observation(profile, committed_digest, *, primitive_id, sample, value=None):
    """The ``payload.profileObservation`` record for one observation.

    ``sample`` is the observation's ``sampleId`` (see :func:`sample_id`).
    ``value`` is a decimal string, required exactly when the profile's unit is
    not ``"none"``. A float is refused; pass the reading as the device printed
    it, for example ``"12.5"``.
    """
    committed_profile(profile, committed_digest)
    evidence_type_ids = profile["interpretation"]["evidenceTypeIds"]
    if primitive_id not in evidence_type_ids:
        raise ProfileObservationError(
            f"primitive {primitive_id!r} is not in the profile's evidenceTypeIds {evidence_type_ids!r}"
        )
    if not isinstance(sample, str) or not _TAGGED_DIGEST.match(sample):
        raise ProfileObservationError(f"sampleId {sample!r} is not a sha256: tagged digest")
    measurement = profile["measurement"]
    unit = measurement["unit"]
    if unit == NON_NUMERIC_UNIT:
        if value is not None:
            raise ProfileObservationError('the profile\'s unit is "none", so the observation carries no value')
    elif not isinstance(value, str) or not DECIMAL_VALUE.match(value):
        raise ProfileObservationError(
            f"unit {unit!r} needs the value as a plain decimal string such as \"12.5\"; got {value!r}"
        )
    obj = profile["outcome"]["objectIdentity"]
    record = {
        "profileDigest": committed_digest,
        "primitiveId": primitive_id,
        "object": {"kind": obj["kind"], "value": obj["value"]},
        "method": measurement["method"],
        "quantity": measurement["quantity"],
        "unit": unit,
        "sampleId": sample,
    }
    if unit != NON_NUMERIC_UNIT:
        record["value"] = value
    return record


def stamp_source(source, *, device_type, adapter_type, adapter_version, firmware_version):
    """A copy of ``source`` with the fields a profile checks, from the real device.

    Each value must be a non-empty string that says what the device and its
    adapter actually are. Never copy these from the profile.
    """
    fields = {
        "deviceType": device_type,
        "adapterType": adapter_type,
        "adapterVersion": adapter_version,
        "firmwareVersion": firmware_version,
    }
    for name, v in fields.items():
        if not isinstance(v, str) or not v.strip():
            raise ProfileObservationError(f"source.{name} must be a non-empty string")
    return {**source, **fields}


def source_mismatches(profile, source):
    """Why observations from ``source`` would not qualify under ``profile``.

    An empty list means the device, kind, adapter and versions all match.
    Pre-flight only: evidence is still recorded faithfully either way.
    """
    device = profile["device"]
    problems = []
    if source.get("deviceId") != device["deviceId"]:
        problems.append(f"deviceId {source.get('deviceId')!r} is not the profiled {device['deviceId']!r}")
    if source.get("deviceType") != device["kind"]:
        problems.append(f"deviceType {source.get('deviceType')!r} is not the profiled kind {device['kind']!r}")
    if source.get("adapterType") != device["adapterType"]:
        problems.append(f"adapterType {source.get('adapterType')!r} is not {device['adapterType']!r}")
    if source.get("adapterVersion") not in device["permittedAdapterVersions"]:
        problems.append(f"adapterVersion {source.get('adapterVersion')!r} is not a permitted adapter version")
    if source.get("firmwareVersion") not in device["permittedFirmwareVersions"]:
        problems.append(f"firmwareVersion {source.get('firmwareVersion')!r} is not a permitted firmware version")
    return problems
