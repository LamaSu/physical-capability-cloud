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

import json
import logging
import subprocess
import time

from .http_util import http, pcc_request

log = logging.getLogger("pcc-node.executor")


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

def poll_pending_jobs(pcc_base, api_key, kernel_id):
    """Poll PCC for pending tool calls for this kernel.

    Returns a list of call dicts.
    """
    status, data = pcc_request(
        "GET", f"/api/ot2/tool-call/pending?kernelId={kernel_id}",
        base_url=pcc_base,
        api_key=api_key,
    )
    if status != 200:
        return []
    calls = data.get("calls", data) if isinstance(data, dict) else data
    return calls if isinstance(calls, list) else []


def execute_and_report(call, adapters, pcc_base, api_key):
    """Execute a tool call using the appropriate adapter, report result to PCC.

    Parameters
    ----------
    call : dict
        Tool call dict with id, toolName, toolArgs.
    adapters : list
        List of adapter instances.
    pcc_base : str
        PCC gateway base URL.
    api_key : str
        Bearer token.
    """
    call_id = call.get("id", "unknown")
    tool_name = call.get("toolName", "")
    tool_args = call.get("toolArgs", {})

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
        "POST", "/api/ot2/tool-result",
        body={"callId": call_id, "result": result},
        base_url=pcc_base,
        api_key=api_key,
    )
    if status != 200:
        log.error(f"Failed to post result for {call_id}: HTTP {status}")
