"""Hardware auto-detection.

Scans for:
  - V4L2 cameras (/dev/video*, Linux only)
  - Opentrons OT-2 robots (HTTP health endpoint)
  - Serial ports (/dev/ttyUSB*, /dev/ttyACM*, Linux/macOS)
  - OctoPrint instances (HTTP API)
  - mDNS network instruments (requires optional zeroconf)

All probes are best-effort: missing tools or unreachable devices are skipped.
"""

import glob as globmod
import os
import platform
import subprocess
import logging

from .http_util import http

log = logging.getLogger("pcc-node.detect")


# ---------------------------------------------------------------------------
# V4L2 Cameras (Linux only)
# ---------------------------------------------------------------------------

def probe_v4l2(device_path):
    """Probe a /dev/video* device via v4l2-ctl.

    Returns a dict with device info or None if not a capture device.
    """
    try:
        r = subprocess.run(
            ["v4l2-ctl", "--device", device_path, "--all"],
            capture_output=True, text=True, timeout=3,
        )
        if r.returncode != 0 or "Video Capture" not in r.stdout:
            return None

        info = {"name": "", "formats": []}

        for line in r.stdout.splitlines():
            line = line.strip()
            if line.startswith("Card type"):
                info["name"] = line.split(":", 1)[1].strip()
            # Detect supported pixel formats
            if "MJPG" in line or "Motion-JPEG" in line:
                if "MJPEG" not in info["formats"]:
                    info["formats"].append("MJPEG")
            if "H264" in line or "H.264" in line:
                if "H264" not in info["formats"]:
                    info["formats"].append("H264")
            if "YUYV" in line:
                if "YUYV" not in info["formats"]:
                    info["formats"].append("YUYV")

        return info
    except FileNotFoundError:
        # v4l2-ctl not installed -- treat device as present but unverified
        return {"name": "unknown (v4l2-ctl not available)", "formats": []}
    except subprocess.TimeoutExpired:
        return None


def detect_cameras():
    """Detect V4L2 cameras. Linux only; returns [] on other platforms."""
    if platform.system() != "Linux":
        return []

    devices = []
    paths = sorted(globmod.glob("/dev/video*"))
    for path in paths:
        info = probe_v4l2(path)
        if info is not None:
            devices.append({
                "type": "camera",
                "path": path,
                "name": info.get("name", ""),
                "formats": info.get("formats", []),
            })
    return devices


# ---------------------------------------------------------------------------
# Opentrons OT-2
# ---------------------------------------------------------------------------

OT2_PROBE_URLS = [
    "http://localhost:31950",
    "http://169.254.31.60:31950",
]


def check_opentrons(url):
    """Check for an Opentrons OT-2 at the given URL.

    Returns a dict with robot info or None.
    """
    try:
        status, data = http("GET", f"{url}/health", timeout=5, verify_ssl=False)
        if status != 200 or not isinstance(data, dict):
            return None
        return {
            "name": data.get("name", ""),
            "api_version": data.get("api_version", ""),
            "fw_version": data.get("fw_version", ""),
            "robot_model": data.get("robot_model", ""),
        }
    except Exception:
        return None


def detect_opentrons():
    """Probe common Opentrons OT-2 endpoints."""
    devices = []
    for url in OT2_PROBE_URLS:
        info = check_opentrons(url)
        if info:
            devices.append({
                "type": "opentrons",
                "url": url,
                **info,
            })
    return devices


# ---------------------------------------------------------------------------
# Serial ports (potential 3D printers, CNC, lab instruments)
# ---------------------------------------------------------------------------

def detect_serial():
    """Detect serial ports. Linux/macOS only."""
    if platform.system() == "Windows":
        # On Windows we could scan COM ports, but skip for now
        return []

    devices = []
    patterns = ["/dev/ttyUSB*", "/dev/ttyACM*"]
    if platform.system() == "Darwin":
        patterns.append("/dev/tty.usb*")

    for pattern in patterns:
        for port in sorted(globmod.glob(pattern)):
            devices.append({
                "type": "serial",
                "path": port,
                "name": os.path.basename(port),
            })
    return devices


# ---------------------------------------------------------------------------
# OctoPrint (3D printer control)
# ---------------------------------------------------------------------------

OCTOPRINT_PROBE_URLS = [
    "http://localhost:5000",
    "http://octopi.local",
]


def check_octoprint(url):
    """Check for an OctoPrint instance at the given URL.

    Returns a dict with server info or None.
    """
    try:
        status, data = http("GET", f"{url}/api/version", timeout=5, verify_ssl=False)
        if status != 200 or not isinstance(data, dict):
            return None
        return {
            "server": data.get("server", ""),
            "api_version": data.get("api", ""),
            "text": data.get("text", ""),
        }
    except Exception:
        return None


def detect_octoprint():
    """Probe common OctoPrint endpoints."""
    devices = []
    for url in OCTOPRINT_PROBE_URLS:
        info = check_octoprint(url)
        if info:
            devices.append({
                "type": "octoprint",
                "url": url,
                **info,
            })
    return devices


# ---------------------------------------------------------------------------
# mDNS discovery (optional -- requires zeroconf)
# ---------------------------------------------------------------------------

def detect_mdns(timeout=3.0):
    """Scan for network instruments via mDNS/Zeroconf.

    Requires the optional ``zeroconf`` package.  Returns [] if not installed.
    """
    try:
        from zeroconf import ServiceBrowser, Zeroconf, ServiceStateChange
    except ImportError:
        log.debug("zeroconf not installed -- skipping mDNS discovery")
        return []

    import time
    import threading

    devices = []
    lock = threading.Lock()

    class Listener:
        def add_service(self, zc, service_type, name):
            info = zc.get_service_info(service_type, name)
            if info:
                addresses = [
                    addr for addr in (
                        info.parsed_addresses() if hasattr(info, "parsed_addresses")
                        else []
                    )
                ]
                with lock:
                    devices.append({
                        "type": "mdns",
                        "service_type": service_type,
                        "name": name,
                        "addresses": addresses,
                        "port": info.port,
                        "server": info.server if hasattr(info, "server") else "",
                    })

        def remove_service(self, zc, service_type, name):
            pass

        def update_service(self, zc, service_type, name):
            pass

    service_types = [
        "_http._tcp.local.",
        "_ipp._tcp.local.",
        "_opcua-tcp._tcp.local.",
    ]

    zc = Zeroconf()
    listener = Listener()
    browsers = []
    for st in service_types:
        try:
            browsers.append(ServiceBrowser(zc, st, listener))
        except Exception:
            pass

    time.sleep(timeout)
    zc.close()

    return devices


# ---------------------------------------------------------------------------
# Combined detection
# ---------------------------------------------------------------------------

def detect_all():
    """Auto-detect all connected hardware.

    Returns a list of device dicts, each with at minimum a ``type`` key.
    """
    devices = []

    log.info("Scanning for cameras...")
    devices.extend(detect_cameras())

    log.info("Probing for Opentrons OT-2...")
    devices.extend(detect_opentrons())

    log.info("Scanning serial ports...")
    devices.extend(detect_serial())

    log.info("Probing for OctoPrint...")
    devices.extend(detect_octoprint())

    log.info("Scanning mDNS...")
    devices.extend(detect_mdns())

    return devices
