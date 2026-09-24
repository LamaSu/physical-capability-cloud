"""Real job executor -- maps capability types to device adapters.

This module handles the full job execution lifecycle:
  1. Receive a job dict from the gateway
  2. Find the best device/adapter for the job's capability type
  3. Execute the job (IPP print, Opentrons protocol, OctoPrint job, etc.)
  4. Build an evidence bundle
  5. Report evidence + status back via the gateway client
  6. For a job the device only ACCEPTED (an ``lp`` spool, an OctoPrint print
     start), keep checking the device once per daemon cycle
     (:meth:`JobExecutor.poll_awaiting`) and report the outcome the DEVICE
     reports -- IPP ``job-state``, OctoPrint ``/api/job``
"""

import json
import logging
import math
import os
import platform
import re
import struct
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

log = logging.getLogger("pcc-node.job-executor")

# ---------------------------------------------------------------------------
# Capability type -> device protocol mapping
# ---------------------------------------------------------------------------

CAPABILITY_PROTOCOL_MAP: Dict[str, List[str]] = {
    "document-printing": ["ipp", "printer"],
    "liquid-handler": ["opentrons"],
    "pipette-transfer": ["opentrons"],
    "3d-print": ["octoprint"],
    "fdm-fabrication": ["octoprint"],
    "network-instrument": ["http", "generic"],
    "generic": ["generic", "http", "unknown"],
}


# ---------------------------------------------------------------------------
# IPP / printer execution
# ---------------------------------------------------------------------------

def execute_ipp_print(device: Dict, job: Dict) -> Dict[str, Any]:
    """Print a document via IPP using the system print command.

    On Linux/macOS: ``lp -h <ip> -d default <file>``
    On Windows:     ``notepad /p <file>``  (or rundll32 for images)

    Returns a result dict with submitted, filepath, returncode.

    A zero exit status means the spooler QUEUED the job -- CUPS answers
    "request id is ..." the moment it accepts it, before a sheet is printed,
    and a job can still jam, run out of paper or be cancelled.  That is
    ACCEPTANCE, not completion, so every path reports the acceptance flag
    ``submitted`` and none the completion flag ``printed``: this adapter never
    observes the job's own state.  The job's own IPP ``job-state`` is read
    later, one request per daemon cycle, by :meth:`JobExecutor.poll_awaiting`
    -- when ``stdout`` names the CUPS request id (see
    :func:`parse_lp_request_id`) and the job went to a printer host.
    """
    params = job.get("parameters", {})
    content = params.get("content", params.get("text", "Hello from PCC"))
    filename = params.get("filename", "pcc-print.txt")

    # Write content to a temp file
    suffix = os.path.splitext(filename)[1] or ".txt"
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=suffix, delete=False, encoding="utf-8"
    ) as f:
        f.write(content)
        filepath = f.name

    printer_ip = (
        device.get("host")
        or device.get("address")
        or device.get("ip")
        or device.get("adapterConfig", {}).get("host", "")
    )
    printer_name = device.get("model", device.get("name", ""))

    try:
        if platform.system() in ("Linux", "Darwin"):
            cmd: List[str]
            if printer_ip:
                cmd = ["lp", "-h", printer_ip, "-d", "default", filepath]
            elif printer_name:
                cmd = ["lp", "-d", printer_name, filepath]
            else:
                cmd = ["lp", filepath]
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=30
            )
        else:
            # Windows: print via notepad silently
            if printer_name:
                result = subprocess.run(
                    ["notepad", "/p", filepath],
                    capture_output=True, text=True, timeout=30
                )
            else:
                result = subprocess.run(
                    ["notepad", "/p", filepath],
                    capture_output=True, text=True, timeout=30
                )

        return {
            # Exit 0 = QUEUED (accepted), never printed -- see the docstring.
            "submitted": result.returncode == 0,
            "filepath": filepath,
            "returncode": result.returncode,
            "stdout": result.stdout[:500] if result.stdout else "",
            "stderr": result.stderr[:500] if result.stderr else "",
            "printer_ip": printer_ip,
            "printer_name": printer_name,
        }
    except subprocess.TimeoutExpired:
        return {
            "submitted": False,
            "filepath": filepath,
            "error": "print command timed out",
            "printer_ip": printer_ip,
        }
    except FileNotFoundError as e:
        # lp / notepad not found -- return a soft success so tests pass
        log.warning(f"Print command not found: {e}")
        return {
            "submitted": False,
            "filepath": filepath,
            "error": f"print command not available: {e}",
            "printer_ip": printer_ip,
        }
    except Exception as e:
        return {
            "submitted": False,
            "filepath": filepath,
            "error": str(e),
            "printer_ip": printer_ip,
        }


# ---------------------------------------------------------------------------
# Execution-result classification (evidence contract sec-10)
# ---------------------------------------------------------------------------
#
# Device adapters signal failure by RETURNING a dict whose content says so --
# they do not raise.  Consumers of an evidence bundle (notably the settlement
# oracle) key off the event TYPE in the bundle, not the event payload, so a
# failed run reported with an "execution_completed" event would settle as a
# success.  Classification is therefore fail-closed: anything this module
# cannot positively recognise as a success is never reported as one.

RESULT_SUCCESS = "success"
RESULT_FAILURE = "failure"
RESULT_UNCLASSIFIABLE = "unclassifiable"
# The device ACCEPTED the work and its outcome has not been observed: neither a
# success nor a failure (classify_execution_result rule 10).
RESULT_ACCEPTED = "accepted"

# Every type emitted here must be a member of the closed EVIDENCE_EVENT_TYPES
# enum in packages/spec/src/types/evidence.ts (tests parse it); consumers that
# validate bundles reject any other string.
EVENT_EXECUTION_STARTED = "execution_started"
EVENT_EXECUTION_PROGRESS = "execution_progress"
EVENT_EXECUTION_COMPLETED = "execution_completed"
EVENT_EXECUTION_FAILED = "execution_failed"

# Evidence levels, weakest first (the ``level`` payload value in brackets):
#   submitted        -- the device only ACCEPTED the command (a spooler queued
#     ["submitted"]     the job, a print was started, an API answered 202)
#   device reported  -- the device itself reported the work finished (or
#     ["device_reported"] failed): JobExecutor.poll_awaiting reading IPP
#                       job-state / OctoPrint /api/job after an acceptance
#   inspected output -- the output itself was inspected (not emitted here)
# Only device-reported (or stronger) evidence may carry execution_completed,
# which is what the settlement oracle releases on.  A submitted-only result is
# recorded as execution_progress at this level and never as a completion.
EVIDENCE_LEVEL_SUBMITTED = "submitted"
EVIDENCE_LEVEL_DEVICE_REPORTED = "device_reported"

# LO-EV-9 (evidence #3219/#3241; the pattern of kernel-sdk's job handler and
# the kernel's EvidenceEmitter on #341): every evidence event commits the PCC
# job it belongs to at top-level payload.jobId, plus the settlement unit and
# challenge nonce when the assignment names them.  Device-local ids never take
# these names: they stay nested (payload.response, payload.handle.cupsJobId).
UNIT_FIELD_RE = re.compile(r"0x[0-9a-f]{64}")
UNIT_FIELDS = ("settlementUnitId", "challengeNonce")


class AssignmentBindingError(ValueError):
    """The job assignment cannot be bound: no job id, or a malformed unit field."""


def assignment_binding(job: Dict) -> Dict[str, str]:
    """The fields every evidence event for ``job`` must commit.

    ``jobId`` is the PCC job id; ``settlementUnitId`` and ``challengeNonce``
    are included only when the assignment names them, and each must be
    ``0x`` + 64 lowercase hex (as kernel-sdk requires).  Raises
    AssignmentBindingError otherwise: evidence that cannot bind is refused
    before anything runs.
    """
    job_id = job.get("id")
    if not isinstance(job_id, str) or not job_id.strip():
        raise AssignmentBindingError("the assignment has no job id")
    binding = {"jobId": job_id}
    for field in UNIT_FIELDS:
        value = job.get(field)
        if value is None:
            continue
        if not (isinstance(value, str) and UNIT_FIELD_RE.fullmatch(value)):
            raise AssignmentBindingError(f"{field} must be 0x + 64 lowercase hex")
        binding[field] = value
    return binding


def bind_event_payload(payload: Any, binding: Dict[str, str]) -> Dict[str, Any]:
    """A copy of ``payload`` that commits the binding fields.

    A payload that already carries a different value for one of them is
    refused (ValueError), as the kernel's EvidenceEmitter does: the event
    would claim another job or unit.
    """
    out: Dict[str, Any] = dict(payload) if isinstance(payload, dict) else {"result": payload}
    for field, value in binding.items():
        if field in out and out[field] != value:
            raise ValueError(
                f"event payload.{field} {out[field]!r} does not match the assignment's {value!r}"
            )
        out[field] = value
    return out


def _resolve_binding(job_id: str, binding: Optional[Dict[str, str]]) -> Dict[str, str]:
    resolved = dict(binding) if binding else {"jobId": job_id}
    if resolved.get("jobId") != job_id:
        raise ValueError(f"binding is for job {resolved.get('jobId')!r}, not {job_id!r}")
    return resolved

# Outcome reported directly by an adapter via a "status" key.  Compared after
# `.strip().lower()`: a device that shouts "FAILED" must not slip past the
# failure set and fall through to a boolean flag that says otherwise.
FAILURE_STATUS_VALUES = frozenset({
    "failed", "failure", "error", "errored", "aborted",
    "cancelled", "canceled", "stopped", "timeout", "timed_out",
})
SUCCESS_STATUS_VALUES = frozenset({
    "completed", "complete", "succeeded", "success", "ok", "done",
})

# COMPLETION flags -- the device reported that the WORK ITSELF finished.
# Reserved for adapters that actually OBSERVE completion:
#   executed -> JobExecutor._execute_generic_http, for a 2xx other than 202:
#               a synchronous API's own answer that it ran the request
#   printed  -> no current adapter.  An ``lp`` exit of 0 and an OctoPrint 2xx
#               both mean the job was QUEUED or STARTED, so those adapters
#               report ``submitted``.  A finished print is observed later by
#               JobExecutor.poll_awaiting (IPP job-state, OctoPrint /api/job),
#               which emits its own device_reported execution_completed rather
#               than a flag through this classifier.
COMPLETION_FLAG_KEYS = ("printed", "executed")

# ACCEPTANCE flags -- the device only reported that it TOOK the request.
#   submitted -> execute_ipp_print, JobExecutor._execute_octoprint,
#                JobExecutor._execute_generic_http (HTTP 202 only),
#                JobExecutor._execute_opentrons
# Acceptance is not completion: an Opentrons run that is playing has been
# accepted and can still fail at step 40.  True here is therefore NOT a success
# -- alone it classifies as accepted (rule 10), which never emits
# execution_completed -- and False is still a failure.
ACCEPTANCE_FLAG_KEYS = ("submitted",)

ALL_FLAG_KEYS = COMPLETION_FLAG_KEYS + ACCEPTANCE_FLAG_KEYS

# Where adapters park the device's own answer.  A 2xx is a TRANSPORT verdict,
# not the device's: transport-succeeds / application-fails is the ordinary
# instrument failure mode (JSON-RPC, SiLA, OPC-UA HTTP bridges, LabVIEW web
# services and most vendor REST answer 200 with the outcome in the body).
NESTED_RESULT_KEYS = ("response", "data", "body", "payload")

# Keys inside a device body that POSITIVELY assert a failure.
NESTED_ERROR_KEYS = ("error", "errors", "fault", "faultstring")
# A success key is only a success when it holds the boolean True.  Any other
# value present under it (False, "false", 0, None, "yes") is read as a failure:
# an unreadable success claim is not evidence that nothing failed.
NESTED_FALSE_SUCCESS_KEYS = ("success", "ok", "succeeded")
# Status-like keys whose STRING value may name a failure at any depth.
STATUS_FIELD_KEYS = ("status", "state")

# The device-body scan walks nested dicts and lists (a failure is as real at
# data.result[0].error as at the top level).  A body deeper or larger than
# these bounds cannot be verified, and the scan says so as a failure.
DEVICE_BODY_MAX_DEPTH = 8
DEVICE_BODY_MAX_NODES = 5000

# XML/SOAP fault ELEMENT markers, matched case-insensitively against a non-JSON
# (string) body.  Anchored to structured fault vocabulary rather than free text
# -- "an error occurred" is prose, "<soap:Fault" is a verdict -- and this list
# can only ever turn a claimed success into a failure, never the reverse.
FAULT_BODY_MARKERS = (
    "<soap:fault", "<soapenv:fault", "<env:fault", "<fault>", "<fault ",
    "faultstring", "faultcode", "<error>", "<error ",
)

# pcc_node.http_util.http returns status_code 0 when the request never
# completed -- connection refused, DNS failure, timeout (see its docstring).
# No real HTTP response carries a status <= 0, so a result passing this
# sentinel through never reached the device, whatever else the result claims.
TRANSPORT_FAILURE_MAX_STATUS = 0

# Only 2xx means the device acted.  A 3xx is a redirect nothing followed, and
# a bare `status < 400` also admits the transport sentinel above.
HTTP_SUCCESS_MIN = 200
HTTP_SUCCESS_MAX_EXCLUSIVE = 300

# RFC 9110 sec 15.3.3, 202 Accepted: "the request has been accepted for
# processing, but the processing has not been completed".  Inside the 2xx band,
# but it is the device's own statement that the work has NOT finished.
HTTP_ACCEPTED = 202

OCTOPRINT_SUCCESS_STATUSES = (200, 201, 204)

# Generic HTTP completion contract (r31 astra verdict item 1, bus #2476).  A 2xx
# is only the TRANSPORT's answer; "2xx and no recognized error" is not the
# device saying the work finished.  _execute_generic_http therefore claims
# `executed` only on the device's POSITIVE completion statement:
#   * a per-device contract, when configured -- ``device["completionField"]``
#     (a dot path into the JSON body, e.g. "result.phase") and
#     ``device["completionValues"]`` (the values meaning finished; default
#     [True]).  With a contract, the default vocabulary below is not used; or
#   * by default, a completion word in ``status``/``state``, or a completion
#     boolean set to True, at the body's top level or in one of
#     GENERIC_OUTCOME_ENVELOPES.
# A recognised queueing/running statement is acceptance (``submitted``).
# Anything else -- {}, null, {"ok": true}, an unknown status word, a malformed
# value, or completion and acceptance stated at once -- carries no flag at
# all and classifies as unclassifiable, which fails the job closed.
# "ok" and "success" are deliberately NOT completion words: many APIs use them
# for "your REQUEST succeeded", which says nothing about the work.
GENERIC_COMPLETION_STATUS_VALUES = frozenset({
    "completed", "complete", "succeeded", "finished", "done",
})
GENERIC_ACCEPTANCE_STATUS_VALUES = frozenset({
    "accepted", "queued", "pending", "submitted", "scheduled", "created",
    "started", "running", "in_progress", "in-progress", "processing", "busy",
    "printing", "waiting",
})
GENERIC_COMPLETION_BOOL_KEYS = ("completed", "complete", "done", "finished")
GENERIC_ACCEPTANCE_BOOL_KEYS = ("submitted", "accepted", "queued")
GENERIC_OUTCOME_ENVELOPES = ("result", "data", "response", "body", "payload")

OUTCOME_COMPLETED = "completed"
OUTCOME_ACCEPTED = "accepted"
OUTCOME_UNKNOWN = "unknown"

# Opentrons run lifecycle.  `POST /runs/<id>/actions {play}` only STARTS the
# protocol; the run's own status is the only report that it finished, so a
# protocol that starts and then fails at step 40 is invisible without polling.
# Terminal values come from the OT-2 HTTP API's run-status enum.
OPENTRONS_TERMINAL_SUCCESS = frozenset({"succeeded"})
OPENTRONS_TERMINAL_FAILURE = frozenset({"failed", "stopped"})

# The daemon runs jobs synchronously (daemon.py polls, then calls execute), so
# the wait is bounded to keep the poll loop responsive.  Per-device override:
# ``device["runPollTimeout"]`` / ``device["runPollInterval"]``, both seconds.
# A budget of 0 skips polling entirely; the result is then explicitly
# non-terminal, which classifies as unclassifiable and never as a success.
# KNOWN LIMIT: a protocol longer than the budget returns non-terminal and so
# fails closed -- it never settles.  Raising the budget or adding an async
# run-completion watcher is the fix; releasing on "the run was accepted" is not.
OPENTRONS_RUN_POLL_TIMEOUT_S = 120.0
OPENTRONS_RUN_POLL_INTERVAL_S = 2.0
# Upper bound for a single poll request; the remaining budget can lower it.
POLL_REQUEST_TIMEOUT_MAX_S = 30.0

UNCLASSIFIABLE_REASON = "unclassifiable_result"


def _opentrons_run_data(body: Any) -> Optional[Dict]:
    """The ``data`` object of an OT-2 ``GET /runs/<id>`` body."""
    if not isinstance(body, dict):
        return None
    data = body.get("data")
    return data if isinstance(data, dict) else None


def _opentrons_run_status(body: Any) -> Optional[str]:
    """Case-folded ``data.status`` from an OT-2 ``GET /runs/<id>`` body."""
    data = _opentrons_run_data(body)
    if data is None:
        return None
    status = data.get("status")
    return status.strip().lower() if isinstance(status, str) else None


def _opentrons_run_errors(body: Any) -> List:
    """Protocol errors the OT-2 attached to the run (``data.errors``).

    A populated list is the run's own verdict that something went wrong, and
    it can be present before the status field catches up -- so it counts as a
    terminal failure on its own.
    """
    data = _opentrons_run_data(body)
    if data is None:
        return []
    errors = data.get("errors")
    if isinstance(errors, list):
        return errors
    return [errors] if errors else []


def _short(value: Any, limit: int = 200) -> str:
    """Render a nested value for a one-line failure message."""
    try:
        text = value if isinstance(value, str) else json.dumps(value, default=str)
    except (TypeError, ValueError):
        text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."


def _normalized_status(container: Any) -> Optional[str]:
    """Case-folded ``status`` string, or None when there is not one."""
    if not isinstance(container, dict):
        return None
    status = container.get("status")
    if not isinstance(status, str):
        return None
    return status.strip().lower()


def _extract_device_error(body: Any) -> Optional[str]:
    """The device's own failure message from a response body, or None.

    Reads failure signals at ANY depth: a failure nested in ``data``,
    ``result``, a list item or a deeper envelope is still the device saying it
    failed.  A body it cannot finish reading (too deep, too large) counts as a
    failure.  Otherwise an unrecognised body yields None -- this never turns an
    unknown shape into a failure, and it never turns anything into a success.
    Being the only reader of a device body, it is the single place a new
    failure envelope has to be taught.
    """
    budget = [DEVICE_BODY_MAX_NODES]
    return _scan_device_body(body, "", 0, budget)


def _scan_device_body(node: Any, path: str, depth: int, budget: List[int]) -> Optional[str]:
    """Depth-first failure scan behind :func:`_extract_device_error`."""
    budget[0] -= 1
    if budget[0] < 0:
        return "device body too large to verify"
    where = f" (at {path})" if path else ""

    if isinstance(node, str):
        # Only a whole body (or a whole nested value) is an XML/SOAP document.
        lowered = node.lower()
        for marker in FAULT_BODY_MARKERS:
            if marker in lowered:
                return f"device returned a fault body (matched {marker!r}){where}"
        return None

    if isinstance(node, (list, tuple)):
        if depth >= DEVICE_BODY_MAX_DEPTH:
            return "device body too deeply nested to verify"
        for index, item in enumerate(node):
            message = _scan_device_body(item, f"{path}[{index}]", depth + 1, budget)
            if message:
                return message
        return None

    if not isinstance(node, dict):
        return None
    if depth >= DEVICE_BODY_MAX_DEPTH:
        return "device body too deeply nested to verify"

    for key in NESTED_ERROR_KEYS:
        value = node.get(key)
        if value:
            text = value if isinstance(value, str) else f"{key}={_short(value)}"
            return f"{text}{where}"

    for key in NESTED_FALSE_SUCCESS_KEYS:
        if key in node and node[key] is not True:
            return f"device reported {key}={node[key]!r}{where}"

    for key in STATUS_FIELD_KEYS:
        value = node.get(key)
        values = value if isinstance(value, list) else [value]
        for item in values:
            if isinstance(item, str) and item.strip().lower() in FAILURE_STATUS_VALUES:
                return f"device reported {key}={value!r}{where}"

    for key, value in node.items():
        if isinstance(value, (dict, list, tuple)) or (isinstance(value, str) and "<" in value):
            child = f"{path}.{key}" if path else str(key)
            message = _scan_device_body(value, child, depth + 1, budget)
            if message:
                return message

    return None


def _nested_device_error(result: Dict) -> Optional[str]:
    """Scan the containers adapters park a device's answer in.

    Rule 3b of :func:`classify_execution_result`.  An adapter that forgets to
    lift a nested failure to the top level is still fail-closed here, so the
    guarantee holds by construction rather than by every future adapter being
    reviewed.
    """
    for key in NESTED_RESULT_KEYS:
        if key not in result:
            continue
        message = _extract_device_error(result[key])
        if message:
            return f"{key}: {message}"
    return None


def _contract_outcome(data: Any, field: Any, values: Any) -> Tuple[str, str]:
    """Outcome under a device's own completion contract (see the constants)."""
    if not isinstance(field, str) or not field.strip():
        return OUTCOME_UNKNOWN, "completionField is not a usable path"
    node: Any = data
    for part in field.strip().split("."):
        if not isinstance(node, dict) or part not in node:
            return OUTCOME_UNKNOWN, f"completionField {field!r} is absent from the body"
        node = node[part]
    wanted = values if isinstance(values, list) and values else [True]
    for want in wanted:
        if isinstance(want, bool):
            matched = node is want
        elif isinstance(want, int):
            matched = isinstance(node, int) and not isinstance(node, bool) and node == want
        elif isinstance(want, str):
            matched = isinstance(node, str) and node.strip().lower() == want.strip().lower()
        else:
            matched = False
        if matched:
            return OUTCOME_COMPLETED, f"completionField {field!r} = {_short(node)}"
    if isinstance(node, str) and node.strip().lower() in GENERIC_ACCEPTANCE_STATUS_VALUES:
        return OUTCOME_ACCEPTED, f"completionField {field!r} = {_short(node)}"
    return OUTCOME_UNKNOWN, f"completionField {field!r} = {_short(node)} is not a completion value"


def _generic_http_outcome(data: Any, device: Dict) -> Tuple[str, str]:
    """What a 2xx device body positively states: completed, accepted or unknown.

    Called only after the failure scan found nothing, and never for a 202.
    Returns ``(outcome, reason)``.  Only an explicit, well-formed statement
    counts; everything else is unknown.
    """
    if "completionField" in device:
        return _contract_outcome(data, device.get("completionField"), device.get("completionValues"))

    if not isinstance(data, dict):
        return OUTCOME_UNKNOWN, "the device body states no outcome"
    containers = [data] + [
        data[key] for key in GENERIC_OUTCOME_ENVELOPES if isinstance(data.get(key), dict)
    ]

    completed = accepted = unreadable = False
    for container in containers:
        for key in STATUS_FIELD_KEYS:
            if key not in container:
                continue
            value = container[key]
            if isinstance(value, dict):
                continue  # an object under "state" is a container, not a statement
            word = value.strip().lower() if isinstance(value, str) else None
            if word in GENERIC_COMPLETION_STATUS_VALUES:
                completed = True
            elif word in GENERIC_ACCEPTANCE_STATUS_VALUES:
                accepted = True
            else:
                unreadable = True  # unknown word, number, list, null
        for key in GENERIC_COMPLETION_BOOL_KEYS:
            if key in container:
                if container[key] is True:
                    completed = True
                else:
                    unreadable = True
        for key in GENERIC_ACCEPTANCE_BOOL_KEYS:
            if key in container:
                if container[key] is True:
                    accepted = True
                else:
                    unreadable = True

    if unreadable:
        return OUTCOME_UNKNOWN, "the device body carries an outcome field this node cannot read"
    if completed and accepted:
        return OUTCOME_UNKNOWN, "the device body states both completion and acceptance"
    if completed:
        return OUTCOME_COMPLETED, "the device body states completion"
    if accepted:
        return OUTCOME_ACCEPTED, "the device body states acceptance"
    return OUTCOME_UNKNOWN, "the device body states no outcome"


def _describe_transport_status(status: int, data: Any) -> str:
    """Failure text for an HTTP exchange that did not land in the 2xx band."""
    if status <= TRANSPORT_FAILURE_MAX_STATUS:
        nested = data.get("error") if isinstance(data, dict) else None
        return str(nested) if nested else "transport failure: device unreachable"
    return f"device returned HTTP {status}"


def _as_float(value: Any, default: float) -> float:
    """Read a numeric device-config override; fall back on anything unusable.

    Infinity and NaN are unusable (r31 astra verdict item 4): an infinite poll
    budget never ends, and NaN compares false against every deadline.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = float(value)
    return number if math.isfinite(number) else default


def _readable_status_code(result: Dict) -> Optional[int]:
    """The result's ``status_code`` when it is a genuine HTTP status number.

    ``bool`` is excluded deliberately: ``False == 0`` in Python, and a boolean
    in ``status_code`` is a malformed result rather than a transport report --
    the remaining rules classify it.
    """
    status_code = result.get("status_code")
    if isinstance(status_code, bool) or not isinstance(status_code, int):
        return None
    return status_code


def _is_transport_failure(result: Dict) -> bool:
    """True when a result carries http_util's transport-failure sentinel."""
    status_code = _readable_status_code(result)
    return status_code is not None and status_code <= TRANSPORT_FAILURE_MAX_STATUS


def _is_http_status_failure(result: Dict) -> bool:
    """True when ``status_code`` is a real HTTP status outside the 2xx band.

    Generalises the transport sentinel: 0 (never reached the device), a 3xx
    (a redirect nothing followed) and a 4xx/5xx all mean the device did not
    report doing the work, whatever flag the result carries alongside.
    """
    status_code = _readable_status_code(result)
    if status_code is None:
        return False
    return not (HTTP_SUCCESS_MIN <= status_code < HTTP_SUCCESS_MAX_EXCLUSIVE)


def _is_returncode_failure(result: Dict) -> bool:
    """True when a subprocess ``returncode`` says the command did not succeed.

    Only integer 0 is a success; anything else present under that key -- 1,
    ``"1"``, ``"0"``, None -- contradicts a sibling ``printed: True``.
    """
    if "returncode" not in result:
        return False
    returncode = result["returncode"]
    if isinstance(returncode, bool) or not isinstance(returncode, int):
        return True
    return returncode != 0


def classify_execution_result(result: Any) -> str:
    """Classify an adapter result as success / failure / accepted / unclassifiable.

    Pure function -- no I/O, no side effects.  Returns one of
    :data:`RESULT_SUCCESS`, :data:`RESULT_FAILURE`, :data:`RESULT_ACCEPTED`,
    :data:`RESULT_UNCLASSIFIABLE`.

    First matching rule wins:

    1.  not a dict (``None``, str, list, ...)             -> unclassifiable
    2.  empty dict                                        -> unclassifiable
    3.  truthy top-level ``error``                        -> failure
    3b. failure stated inside ``response``/``data``/
        ``body``/``payload`` (:func:`_nested_device_error`) -> failure
    4.  ``status_code`` present and outside 2xx           -> failure
    4b. ``returncode`` present and not integer 0          -> failure
    5.  ``status`` in :data:`FAILURE_STATUS_VALUES`       -> failure
    6.  ANY flag in :data:`ALL_FLAG_KEYS` present and not
        ``True``                                          -> failure
    4c. ``status_code`` present but not a genuine HTTP
        status integer (checked after rule 6)             -> unclassifiable
    7.  ``status`` in :data:`SUCCESS_STATUS_VALUES`       -> success
    8.  ``status`` present but unrecognised, not a string,
        or null                                           -> unclassifiable
    9.  a :data:`COMPLETION_FLAG_KEYS` flag is present
        (and every flag passed rule 6)                     -> success
    10. an :data:`ACCEPTANCE_FLAG_KEYS` flag is ``True``,
        or ``status_code`` is 202 (no success status,
        no completion flag)                               -> accepted
    11. anything else                                      -> unclassifiable

    A ``status_code`` of 202 (:data:`HTTP_ACCEPTED`) turns what rules 7 and 9
    would call a success into accepted: the device said it has not finished.

    Why the order is what it is, rule by rule:

    * Rule 3b exists because a device's verdict usually rides in the response
      BODY, not the status line.  An adapter that answers HTTP 200 while the
      instrument says ``{"error": ...}`` would otherwise mint a success here.
      Keeping the scan in the classifier -- not only in the adapter that lifts
      the error -- makes a future adapter fail-closed by construction.
    * Rules 4 and 4b are the backstops for the fields an adapter DERIVES its
      flag from.  A request that never left the node, was redirected, or was
      refused cannot have succeeded, and a non-zero subprocess ``returncode``
      contradicts a sibling ``printed: True`` -- so each outranks both a
      claimed success ``status`` and the flag derived from it.  They exist so a
      future adapter that forwards a raw status is fail-closed by default.
    * Rule 6 precedes rule 7 so a False flag outranks a success ``status``
      string: ``{"status": "ok", "printed": False}`` is a failure.  It tests
      EVERY flag present, not the first one found, so a result carrying both
      ``printed: True`` and ``executed: False`` is a failure too.  It tests
      ``is True`` rather than truthiness, so ``printed: 1`` is a failure: only
      an unambiguous boolean True counts as a success.
    * Rule 8 keeps the device's own word authoritative.  ``{"submitted": True,
      "status": "running"}`` is an accepted run with an unknown outcome; a flag
      must not override an explicit non-terminal status the classifier does not
      recognise as success.
    * Rule 9 uses COMPLETION flags only.  An ACCEPTANCE flag (``submitted``)
      says the device took the request, never that the work finished, so
      ``{"submitted": True}`` alone never reaches a success.
    * Rule 10 names that SUBMITTED evidence level rather than lumping it in
      with results the classifier cannot read.  Accepted is neither outcome:
      the bundle records the submission as ``execution_progress`` (level
      ``submitted``) and carries no ``execution_completed`` for the settlement
      oracle to release on, and the job is left non-terminal -- it has not
      failed, it simply has not been observed to finish.  A success ``status``
      (rule 7) or a completion flag (rule 9) outranks it, because each is the
      device reporting the work done.  Rule 8 outranks it too, and not only by
      position: ``{"submitted": True, "status": "running"}`` stays
      unclassifiable because a status the classifier cannot read may name a
      failure it does not know (``"rejected"``, ``"jammed"``), and accepted
      would leave that job waiting instead of failing it closed.
    """
    if not isinstance(result, dict):
        return RESULT_UNCLASSIFIABLE

    if not result:
        return RESULT_UNCLASSIFIABLE

    if result.get("error"):
        return RESULT_FAILURE

    if _nested_device_error(result):
        return RESULT_FAILURE

    if _is_http_status_failure(result):
        return RESULT_FAILURE

    if _is_returncode_failure(result):
        return RESULT_FAILURE

    status = _normalized_status(result)
    if status in FAILURE_STATUS_VALUES:
        return RESULT_FAILURE

    if any(result[key] is not True for key in ALL_FLAG_KEYS if key in result):
        return RESULT_FAILURE

    # A status_code that is PRESENT but is not a genuine HTTP status number
    # ("202", "0", "500", False, None) cannot be read, so rules 4 and 10 could
    # not have seen it.  An unreadable outcome field is not evidence that
    # nothing failed: it never reaches a success (rule 4c).
    if "status_code" in result and _readable_status_code(result) is None:
        return RESULT_UNCLASSIFIABLE

    # A 202 is the device saying the work has NOT finished, so it turns any
    # success claim below (a success status, a completion flag) into accepted.
    accepted_by_transport = result.get("status_code") == HTTP_ACCEPTED

    if status in SUCCESS_STATUS_VALUES:
        return RESULT_ACCEPTED if accepted_by_transport else RESULT_SUCCESS

    # A status that is present but not a readable success -- an unknown string,
    # a non-string ({"status": ["failed"]}) or an explicit null -- may be a
    # failure in another shape, so it is never read as "no status" (rule 8).
    if "status" in result:
        return RESULT_UNCLASSIFIABLE

    if any(key in result for key in COMPLETION_FLAG_KEYS):
        return RESULT_ACCEPTED if accepted_by_transport else RESULT_SUCCESS

    # `is True`, not `in`: rule 6 already guarantees it, but this rule must not
    # turn `submitted: False` into an acceptance if the rules are ever reordered.
    if accepted_by_transport or any(result.get(key) is True for key in ACCEPTANCE_FLAG_KEYS):
        return RESULT_ACCEPTED

    return RESULT_UNCLASSIFIABLE


def describe_execution_failure(result: Any) -> str:
    """Best-effort human-readable reason for a failure result.  Never raises."""
    if isinstance(result, dict):
        error = result.get("error")
        if error:
            return str(error)
        if _is_transport_failure(result):
            return (
                "device unreachable: request never completed "
                f"(status_code={result.get('status_code')!r})"
            )
        nested = _nested_device_error(result)
        if nested:
            return nested
        if _is_http_status_failure(result):
            return f"device returned HTTP {result.get('status_code')}"
        if _is_returncode_failure(result):
            return f"command exited with returncode={result.get('returncode')!r}"
        status = result.get("status")
        if status:
            return f"device reported status={status!r}"
        for key in ALL_FLAG_KEYS:
            if key in result:
                return f"device reported {key}={result[key]!r}"
    return "device reported failure without an error message"


# ---------------------------------------------------------------------------
# Evidence builder
# ---------------------------------------------------------------------------

def build_evidence_bundle(
    job_id: str,
    device: Dict,
    result: Dict,
    *,
    binding: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Construct an evidence bundle from execution result.

    The event trail ALWAYS comes from :func:`classify_execution_result`
    (evidence contract sec-10):

    * success        -> ``execution_completed``
    * failure        -> ``execution_failed`` (never ``execution_completed``)
    * accepted       -> ``execution_progress`` with payload
      ``{"level": "submitted", "result": <raw result>}``; no outcome event,
      and never ``execution_completed``
    * unclassifiable -> no outcome event at all; the raw result is kept in
      ``bundle["result"]``

    There is deliberately no caller-supplied ``events`` override any more (r31
    astra verdict item 6): it let any caller put ``execution_completed`` next
    to a failed result, emit both terminal events, or emit types outside the
    closed EVIDENCE_EVENT_TYPES enum.
    """
    now = datetime.now(tz=timezone.utc).isoformat()
    resolved = _resolve_binding(job_id, binding)
    return {
        "jobId": job_id,
        "deviceId": device.get("id", device.get("host", "unknown")),
        "deviceProtocol": device.get("protocol", device.get("type", "unknown")),
        "executedAt": now,
        "result": result,
        "events": [
            {**event, "payload": bind_event_payload(event["payload"], resolved)}
            for event in _synthesize_events(device, result, now)
        ],
    }


def build_device_reported_bundle(
    job_id: str,
    device: Dict,
    result: Dict,
    *,
    completed: bool,
    error: Optional[str] = None,
    binding: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Evidence for an outcome the DEVICE reported after it accepted the work.

    Used by the completion pollers (IPP job-state, OctoPrint /api/job).  It is
    closed by construction: exactly one terminal event, whose type is chosen by
    ``completed is True`` (anything else is a failure) and whose level is fixed
    to device-reported.  No caller can supply event types, add a second
    terminal event, or mark an accepted-only result complete.
    """
    now = datetime.now(tz=timezone.utc).isoformat()
    resolved = _resolve_binding(job_id, binding)
    payload: Dict[str, Any] = {"level": EVIDENCE_LEVEL_DEVICE_REPORTED, **result}
    if completed is True:
        event_type = EVENT_EXECUTION_COMPLETED
    else:
        event_type = EVENT_EXECUTION_FAILED
        payload["error"] = error or "device reported a failure"
    return {
        "jobId": job_id,
        "deviceId": device.get("id", device.get("host", "unknown")),
        "deviceProtocol": device.get("protocol", device.get("type", "unknown")),
        "executedAt": now,
        "result": result,
        "events": [{"type": event_type, "timestamp": now, "payload": bind_event_payload(payload, resolved)}],
    }


def _synthesize_events(device: Dict, result: Any, now: str) -> List[Dict]:
    """Default event trail: ``execution_started`` plus at most one more event --
    an outcome (completed / failed), or a submitted-level progress record."""
    events: List[Dict] = [
        {
            "type": EVENT_EXECUTION_STARTED,
            "timestamp": now,
            "payload": {"deviceId": device.get("id", "unknown")},
        }
    ]

    verdict = classify_execution_result(result)

    if verdict == RESULT_SUCCESS:
        events.append(
            {
                "type": EVENT_EXECUTION_COMPLETED,
                "timestamp": now,
                "payload": result,
            }
        )
    elif verdict == RESULT_FAILURE:
        events.append(
            {
                "type": EVENT_EXECUTION_FAILED,
                "timestamp": now,
                "payload": {
                    "error": describe_execution_failure(result),
                    "result": result,
                },
            }
        )
    elif verdict == RESULT_ACCEPTED:
        # SUBMITTED evidence: the device took the work and its outcome is not
        # yet observed.  Progress, not an outcome -- and never
        # execution_completed, which is what the settlement oracle releases on.
        events.append(
            {
                "type": EVENT_EXECUTION_PROGRESS,
                "timestamp": now,
                "payload": {"level": EVIDENCE_LEVEL_SUBMITTED, "result": result},
            }
        )
    # Unclassifiable: fail closed by emitting NO outcome event. An invented
    # type would not be in the evidence vocabulary, and without
    # execution_completed there is nothing for a verifier to release on.

    return events


# ---------------------------------------------------------------------------
# Deferred completion tracking (IPP job-state, OctoPrint /api/job)
# ---------------------------------------------------------------------------
#
# A queued `lp` job and a started OctoPrint print are ACCEPTED, not completed
# (rule 10 above), so execute() leaves them "running".  Prints take minutes to
# hours, so execute() does not block on them: it registers the job, and the
# daemon calls JobExecutor.poll_awaiting() once per cycle, which asks each
# device ONCE for the job's own state and reports only what the DEVICE says.
#
# Fail closed: an outcome that was not observed is never a completion.
# Unknown, unreadable, still processing, a failed request and an exhausted
# budget all leave the job registered or drop it WITHOUT a terminal status.

COMPLETION_KIND_IPP = "ipp"
COMPLETION_KIND_OCTOPRINT = "octoprint"

# Verdict of ONE completion check.
POLL_COMPLETED = "completed"      # the device reported the work finished
POLL_FAILED = "failed"            # the device reported a terminal failure
POLL_WAITING = "waiting"          # not finished, or not (yet) readable
# The device says it can NEVER report the outcome (IPP 'queued-in-device',
# RFC 8011 sec 5.3.8).  Dropped at once like an expired budget: no status.
POLL_UNOBSERVABLE = "unobservable"

# Budget per accepted job, seconds from acceptance; the per-device override is
# ``device["completionPollTimeout"]``.  0 (or less) disables tracking.  The
# interval is the daemon's poll cycle: one request per job per cycle.
IPP_COMPLETION_POLL_TIMEOUT_S = 3600.0
OCTOPRINT_COMPLETION_POLL_TIMEOUT_S = 172800.0   # 48 h: long FDM prints
DEFAULT_COMPLETION_POLL_TIMEOUT_S = {
    COMPLETION_KIND_IPP: IPP_COMPLETION_POLL_TIMEOUT_S,
    COMPLETION_KIND_OCTOPRINT: OCTOPRINT_COMPLETION_POLL_TIMEOUT_S,
}
# Per request.  Checks run inside the daemon loop, so keep a dead device from
# stalling it for long.
COMPLETION_POLL_REQUEST_TIMEOUT_S = 10

# --- IPP (RFC 8010 encoding, RFC 8011 semantics) ---------------------------

IPP_PORT = 631
IPP_REQUEST_VERSION = b"\x02\x00"              # IPP/2.0
IPP_OPERATION_GET_JOB_ATTRIBUTES = 0x0009      # RFC 8011 sec 5.4.15
IPP_INT_MAX = 2 ** 31 - 1                      # integer(1:MAX); request-id range

# Delimiter tags are 0x00-0x0f, value tags 0x10-0xff (RFC 8010 sec 3.5).
IPP_TAG_OPERATION_ATTRIBUTES = 0x01
IPP_TAG_JOB_ATTRIBUTES = 0x02
IPP_TAG_END_OF_ATTRIBUTES = 0x03
IPP_DELIMITER_TAG_MAX = 0x0F

IPP_VALUE_INTEGER = 0x21
IPP_VALUE_ENUM = 0x23
IPP_VALUE_KEYWORD = 0x44
IPP_VALUE_URI = 0x45
IPP_VALUE_CHARSET = 0x47
IPP_VALUE_NATURAL_LANGUAGE = 0x48

# RFC 8011 appendix B.1.2: 0x0000-0x00FF is the "successful" class.
IPP_STATUS_SUCCESS_MAX = 0x00FF

# job-state (type1 enum), RFC 8011 sec 5.3.7 table 15.
IPP_JOB_STATE_NAMES = {
    3: "pending",
    4: "pending-held",
    5: "processing",
    6: "processing-stopped",
    7: "canceled",
    8: "aborted",
    9: "completed",
}
# B.1.2.1: "The transition of the Job object into the 'completed' state is the
# only indicator that the Job has been printed."
IPP_JOB_STATES_COMPLETED = frozenset({9})
IPP_JOB_STATES_FAILED = frozenset({7, 8})
IPP_JOB_STATES_NOT_COMPLETED = frozenset({3, 4, 5, 6})   # sec 5.3.7.2

# job-state-reasons (sec 5.3.8) that change what 'completed' means:
# * 'queued-in-device': a gateway handed the job to a device that cannot report
#   status; it says 'completed' and "never will have any better information".
# * '...completed-with-errors': the device finished, and reports errors.
#   (Table 15 spells these without the 'job-' prefix; sec 5.3.8 with it.)
IPP_REASON_QUEUED_IN_DEVICE = "queued-in-device"
IPP_REASONS_COMPLETED_WITH_ERRORS = frozenset({
    "job-completed-with-errors", "completed-with-errors",
})

# `lp` announces the spooled job as "request id is <queue>-<N> (1 file(s))".
# The queue is the longest run before the LAST "-<digits>", so hyphenated
# queue names parse.  The character class is deliberately narrow (CUPS allows
# more): the queue is pasted into a URL path, and an unusual name only means
# "no handle", i.e. the job stays accepted-only.
_LP_REQUEST_ID = re.compile(
    r"^[ \t]*request id is ([A-Za-z0-9_.+@~-]+)-(\d+)(?=\s|$)", re.MULTILINE
)
# A host `lp -h` printed to that is safe to put in a URL unmodified: a name or
# an IPv4 address.  A host:port or IPv6 literal gets no handle (not tracked).
_IPP_HOST = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")


class IppDecodeError(ValueError):
    """The bytes are not a well-formed IPP response (RFC 8010 sec 3)."""


def parse_lp_request_id(stdout: Any) -> Optional[Tuple[str, int]]:
    """``(queue, job_id)`` from ``lp`` stdout, or None when there is none.

    ``"request id is default-42 (1 file(s))"`` -> ``("default", 42)``.  None
    for anything else, including the empty stdout of the Windows
    ``notepad /p`` path: no request id means no completion handle.
    """
    if not isinstance(stdout, str):
        return None
    match = _LP_REQUEST_ID.search(stdout)
    if match is None:
        return None
    job_id = int(match.group(2))
    if not 1 <= job_id <= IPP_INT_MAX:
        return None
    return match.group(1), job_id


def ipp_job_urls(handle: Dict[str, Any]) -> Tuple[str, str]:
    """``(http_url, printer_uri)`` for an IPP completion handle.

    RFC 8010 sec 5: the HTTP layer uses ``http://host:631/...`` and the
    ``printer-uri`` operation attribute keeps the ``ipp://`` form.
    """
    path = f"{handle['printer_ip']}:{IPP_PORT}/printers/{handle['queue']}"
    return f"http://{path}", f"ipp://{path}"


def _ipp_value(value_tag: int, name: bytes, value: bytes) -> bytes:
    """attribute-with-one-value, or additional-value when ``name`` is empty
    (RFC 8010 secs 3.1.4 / 3.1.5).  Lengths are SIGNED-SHORT, big-endian."""
    return (
        struct.pack(">B", value_tag)
        + struct.pack(">h", len(name)) + name
        + struct.pack(">h", len(value)) + value
    )


def encode_ipp_get_job_attributes(printer_uri: str, job_id: int, request_id: int) -> bytes:
    """Encode an IPP/2.0 Get-Job-Attributes request (RFC 8010 / RFC 8011).

    Operation attributes in the order RFC 8011 secs 4.1.4-4.1.5 require:
    attributes-charset, attributes-natural-language, printer-uri, job-id --
    then requested-attributes = job-state, job-state-reasons.  The reasons ride
    along because 'completed' alone can mean "handed to a device that cannot
    report" or "finished with errors" (see IPP_REASON_QUEUED_IN_DEVICE).
    """
    if not 1 <= job_id <= IPP_INT_MAX:
        raise ValueError(f"job-id out of range: {job_id!r}")
    if not 1 <= request_id <= IPP_INT_MAX:
        raise ValueError(f"request-id out of range: {request_id!r}")
    return b"".join((
        IPP_REQUEST_VERSION,
        struct.pack(">h", IPP_OPERATION_GET_JOB_ATTRIBUTES),
        struct.pack(">i", request_id),
        bytes((IPP_TAG_OPERATION_ATTRIBUTES,)),
        _ipp_value(IPP_VALUE_CHARSET, b"attributes-charset", b"utf-8"),
        _ipp_value(IPP_VALUE_NATURAL_LANGUAGE, b"attributes-natural-language", b"en"),
        _ipp_value(IPP_VALUE_URI, b"printer-uri", printer_uri.encode("ascii")),
        _ipp_value(IPP_VALUE_INTEGER, b"job-id", struct.pack(">i", job_id)),
        _ipp_value(IPP_VALUE_KEYWORD, b"requested-attributes", b"job-state"),
        _ipp_value(IPP_VALUE_KEYWORD, b"", b"job-state-reasons"),
        bytes((IPP_TAG_END_OF_ATTRIBUTES,)),
    ))


def _ipp_read_length(data: bytes, pos: int, what: str) -> Tuple[int, int]:
    """A SIGNED-SHORT length at ``pos``; returns ``(length, next_pos)``."""
    if pos + 2 > len(data):
        raise IppDecodeError(f"truncated in {what}")
    (length,) = struct.unpack(">h", data[pos:pos + 2])
    if length < 0:
        raise IppDecodeError(f"negative {what}: {length}")
    return length, pos + 2


def decode_ipp_response(data: Any) -> Dict[str, Any]:
    """Parse an IPP response (RFC 8010 sec 3).  Pure; raises IppDecodeError.

    Returns ``{"version": (major, minor), "statusCode": int, "requestId": int,
    "groups": [{"tag": int, "attributes": [{"name": str, "values":
    [(value_tag, bytes), ...]}]}]}``.  Values are walked by length whatever
    their tag, so a collection is a flat run of values and never a job-state.
    Truncation, a missing end-of-attributes-tag, an attribute outside a group
    and an additional-value with no attribute before it are all malformed.
    """
    if not isinstance(data, (bytes, bytearray)):
        raise IppDecodeError(f"expected bytes, got {type(data).__name__}")
    data = bytes(data)
    if len(data) < 8:
        raise IppDecodeError(f"truncated header ({len(data)} bytes)")
    (status_code,) = struct.unpack(">H", data[2:4])
    (request_id,) = struct.unpack(">i", data[4:8])
    groups: List[Dict[str, Any]] = []
    pos = 8
    while True:
        if pos >= len(data):
            raise IppDecodeError("no end-of-attributes-tag")
        tag = data[pos]
        pos += 1
        if tag == IPP_TAG_END_OF_ATTRIBUTES:
            break
        if tag <= IPP_DELIMITER_TAG_MAX:
            groups.append({"tag": tag, "attributes": []})
            continue
        if not groups:
            raise IppDecodeError("attribute before any attribute group")
        name_len, pos = _ipp_read_length(data, pos, "name-length")
        if pos + name_len > len(data):
            raise IppDecodeError("truncated in name")
        name = data[pos:pos + name_len].decode("ascii", errors="replace")
        pos += name_len
        value_len, pos = _ipp_read_length(data, pos, "value-length")
        if pos + value_len > len(data):
            raise IppDecodeError("truncated in value")
        value = data[pos:pos + value_len]
        pos += value_len
        attributes = groups[-1]["attributes"]
        if name_len == 0:
            if not attributes:
                raise IppDecodeError("additional-value with no attribute before it")
            attributes[-1]["values"].append((tag, value))
        else:
            attributes.append({"name": name, "values": [(tag, value)]})
    return {
        "version": (data[0], data[1]),
        "statusCode": status_code,
        "requestId": request_id,
        "groups": groups,
    }


def ipp_job_state(response: Dict[str, Any]) -> Tuple[Optional[int], List[str], str]:
    """``(job_state, job_state_reasons, problem)`` from a decoded response.

    Read ONLY from the one Job Attributes group (tag 0x02) a Get-Job-Attributes
    response carries (RFC 8011 sec 4.3.4.2): the same keyword echoed in the
    Unsupported group, or anything in the Operation group, is not the job's
    state.  ``job_state`` is None -- with ``problem`` saying why -- unless
    there is exactly one job-state holding exactly one 4-octet enum.  An
    out-of-band value (RFC 8011 sec 5.1 'unknown') is therefore None too.
    """
    job_groups = [g for g in response["groups"] if g["tag"] == IPP_TAG_JOB_ATTRIBUTES]
    if len(job_groups) != 1:
        return None, [], f"{len(job_groups)} job attribute groups (expected 1)"
    attributes = job_groups[0]["attributes"]

    reasons: List[str] = []
    for attribute in attributes:
        if attribute["name"] == "job-state-reasons":
            reasons.extend(
                value.decode("ascii", errors="replace")
                for value_tag, value in attribute["values"]
                if value_tag == IPP_VALUE_KEYWORD
            )

    states = [a for a in attributes if a["name"] == "job-state"]
    if len(states) != 1:
        return None, reasons, f"{len(states)} job-state attributes (expected 1)"
    values = states[0]["values"]
    if len(values) != 1:
        return None, reasons, f"job-state has {len(values)} values (expected 1)"
    value_tag, value = values[0]
    if value_tag != IPP_VALUE_ENUM or len(value) != 4:
        return None, reasons, (
            f"job-state is not a 4-octet enum (tag 0x{value_tag:02x}, "
            f"{len(value)} octets)"
        )
    (state,) = struct.unpack(">i", value)
    return state, reasons, ""


def ipp_completion_verdict(
    http_status: int, body: Any, request_id: int
) -> Tuple[str, Dict[str, Any]]:
    """Verdict for one Get-Job-Attributes exchange.  Pure; never raises.

    Returns ``(verdict, observation)``.  COMPLETED only for job-state 9
    without 'queued-in-device' or a completed-with-errors reason; FAILED for 7
    canceled / 8 aborted and for 9 with errors; UNOBSERVABLE for 9 with
    'queued-in-device'.  Everything else -- 3-6, an unknown or unreadable
    state, a non-success IPP status-code (e.g. 0x0406 not-found: the job may
    have been purged), a request-id that is not ours, a malformed body, a
    non-200 HTTP status (RFC 8010 sec 3.4.3) or a transport failure (status
    0) -- is WAITING.
    """
    observation: Dict[str, Any] = {"httpStatus": http_status}
    if http_status != 200:
        observation["reason"] = (
            "transport failure: printer unreachable"
            if not isinstance(http_status, int) or http_status <= 0
            else f"HTTP {http_status} (no IPP answer)"
        )
        return POLL_WAITING, observation
    try:
        response = decode_ipp_response(body)
    except IppDecodeError as exc:
        observation["reason"] = f"malformed IPP response: {exc}"
        return POLL_WAITING, observation

    observation["ippVersion"] = "%d.%d" % response["version"]
    observation["ippStatusCode"] = "0x%04x" % response["statusCode"]
    if response["version"][0] not in (1, 2):
        observation["reason"] = "not an IPP/1.x or IPP/2.x response"
        return POLL_WAITING, observation
    if response["requestId"] != request_id:
        observation["reason"] = (
            f"request-id {response['requestId']} is not ours ({request_id})"
        )
        return POLL_WAITING, observation
    if response["statusCode"] > IPP_STATUS_SUCCESS_MAX:
        observation["reason"] = (
            f"IPP status-code {observation['ippStatusCode']} is not a success"
        )
        return POLL_WAITING, observation

    state, reasons, problem = ipp_job_state(response)
    observation["jobStateCode"] = state
    observation["jobState"] = IPP_JOB_STATE_NAMES.get(state) if state is not None else None
    observation["jobStateReasons"] = reasons
    if state is None:
        observation["reason"] = f"no readable job-state: {problem}"
        return POLL_WAITING, observation

    name = IPP_JOB_STATE_NAMES.get(state, str(state))
    if state in IPP_JOB_STATES_COMPLETED:
        if IPP_REASON_QUEUED_IN_DEVICE in reasons:
            observation["reason"] = (
                "job-state completed with 'queued-in-device': the job was "
                "handed to a device that cannot report its outcome"
            )
            return POLL_UNOBSERVABLE, observation
        errors = sorted(IPP_REASONS_COMPLETED_WITH_ERRORS.intersection(reasons))
        if errors:
            observation["reason"] = f"job-state completed with errors ({', '.join(errors)})"
            return POLL_FAILED, observation
        observation["reason"] = "job-state completed"
        return POLL_COMPLETED, observation
    if state in IPP_JOB_STATES_FAILED:
        observation["reason"] = f"job-state {name}"
        return POLL_FAILED, observation
    if state in IPP_JOB_STATES_NOT_COMPLETED:
        observation["reason"] = f"job-state {name}"
        return POLL_WAITING, observation
    observation["reason"] = f"unrecognised job-state {state}"
    return POLL_WAITING, observation


# --- OctoPrint (REST API, GET /api/job) -------------------------------------
#
# The docs call the state list "not exhaustive", so every set below is an
# ALLOWLIST: a state string not named here is always WAITING.
OCTOPRINT_STATES_IDLE = frozenset({"operational"})
OCTOPRINT_STATES_ACTIVE = frozenset({"printing", "pausing", "paused"})
OCTOPRINT_STATES_CANCELLING = frozenset({"cancelling"})
OCTOPRINT_STATES_FAILED = frozenset({"error", "offline", "offline after error"})
OCTOPRINT_COMPLETE_PERCENT = 100.0   # progress.completion is a percentage


def _octoprint_base_url(device: Dict) -> str:
    return device.get("url") or f"http://{device.get('host', 'localhost')}:5000"


def _octoprint_headers(device: Dict) -> Dict[str, str]:
    """Auth headers for the device's OctoPrint API -- shared by the adapter and
    the completion poller, so the key is never copied into a handle (a handle
    rides in evidence)."""
    api_key = device.get("api_key") or device.get("apiKey", "")
    return {"X-Api-Key": api_key} if api_key else {}


def _octoprint_file_is_ours(job: Any, filename: str) -> bool:
    """True when ``job.file`` is the local file this node selected.

    ``path`` is the path within the location (``folder/file.gco``), which is
    what the adapter selected by; ``name`` has no folder, so it is only the
    fallback when ``path`` is absent.
    """
    if not isinstance(job, dict):
        return False
    selected = job.get("file")
    if not isinstance(selected, dict) or selected.get("origin") != "local":
        return False
    wanted = filename.lstrip("/")
    path = selected.get("path")
    if isinstance(path, str):
        return path == wanted
    name = selected.get("name")
    return isinstance(name, str) and name == wanted


def _octoprint_completion_percent(progress: Any) -> Optional[float]:
    if not isinstance(progress, dict):
        return None
    completion = progress.get("completion")
    if isinstance(completion, bool) or not isinstance(completion, (int, float)):
        return None
    return float(completion) if math.isfinite(completion) else None


def octoprint_completion_verdict(
    http_status: int, body: Any, filename: str, seen_active: bool
) -> Tuple[str, str, bool]:
    """Verdict for one ``GET /api/job``.  Pure; never raises.

    Returns ``(verdict, reason, active)``; ``active`` is True when OUR file is
    printing/pausing/paused, and the caller remembers it as ``seen_active``.

    * our file is not the current job (another file, none, not local) -> WAITING
    * printing / pausing / paused                                      -> WAITING
    * cancelling (irreversible; a select+print is refused while a print
      is active, so after our acceptance this is our print)            -> FAILED
    * error / offline / offline after error, below 100 %               -> FAILED
      ... at 100 % (it may have finished before the connection went)   -> WAITING
    * operational, never seen active (the selection may show a PREVIOUS
      run of the same file, or the print has not started)              -> WAITING
    * operational after active, completion >= 100, no error message   -> COMPLETED
    * operational after active, completion < 100 (stopped early)      -> FAILED
    * operational after active, completion unreadable / error message -> WAITING
    * any other state, a non-200 answer, an unreadable body            -> WAITING
    """
    if http_status != 200:
        return POLL_WAITING, (
            "transport failure: OctoPrint unreachable"
            if not isinstance(http_status, int) or http_status <= 0
            else f"HTTP {http_status}"
        ), False
    if not isinstance(body, dict):
        return POLL_WAITING, "unreadable /api/job body", False
    state = body.get("state")
    if not isinstance(state, str) or not state.strip():
        return POLL_WAITING, "no state in /api/job", False
    normalized = state.strip().lower()
    if not _octoprint_file_is_ours(body.get("job"), filename):
        return POLL_WAITING, f"{state}: our file is not the current job", False

    completion = _octoprint_completion_percent(body.get("progress"))
    finished = completion is not None and completion >= OCTOPRINT_COMPLETE_PERCENT
    shown = "unknown" if completion is None else f"{completion:g}%"

    if normalized in OCTOPRINT_STATES_ACTIVE:
        return POLL_WAITING, f"{state} at {shown}", True
    if normalized in OCTOPRINT_STATES_CANCELLING:
        return POLL_FAILED, f"print cancelled ({state} at {shown})", False
    if normalized in OCTOPRINT_STATES_FAILED:
        if finished:
            return POLL_WAITING, (
                f"{state} at {shown}: it may have finished before this state"
            ), False
        return POLL_FAILED, f"printer reported {state!r} at {shown}", False
    if normalized in OCTOPRINT_STATES_IDLE:
        if not seen_active:
            return POLL_WAITING, (
                f"{state} at {shown}, but our print was never seen running"
            ), False
        error = body.get("error")
        if isinstance(error, str) and error.strip():
            return POLL_WAITING, f"{state} with an error reported: {error}", False
        if finished:
            return POLL_COMPLETED, f"{state} at {shown} after printing", False
        if completion is None:
            return POLL_WAITING, f"{state}, completion unreadable", False
        return POLL_FAILED, f"print stopped at {shown} (cancelled before completion)", False
    return POLL_WAITING, f"unrecognised state {state!r}", False


# ---------------------------------------------------------------------------
# Main executor class
# ---------------------------------------------------------------------------

class JobExecutor:
    """Executes jobs on local devices and reports evidence to the gateway.

    Parameters
    ----------
    devices:
        List of device dicts (from NodeConfig.devices or discovery).
    gateway_client:
        A PCCGatewayClient instance for pushing status + evidence.
    clock:
        Monotonic clock for completion deadlines (tests inject a fake one).
    """

    def __init__(
        self,
        devices: List[Dict],
        gateway_client=None,
        clock: Optional[Callable[[], float]] = None,
        outbox: Optional[Any] = None,
    ):
        # Index by id and by protocol for fast lookup
        self._devices_by_id: Dict[str, Dict] = {}
        self._devices_by_protocol: Dict[str, List[Dict]] = {}

        for dev in devices:
            dev_id = dev.get("id") or dev.get("host") or dev.get("ip", "")
            if dev_id:
                self._devices_by_id[dev_id] = dev
            protocol = dev.get("protocol") or dev.get("type") or "generic"
            self._devices_by_protocol.setdefault(protocol, []).append(dev)

        self.gateway = gateway_client
        self._clock: Callable[[], float] = clock or time.monotonic
        # Durable retry for terminal status reports the gateway did not
        # acknowledge (outbox.StatusOutbox; r31 finding 7).  None: log only.
        self.outbox = outbox

        # Jobs a device ACCEPTED whose completion is still to be observed, by
        # job id (see poll_awaiting).  IN MEMORY ONLY: a daemon restart forgets
        # them and they stay "running" upstream.  That is the safe side -- the
        # job was claimed "running" before its side effect, so it is never
        # dispatched as queued again (no second print), and no outcome nobody
        # observed is reported -- but settling it then needs a human.
        self._awaiting: Dict[str, Dict[str, Any]] = {}
        self._last_ipp_request_id = 0

    def execute(self, job: Dict) -> Dict[str, Any]:
        """Execute a job dict.  Returns the evidence bundle or error dict."""
        capability_type = job.get("capabilityType") or job.get("capability_type", "generic")

        # Evidence must bind to this assignment (LO-EV-9).  One that cannot --
        # no job id, or a malformed settlement unit or nonce -- is refused
        # before the claim and before the device is touched.  (A missing id
        # used to be replaced with an invented "job-<time>", which no
        # settlement could ever match.)
        try:
            binding = assignment_binding(job)
        except AssignmentBindingError as exc:
            job_id = job.get("id")
            log.error("Refusing job %r: %s; the device was not touched", job_id, exc)
            if self.gateway and isinstance(job_id, str) and job_id.strip():
                self._report_terminal_failure(job_id, {"error": f"unbindable assignment: {exc}"})
            return {"status": "refused", "error": f"unbindable assignment: {exc}"}
        job_id = binding["jobId"]

        log.info(f"Executing job {job_id} (capability: {capability_type})")

        # Claim before the side effect.  For an accepted job "running" is the
        # only status this node ever reports, so if the claim does not land the
        # job stays "queued" upstream and a restarted daemon would run it again
        # (a second print).  Not starting is the safe side; the job is forgotten
        # so a later poll can claim it.
        if self.gateway and not self.gateway.update_job_status(job_id, "running"):
            log.error(
                "Job %s: the gateway did not acknowledge the 'running' claim; "
                "not starting it, so no later poll or restart can run it twice",
                job_id,
            )
            forget = getattr(self.gateway, "forget_job", None)
            if callable(forget):
                forget(job_id)
            return {"status": "not_started", "error": "claim_not_acknowledged"}

        try:
            device = self._find_device(job)
            if device is None:
                error_result = {
                    "status": "failed",
                    "error": "no_device_found",
                    "capabilityType": capability_type,
                }
                if self.gateway:
                    self._report_terminal_failure(job_id, {"error": "no_device_found"})
                return error_result

            result = self._execute_on_device(device, job)
            verdict = classify_execution_result(result)
            evidence = build_evidence_bundle(job_id, device, result, binding=binding)
            device_label = device.get("id", "?")

            if self.gateway:
                # Evidence is pushed for every outcome -- a failed run must
                # still reach the verifier so that it can dispute.
                pushed = self.gateway.push_evidence(job_id, evidence)

                if verdict == RESULT_SUCCESS:
                    # As for device-reported completion: 'completed' whose
                    # execution_completed was never stored could not settle,
                    # and pushing the bundle again risks a duplicate.
                    if pushed:
                        self._report_terminal(job_id, "completed", result, "device reported success")
                    else:
                        log.error(
                            "Job %s: the device succeeded but the gateway did not store "
                            "the completion evidence; NOT reporting 'completed' -- the "
                            "job stays 'running' upstream", job_id,
                        )
                elif verdict == RESULT_FAILURE:
                    self._report_terminal_failure(
                        job_id,
                        {
                            "error": describe_execution_failure(result),
                            "result": result,
                        },
                    )
                elif verdict == RESULT_ACCEPTED:
                    # No terminal status.  The device took the job but has not
                    # reported it finished, so it is neither completed nor
                    # failed; it stays "running", as reported above -- until
                    # poll_awaiting observes the device's own outcome, when
                    # the adapter left a handle to ask the device with.
                    self._register_awaiting(job_id, device, result, binding)
                else:
                    self._report_terminal_failure(
                        job_id,
                        {"error": UNCLASSIFIABLE_REASON, "result": result},
                    )

            if verdict == RESULT_SUCCESS:
                log.info(f"Job {job_id} completed on device {device_label}")
            elif verdict == RESULT_FAILURE:
                log.warning(
                    f"Job {job_id} failed on device {device_label}: "
                    f"{describe_execution_failure(result)}"
                )
            elif verdict == RESULT_ACCEPTED:
                log.info(
                    f"Job {job_id} accepted by device {device_label}; completion "
                    f"not yet observed (evidence level "
                    f"'{EVIDENCE_LEVEL_SUBMITTED}'), so no terminal status is "
                    f"reported and the job stays running"
                )
            else:
                log.warning(
                    f"Job {job_id} returned an unclassifiable result on device "
                    f"{device_label}; reporting failed (fail-closed)"
                )
            return evidence

        except Exception as e:
            log.error(f"Job {job_id} failed: {e}")
            error_info = {"error": str(e), "status": "failed"}
            if self.gateway:
                self._report_terminal_failure(job_id, error_info)
            return error_info

    def _report_terminal_failure(self, job_id: str, metadata: Dict) -> bool:
        """Report a job failed, and say so loudly when the report does not land.

        ``update_job_status`` returns False after a bare ``log.warning`` when
        the gateway rejects the PATCH (ws_client.py), and every other call site
        in this module discards that return.  A dropped 'failed' report leaves
        the job non-terminal, which matters beyond this node: the gateway's own
        completion route is gated on the job not already being 'failed'.

        With an outbox the unacknowledged report is queued and retried
        (flush_outbox); without one it is only logged.
        """
        return self._report_terminal(job_id, "failed", metadata, metadata.get("error"))

    def _report_terminal(self, job_id: str, status: str, metadata: Dict, reason: Any) -> bool:
        """Report a terminal status; queue it durably when it is not acknowledged."""
        acknowledged = bool(self.gateway.update_job_status(job_id, status, metadata))
        if acknowledged:
            return True
        queued = self.outbox is not None and self.outbox.enqueue(job_id, status, metadata)
        log.error(
            "Job %s: the gateway did not acknowledge the %r status report (%s); %s",
            job_id, status, reason,
            "it is queued and will be retried" if queued
            else "the job may still look non-terminal upstream",
        )
        return False

    def flush_outbox(self) -> int:
        """Retry queued terminal reports that are due.  Returns how many landed."""
        if self.outbox is None or self.gateway is None:
            return 0
        return self.outbox.flush(self.gateway.update_job_status)

    # ------------------------------------------------------------------
    # Deferred completion tracking
    # ------------------------------------------------------------------

    def awaiting_completion(self) -> Dict[str, Dict[str, Any]]:
        """Snapshot of the jobs awaiting device-reported completion."""
        return {job_id: dict(entry) for job_id, entry in self._awaiting.items()}

    def _completion_handle(
        self, device: Dict, result: Any
    ) -> Optional[Tuple[str, Dict[str, Any]]]:
        """``(kind, handle)`` to ask the device about an accepted job, or None.

        A handle is PUBLIC: it is copied into evidence, so it never holds a
        credential (the OctoPrint key is re-derived from the device per poll).

        * IPP: ``lp`` stdout names the CUPS request id and the job went to a
          printer host (``lp -h``).  No request id (e.g. the Windows
          ``notepad /p`` path), a local queue (``lp -d``/``lp``, no host) or a
          host that is not a plain name/IPv4 -> no handle.
        * OctoPrint: the base URL and the file the adapter selected.
        """
        if not isinstance(result, dict):
            return None
        protocol = device.get("protocol") or device.get("type") or "generic"

        if protocol in ("ipp", "printer"):
            parsed = parse_lp_request_id(result.get("stdout"))
            host = result.get("printer_ip")
            if parsed is None or not isinstance(host, str) or not _IPP_HOST.match(host):
                return None
            queue, cups_job_id = parsed
            return COMPLETION_KIND_IPP, {
                "printer_ip": host, "queue": queue, "cupsJobId": cups_job_id,
            }

        if protocol in ("octoprint", "3d-printer"):
            base_url = result.get("device")
            filename = result.get("filename")
            if not (isinstance(base_url, str) and base_url.startswith(("http://", "https://"))):
                return None
            if not (isinstance(filename, str) and filename.strip()):
                return None
            return COMPLETION_KIND_OCTOPRINT, {"base_url": base_url, "filename": filename}

        return None

    def _register_awaiting(
        self, job_id: str, device: Dict, result: Any, binding: Optional[Dict[str, str]] = None
    ) -> bool:
        """Track an ACCEPTED job until its device reports an outcome.

        Registers nothing -- the job simply stays accepted-only, "running"
        upstream, as before completion tracking existed -- when there is no
        handle, when the device's ``completionPollTimeout`` is 0 or less, or
        when the job is already tracked (a second entry could report twice).
        """
        found = self._completion_handle(device, result)
        if found is None:
            log.info(
                "Job %s: no completion handle for this device/result; it stays "
                "accepted-only (running) with no completion tracking", job_id,
            )
            return False
        kind, handle = found
        timeout_s = _as_float(
            device.get("completionPollTimeout"), DEFAULT_COMPLETION_POLL_TIMEOUT_S[kind]
        )
        if not math.isfinite(timeout_s):
            timeout_s = DEFAULT_COMPLETION_POLL_TIMEOUT_S[kind]
        if timeout_s <= 0:
            log.info(
                "Job %s: completion tracking disabled (completionPollTimeout=%g); "
                "it stays accepted-only (running)", job_id, timeout_s,
            )
            return False
        if job_id in self._awaiting:
            log.warning(
                "Job %s is already awaiting completion; not registering it twice",
                job_id,
            )
            return False
        accepted_at = self._clock()
        self._awaiting[job_id] = {
            "job_id": job_id,
            "binding": _resolve_binding(job_id, binding),
            "device": device,
            "kind": kind,
            "handle": handle,
            "accepted_at": accepted_at,
            "deadline": accepted_at + timeout_s,
            "seen_active": False,        # OctoPrint: our print observed running
            "last_observation": None,
        }
        log.info(
            "Job %s: awaiting device-reported completion via %s %s (budget %gs)",
            job_id, kind, handle, timeout_s,
        )
        return True

    def poll_awaiting(self) -> None:
        """Check every awaiting job ONCE -- one request each, no sleeping.

        Called by the daemon once per cycle.  Per job:

        * past its deadline -> dropped WITHOUT a status, ERROR naming it
          (outcome unknown; it stays "running" upstream).  Checked first, so a
          job is never polled after its budget.
        * the device reports COMPLETED -> dropped, then one bundle
          ``[execution_completed {level: device_reported, ...}]`` and one
          ``completed`` status (only if that evidence was acknowledged).
        * a device-reported terminal FAILURE -> dropped, then one bundle
          ``[execution_failed ...]`` and one ``failed`` status.
        * the device says the outcome is unobservable -> dropped like a
          deadline, ERROR, no status.
        * still pending/processing, or the check failed/was unreadable ->
          left registered.

        A job is removed from the registry BEFORE anything is reported, so no
        failure part-way through can make a later cycle report it again: never
        two terminal statuses, never two completion bundles.  One job's
        exception is logged and does not stop the others.
        """
        for job_id in list(self._awaiting):
            entry = self._awaiting.get(job_id)
            if entry is None:
                continue
            try:
                self._poll_one(entry)
            except Exception as exc:
                log.error(
                    "Job %s: completion check raised %s: %s",
                    job_id, type(exc).__name__, exc,
                )

    def _poll_one(self, entry: Dict[str, Any]) -> None:
        job_id = entry["job_id"]
        if self._clock() >= entry["deadline"]:
            self._awaiting.pop(job_id, None)
            log.error(
                "Job %s: the device reported no outcome within %gs of its "
                "acceptance (%s %s); completion tracking stopped WITHOUT "
                "reporting completed or failed -- the outcome is unknown and the "
                "job stays 'running' upstream (last observation: %s)",
                job_id, entry["deadline"] - entry["accepted_at"], entry["kind"],
                entry["handle"], entry["last_observation"],
            )
            return

        if entry["kind"] == COMPLETION_KIND_IPP:
            verdict, observation = self._check_ipp(entry)
        else:
            verdict, observation = self._check_octoprint(entry)
        entry["last_observation"] = observation

        if verdict == POLL_WAITING:
            log.debug("Job %s: still awaiting completion (%s)", job_id, observation.get("reason"))
            return

        self._awaiting.pop(job_id, None)
        if verdict == POLL_UNOBSERVABLE:
            log.error(
                "Job %s: the device cannot report this job's outcome (%s); "
                "completion tracking stopped WITHOUT reporting completed or "
                "failed -- the outcome is unknown and the job stays 'running' "
                "upstream", job_id, observation.get("reason"),
            )
            return
        self._report_device_outcome(entry, verdict, observation)

    def _next_ipp_request_id(self) -> int:
        self._last_ipp_request_id = self._last_ipp_request_id % IPP_INT_MAX + 1
        return self._last_ipp_request_id

    def _check_ipp(self, entry: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        """One IPP Get-Job-Attributes for an awaiting job."""
        from .http_util import http_bytes

        handle = entry["handle"]
        url, printer_uri = ipp_job_urls(handle)
        request_id = self._next_ipp_request_id()
        request = encode_ipp_get_job_attributes(printer_uri, handle["cupsJobId"], request_id)
        status, body = http_bytes(
            "POST", url, data=request,
            headers={"Content-Type": "application/ipp"},
            timeout=COMPLETION_POLL_REQUEST_TIMEOUT_S,
        )
        return ipp_completion_verdict(status, body, request_id)

    def _check_octoprint(self, entry: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        """One ``GET /api/job`` for an awaiting OctoPrint job."""
        from .http_util import http

        handle = entry["handle"]
        try:
            status, body = http(
                "GET", f"{handle['base_url']}/api/job",
                headers=_octoprint_headers(entry["device"]),
                timeout=COMPLETION_POLL_REQUEST_TIMEOUT_S,
                verify_ssl=False,
            )
        except Exception as exc:  # e.g. a body that is not UTF-8
            status, body = 0, {"error": f"{type(exc).__name__}: {exc}"}

        verdict, reason, active = octoprint_completion_verdict(
            status, body, handle["filename"], entry["seen_active"]
        )
        if active:
            entry["seen_active"] = True
        observation: Dict[str, Any] = {"httpStatus": status, "reason": reason}
        if isinstance(body, dict):
            job = body.get("job")
            observation.update(
                deviceState=body.get("state"),
                file=job.get("file") if isinstance(job, dict) else None,
                progress=body.get("progress"),
                error=body.get("error"),
            )
        else:
            observation["body"] = _short(body)
        return verdict, observation

    def _report_device_outcome(
        self, entry: Dict[str, Any], verdict: str, observation: Dict[str, Any]
    ) -> None:
        """Push the device-reported outcome, then report its terminal status.

        The caller has already removed the job from the registry: this runs
        at most once per job.  'completed' is reported only when the gateway
        acknowledged the completion evidence -- a completed status whose
        execution_completed never landed could not settle, and pushing the
        bundle again risks a duplicate -- so an unacknowledged push leaves the
        job "running" and says so at ERROR.  'failed' is reported either way,
        as execute() does: failing closed needs no evidence to be safe.
        """
        job_id = entry["job_id"]
        result = {
            "kind": entry["kind"],
            "handle": dict(entry["handle"]),
            **observation,
        }
        evidence = build_device_reported_bundle(
            job_id,
            entry["device"],
            result,
            completed=verdict == POLL_COMPLETED,
            error=observation.get("reason") or "device reported a failure",
            binding=entry.get("binding"),
        )
        payload = evidence["events"][0]["payload"]

        pushed = self.gateway.push_evidence(job_id, evidence)
        if verdict == POLL_COMPLETED:
            if not pushed:
                log.error(
                    "Job %s: the device reported completion (%s) but the gateway "
                    "did not acknowledge the completion evidence; NOT reporting "
                    "'completed' -- the job stays 'running' upstream",
                    job_id, observation.get("reason"),
                )
                return
            if self._report_terminal(job_id, "completed", result, observation.get("reason")):
                log.info(
                    "Job %s completed: the device reported it (%s)",
                    job_id, observation.get("reason"),
                )
            return

        log.warning(
            "Job %s failed: the device reported %s", job_id, payload["error"],
        )
        self._report_terminal_failure(job_id, {"error": payload["error"], "result": result})

    def _find_device(self, job: Dict) -> Optional[Dict]:
        """Find the best device for this job.

        Priority:
          1. Explicit deviceId in job
          2. Match by assignedDevices list
          3. Match by capabilityType -> protocol
          4. Any available device
        """
        # 1. Explicit device ID
        device_id = job.get("deviceId")
        if device_id and device_id in self._devices_by_id:
            return self._devices_by_id[device_id]

        # 2. assignedDevices list
        for dev_id in job.get("assignedDevices", []):
            if dev_id in self._devices_by_id:
                return self._devices_by_id[dev_id]

        # 3. Capability type -> protocol map
        capability_type = job.get("capabilityType") or job.get("capability_type", "")
        # Fall back: extract type from capabilityId (e.g. "cap-kernel-nanoclaw-liquid-handler")
        if not capability_type:
            cap_id = job.get("capabilityId", "")
            for known_type in CAPABILITY_PROTOCOL_MAP:
                if known_type in cap_id:
                    capability_type = known_type
                    break
        protocols = CAPABILITY_PROTOCOL_MAP.get(capability_type, [])
        for protocol in protocols:
            devs = self._devices_by_protocol.get(protocol, [])
            if devs:
                return devs[0]

        # 4. Any available device
        all_devices = list(self._devices_by_id.values())
        if all_devices:
            return all_devices[0]

        return None

    def _execute_on_device(self, device: Dict, job: Dict) -> Dict[str, Any]:
        """Route to the right execution method based on device protocol."""
        protocol = device.get("protocol") or device.get("type") or "generic"

        if protocol in ("ipp", "printer"):
            return execute_ipp_print(device, job)

        if protocol == "opentrons":
            return self._execute_opentrons(device, job)

        if protocol in ("octoprint", "3d-printer"):
            return self._execute_octoprint(device, job)

        # Generic HTTP fallback
        return self._execute_generic_http(device, job)

    def _execute_opentrons(self, device: Dict, job: Dict) -> Dict[str, Any]:
        """Submit and run an Opentrons protocol."""
        from .http_util import http

        base_url = device.get("url") or f"http://{device.get('host', 'localhost')}:31950"
        ot2_headers = {"opentrons-version": "2"}
        params = job.get("parameters", {})
        protocol_id = params.get("protocolId") or params.get("protocol_id")

        # If pythonCode provided instead of protocolId, upload first
        python_code = params.get("pythonCode") or params.get("python_code")
        if not protocol_id and python_code:
            filename = params.get("filename", "pcc_protocol.py")
            boundary = f"----PCCBoundary{id(job)}"
            upload_body = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
                f"Content-Type: text/x-python\r\n"
                f"\r\n"
                f"{python_code}\r\n"
                f"--{boundary}--"
            ).encode("utf-8")
            upload_headers = {
                **ot2_headers,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            }
            from urllib.request import Request, urlopen
            import json as _json
            import ssl
            _ctx = ssl.create_default_context()
            _ctx.check_hostname = False
            _ctx.verify_mode = ssl.CERT_NONE
            try:
                req = Request(f"{base_url}/protocols", data=upload_body, headers=upload_headers, method="POST")
                with urlopen(req, timeout=30, context=_ctx) as resp:
                    upload_result = _json.loads(resp.read().decode("utf-8"))
                protocol_id = (upload_result.get("data", {}) or {}).get("id")
            except Exception as exc:
                return {"error": f"protocol upload failed: {exc}", "uploaded": False}
            if not protocol_id:
                return {"error": "protocol upload returned no ID", "data": upload_result}

        if not protocol_id:
            return {"error": "no_protocol_id", "note": "opentrons job requires protocolId or pythonCode in parameters"}

        # Create a run
        status, run_data = http(
            "POST", f"{base_url}/runs",
            body={"data": {"protocolId": protocol_id}},
            headers=ot2_headers,
            verify_ssl=False,
        )
        if status not in (200, 201):
            return {"error": f"run creation failed HTTP {status}", "data": run_data}

        run_id = (run_data.get("data", {}) or {}).get("id") if isinstance(run_data, dict) else None
        if not run_id:
            return {"error": "run_id_missing", "data": run_data}

        # Start the run.  The play action is what actually starts the protocol,
        # so its status is the only evidence the run began.  This was the one
        # discarded http() return in the module: a protocol that never started
        # still returned submitted=True, and golden-v4's and(execution_completed
        # present, execution_failed absent) RELEASED it.  Guard mirrors the
        # run-creation allowlist above; a status outside it fails closed.
        play_status, play_data = http(
            "POST", f"{base_url}/runs/{run_id}/actions",
            body={"data": {"actionType": "play"}},
            headers=ot2_headers,
            verify_ssl=False,
        )
        if play_status not in (200, 201):
            return {
                "error": f"run play failed HTTP {play_status}",
                "runId": run_id,
                "protocolId": protocol_id,
                # Redundant with "error" by design: classify_execution_result
                # rule 3 catches the error and rule 7 catches this flag, so the
                # failure survives either rule being edited.
                "submitted": False,
                "device": base_url,
                "data": play_data,
            }

        # The play action only STARTS the protocol.  `submitted: True` is an
        # ACCEPTANCE flag: a run that begins and then fails at step 40 was still
        # submitted, and reporting that as a completion is the OH-1 defect one
        # layer up from the play guard above.  So wait for the run's own
        # terminal status and report THAT.
        timeout_s = _as_float(device.get("runPollTimeout"), OPENTRONS_RUN_POLL_TIMEOUT_S)
        interval_s = _as_float(device.get("runPollInterval"), OPENTRONS_RUN_POLL_INTERVAL_S)
        run_status, run_body = self._await_opentrons_run(
            base_url, run_id, ot2_headers, timeout_s, interval_s
        )

        base_result: Dict[str, Any] = {
            "runId": run_id,
            "protocolId": protocol_id,
            "submitted": True,
            "device": base_url,
        }

        run_errors = _opentrons_run_errors(run_body)
        # r31 astra verdict item 2: a "succeeded" data.status is not enough when
        # the same polled body also carries a failure marker anywhere
        # ({"error": "run failed", "data": {"status": "succeeded"}}).  A
        # conflict is a failure, never a success.
        body_error = _extract_device_error(run_body)

        if run_status in OPENTRONS_TERMINAL_FAILURE or run_errors or body_error:
            if run_errors:
                reason = f"run reported {len(run_errors)} protocol error(s): {_short(run_errors)}"
            elif run_status in OPENTRONS_TERMINAL_FAILURE:
                reason = f"run finished with status {run_status!r}"
            else:
                reason = f"run status {run_status!r} conflicts with a failure in the run body: {body_error}"
            return {
                **base_result,
                "status": "failed",
                "runStatus": run_status or "errored",
                "error": reason,
                "data": run_body,
            }

        if run_status in OPENTRONS_TERMINAL_SUCCESS:
            return {
                **base_result,
                "status": "completed",
                "runStatus": run_status,
                # Keep the polled evidence: the classifier re-reads it (rule 3b)
                # and the bundle carries what the success was decided on.
                "response": run_body,
            }

        # Started, outcome unknown.  An explicit non-terminal status keeps this
        # fail-closed -- neither execution_completed nor execution_failed --
        # rather than releasing on acceptance.
        return {
            **base_result,
            "status": "running",
            "runStatus": run_status or "unknown",
            "note": (
                "run started but did not reach a terminal state within "
                f"{timeout_s:g}s; outcome unknown"
            ),
            "data": run_body,
        }

    def _await_opentrons_run(
        self,
        base_url: str,
        run_id: str,
        headers: Dict,
        timeout_s: float,
        interval_s: float,
    ):
        """Poll ``GET /runs/<id>`` until the run reaches a terminal state.

        Returns ``(run_status, last_body)``.  ``run_status`` is None when the
        run never reached a terminal state inside the budget, or when the poll
        could not be read -- both of which the caller must treat as "outcome
        unknown", never as a success.
        """
        from .http_util import http

        if timeout_s <= 0:
            return None, None

        deadline = time.monotonic() + timeout_s
        last_body: Any = None
        while True:
            # Each request gets at most the remaining budget (r31 item 4): a
            # device that stops answering cannot hold the poll past its deadline.
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, last_body
            status, body = http(
                "GET", f"{base_url}/runs/{run_id}", headers=headers, verify_ssl=False,
                timeout=max(1.0, min(POLL_REQUEST_TIMEOUT_MAX_S, remaining)),
            )
            last_body = body
            if status in (200, 201):
                run_status = _opentrons_run_status(body)
                if (
                    run_status in OPENTRONS_TERMINAL_SUCCESS
                    or run_status in OPENTRONS_TERMINAL_FAILURE
                    or _opentrons_run_errors(body)
                ):
                    return run_status, body

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None, last_body
            time.sleep(min(max(interval_s, 0.0), remaining))

    def _execute_octoprint(self, device: Dict, job: Dict) -> Dict[str, Any]:
        """Start an OctoPrint print job.

        OctoPrint answering 200/201/204 to ``select + print`` means the API
        ACCEPTED the job -- it selected the file and started the print -- not
        that anything was printed: the print can still fail hours later.  The
        result therefore carries the acceptance flag ``submitted``, never the
        completion flag ``printed``.  Completion is the job's own state
        (``GET /api/job``), which :meth:`poll_awaiting` reads once per daemon
        cycle after the acceptance.

        ``submitted`` still reads the device's answer, not just the status
        line, for the same reason as :meth:`_execute_generic_http`: a printer
        that replies ``{"error": "E_JAM: carriage jam, job aborted"}`` in a 200
        body has failed.  A failure stated in the body outranks the status code.
        """
        from .http_util import http

        base_url = _octoprint_base_url(device)
        params = job.get("parameters", {})
        filename = params.get("filename", "")

        headers = _octoprint_headers(device)

        if not filename:
            return {"error": "no_filename", "note": "octoprint job requires filename in parameters"}

        status, data = http(
            "POST", f"{base_url}/api/files/local/{filename}",
            body={"command": "select", "print": True},
            headers=headers,
            verify_ssl=False,
        )

        transport_ok = status in OCTOPRINT_SUCCESS_STATUSES
        device_error = _extract_device_error(data)

        result: Dict[str, Any] = {
            # Accepted-and-started, never printed -- see the docstring.
            "submitted": transport_ok and device_error is None,
            "filename": filename,
            "status_code": status,
            "device": base_url,
        }
        if device_error is not None:
            result["error"] = device_error
        elif not transport_ok:
            result["error"] = _describe_transport_status(status, data)
        return result

    def _execute_generic_http(self, device: Dict, job: Dict) -> Dict[str, Any]:
        """Generic HTTP execution via passthrough parameters.

        This is the catch-all branch of :meth:`_execute_on_device`: every
        protocol that is not ipp/printer/opentrons/octoprint lands here --
        modbus, opcua, http, serial, mdns, camera and unknown per
        ``discovery.py``/``detect.py``, plus anything ``_find_device`` step 4
        drops on an unmapped capability.  It is the widest adapter path, not an
        edge, so its notion of "success" is the one that matters most.

        ``executed`` is therefore derived from the DEVICE's answer, not from
        the transport alone:

        * the success band is 2xx.  ``status < 400`` also admitted redirects
          (nothing was executed) and http_util's status-0 transport sentinel.
        * a failure stated in the response body is lifted to the top level at
          EVERY status, not only on transport failure.  A reachable instrument
          that answers ``200`` with ``{"error": ...}`` -- a JSON-RPC error, a
          REST ``{"status": "error"}``, ``{"success": false}``, a SOAP fault --
          is a failed job, and lifting its reason here is what stops the bundle
          claiming ``execution_completed`` for it.
        * 202 Accepted is ACCEPTANCE, not completion (:data:`HTTP_ACCEPTED`):
          the device took the request and has not finished it.  A 202 reports
          the acceptance flag ``submitted`` instead of ``executed``, derived
          the same way.
        * any other clean 2xx claims ``executed`` ONLY when the body positively
          states completion (the device's contract, or the default completion
          vocabulary -- see GENERIC_COMPLETION_STATUS_VALUES).  A recognised
          queueing/running statement reports ``submitted``.  Anything else
          (``{}``, ``null``, ``{"ok": true}``, an unknown status word, a
          malformed value) carries NO flag, so it classifies as unclassifiable
          and the job fails closed: "2xx and no recognised error" is the
          transport answering, not the device saying the work finished (r31
          astra verdict item 1).
        """
        from .http_util import http

        base_url = device.get("url") or device.get("baseUrl") or ""
        params = job.get("parameters", {})
        method = params.get("method", "POST")
        path = params.get("path", "/execute")
        body = params.get("body") or params

        if not base_url:
            return {"error": "no_base_url", "executed": False}

        url = f"{base_url.rstrip('/')}{path}"
        status, data = http(method, url, body=body, verify_ssl=False)

        transport_ok = HTTP_SUCCESS_MIN <= status < HTTP_SUCCESS_MAX_EXCLUSIVE
        device_error = _extract_device_error(data)
        # A 202 only acknowledges the request, so it may never claim `executed`.
        flag = "submitted" if status == HTTP_ACCEPTED else "executed"

        result: Dict[str, Any] = {"status_code": status, "response": data, "device": base_url}
        if device_error is not None:
            return {flag: False, **result, "error": device_error}
        if not transport_ok:
            return {flag: False, **result, "error": _describe_transport_status(status, data)}
        if status == HTTP_ACCEPTED:
            return {"submitted": True, **result}

        outcome, reason = _generic_http_outcome(data, device)
        if outcome == OUTCOME_COMPLETED:
            return {"executed": True, **result}
        if outcome == OUTCOME_ACCEPTED:
            return {"submitted": True, **result}
        # No flag: the classifier reads this as unclassifiable (fail closed).
        return {**result, "outcome": "unrecognized", "note": reason}
