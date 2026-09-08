"""Real job executor -- maps capability types to device adapters.

This module handles the full job execution lifecycle:
  1. Receive a job dict from the gateway
  2. Find the best device/adapter for the job's capability type
  3. Execute the job (IPP print, Opentrons protocol, OctoPrint job, etc.)
  4. Build an evidence bundle
  5. Report evidence + status back via the gateway client
"""

import json
import logging
import os
import platform
import subprocess
import tempfile
import time
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
# IPP / printer execution
# ---------------------------------------------------------------------------

def execute_ipp_print(device: Dict, job: Dict) -> Dict[str, Any]:
    """Print a document via IPP using the system print command.

    On Linux/macOS: ``lp -h <ip> -d default <file>``
    On Windows:     ``notepad /p <file>``  (or rundll32 for images)

    Returns a result dict with printed, filepath, returncode.
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
            "printed": result.returncode == 0,
            "filepath": filepath,
            "returncode": result.returncode,
            "stdout": result.stdout[:500] if result.stdout else "",
            "stderr": result.stderr[:500] if result.stderr else "",
            "printer_ip": printer_ip,
            "printer_name": printer_name,
        }
    except subprocess.TimeoutExpired:
        return {
            "printed": False,
            "filepath": filepath,
            "error": "print command timed out",
            "printer_ip": printer_ip,
        }
    except FileNotFoundError as e:
        # lp / notepad not found -- return a soft success so tests pass
        log.warning(f"Print command not found: {e}")
        return {
            "printed": False,
            "filepath": filepath,
            "error": f"print command not available: {e}",
            "printer_ip": printer_ip,
        }
    except Exception as e:
        return {
            "printed": False,
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

EVENT_JOB_STARTED = "job_started"
EVENT_EXECUTION_COMPLETED = "execution_completed"
EVENT_EXECUTION_FAILED = "execution_failed"
EVENT_EXECUTION_UNCLASSIFIED = "execution_unclassified"

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
#   printed  -> execute_ipp_print, JobExecutor._execute_octoprint
#   executed -> JobExecutor._execute_generic_http
COMPLETION_FLAG_KEYS = ("printed", "executed")

# ACCEPTANCE flags -- the device only reported that it TOOK the request.
# Acceptance is not completion: an Opentrons run that is playing has been
# accepted and can still fail at step 40.  True here is therefore NOT a success
# (the outcome is not yet known -- fail closed); False is still a failure.
ACCEPTANCE_FLAG_KEYS = ("submitted",)

ALL_FLAG_KEYS = COMPLETION_FLAG_KEYS + ACCEPTANCE_FLAG_KEYS

# Where adapters park the device's own answer.  A 2xx is a TRANSPORT verdict,
# not the device's: transport-succeeds / application-fails is the ordinary
# instrument failure mode (JSON-RPC, SiLA, OPC-UA HTTP bridges, LabVIEW web
# services and most vendor REST answer 200 with the outcome in the body).
NESTED_RESULT_KEYS = ("response", "data", "body", "payload")

# Keys inside a device body that POSITIVELY assert a failure.
NESTED_ERROR_KEYS = ("error", "errors", "fault", "faultstring")
NESTED_FALSE_SUCCESS_KEYS = ("success", "ok", "succeeded")

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

OCTOPRINT_SUCCESS_STATUSES = (200, 201, 204)

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

    Reads POSITIVE failure signals only.  An unrecognised body yields None, so
    this never invents a failure -- and, being the only reader of a device
    body, it is the single place a new failure envelope has to be taught.
    """
    if isinstance(body, str):
        lowered = body.lower()
        for marker in FAULT_BODY_MARKERS:
            if marker in lowered:
                return f"device returned a fault body (matched {marker!r})"
        return None

    if not isinstance(body, dict):
        return None

    for key in NESTED_ERROR_KEYS:
        value = body.get(key)
        if value:
            return value if isinstance(value, str) else f"{key}={_short(value)}"

    for key in NESTED_FALSE_SUCCESS_KEYS:
        if body.get(key) is False:
            return f"device reported {key}=False"

    if _normalized_status(body) in FAILURE_STATUS_VALUES:
        return f"device reported status={body.get('status')!r}"

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


def _describe_transport_status(status: int, data: Any) -> str:
    """Failure text for an HTTP exchange that did not land in the 2xx band."""
    if status <= TRANSPORT_FAILURE_MAX_STATUS:
        nested = data.get("error") if isinstance(data, dict) else None
        return str(nested) if nested else "transport failure: device unreachable"
    return f"device returned HTTP {status}"


def _as_float(value: Any, default: float) -> float:
    """Read a numeric device-config override; fall back on anything unusable."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


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
    """Classify an adapter result as success / failure / unclassifiable.

    Pure function -- no I/O, no side effects.  Returns one of
    :data:`RESULT_SUCCESS`, :data:`RESULT_FAILURE`, :data:`RESULT_UNCLASSIFIABLE`.

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
    7.  ``status`` in :data:`SUCCESS_STATUS_VALUES`       -> success
    8.  ``status`` present as a string but unrecognised   -> unclassifiable
    9.  a :data:`COMPLETION_FLAG_KEYS` flag is present
        (and every flag passed rule 6)                     -> success
    10. anything else                                      -> unclassifiable

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
      ``{"submitted": True}`` alone falls through to rule 10 -- unclassifiable,
      which emits neither ``execution_completed`` nor ``execution_failed``.
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

    if status in SUCCESS_STATUS_VALUES:
        return RESULT_SUCCESS

    if status is not None:
        return RESULT_UNCLASSIFIABLE

    if any(key in result for key in COMPLETION_FLAG_KEYS):
        return RESULT_SUCCESS

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
    events: Optional[List[Dict]] = None,
) -> Dict[str, Any]:
    """Construct an evidence bundle from execution result.

    The synthesized event trail branches on :func:`classify_execution_result`
    (evidence contract sec-10):

    * success        -> ``execution_completed``
    * failure        -> ``execution_failed`` (never ``execution_completed``)
    * unclassifiable -> ``execution_unclassified`` -- neither of the above

    Passing ``events`` explicitly bypasses the branch entirely; that caller
    escape hatch is unchanged.
    """
    now = datetime.now(tz=timezone.utc).isoformat()
    return {
        "jobId": job_id,
        "deviceId": device.get("id", device.get("host", "unknown")),
        "deviceProtocol": device.get("protocol", device.get("type", "unknown")),
        "executedAt": now,
        "result": result,
        "events": events or _synthesize_events(device, result, now),
    }


def _synthesize_events(device: Dict, result: Any, now: str) -> List[Dict]:
    """Default event trail: ``job_started`` plus exactly ONE outcome event."""
    events: List[Dict] = [
        {
            "type": EVENT_JOB_STARTED,
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
    else:
        # Fail closed: an unrecognised result claims neither completion nor
        # failure, so no completion event exists for a verifier to release on.
        events.append(
            {
                "type": EVENT_EXECUTION_UNCLASSIFIED,
                "timestamp": now,
                "payload": {
                    "reason": UNCLASSIFIABLE_REASON,
                    "result": result,
                },
            }
        )

    return events


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
        """Execute a job dict.  Returns the evidence bundle or error dict."""
        job_id = job.get("id", f"job-{int(time.time())}")
        capability_type = job.get("capabilityType") or job.get("capability_type", "generic")

        log.info(f"Executing job {job_id} (capability: {capability_type})")

        if self.gateway:
            self.gateway.update_job_status(job_id, "running")

        try:
            device = self._find_device(job)
            if device is None:
                error_result = {
                    "status": "failed",
                    "error": "no_device_found",
                    "capabilityType": capability_type,
                }
                if self.gateway:
                    self.gateway.update_job_status(
                        job_id, "failed", {"error": "no_device_found"}
                    )
                return error_result

            result = self._execute_on_device(device, job)
            verdict = classify_execution_result(result)
            evidence = build_evidence_bundle(job_id, device, result)
            device_label = device.get("id", "?")

            if self.gateway:
                # Evidence is pushed for every outcome -- a failed run must
                # still reach the verifier so that it can dispute.
                self.gateway.push_evidence(job_id, evidence)

                if verdict == RESULT_SUCCESS:
                    self.gateway.update_job_status(job_id, "completed", result)
                elif verdict == RESULT_FAILURE:
                    self._report_terminal_failure(
                        job_id,
                        {
                            "error": describe_execution_failure(result),
                            "result": result,
                        },
                    )
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
                self.gateway.update_job_status(job_id, "failed", error_info)
            return error_info

    def _report_terminal_failure(self, job_id: str, metadata: Dict) -> bool:
        """Report a job failed, and say so loudly when the report does not land.

        ``update_job_status`` returns False after a bare ``log.warning`` when
        the gateway rejects the PATCH (ws_client.py), and every other call site
        in this module discards that return.  A dropped 'failed' report leaves
        the job non-terminal, which matters beyond this node: the gateway's own
        completion route is gated on the job not already being 'failed'.

        This does NOT close that hole -- it makes it observable rather than
        silent.  Closing it needs a retry/outbox here or a change on the
        gateway side, neither of which is in this module's scope.
        """
        acknowledged = bool(
            self.gateway.update_job_status(job_id, "failed", metadata)
        )
        if not acknowledged:
            log.error(
                "Job %s: the gateway did not acknowledge the 'failed' status "
                "report; the job may still look non-terminal upstream "
                "(reason: %s)",
                job_id,
                metadata.get("error"),
            )
        return acknowledged

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

        if run_status in OPENTRONS_TERMINAL_FAILURE or run_errors:
            reason = (
                f"run reported {len(run_errors)} protocol error(s): "
                f"{_short(run_errors)}"
                if run_errors
                else f"run finished with status {run_status!r}"
            )
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
            status, body = http(
                "GET", f"{base_url}/runs/{run_id}", headers=headers, verify_ssl=False
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

        ``printed`` reads the device's answer, not just the status line, for
        the same reason as :meth:`_execute_generic_http`: OctoPrint answering
        200/204 means the API accepted ``select + print``, and a printer that
        replies ``{"error": "E_JAM: carriage jam, job aborted"}`` in a 200 body
        has failed.  A failure stated in the body outranks the status code.
        """
        from .http_util import http

        base_url = device.get("url") or f"http://{device.get('host', 'localhost')}:5000"
        api_key = device.get("api_key") or device.get("apiKey", "")
        params = job.get("parameters", {})
        filename = params.get("filename", "")

        headers = {}
        if api_key:
            headers["X-Api-Key"] = api_key

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
            "printed": transport_ok and device_error is None,
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

        result: Dict[str, Any] = {
            "executed": transport_ok and device_error is None,
            "status_code": status,
            "response": data,
            "device": base_url,
        }
        if device_error is not None:
            result["error"] = device_error
        elif not transport_ok:
            result["error"] = _describe_transport_status(status, data)
        return result
