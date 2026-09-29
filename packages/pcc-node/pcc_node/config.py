"""Node configuration -- generate, save, load.

A NodeConfig captures everything needed to run a PCC node:
kernel identity, PCC gateway location, devices (with each device's declared
terms), approval policy, camera, and poll intervals.
"""

import json
import os
import hashlib
import time
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any

from .declared_terms import announcement_plan


@dataclass
class NodeConfig:
    """Configuration for a PCC node."""

    kernel_id: str = ""
    kernel_name: str = ""
    pcc_base: str = "https://capability.network"
    pcc_api_key: str = ""
    devices: List[Dict[str, Any]] = field(default_factory=list)
    approval_mode: str = "manual"  # manual | auto | policy
    # No kernel-wide "pricing" any more: it defaulted to {"base": 10,
    # "per_minute": 0.15}, a price nobody declared, and the gateway never read
    # it.  Terms are declared per device ("assuranceTiers", "pricing" in a
    # devices entry; pcc_node.declared_terms).  An old file's "pricing" is
    # ignored on load (from_dict drops unknown keys).
    camera_device: str = ""
    camera_push_interval: int = 50  # seconds
    poll_interval: int = 5  # seconds
    public_key: str = ""
    # Auto-diagnostic feedback: send encrypted bundles when the daemon hits
    # repeated errors or on a periodic schedule. Default is "errors" so the
    # PCC team automatically gets a crash report when something goes wrong —
    # the first-run banner in `pcc-node start` explains this and lets the
    # operator opt out via `pcc-node feedback off`.
    # "off" = never, "errors" = on repeated errors (default), "periodic" = every N hours
    diagnostics_mode: str = "errors"
    diagnostics_interval_hours: int = 24  # for "periodic" mode

    def to_dict(self) -> dict:
        """Serialize to a plain dict (JSON-safe)."""
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "NodeConfig":
        """Deserialize from a dict, ignoring unknown keys."""
        known = {f.name for f in cls.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        filtered = {k: v for k, v in d.items() if k in known}
        return cls(**filtered)


def _generate_kernel_id() -> str:
    """Generate a short deterministic-ish kernel ID."""
    seed = f"{os.getpid()}-{time.time()}-{os.urandom(8).hex()}"
    h = hashlib.sha256(seed.encode()).hexdigest()[:12]
    return f"kernel-{h}"


def generate_config(devices: list) -> NodeConfig:
    """Generate a NodeConfig from a list of detected devices.

    Picks the first camera device for camera_device, infers a kernel name
    from the primary device type, and generates a unique kernel ID.
    """
    kernel_id = _generate_kernel_id()

    # Pick a human-friendly name based on detected equipment
    primary_types = [d.get("type", "") for d in devices]
    if "opentrons" in primary_types:
        kernel_name = "liquid-handler-node"
    elif "octoprint" in primary_types:
        kernel_name = "3d-printer-node"
    elif "camera" in primary_types:
        kernel_name = "camera-node"
    elif "serial" in primary_types:
        kernel_name = "serial-device-node"
    else:
        kernel_name = "pcc-node"

    # Pick camera device
    camera = ""
    for d in devices:
        if d.get("type") == "camera":
            camera = d.get("path", "")
            break

    return NodeConfig(
        kernel_id=kernel_id,
        kernel_name=kernel_name,
        devices=devices,
        camera_device=camera,
    )


def _device_identity(device: Dict[str, Any]) -> set:
    """What makes two device entries the same device: an id, a url, a host/ip."""
    found = set()
    for kind, value in (
        ("id", device.get("id")),
        ("url", device.get("url")),
        ("host", device.get("host") or device.get("ip")),
    ):
        if isinstance(value, str) and value:
            found.add((kind, value))
    return found


def merge_detected_devices(configured: List[Dict[str, Any]], detected: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The operator's configured devices, plus each detected device that none
    of them already describes.

    Configured entries are authoritative and kept whole, whether or not
    detection saw them this time: they carry what only the operator can say,
    such as a device's declared terms (``assuranceTiers``, ``pricing``; see
    pcc_node.declared_terms).  ``pcc-node start`` used to REPLACE them with
    the freshly detected devices, which would have erased every declaration
    on the next start.  A detected device matches a configured one when they
    share an id, a url or a host/ip.
    """
    merged = [dict(device) for device in configured]
    seen = set()
    for device in merged:
        seen |= _device_identity(device)
    for device in detected:
        identity = _device_identity(device)
        if identity & seen:
            continue
        merged.append(device)
        seen |= identity
    return merged


def save_config(config: NodeConfig, path: str = "./pcc-node.json") -> str:
    """Save config to a JSON file.  Returns the absolute path written."""
    abs_path = os.path.abspath(path)
    with open(abs_path, "w") as f:
        json.dump(config.to_dict(), f, indent=2)
    return abs_path


def load_config(path: str = "./pcc-node.json") -> NodeConfig:
    """Load config from a JSON file.

    Raises FileNotFoundError if the file does not exist, and
    DeclaredTermsError (a ValueError) when a device's declared terms are
    malformed or two devices offer one capability type under different
    terms: declared terms are checked when the config loads, with the device
    and the field named, never skipped silently (board N23, #3560).
    """
    abs_path = os.path.abspath(path)
    with open(abs_path) as f:
        data = json.load(f)
    config = NodeConfig.from_dict(data)
    announcement_plan(config.devices)
    return config
