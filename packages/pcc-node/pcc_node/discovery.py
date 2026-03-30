"""
Network device discovery for PCC operator onboarding.
Scans the local subnet for devices, then fingerprints each against known protocols.

All network I/O uses stdlib only (socket, urllib.request, subprocess).
No external dependencies required.
"""

import json
import logging
import platform
import socket
import subprocess
import ipaddress
import concurrent.futures
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any

from .http_util import http

log = logging.getLogger("pcc-node.discovery")

# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

@dataclass
class DiscoveredDevice:
    """A device found on the local network."""
    ip: str
    hostname: Optional[str]
    mac: Optional[str]
    open_ports: List[int]
    protocol: Optional[str]   # "opentrons", "octoprint", "modbus", "ipp", "opcua", "http", "unknown"
    device_type: Optional[str]  # "liquid-handler", "3d-printer", "plc", "lab-instrument", "printer", "cnc", "unknown"
    confidence: float           # 0.0 – 1.0
    details: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Port catalogue
# ---------------------------------------------------------------------------

# port -> (protocol_hint, default_device_type)
KNOWN_PORTS: Dict[int, tuple] = {
    31950: ("opentrons", "liquid-handler"),
    5000:  ("octoprint", "3d-printer"),
    80:    ("http",      "unknown"),
    443:   ("https",     "unknown"),
    8080:  ("http-alt",  "unknown"),
    502:   ("modbus",    "plc"),
    631:   ("ipp",       "printer"),
    4840:  ("opcua",     "cnc"),
}

# Default scan order: most distinctive ports first
SCAN_PORTS = [31950, 502, 631, 4840, 5000, 8080, 80, 443]


# ---------------------------------------------------------------------------
# Subnet detection
# ---------------------------------------------------------------------------

def get_local_subnet() -> str:
    """Detect the local subnet, e.g. '192.168.1.0/24'.

    Strategy:
    1. Open a UDP socket towards a public address (no traffic sent) to find
       the local IP used for outbound packets.
    2. Derive a /24 subnet from that IP.

    Falls back to '192.168.1.0/24' on any error.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(1.0)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
        # Build /24 network
        net = ipaddress.IPv4Network(f"{local_ip}/24", strict=False)
        return str(net)
    except Exception as exc:
        log.debug("get_local_subnet fallback: %s", exc)
        return "192.168.1.0/24"


# ---------------------------------------------------------------------------
# Host scanning
# ---------------------------------------------------------------------------

def _port_open(ip: str, port: int, timeout: float) -> bool:
    """Return True if *port* on *ip* accepts a TCP connection within *timeout*."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            return s.connect_ex((ip, port)) == 0
    except OSError:
        return False


def _resolve_hostname(ip: str) -> Optional[str]:
    """Reverse-DNS lookup. Returns None on failure."""
    try:
        result = socket.gethostbyaddr(ip)
        return result[0]
    except (socket.herror, socket.gaierror, OSError):
        return None


def _parse_arp_table() -> Dict[str, str]:
    """Return {ip: mac} from the OS ARP table.  Best-effort; returns {} on error."""
    arp: Dict[str, str] = {}
    try:
        if platform.system() == "Windows":
            out = subprocess.run(
                ["arp", "-a"],
                capture_output=True, text=True, timeout=5,
            ).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 2:
                    ip_part = parts[0].strip()
                    mac_part = parts[1].strip()
                    # Windows arp -a uses dashes: aa-bb-cc-dd-ee-ff
                    if "-" in mac_part or ":" in mac_part:
                        try:
                            ipaddress.IPv4Address(ip_part)
                            arp[ip_part] = mac_part.replace("-", ":").lower()
                        except ValueError:
                            pass
        else:
            out = subprocess.run(
                ["arp", "-a"],
                capture_output=True, text=True, timeout=5,
            ).stdout
            # Linux/macOS: "hostname (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] ..."
            for line in out.splitlines():
                parts = line.split()
                for i, p in enumerate(parts):
                    if p.startswith("(") and p.endswith(")"):
                        ip_candidate = p[1:-1]
                        try:
                            ipaddress.IPv4Address(ip_candidate)
                        except ValueError:
                            continue
                        # MAC is usually after "at"
                        if i + 2 < len(parts) and parts[i + 1] == "at":
                            mac_candidate = parts[i + 2]
                            if ":" in mac_candidate:
                                arp[ip_candidate] = mac_candidate.lower()
    except Exception as exc:
        log.debug("ARP parse failed: %s", exc)
    return arp


# Lazy-loaded ARP table (populated once per discovery run)
_ARP_CACHE: Optional[Dict[str, str]] = None


def _get_arp_cache() -> Dict[str, str]:
    global _ARP_CACHE
    if _ARP_CACHE is None:
        _ARP_CACHE = _parse_arp_table()
    return _ARP_CACHE


def scan_host(ip: str, timeout: float = 0.5) -> Optional[DiscoveredDevice]:
    """Check if a host is alive by probing known ports.

    Returns a DiscoveredDevice with open_ports populated (no fingerprinting yet),
    or None if the host appears unreachable.
    """
    open_ports = []
    for port in SCAN_PORTS:
        if _port_open(ip, port, timeout):
            open_ports.append(port)

    if not open_ports:
        return None

    hostname = _resolve_hostname(ip)
    mac = _get_arp_cache().get(ip)

    # Initial protocol guess from the first recognized port
    protocol: Optional[str] = None
    device_type: Optional[str] = None
    for port in open_ports:
        if port in KNOWN_PORTS:
            protocol, device_type = KNOWN_PORTS[port]
            break

    return DiscoveredDevice(
        ip=ip,
        hostname=hostname,
        mac=mac,
        open_ports=open_ports,
        protocol=protocol,
        device_type=device_type,
        confidence=0.1,  # updated by fingerprinting
        details={},
    )


# ---------------------------------------------------------------------------
# Fingerprinting
# ---------------------------------------------------------------------------

def _probe_opentrons(ip: str) -> Optional[Dict[str, Any]]:
    """GET /health on Opentrons port 31950.  Returns details dict or None."""
    status, data = http(
        "GET", f"http://{ip}:31950/health",
        timeout=2, verify_ssl=False,
    )
    if status == 200 and isinstance(data, dict) and "name" in data:
        return {
            "name": data.get("name", ""),
            "api_version": data.get("api_version", ""),
            "fw_version": data.get("fw_version", ""),
            "robot_model": data.get("robot_model", ""),
        }
    return None


def _probe_octoprint(ip: str, port: int) -> Optional[Dict[str, Any]]:
    """GET /api/version on OctoPrint.  Returns details dict or None."""
    status, data = http(
        "GET", f"http://{ip}:{port}/api/version",
        timeout=2, verify_ssl=False,
    )
    if status == 200 and isinstance(data, dict) and "server" in data:
        return {
            "server": data.get("server", ""),
            "api_version": data.get("api", ""),
            "text": data.get("text", ""),
        }
    # Try /api/connection as a fallback identifier
    status2, data2 = http(
        "GET", f"http://{ip}:{port}/api/connection",
        timeout=2, verify_ssl=False,
    )
    if status2 == 200 and isinstance(data2, dict):
        return {
            "server": "unknown",
            "api_version": "",
            "text": "OctoPrint (detected via /api/connection)",
        }
    return None


def _probe_http_generic(ip: str, port: int) -> Optional[Dict[str, Any]]:
    """Fetch / and sniff the Server header for hints."""
    status, data = http(
        "GET", f"http://{ip}:{port}/",
        timeout=2, verify_ssl=False,
    )
    if status > 0:
        body_str = data if isinstance(data, str) else json.dumps(data)
        return {"status": status, "body_preview": body_str[:200]}
    return None


def fingerprint_device(device: DiscoveredDevice) -> DiscoveredDevice:
    """Run protocol-specific probes to classify a device.

    Mutates and returns the DiscoveredDevice with updated protocol/device_type/
    confidence/details fields.
    """
    ports = set(device.open_ports)

    # --- Opentrons OT-2 ---
    if 31950 in ports:
        details = _probe_opentrons(device.ip)
        if details:
            device.protocol = "opentrons"
            device.device_type = "liquid-handler"
            device.confidence = 0.95
            device.details = details
            return device
        # Port open but no valid response
        device.protocol = "opentrons"
        device.device_type = "liquid-handler"
        device.confidence = 0.5
        return device

    # --- OctoPrint ---
    for port in (5000, 8080, 80):
        if port in ports:
            details = _probe_octoprint(device.ip, port)
            if details:
                device.protocol = "octoprint"
                device.device_type = "3d-printer"
                device.confidence = 0.9
                device.details = {"url": f"http://{device.ip}:{port}", **details}
                return device

    # --- Modbus TCP (port 502) — just TCP open is enough for a PLC hint ---
    if 502 in ports:
        device.protocol = "modbus"
        device.device_type = "plc"
        device.confidence = 0.6
        device.details = {"note": "Modbus TCP port 502 open"}
        return device

    # --- IPP (Internet Printing Protocol, port 631) ---
    if 631 in ports:
        device.protocol = "ipp"
        device.device_type = "printer"
        device.confidence = 0.7
        device.details = {"note": "IPP port 631 open"}
        return device

    # --- OPC-UA (port 4840) ---
    if 4840 in ports:
        device.protocol = "opcua"
        device.device_type = "cnc"
        device.confidence = 0.6
        device.details = {"note": "OPC-UA port 4840 open"}
        return device

    # --- Generic HTTP fallback ---
    for port in (80, 443, 8080):
        if port in ports:
            details = _probe_http_generic(device.ip, port)
            if details:
                device.protocol = "http"
                device.device_type = "unknown"
                device.confidence = 0.3
                device.details = details
                return device

    # Nothing matched
    device.protocol = "unknown"
    device.device_type = "unknown"
    device.confidence = 0.1
    return device


# ---------------------------------------------------------------------------
# Full discovery
# ---------------------------------------------------------------------------

def discover_network(
    subnet: Optional[str] = None,
    timeout: float = 0.5,
    max_workers: int = 50,
) -> List[DiscoveredDevice]:
    """Scan a subnet and fingerprint every responding host.

    Parameters
    ----------
    subnet:
        CIDR notation, e.g. ``"192.168.1.0/24"``.  Defaults to the detected
        local subnet.
    timeout:
        Per-port TCP connect timeout in seconds.
    max_workers:
        ThreadPoolExecutor concurrency cap.

    Returns
    -------
    List of DiscoveredDevice, sorted by confidence descending.
    """
    global _ARP_CACHE
    _ARP_CACHE = None  # reset per-run

    if subnet is None:
        subnet = get_local_subnet()

    log.info("Scanning subnet %s (timeout=%.1fs, workers=%d)", subnet, timeout, max_workers)

    try:
        network = ipaddress.IPv4Network(subnet, strict=False)
    except ValueError as exc:
        log.error("Invalid subnet %r: %s", subnet, exc)
        return []

    hosts = list(network.hosts())
    devices: List[DiscoveredDevice] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(scan_host, str(ip), timeout): ip
            for ip in hosts
        }
        for future in concurrent.futures.as_completed(futures):
            try:
                result = future.result()
            except Exception as exc:
                log.debug("scan_host error: %s", exc)
                continue
            if result is not None:
                devices.append(fingerprint_device(result))

    devices.sort(key=lambda d: d.confidence, reverse=True)
    log.info("Discovery complete: found %d device(s)", len(devices))
    return devices


# ---------------------------------------------------------------------------
# Auto-register helpers
# ---------------------------------------------------------------------------

def device_to_adapter_config(device: DiscoveredDevice) -> Optional[Dict[str, Any]]:
    """Convert a DiscoveredDevice into a PCC adapter config dict.

    Returns None for unknown/low-confidence devices.
    """
    if device.confidence < 0.5 or device.device_type in ("unknown", None):
        return None

    if device.protocol == "opentrons":
        return {
            "type": "opentrons",
            "url": f"http://{device.ip}:31950",
            "name": device.details.get("name", "OT-2"),
            "api_version": device.details.get("api_version", ""),
            "fw_version": device.details.get("fw_version", ""),
            "robot_model": device.details.get("robot_model", ""),
        }

    if device.protocol == "octoprint":
        url = device.details.get("url", f"http://{device.ip}:5000")
        return {
            "type": "octoprint",
            "url": url,
            "server": device.details.get("server", ""),
            "api_version": device.details.get("api_version", ""),
        }

    if device.protocol == "modbus":
        return {
            "type": "modbus",
            "host": device.ip,
            "port": 502,
        }

    if device.protocol == "ipp":
        return {
            "type": "printer",
            "host": device.ip,
            "port": 631,
        }

    if device.protocol == "opcua":
        return {
            "type": "opcua",
            "endpoint": f"opc.tcp://{device.ip}:4840",
        }

    return None


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

def format_discovery_report(devices: List[DiscoveredDevice]) -> str:
    """Pretty-print discovered devices for CLI output."""
    if not devices:
        return "No devices found on the network."

    lines = [f"Found {len(devices)} device(s):\n"]
    for i, dev in enumerate(devices, 1):
        hostname_str = f" ({dev.hostname})" if dev.hostname else ""
        mac_str = f"  MAC: {dev.mac}" if dev.mac else ""
        ports_str = ", ".join(str(p) for p in dev.open_ports)
        confidence_pct = f"{dev.confidence * 100:.0f}%"

        lines.append(
            f"  [{i}] {dev.ip}{hostname_str}"
        )
        lines.append(
            f"       Type: {dev.device_type or 'unknown'}  "
            f"Protocol: {dev.protocol or 'unknown'}  "
            f"Confidence: {confidence_pct}"
        )
        if mac_str:
            lines.append(f"       {mac_str}")
        lines.append(f"       Open ports: {ports_str}")
        if dev.details:
            detail_str = "  ".join(
                f"{k}={v}" for k, v in dev.details.items()
                if k not in ("body_preview", "note")
            )
            if detail_str:
                lines.append(f"       {detail_str}")
        if "note" in dev.details:
            lines.append(f"       Note: {dev.details['note']}")
        lines.append("")

    return "\n".join(lines)
