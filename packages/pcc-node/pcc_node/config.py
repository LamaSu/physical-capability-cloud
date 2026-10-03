"""Node configuration -- generate, save, load.

A NodeConfig captures everything needed to run a PCC node:
kernel identity, PCC gateway location, detected devices, approval policy,
pricing, camera, and poll intervals.
"""

import errno
import json
import logging
import os
import hashlib
import stat
import time
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any

log = logging.getLogger("pcc-node.config")

_POSIX = os.name != "nt"
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)

_WINDOWS_REFUSAL = (
    "pcc-node 0.1.1 does not use a config file on Windows: it cannot yet make the file private there, "
    "and a config decides where your API key is sent. Run the node on Linux or macOS (WSL works)."
)


class ConfigFileError(Exception):
    """The config file exists but must not be used as it is."""


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


def save_config(config: NodeConfig, path: str = "./pcc-node.json") -> str:
    """Save config to a JSON file.  Returns the absolute path written.

    The config carries ``pcc_api_key``, so the file is created owner-only
    (0600) whatever the umask. It is written to a new temporary file beside
    the target and renamed over it: an existing readable config, or a symlink
    at *path*, is replaced rather than written through, and a failed write
    leaves the old config (or nothing) instead of a partial file.

    On Windows every config is refused with ConfigFileError: the file cannot
    yet be made private there (verdicts 105c and 105d, finding 3).
    """
    if not _POSIX:
        raise ConfigFileError(_WINDOWS_REFUSAL)
    data = config.to_dict()
    abs_path = os.path.abspath(path)
    directory = os.path.dirname(abs_path)
    tmp_path = os.path.join(directory, f".{os.path.basename(abs_path)}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, abs_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise
    return abs_path


def load_config_data(path: str = "./pcc-node.json") -> dict:
    """The config file's JSON object, read through one checked descriptor.

    Raises FileNotFoundError if the file does not exist, and ValueError if it
    is not JSON. The file is read through one no-follow descriptor, so a
    symlink is refused, and it must be a regular file holding a JSON object.

    A config decides where the operator's key is sent (its pcc_base), so it
    must belong to this account, and no other user may be able to write it.
    That holds even when the file holds no key. A writable file is refused,
    not repaired: fchmod would not revoke a descriptor another account
    already holds open, and the contents may already be someone else's
    (verdict 105c, finding 5). A key-bearing config that others could only
    read is restricted to 0600 before use, and the operator is told to rotate
    the key (verdict 105b, finding 7).

    On Windows every config is refused, before the file is opened: even a
    keyless one names the gateway a key given on the command line is sent to,
    and another account could rewrite it (verdict 105d).
    ConfigFileError says why a config was refused; the key is never printed.
    """
    if not _POSIX:
        raise ConfigFileError(_WINDOWS_REFUSAL)
    abs_path = os.path.abspath(path)
    try:
        fd = os.open(abs_path, os.O_RDONLY | _NOFOLLOW | _CLOEXEC)
    except OSError as exc:
        # open(O_NOFOLLOW) on a symlink fails with ELOOP (Linux, macOS) or EMLINK (FreeBSD).
        if exc.errno in (errno.ELOOP, errno.EMLINK):
            raise ConfigFileError(f"{abs_path} is a symbolic link: point pcc-node at the file itself") from None
        raise
    with os.fdopen(fd, "r") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise ConfigFileError(f"{abs_path} is not a regular file")
        data = json.load(f)
        if not isinstance(data, dict):
            raise ConfigFileError(f"{abs_path} is not a pcc-node config: it is not a JSON object")
        if st.st_uid != os.getuid():
            raise ConfigFileError(f"{abs_path} is owned by another account (uid {st.st_uid})")
        mode = st.st_mode & 0o777
        if mode & 0o022:
            raise ConfigFileError(
                f"{abs_path} can be written by other users (mode {oct(mode)}). Another account may "
                f"already hold it open, so restricting it now would not stop changes, and it may "
                f"already have been changed. Check its contents, then write it to a new file, for "
                f"example: cp {abs_path} {abs_path}.new && chmod 600 {abs_path}.new && "
                f"mv {abs_path}.new {abs_path}. If it holds an API key, rotate the key."
            )
        if mode & 0o077 and _holds_a_key(data):
            os.fchmod(f.fileno(), 0o600)
            log.warning(
                "%s holds an API key and other users could read it (mode %s). It is now 0600; "
                "rotate the key if other accounts on this machine may have read it.", abs_path, oct(mode),
            )
    return data


def load_config(path: str = "./pcc-node.json") -> NodeConfig:
    """Load the config at *path*: load_config_data's checks, as a NodeConfig."""
    return NodeConfig.from_dict(load_config_data(path))


def _holds_a_key(data: dict) -> bool:
    """True if the config carries the PCC API key or a device's own API key."""
    if data.get("pcc_api_key"):
        return True
    devices = data.get("devices") or []
    return any(isinstance(d, dict) and (d.get("api_key") or d.get("apiKey")) for d in devices)
