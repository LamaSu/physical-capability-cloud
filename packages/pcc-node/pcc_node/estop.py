"""Emergency stop on the node (ADK track item 9).

The gateway records an operator's emergency stop as ``emergencyStop`` on the
kernel's operator policy. It is set with POST /api/operator/emergency-stop and
read with GET /api/operator/policy/:kernelId. The gateway then stops admitting
new jobs, but the node used to ignore the flag: a job it had already been sent
still ran, and no device was told to stop.

The daemon asks EStopGuard.check() once per loop, before it takes a job:

- ``active``: the node takes no job. On entering this state it sends each
  device its adapter's stop command, where the adapter has one, and it retries
  the devices whose stop failed on later loops.
- ``unknown`` (the flag could not be read): the node takes no job this loop,
  so admission fails closed. Devices are not stopped over a network blip.
- ``clear``: normal operation.

A remote stop is best effort. It does not replace the device's physical
emergency stop.
"""

import logging
from urllib.parse import quote

from .http_util import http, pcc_request

log = logging.getLogger("pcc-node.estop")

ACTIVE = "active"
CLEAR = "clear"
UNKNOWN = "unknown"

# Outcomes of stopping one device.
STOPPED = "stopped"          # the device accepted the stop command
IDLE = "idle"                # nothing was running to stop
UNSUPPORTED = "unsupported"  # this adapter has no remote stop
FAILED = "failed"            # the stop command did not get through; retried


def read_estop(pcc_base, api_key, kernel_id, timeout=5):
    """Read this kernel's emergency-stop flag from the gateway.

    Returns (state, detail). Only a boolean flag in a readable policy counts;
    anything else is UNKNOWN.
    """
    path = f"/api/operator/policy/{quote(str(kernel_id), safe='')}"
    status, body = pcc_request("GET", path, base_url=pcc_base, api_key=api_key, timeout=timeout)
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get("policy"), dict):
        return UNKNOWN, f"policy read failed (HTTP {status})"
    flag = body["policy"].get("emergencyStop")
    if flag is True:
        return ACTIVE, "emergency stop is set"
    if flag is False:
        return CLEAR, "emergency stop is not set"
    return UNKNOWN, f"policy has no boolean emergencyStop ({type(flag).__name__})"


def _base_url(device, default_port):
    url = device.get("url") or device.get("baseUrl")
    if url:
        return str(url).rstrip("/")
    host = device.get("host") or device.get("address") or device.get("ip")
    if not host:
        return ""
    return f"http://{host}:{device.get('port') or default_port}"


def _stop_octoprint(device, timeout):
    base = _base_url(device, 5000)
    if not base:
        return FAILED, "no OctoPrint address"
    headers = {}
    api_key = device.get("api_key") or device.get("apiKey")
    if api_key:
        headers["X-Api-Key"] = api_key
    status, _ = http("POST", f"{base}/api/job", {"command": "cancel"}, headers, timeout=timeout)
    if status in (200, 204):
        return STOPPED, "OctoPrint job cancelled"
    if status == 409:
        return IDLE, "OctoPrint had no job to cancel"
    return FAILED, f"OctoPrint cancel returned HTTP {status}"


def _current_opentrons_run(runs_body):
    if not isinstance(runs_body, dict):
        return None
    current = (runs_body.get("links") or {}).get("current") or {}
    href = current.get("href") if isinstance(current, dict) else None
    if isinstance(href, str) and href.rstrip("/").split("/")[-1]:
        return href.rstrip("/").split("/")[-1]
    for run in runs_body.get("data") or []:
        if isinstance(run, dict) and run.get("current") is True and run.get("id"):
            return str(run["id"])
    return None


def _stop_opentrons(device, timeout):
    base = _base_url(device, 31950)
    if not base:
        return FAILED, "no Opentrons address"
    headers = {"opentrons-version": "2"}
    status, body = http("GET", f"{base}/runs", None, headers, timeout=timeout)
    if status != 200:
        return FAILED, f"Opentrons run list returned HTTP {status}"
    run_id = _current_opentrons_run(body)
    if not run_id:
        return IDLE, "Opentrons had no current run"
    status, _ = http(
        "POST",
        f"{base}/runs/{quote(run_id, safe='')}/actions",
        {"data": {"actionType": "stop"}},
        headers,
        timeout=timeout,
    )
    if status in (200, 201):
        return STOPPED, f"Opentrons run {run_id} stopped"
    if status == 409:
        return IDLE, f"Opentrons run {run_id} was not running"
    return FAILED, f"Opentrons stop returned HTTP {status}"


def _stop_declared(device, timeout):
    """A generic device that declares its own stop endpoint (stopPath)."""
    stop_path = device.get("stopPath")
    base = _base_url(device, 80)
    if not isinstance(stop_path, str) or not stop_path.startswith("/") or stop_path.startswith("//"):
        return FAILED, "stopPath must be a path that starts with one /"
    if not base.startswith(("http://", "https://")):
        return FAILED, "no http(s) address for the declared stop"
    status, _ = http("POST", f"{base}{stop_path}", {}, None, timeout=timeout)
    if 200 <= status < 300:
        return STOPPED, f"declared stop {stop_path} accepted"
    return FAILED, f"declared stop {stop_path} returned HTTP {status}"


def stop_device(device, timeout=5):
    """Send one device its adapter's stop command. Returns (outcome, detail)."""
    protocol = device.get("protocol") or device.get("type") or "generic"
    try:
        if protocol in ("octoprint", "3d-printer"):
            return _stop_octoprint(device, timeout)
        if protocol == "opentrons":
            return _stop_opentrons(device, timeout)
        if device.get("stopPath") is not None:
            return _stop_declared(device, timeout)
    except Exception as exc:  # a stop attempt must never crash the daemon
        return FAILED, f"stop raised {type(exc).__name__}"
    return UNSUPPORTED, f"no remote stop for a {protocol} device: use its physical emergency stop"


def _device_name(device, index):
    return str(device.get("id") or device.get("name") or device.get("host") or f"device-{index}")


class EStopGuard:
    """Gates job intake on the kernel's emergency-stop flag.

    ``reader`` and ``stopper`` default to read_estop and stop_device; tests
    pass their own.
    """

    def __init__(self, pcc_base, api_key, kernel_id, devices, reader=None, stopper=None):
        self._pcc_base = pcc_base
        self._api_key = api_key
        self._kernel_id = kernel_id
        self._devices = list(devices or [])
        self._reader = reader
        self._stopper = stopper
        self.state = UNKNOWN
        self._to_retry = []

    def check(self):
        """Read the flag, act on it, and say whether the node may take a job."""
        read = self._reader or read_estop
        try:
            state, detail = read(self._pcc_base, self._api_key, self._kernel_id)
        except Exception as exc:
            state, detail = UNKNOWN, f"policy read raised {type(exc).__name__}"
        if state not in (ACTIVE, CLEAR, UNKNOWN):
            state, detail = UNKNOWN, f"unexpected state {state!r}"

        if state != self.state:
            if state == ACTIVE:
                log.warning("EMERGENCY STOP for kernel %s: taking no jobs, stopping devices", self._kernel_id)
            elif state == CLEAR:
                log.info("Emergency stop clear for kernel %s: taking jobs (%s)", self._kernel_id, detail)
            else:
                log.warning("Emergency-stop state unknown for kernel %s: taking no jobs (%s)", self._kernel_id, detail)

        if state == ACTIVE and self.state != ACTIVE:
            self._to_retry = self._stop(list(enumerate(self._devices)))
        elif state == ACTIVE and self._to_retry:
            self._to_retry = self._stop(self._to_retry)
        elif state != ACTIVE:
            self._to_retry = []

        self.state = state
        return state == CLEAR

    def _stop(self, indexed_devices):
        """Stop each device; return the ones to retry."""
        stop = self._stopper or stop_device
        retry = []
        for index, device in indexed_devices:
            try:
                outcome, detail = stop(device)
            except Exception as exc:
                outcome, detail = FAILED, f"stop raised {type(exc).__name__}"
            name = _device_name(device, index)
            if outcome == FAILED:
                log.error("Emergency stop: %s NOT stopped (%s); retrying next loop", name, detail)
                retry.append((index, device))
            elif outcome == UNSUPPORTED:
                log.warning("Emergency stop: %s: %s", name, detail)
            else:
                log.warning("Emergency stop: %s %s (%s)", name, outcome, detail)
        return retry
