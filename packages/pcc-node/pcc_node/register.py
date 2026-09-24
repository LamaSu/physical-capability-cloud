"""PCC network registration.

Handles:
  - API key provisioning (self-service)
  - Kernel registration
  - Capability announcements (signed with node keys)
"""

import logging
import time

from .http_util import pcc_request
from .crypto import sign_announcement, _HAS_NACL as _ED25519_AVAILABLE
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

    The announcement goes to the kernel HEARTBEAT (``POST
    /api/kernels/<id>/heartbeat``), the route that actually writes the
    capability catalog.  ``POST /api/kernels/<id>/capabilities`` is a stub
    that answers ``acknowledged`` and stores nothing, so a node registered
    through it stayed undiscoverable (bus #2622 item 3).  Only capability
    types are sent: the raw device dicts (URLs, and credentials such as an
    OctoPrint ``api_key``) never leave the node.

    Each capability claims ``assuranceTiers: [0]``: the node proves nothing
    by announcing, and the gateway's default for an absent claim is wider.

    Signature (canonical form, so a verifier can rebuild it from the
    request): Ed25519 over the compact, key-sorted JSON of
    ``{"kernelId": <the kernel id in the path>, "capabilities": <the body's
    capability types, in order>, "timestamp": <the body's timestamp>}``.
    Types are sorted before sending.  Without PyNaCl the announcement goes
    unsigned: an HMAC is not a signature anyone else can verify.

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

    found = set()
    for dev in devices:
        dtype = dev.get("type", "")
        found.update(cap_map.get(dtype, [dtype] if dtype else []))
    slugs = sorted(found)

    if not slugs:
        log.info("No capabilities to announce")
        return

    announcement = {
        "kernelId": kernel_id,
        "capabilities": slugs,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    signature = ""
    if secret_key and _ED25519_AVAILABLE:
        signature = sign_announcement(announcement, secret_key)
    elif secret_key:
        log.info("PyNaCl is not installed: sending the capability announcement unsigned")

    payload = {
        "status": "online",
        "capabilities": [{"type": slug, "assuranceTiers": [0]} for slug in slugs],
        "timestamp": announcement["timestamp"],
        "signature": signature,
    }

    status, data = pcc_request(
        "POST", f"/api/kernels/{kernel_id}/heartbeat",
        body=payload,
        base_url=pcc_base,
        api_key=api_key,
    )

    if status not in (200, 201):
        log.warning(f"Capability announcement failed (HTTP {status}): {data}")
        return
    received = data.get("capabilitiesReceived") if isinstance(data, dict) else None
    if isinstance(received, int) and not isinstance(received, bool) and received < len(slugs):
        log.warning(
            "Capability announcement: the gateway recorded %d of %d capabilities (%s)",
            received, len(slugs), ", ".join(slugs),
        )
    else:
        log.info(f"Announced {len(slugs)} capabilities: {', '.join(slugs)}")


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
