"""Node configuration -- generate, save, load.

A NodeConfig captures everything needed to run a PCC node:
kernel identity, PCC gateway location, detected devices, approval policy,
pricing, camera, and poll intervals.
"""

import json
import os
import hashlib
import time
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any


@dataclass
class NodeConfig:
    """Configuration for a PCC node."""

    kernel_id: str = ""
    kernel_name: str = ""
    pcc_base: str = "https://capability.network"
    pcc_api_key: str = ""
    devices: List[Dict[str, Any]] = field(default_factory=list)
    approval_mode: str = "manual"  # manual | auto | policy
    pricing: Dict[str, Any] = field(
        default_factory=lambda: {"base": 10, "per_minute": 0.15}
    )
    camera_device: str = ""
    camera_push_interval: int = 50  # seconds
    poll_interval: int = 5  # seconds
    public_key: str = ""
    # Opt-in diagnostic feedback: automatically send diagnostic bundles
    # when errors occur or on a periodic schedule.
    # "off" = never (default), "errors" = on repeated errors, "periodic" = every N hours
    diagnostics_mode: str = "off"
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


def save_config(config: NodeConfig, path: str = "./pcc-node.json") -> str:
    """Save config to a JSON file.  Returns the absolute path written."""
    abs_path = os.path.abspath(path)
    with open(abs_path, "w") as f:
        json.dump(config.to_dict(), f, indent=2)
    return abs_path


def load_config(path: str = "./pcc-node.json") -> NodeConfig:
    """Load config from a JSON file.

    Raises FileNotFoundError if the file does not exist.
    """
    abs_path = os.path.abspath(path)
    with open(abs_path) as f:
        data = json.load(f)
    return NodeConfig.from_dict(data)
