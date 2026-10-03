"""Generic tool executor -- polls PCC for jobs, executes locally.

Generalizes the OT-2 executor pattern to work with any device adapter.
Each adapter implements a simple interface:

    class MyAdapter:
        device_type = "opentrons"

        def execute(self, tool_name: str, tool_args: dict) -> str:
            '''Execute a tool call. Return JSON string result.'''
            ...

        def health(self) -> dict:
            '''Return device health info.'''
            ...
"""

import hashlib
import json
import logging
import os
import subprocess
import time
from datetime import datetime, timezone
from urllib.parse import quote

from .http_util import http, pcc_request

log = logging.getLogger("pcc-node.executor")


# ---------------------------------------------------------------------------
# Execution lease guard (#400 F3)
#
# Cross-family review (r5, F3, HIGH) found that the exact-SHA node checked
# only that kernelId matched, then called adapter.execute() unconditionally --
# never rechecking local e-stop, scope expiry/revocation, breaker state,
# command freshness, or execution fencing. adk (#5510) ruled the node-side fix
# is a small SELF-CONTAINED fail-closed guard right before adapter.execute(),
# reusing #471's claim-token wire shape (claim, then start with the token;
# the token is opaque to the node). The gateway half enforces the lease;
# this guard re-checks it and never actuates on doubt.
# ---------------------------------------------------------------------------

#: Default bound (seconds) on how old a poll answer may be before the call it
#: produced is refused as stale. Overridable via PCC_NODE_LEASE_FRESHNESS_S.
DEFAULT_LEASE_FRESHNESS_S = 30

#: Default local fencing directory (one attempted-call marker per call id,
#: ever). Overridable via PCC_NODE_FENCE_DIR.
DEFAULT_FENCE_DIR = os.path.join(os.path.expanduser("~"), ".pcc-node", "relay-fence")


# ---------------------------------------------------------------------------
# Device adapters
# ---------------------------------------------------------------------------

class OpentronAdapter:
    """Adapter for Opentrons OT-2 robots."""

    device_type = "opentrons"

    def __init__(self, base_url="http://localhost:31950", api_version="2"):
        self.base_url = base_url
        self.api_version = api_version

    def _ot2(self, method, path, body=None):
        url = f"{self.base_url}{path}"
        headers = {"opentrons-version": self.api_version}
        return http(method, url, body, headers, verify_ssl=False)

    def health(self):
        status, data = self._ot2("GET", "/health")
        if status == 200 and isinstance(data, dict):
            return data
        return {"error": f"health check failed (HTTP {status})"}

    def execute(self, tool_name, tool_args):
        dispatch = {
            "ot2_health": lambda a: self._ot2("GET", "/health"),
            "ot2_pipettes": lambda a: self._ot2("GET", "/pipettes"),
            "ot2_modules": lambda a: self._ot2("GET", "/modules"),
            "ot2_deck_calibration": lambda a: self._ot2("GET", "/calibration/status"),
            "ot2_pipette_offset": lambda a: self._ot2("GET", "/calibration/pipette_offset"),
            "ot2_tip_length": lambda a: self._ot2("GET", "/calibration/tip_length"),
            "ot2_protocols_list": lambda a: self._ot2("GET", "/protocols"),
            "ot2_runs_list": lambda a: self._ot2("GET", "/runs"),
            "ot2_run_create": lambda a: self._ot2(
                "POST", "/runs", {"data": {"protocolId": a["protocolId"]}}
            ),
            "ot2_run_action": lambda a: self._ot2(
                "POST", f"/runs/{a['runId']}/actions",
                {"data": {"actionType": a["action"]}},
            ),
            "ot2_run_status": lambda a: self._ot2("GET", f"/runs/{a['runId']}"),
            "ot2_lights": lambda a: self._ot2(
                "POST", "/robot/lights", {"on": a.get("on", True)}
            ),
            "ot2_home": lambda a: self._ot2(
                "POST", "/robot/home",
                {"target": "robot"} if not a.get("axes") else
                {"target": "robot", "axes": a["axes"]},
            ),
            "ot2_identify": lambda a: self._ot2(
                "POST", f"/identify?seconds={a.get('seconds', 5)}"
            ),
        }

        handler = dispatch.get(tool_name)
        if handler:
            _status, result = handler(tool_args)
            return json.dumps(result, indent=2)

        if tool_name == "ot2_shell":
            return self._shell(tool_args)

        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    def _shell(self, args):
        cmd = args.get("command", "")
        timeout = args.get("timeout", 30)
        try:
            r = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout,
            )
            return json.dumps({
                "exit_code": r.returncode,
                "output": (r.stdout + r.stderr)[:4000],
            })
        except subprocess.TimeoutExpired:
            return json.dumps({"error": "command timed out"})
        except Exception as e:
            return json.dumps({"error": str(e)})


class OctoPrintAdapter:
    """Adapter for OctoPrint-controlled 3D printers."""

    device_type = "octoprint"

    def __init__(self, base_url="http://localhost:5000", api_key=""):
        self.base_url = base_url
        self.api_key = api_key

    def _op(self, method, path, body=None):
        url = f"{self.base_url}{path}"
        headers = {}
        if self.api_key:
            headers["X-Api-Key"] = self.api_key
        return http(method, url, body, headers, verify_ssl=False)

    def health(self):
        status, data = self._op("GET", "/api/version")
        if status == 200 and isinstance(data, dict):
            return data
        return {"error": f"health check failed (HTTP {status})"}

    def execute(self, tool_name, tool_args):
        dispatch = {
            "octoprint_version": lambda a: self._op("GET", "/api/version"),
            "octoprint_connection": lambda a: self._op("GET", "/api/connection"),
            "octoprint_state": lambda a: self._op("GET", "/api/printer"),
            "octoprint_job": lambda a: self._op("GET", "/api/job"),
            "octoprint_files": lambda a: self._op("GET", "/api/files"),
            "octoprint_print": lambda a: self._op(
                "POST", f"/api/files/local/{a['filename']}",
                {"command": "select", "print": True},
            ),
            "octoprint_cancel": lambda a: self._op(
                "POST", "/api/job", {"command": "cancel"}
            ),
            "octoprint_pause": lambda a: self._op(
                "POST", "/api/job",
                {"command": "pause", "action": a.get("action", "toggle")},
            ),
        }

        handler = dispatch.get(tool_name)
        if handler:
            _status, result = handler(tool_args)
            return json.dumps(result, indent=2)

        return json.dumps({"error": f"Unknown tool: {tool_name}"})


class GenericHTTPAdapter:
    """Fallback adapter for generic HTTP-accessible devices."""

    device_type = "generic"

    def __init__(self, base_url=""):
        self.base_url = base_url

    def health(self):
        if not self.base_url:
            return {"error": "no base_url configured"}
        status, data = http("GET", self.base_url, verify_ssl=False)
        return {"status": status, "reachable": status > 0}

    def execute(self, tool_name, tool_args):
        # Generic passthrough: tool_args must contain method, path, body
        method = tool_args.get("method", "GET")
        path = tool_args.get("path", "/")
        body = tool_args.get("body")
        url = f"{self.base_url}{path}" if self.base_url else path
        status, result = http(method, url, body, verify_ssl=False)
        return json.dumps({"status": status, "result": result}, indent=2)


# ---------------------------------------------------------------------------
# Adapter factory
# ---------------------------------------------------------------------------

def create_adapter(device):
    """Create the appropriate adapter for a detected device.

    Parameters
    ----------
    device : dict
        A device dict from detect_all().

    Returns
    -------
    adapter instance or None
    """
    dtype = device.get("type", "")

    if dtype == "opentrons":
        url = device.get("url", "http://localhost:31950")
        return OpentronAdapter(base_url=url)

    if dtype == "octoprint":
        url = device.get("url", "http://localhost:5000")
        return OctoPrintAdapter(base_url=url)

    if dtype in ("serial", "mdns"):
        url = device.get("url", "")
        if url:
            return GenericHTTPAdapter(base_url=url)

    return None


# ---------------------------------------------------------------------------
# Job polling + execution
# ---------------------------------------------------------------------------

def relay_path(kernel_id, suffix):
    """/api/relay/<kernel>/<suffix>, with the kernel id encoded as one path segment."""
    return f"/api/relay/{quote(str(kernel_id), safe='')}{suffix}"


def poll_pending_jobs(pcc_base, api_key, kernel_id):
    """Poll PCC for pending tool calls for this kernel.

    Uses the device relay (/api/relay/:kernelId); the legacy /api/ot2 relay is
    retired (N4b-gw). The key must be the kernel operator's.

    Sends X-PCC-Lease: 1 (#400 F3): a lease-enforcing gateway only hands out
    claimTokens to pollers that send this header. Each returned call is
    stamped with the time.monotonic() this answer arrived (call["_receivedAt"])
    so acquire_execution_lease can later judge its freshness; this stamp is
    local bookkeeping only and must never be sent back to the gateway.

    Returns a list of call dicts.
    """
    status, data = pcc_request(
        "GET", relay_path(kernel_id, "/tool-call/pending"),
        base_url=pcc_base,
        api_key=api_key,
        headers={"X-PCC-Lease": "1"},
    )
    if status != 200:
        return []
    calls = data.get("calls", data) if isinstance(data, dict) else data
    calls = calls if isinstance(calls, list) else []
    received_at = time.monotonic()
    for call in calls:
        if isinstance(call, dict):
            call["_receivedAt"] = received_at
    return calls


def _require_kernel_id(kernel_id):
    if not isinstance(kernel_id, str) or not kernel_id:
        raise ValueError("the kernel id this node polled is required: a call runs only for that kernel")
    return kernel_id


def _lease_freshness_bound_s():
    """The freshness bound (seconds) and whether it could be established.

    (bound, True) on the default or a validly-overridden bound.
    (None, False) when PCC_NODE_LEASE_FRESHNESS_S is set but does not parse
    as a positive, finite number: the caller must fail closed (refuse) rather
    than guess at a bound it cannot trust.
    """
    raw = os.environ.get("PCC_NODE_LEASE_FRESHNESS_S")
    if raw is None:
        return DEFAULT_LEASE_FRESHNESS_S, True
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        return None, False
    if parsed != parsed:  # NaN
        return None, False
    if not (0 < parsed < float("inf")):
        return None, False
    return parsed, True


def _resolve_fence_dir(fence_dir=None):
    if fence_dir:
        return fence_dir
    return os.environ.get("PCC_NODE_FENCE_DIR") or DEFAULT_FENCE_DIR


def acquire_execution_lease(call, pcc_base, api_key, kernel, fence_dir=None):
    """Fail-closed guard run BEFORE any adapter is touched (#400 F3).

    Self-contained so #471's job-execution path can reuse it directly later.
    Re-checks, in order, that this node may actually run `call`:

      a. a non-empty string "claimToken" is present (an old, lease-less
         gateway gets no actuation);
      b. the poll answer that produced this call is still fresh;
      c. this node has not already attempted this exact call id, ever
         (local fencing, independent of the gateway's own state);
      d. the gateway grants a lease for it right now -- re-checking e-stop,
         scope, budget, breaker and the claim's age server-side.

    Returns (ok, report_error):
      (True, None)         -- leased; the caller may run the adapter.
      (False, "<reason>")  -- refused; report "<reason>" via tool-result so
                               the gateway can close the call.
      (False, None)        -- refused silently; do NOT report. Either the
                               gateway already closed this call (409/404), or
                               an earlier attempt on this node already
                               reported it (the fence).
    """
    call_id = call.get("id", "unknown")

    # (a) claim token: missing means a gateway without leases. Fail closed.
    claim_token = call.get("claimToken")
    if not isinstance(claim_token, str) or not claim_token:
        return False, "not_executed:no_lease"

    # (b) freshness: an untrustworthy configured bound is itself a reason to
    # refuse -- we cannot tell whether the call is fresh, so treat it as
    # stale rather than guess.
    freshness_s, freshness_ok = _lease_freshness_bound_s()
    if not freshness_ok:
        log.error(
            "PCC_NODE_LEASE_FRESHNESS_S does not parse as a positive, finite "
            "number; refusing to start the execution-lease guard (fail closed)"
        )
        return False, "not_executed:stale"

    received_at = call.get("_receivedAt")
    if isinstance(received_at, bool) or not isinstance(received_at, (int, float)):
        # No receipt time recorded for this call: cannot prove freshness.
        return False, "not_executed:stale"
    if (time.monotonic() - received_at) > freshness_s:
        return False, "not_executed:stale"

    # (c) local fencing: one attempt per call id, ever, on this node. The
    # marker is created BEFORE the lease request below, so a crash after a
    # granted lease never re-runs the call here.
    fdir = _resolve_fence_dir(fence_dir)
    try:
        os.makedirs(fdir, mode=0o700, exist_ok=True)
        os.chmod(fdir, 0o700)
    except OSError as e:
        log.error(f"Cannot create fence dir {fdir!r} for call {call_id}: {e}")
        return False, "not_executed:fence_unavailable"

    fence_name = hashlib.sha256(str(call_id).encode("utf-8")).hexdigest()
    fence_path = os.path.join(fdir, fence_name)
    try:
        fd = os.open(fence_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        # This node already attempted this call: the first attempt reported
        # it (or the gateway already closed it). Refuse silently.
        log.info(f"Call {call_id} already attempted on this node; refusing (fenced)")
        return False, None
    except OSError as e:
        log.error(f"Cannot create fence marker for call {call_id}: {e}")
        return False, "not_executed:fence_unavailable"

    try:
        with os.fdopen(fd, "w") as f:
            f.write(f"{call_id} {datetime.now(timezone.utc).isoformat()}\n")
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError as e:
                # Best effort: the gateway's executing state is the primary
                # guard, so a failed fsync is logged, not fatal.
                log.warning(f"fsync of fence marker for {call_id} failed (best effort): {e}")
    except OSError as e:
        # The marker file already exists (O_CREAT|O_EXCL succeeded above) --
        # its content is debug-only, so a write failure here is likewise
        # non-fatal.
        log.warning(f"Writing fence marker content for {call_id} failed (best effort): {e}")

    # (d) the lease itself: a short timeout, never retried here. Run only on
    # 200 with a JSON body whose "started" is exactly true.
    start_path = relay_path(kernel, f"/tool-call/{quote(str(call_id), safe='')}/start")
    try:
        status, data = pcc_request(
            "POST", start_path,
            body={"claimToken": claim_token},
            base_url=pcc_base, api_key=api_key, timeout=10,
        )
    except Exception as e:
        log.warning(f"Lease request transport error for call {call_id}: {e}")
        return False, "not_executed:lease_unavailable"

    if status == 409:
        log.info(f"Lease refused for call {call_id} (409 lease_refused): {data!r}")
        return False, None
    if status == 404:
        log.info(f"Lease refused for call {call_id} (404): the gateway doesn't know this call")
        return False, None
    if status == 200 and isinstance(data, dict) and data.get("started") is True:
        return True, None

    # 503 policy_unavailable, any other status, a transport error (status 0,
    # as http_util reports it) or a 200 whose body doesn't carry
    # started===true (a malformed/ambiguous grant -- the gateway's contract
    # promises 200 implies started:true, so this should not happen; fail
    # closed and report it the same way so the gateway can still close the
    # call rather than leave it stuck).
    log.warning(f"Lease not granted for call {call_id}: HTTP {status} {data!r}")
    return False, "not_executed:lease_unavailable"


def execute_and_report(call, adapters, pcc_base, api_key, kernel_id):
    """Execute a tool call using the appropriate adapter, report result to PCC.

    Parameters
    ----------
    call : dict
        Tool call dict with id, kernelId, toolName and args, as the device
        relay's pending list returns it.
    adapters : list
        List of adapter instances.
    pcc_base : str
        PCC gateway base URL.
    api_key : str
        Bearer token (the kernel operator's).
    kernel_id : str
        The kernel this node polled (required). A call runs only for it: one that
        names a different kernel is refused before any adapter is touched, and
        the result is reported to this kernel's relay path.

    Returns True when the call ran, False when it was refused.
    """
    kernel = _require_kernel_id(kernel_id)
    call_id = call.get("id", "unknown")
    tool_name = call.get("toolName", "")
    # The relay names the arguments "args"; older payloads used "toolArgs".
    tool_args = call.get("args", call.get("toolArgs", {}))

    # Decide BEFORE touching the device: a call for another kernel never runs here.
    stated = call.get("kernelId")
    if stated is not None and stated != kernel:
        log.error(f"Call {call_id} names kernel {stated!r}, not the polled {kernel!r}; refusing it")
        return False

    # #400 F3: re-check the execution lease BEFORE any adapter is touched.
    leased, report_error = acquire_execution_lease(call, pcc_base, api_key, kernel)
    if not leased:
        if report_error:
            r_status, _r_data = pcc_request(
                "POST", relay_path(kernel, "/tool-result"),
                body={"callId": call_id, "error": report_error},
                base_url=pcc_base,
                api_key=api_key,
            )
            if r_status != 200:
                log.error(f"Failed to report lease refusal for {call_id}: HTTP {r_status}")
        else:
            log.info(f"Call {call_id} refused (lease); nothing reported")
        return False

    log.info(f"Executing {tool_name}({json.dumps(tool_args)[:100]}) [call={call_id}]")

    # Try each adapter until one handles it
    result = json.dumps({"error": f"No adapter for tool: {tool_name}"})
    for adapter in adapters:
        try:
            r = adapter.execute(tool_name, tool_args)
            parsed = json.loads(r)
            if "error" not in parsed or not parsed["error"].startswith("Unknown tool"):
                result = r
                break
        except Exception as e:
            log.warning(f"Adapter {adapter.device_type} error: {e}")
            continue

    log.info(f"Result: {result[:200]}")

    # Post result back to PCC
    status, _data = pcc_request(
        "POST", relay_path(kernel, "/tool-result"),
        body={"callId": call_id, "result": result},
        base_url=pcc_base,
        api_key=api_key,
    )
    if status != 200:
        log.error(f"Failed to post result for {call_id}: HTTP {status}")
    return True


def run_pending_once(adapters, pcc_base, api_key, kernel_id):
    """Poll this kernel's pending calls and execute each one, bound to the same kernel.

    This is the path from polling to execution: the kernel that was polled is the
    only kernel a call may run for, whatever the response says. Returns
    ``(executed, refused)``.
    """
    kernel = _require_kernel_id(kernel_id)
    executed = refused = 0
    for call in poll_pending_jobs(pcc_base, api_key, kernel):
        if isinstance(call, dict) and execute_and_report(call, adapters, pcc_base, api_key, kernel):
            executed += 1
        else:
            refused += 1
    return executed, refused
