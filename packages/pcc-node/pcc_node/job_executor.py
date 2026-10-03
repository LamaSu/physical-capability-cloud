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
# Evidence builder
# ---------------------------------------------------------------------------

def build_evidence_bundle(
    job_id: str,
    device: Dict,
    result: Dict,
    events: Optional[List[Dict]] = None,
) -> Dict[str, Any]:
    """Construct an evidence bundle from execution result."""
    now = datetime.now(tz=timezone.utc).isoformat()
    return {
        "jobId": job_id,
        "deviceId": device.get("id", device.get("host", "unknown")),
        "deviceProtocol": device.get("protocol", device.get("type", "unknown")),
        "executedAt": now,
        "result": result,
        "events": events or [
            {
                "type": "job_started",
                "timestamp": now,
                "payload": {"deviceId": device.get("id", "unknown")},
            },
            {
                "type": "execution_completed",
                "timestamp": now,
                "payload": result,
            },
        ],
    }


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
