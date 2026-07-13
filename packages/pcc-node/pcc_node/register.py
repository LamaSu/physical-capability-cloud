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
from .log_capture import sign_ed25519_utf8, LogSigningRefused

log = logging.getLogger("pcc-node.register")


def kernel_signing_proof_message(kernel_id):
    """The kernelId-bound registration challenge string.

    Byte-identical to the gateway's ``kernelSigningProofMessage``
    (``packages/kernel/src/kernel-keychain.ts:52-53``). Do NOT add an env tag or
    nonce here: the binding wire contract pins this exact string for v1;
    domain-separation is a versioned fast-follow (out of scope), and diverging
    would make every proof fail the gateway's verification.
    """
    return f"pcc-kernel-signing-key:{kernel_id}"


def register_signing_key(pcc_base, api_key, kernel_id, public_key_hex, secret_key_hex):
    """Prove possession of the node's Ed25519 signing key to the gateway.

    Signs the kernelId-bound challenge with the node's Ed25519 key and POSTs the
    algorithm-tagged proof, so the gateway persists
    ``signingKey:{algorithm:"ed25519", publicKey}`` on the kernel row (WIRE
    SHAPE 1) -- the registry value the oracle's #52 verifier resolves to check
    machine-log signatures.

    Endpoint: ``POST /api/kernels`` (the registration/upsert route -- the
    gateway verifies the proof and persists the signing key on the existing
    kernel row, keeping ONE proof route; the gateway side is track M1). The
    kernel already exists (``register_kernel`` runs first), so this is the
    upsert path. Body (field names are the binding contract):

        {"id":                  <kernelId>,
         "signingKeyAlgorithm": "ed25519",
         "signingPublicKey":    "0x" + <64-hex raw ed25519 pubkey, lowercase>,
         "signingProof":        <128-hex detached ed25519 sig over the challenge>}

    Fail CLOSED: raises :class:`LogSigningRefused` if only the HMAC dev-fallback
    key is available (pynacl missing, or ``public != ed25519(secret)``). A
    money-path signer must never be registered with an HMAC value the gateway or
    oracle would treat as ed25519. Callers that want fail-soft behavior (keep the
    daemon running for the announcement path) catch :class:`LogSigningRefused`.

    Returns ``(status, data)`` from the gateway.
    """
    challenge = kernel_signing_proof_message(kernel_id)
    # Raises LogSigningRefused on the HMAC fallback -- do NOT swallow it here; a
    # node that cannot prove a genuine ed25519 key must not register a signer.
    proof_hex = sign_ed25519_utf8(challenge, public_key_hex, secret_key_hex)

    pub = public_key_hex if public_key_hex.lower().startswith("0x") else "0x" + public_key_hex
    body = {
        "id": kernel_id,
        "signingKeyAlgorithm": "ed25519",
        "signingPublicKey": pub.lower(),
        "signingProof": proof_hex,
    }
    status, data = pcc_request(
        "POST", "/api/kernels",
        body=body,
        base_url=pcc_base,
        api_key=api_key,
    )
    if status in (200, 201):
        log.info(f"Registered ed25519 signing key for kernel {kernel_id}")
    else:
        log.warning(f"Signing-key registration failed (HTTP {status}): {data}")
    return status, data


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
        "POST", "/api/auth/provision",
        body={"email": email, "name": "pcc-node"},
        base_url=pcc_base,
    )
    if status in (200, 201) and isinstance(data, dict):
        key = data.get("api_key", "")
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
        "id": config.kernel_id,
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


def register_devices(pcc_base, api_key, kernel_id, devices):
    """Register detected devices after their owning kernel exists."""
    results = []
    for index, device in enumerate(devices):
        device_type = device.get("type", "unknown")
        device_id = (
            device.get("id")
            or device.get("deviceId")
            or f"{kernel_id}-{device_type}-{index}"
        )
        payload = {
            "kernelId": kernel_id,
            "id": device_id,
            "type": device_type,
            "model": device.get("model") or device.get("name") or device_type,
            "adapterType": device.get("adapterType") or device.get("protocol") or device_type,
            "adapterConfig": device.get("adapterConfig", device),
            "capabilities": device.get("capabilities", []),
        }
        status, data = pcc_request(
            "POST", "/api/devices/register",
            body=payload,
            base_url=pcc_base,
            api_key=api_key,
        )
        if status in (200, 201):
            log.info(f"Device {device_id} registered on PCC")
        else:
            log.warning(f"Device registration failed (HTTP {status}): {data}")
        results.append(data if isinstance(data, dict) else {"raw": data, "status": status})
    return results


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
