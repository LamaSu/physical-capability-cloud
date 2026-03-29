"""PCC network registration.

Handles:
  - API key provisioning (self-service)
  - Kernel registration
  - Capability announcements (signed with node keys)
"""

import logging
import time

from .http_util import pcc_request
from .crypto import sign_announcement

log = logging.getLogger("pcc-node.register")


def provision_api_key(pcc_base, email=""):
    """Provision an API key from PCC.

    Parameters
    ----------
    pcc_base : str
        PCC gateway base URL.
    email : str
        Optional operator email for the key request.

    Returns
    -------
    str
        The provisioned API key, or empty string on failure.
    """
    status, data = pcc_request(
        "POST", "/api/keys/provision",
        body={"email": email, "source": "pcc-node"},
        base_url=pcc_base,
    )
    if status in (200, 201) and isinstance(data, dict):
        key = data.get("apiKey", data.get("api_key", data.get("key", "")))
        if key:
            log.info("API key provisioned successfully")
            return key

    log.warning(f"API key provisioning failed (HTTP {status}): {data}")
    return ""


def register_kernel(pcc_base, api_key, config):
    """Register this node's kernel on the PCC network.

    Parameters
    ----------
    pcc_base : str
        PCC gateway base URL.
    api_key : str
        Bearer token for authentication.
    config : NodeConfig
        The node configuration.

    Returns
    -------
    dict
        Registration response, or error dict.
    """
    payload = {
        "kernelId": config.kernel_id,
        "name": config.kernel_name,
        "devices": config.devices,
        "approvalMode": config.approval_mode,
        "pricing": config.pricing,
        "publicKey": config.public_key,
        "registeredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    status, data = pcc_request(
        "POST", "/api/kernels",
        body=payload,
        base_url=pcc_base,
        api_key=api_key,
    )

    if status in (200, 201):
        log.info(f"Kernel {config.kernel_id} registered on PCC")
    else:
        log.warning(f"Kernel registration failed (HTTP {status}): {data}")

    return data if isinstance(data, dict) else {"raw": data, "status": status}


def announce_capabilities(pcc_base, api_key, kernel_id, devices, secret_key=""):
    """Announce capabilities derived from detected devices.

    Each device type maps to one or more capabilities.  Announcements are
    optionally signed with the node's Ed25519 key.

    Parameters
    ----------
    pcc_base : str
        PCC gateway base URL.
    api_key : str
        Bearer token.
    kernel_id : str
        This node's kernel ID.
    devices : list[dict]
        Detected devices (from detect_all()).
    secret_key : str
        Hex-encoded secret key for signing (optional).
    """
    # Map device types to capability slugs
    cap_map = {
        "opentrons": ["liquid-handler", "pipette-transfer", "plate-reader"],
        "octoprint": ["3d-print", "fdm-fabrication"],
        "camera": ["visual-inspection", "photo-evidence"],
        "serial": ["serial-instrument"],
        "mdns": ["network-instrument"],
    }

    capabilities = []
    for dev in devices:
        dtype = dev.get("type", "")
        slugs = cap_map.get(dtype, [dtype] if dtype else [])
        for slug in slugs:
            capabilities.append({
                "slug": slug,
                "device": dev,
            })

    if not capabilities:
        log.info("No capabilities to announce")
        return

    announcement = {
        "kernelId": kernel_id,
        "capabilities": [c["slug"] for c in capabilities],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    signature = ""
    if secret_key:
        signature = sign_announcement(announcement, secret_key)

    payload = {
        **announcement,
        "signature": signature,
        "devices": [c["device"] for c in capabilities],
    }

    status, data = pcc_request(
        "POST", f"/api/kernels/{kernel_id}/capabilities",
        body=payload,
        base_url=pcc_base,
        api_key=api_key,
    )

    if status in (200, 201):
        log.info(
            f"Announced {len(capabilities)} capabilities: "
            f"{', '.join(c['slug'] for c in capabilities)}"
        )
    else:
        log.warning(f"Capability announcement failed (HTTP {status}): {data}")


def send_heartbeat(pcc_base, api_key, kernel_id, status_str="online"):
    """Send a heartbeat to PCC.

    Parameters
    ----------
    pcc_base : str
        PCC gateway base URL.
    api_key : str
        Bearer token.
    kernel_id : str
        Kernel ID.
    status_str : str
        Status string ("online", "offline", "busy").
    """
    pcc_request(
        "POST", f"/api/kernels/{kernel_id}/heartbeat",
        body={"status": status_str},
        base_url=pcc_base,
        api_key=api_key,
    )
