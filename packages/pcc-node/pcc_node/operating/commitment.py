"""What binds a device run's evidence to the claim it ran under (ADK item 12, verdict 117b).

The runtime's first log-chain entry commits to the claim, the job and the kernel, as well as the
operation, the device's record and its run id. So evidence made under one claim can never be
signed for another, and the gateway can check the claim against the token hash it keeps. The
start request carries an idempotency key derived from the same claim, never the token itself.

A record must be portable JSON: text that any JSON parser reads back exactly. That excludes
NaN and the infinities (not JSON at all), integers past 2^53 - 1 (a JavaScript parser rounds
them), and strings that are not valid Unicode (unpaired surrogates cannot be UTF-8 encoded, so
they cannot be hashed the same way twice). A device that reports such a value gets no evidence.
"""

import hashlib
import math
from typing import Any

from pcc_node.log_capture import canonicalize

# The bundle's wire schema. recordCanonical is the record's canonical JSON text: hash it as a
# string; it parses back exactly with any JSON parser, because only portable records are signed.
EVIDENCE_SCHEMA = "pcc-node.job-evidence/1"
MAX_SAFE_INTEGER = 2 ** 53 - 1
_MAX_DEPTH = 64


def claim_digest(claim_token: str) -> str:
    """Lowercase hex SHA-256 of the claim token's UTF-8 bytes: it names the claim without revealing it."""
    return hashlib.sha256(claim_token.encode("utf-8")).hexdigest()


def idempotency_key(job_id: str, kernel_id: str, claim_token: str) -> str:
    """The start request's Idempotency-Key: one per claim, the same on any retry, never the token."""
    material = "\n".join(("pcc-node/idempotency/1", job_id, kernel_id, claim_digest(claim_token)))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def record_commitment(claim_token: str, job_id: str, kernel_id: str, operation: str, record: Any,
                      run_id: str) -> str:
    """The text the first log-chain entry signs: the claim, job, kernel, operation, record and run id."""
    return canonicalize({"claim": claim_digest(claim_token), "jobId": job_id, "kernelId": kernel_id,
                         "operation": operation, "record": record, "runId": run_id})


def _unicode(text: str) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def portable(value: Any, depth: int = 0) -> bool:
    """True if value is JSON that any parser reads back exactly (see the module docstring)."""
    if depth > _MAX_DEPTH:
        return False
    if value is None or isinstance(value, bool):
        return True
    if isinstance(value, int):
        return -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, str):
        return _unicode(value)
    if isinstance(value, list):
        return all(portable(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _unicode(k) and portable(v, depth + 1) for k, v in value.items())
    return False
