"""The job executor: what pcc-node does with a job polled from the gateway.

It refuses to run it on a device. A polled job carries whatever its buyer, the
gateway or anyone answering for the gateway put in it. Until 0.1.1 the executor
turned those fields straight into device commands: Python uploaded to an
Opentrons robot and played, a file selected and printed on OctoPrint, content
sent to the system printer, and an HTTP method, path and body sent unchanged to
a generic device, none of it subject to approval_mode (verdict 68b on #442).

Parameters now reach a device only through the operating agent's typed
operations (``pcc_node.operating``, ADK item 12): each operation's request is
fixed by the operator's profile, and its parameters are type-checked and
checked against the operator's safety envelope first. A refused job is left
queued and untouched, for an operating agent to take.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

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

# Evidence levels, weakest first:
#   submitted        -- the device only ACCEPTED the command (a spooler queued
#                       the job, a print was started, an API answered 202)
#   device-reported  -- the device itself reported the work finished
#   inspected-output -- the output itself was inspected
# Only device-reported (or stronger) evidence may carry execution_completed,
# which is what the settlement oracle releases on.  A submitted-only result is
# recorded as execution_progress at this level and never as a completion.
EVIDENCE_LEVEL_SUBMITTED = "submitted"

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
#               report ``submitted``; ``printed`` waits for an adapter that
#               observes a finished print (IPP job-state, OctoPrint /api/job).
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
    return {
        "jobId": job_id,
        "deviceId": device.get("id", device.get("host", "unknown")),
        "deviceProtocol": device.get("protocol", device.get("type", "unknown")),
        "executedAt": now,
        "result": result,
        "events": _synthesize_events(device, result, now),
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
# Main executor class
# ---------------------------------------------------------------------------

class JobExecutor:
    """Receives the jobs the daemon polls, and refuses to run them on a device.

    See the module docstring. It keeps the node's device index, so a job can
    still be matched to the device it names.

    Parameters
    ----------
    devices:
        List of device dicts (from NodeConfig.devices or discovery).
    gateway_client:
        A PCCGatewayClient instance. A refused job is never reported to it.
    """

    def __init__(self, devices: List[Dict], gateway_client=None):
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

    def execute(self, job: Dict) -> Dict[str, Any]:
        """Refuse to run a polled job on a device, and leave it queued.

        No device is contacted, and no status or evidence is sent: the job is
        left for an operating agent that runs typed operations.
        """
        job_id = job.get("id", "?")
        log.warning(
            "Job %s not run: pcc-node runs a device only through the operating agent's "
            "typed operations, never from a polled job's fields. The job stays queued.",
            job_id,
        )
        return {
            "status": "refused",
            "jobId": job_id,
            "error": "untyped_job",
            "note": "pcc-node drives devices only through typed operations (pcc_node.operating); "
                    "a polled job's fields never become device commands",
        }

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
