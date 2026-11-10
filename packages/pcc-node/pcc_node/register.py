"""PCC network registration.

Handles:
  - API key provisioning (self-service)
  - Kernel registration
  - Capability announcements (signed with node keys)
"""

import base64
import ipaddress
import json
import logging
import re
import secrets
import time
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import urlsplit

from .http_util import pcc_request
from .crypto import sign_announcement
from .log_capture import (
    assert_ed25519_available, canonicalize, sign_ed25519_bytes, sign_ed25519_utf8, LogSigningRefused,
)
from .challenge_store import (
    binding, clear_hold, clear_refusal, hold_path, hold_remaining, load as load_challenge,
    refusal_path, refusal_wait, remove as remove_challenge, save as save_challenge,
    save_hold, save_refusal, store_path, wait_until_text,
)

log = logging.getLogger("pcc-node.register")
PERMANENT_REFUSAL_EXIT = 78
_rng = secrets.SystemRandom()


def _jitter(step):
    return _rng.uniform(step / 2, step)


def _sleep(seconds):
    time.sleep(seconds)


class RegistrationError(RuntimeError):
    """A kernel registration was refused or its response could not be read. Carries the status and body so callers report
    it and fail CLOSED, instead of proceeding as if registration succeeded (item 133, board N119)."""

    def __init__(self, status, data, hint=None, permanent=False):
        message = f"kernel registration failed (HTTP {status}): {data}"
        super().__init__(message + (" -- " + hint if hint else ""))
        self.status = status
        self.data = data
        self.hint = hint
        self.permanent = permanent


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
    """For gateways without the registration challenge.

    Prove possession of the node's Ed25519 signing key to the gateway.

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


class RegistrationChallengeError(RegistrationError):
    """A registration the node refused before sending a proof."""

    def __init__(self, code, hint):
        super().__init__(0, {"error": code, "message": hint}, hint)


def _public_key_hex(public_key):
    return (public_key[2:] if public_key.lower().startswith("0x") else public_key).lower()


def gateway_challenge_host(pcc_base):
    """Return the configured gateway host in the gateway's URL.host form."""
    def unusable(reason):
        return RegistrationChallengeError(
            "gateway_url_unusable",
            f"The gateway URL {pcc_base} cannot be checked against the gateway's registration challenge: {reason}.",
        )
    try:
        url = urlsplit(pcc_base)
    except ValueError:
        raise unusable("its IPv6 address is not valid") from None
    if url.scheme not in ("http", "https"):
        raise unusable("it is not an http or https URL")
    if not url.netloc:
        raise unusable("it has no host")
    if "@" in url.netloc:
        raise unusable("it carries a user name or password")
    if not url.netloc.isascii():
        raise unusable("its host name is not ASCII; use its xn-- form")
    port = ""
    if url.netloc.startswith("["):
        end = url.netloc.find("]")
        address, tail = url.netloc[1:end], url.netloc[end + 1:]
        try:
            if "%" in address:
                raise ValueError("zone")
            host = "[" + ipaddress.IPv6Address(address).compressed + "]"
        except ValueError:
            raise unusable("its IPv6 address is not valid") from None
        if tail:
            if not tail.startswith(":"):
                raise unusable("its port is not a number from 0 to 65535")
            port = tail[1:]
    else:
        host, separator, port = url.netloc.partition(":")
        if not host or "%" in host:
            raise unusable("it has no host")
        host = host.lower()
    if port:
        if re.fullmatch(r"[0-9]{1,5}", port) is None or int(port) > 65535:
            raise unusable("its port is not a number from 0 to 65535")
        if int(port) != (443 if url.scheme == "https" else 80):
            host += ":" + str(int(port))
    return host


def _older_gateway_404(data):
    if not isinstance(data, dict):
        return False
    if set(data) == {"error"}:
        return isinstance(data["error"], str) and data["error"] == "not_found"
    if set(data) == {"message", "error", "statusCode"}:
        return (isinstance(data["message"], str)
                and data["message"] == "Route POST:/api/kernels/registration-challenges not found"
                and isinstance(data["error"], str) and data["error"] == "Not Found"
                and type(data["statusCode"]) is int and data["statusCode"] == 404)
    return False


def request_registration_challenge(pcc_base, api_key, kernel_id, public_key_hex):
    """Ask for the gateway's registration challenge; retry only 429 and 503."""
    body = {"kernelId": kernel_id, "signer": {"algorithm": "ed25519", "publicKey": "0x" + _public_key_hex(public_key_hex)}}
    steps = (5, 15, 45)
    for attempt in range(4):
        try:
            status, data = pcc_request("POST", "/api/kernels/registration-challenges", body=body,
                                       base_url=pcc_base, api_key=api_key)
        except (HTTPException, OSError) as exc:
            raise RegistrationError(exc.code if isinstance(exc, HTTPError) else 0,
                                    {"error": "registration_response_unreadable"}) from exc
        if status == 201:
            if (isinstance(data, dict) and isinstance(data.get("challengeId"), str)
                    and 1 <= len(data["challengeId"]) <= 256 and isinstance(data.get("message"), str)
                    and 1 <= len(data["message"]) <= 4096 and isinstance(data.get("expiresAt"), str)):
                return {field: data[field] for field in ("challengeId", "message", "expiresAt")}
            raise RegistrationChallengeError(
                "registration_challenge_response",
                "The gateway's answer to the registration-challenge request is malformed, so the node signed nothing.",
            )
        if status == 404 and _older_gateway_404(data):
            return None
        if status in (429, 503) and attempt < 3:
            _sleep(_jitter(steps[attempt]))
            continue
        hint = None
        if status in (401, 403):
            hint = (f"The gateway refused this API key for the registration challenge (HTTP {status}). "
                    "Provision a self-service API key (POST /api/auth/provision) and pass it with PCC_API_KEY or --api-key.")
        elif status == 429:
            hint = ("The gateway is limiting registration challenges for this API key (HTTP 429). "
                    "Another node or process using the same key may be holding them. Try again in a few minutes, "
                    "or give this node its own self-service API key.")
        elif status == 503:
            hint = "The gateway could not issue a registration challenge (HTTP 503). Try again in a few minutes."
        raise RegistrationError(status, data, hint, permanent=status == 403)


def _validated_registration_bytes(challenge, kernel_id, public_key_hex, host):
    def invalid(check):
        return RegistrationChallengeError(
            "registration_challenge_invalid",
            f"The gateway's registration challenge failed this node's checks ({check}), so the node did not sign it.",
        )
    try:
        raw = base64.b64decode(challenge["message"], validate=True)
    except (ValueError, TypeError):
        raise invalid("not strict base64") from None
    prefix = b"PCC-KERNEL-REG-V1\n"
    if not raw.startswith(prefix):
        raise invalid("unknown message format")
    try:
        text = raw[len(prefix):].decode("utf-8")
    except UnicodeDecodeError:
        raise invalid("not UTF-8") from None
    try:
        fields = json.loads(text)
    except (ValueError, RecursionError):
        raise invalid("not a JSON object") from None
    if not isinstance(fields, dict):
        raise invalid("not a JSON object")
    if set(fields) != {"challengeId", "nonce", "kernelId", "env", "chainId", "domain", "issuedAt", "expiresAt", "publicKey"}:
        raise invalid("unexpected fields")
    try:
        canonical = canonicalize(fields)
    except RecursionError:
        raise invalid("not in canonical form") from None
    if canonical != text:
        raise invalid("not in canonical form")
    if fields["kernelId"] != kernel_id:
        raise invalid("for another kernel")
    if fields["publicKey"] != "0x" + _public_key_hex(public_key_hex):
        raise invalid("for another signing key")
    if fields["challengeId"] != challenge["challengeId"]:
        raise invalid("challenge id mismatch")
    domain = fields["domain"]
    if not isinstance(domain, str) or not domain.isascii() or domain.lower() != host:
        raise RegistrationChallengeError(
            "registration_challenge_domain",
            f"The gateway's registration challenge is for {domain}, but this node is configured for {host}. "
            "The node signs a challenge only for the gateway it is configured to use; check PCC_BASE or --pcc-base.",
        )
    return raw


def _binding_conflict_hint(public_key_hex):
    return ("This kernel id is already bound to a different signing key than this node's key "
            f"({_public_key_hex(public_key_hex)[:16]}...). Start the node with the key this kernel was registered with, "
            "or register a new kernel with another --kernel-id.")


def register_kernel_signed(pcc_base, api_key, payload, public_key_hex, secret_key_hex, *, persist_challenge=True):
    """Check and prove the node key in the call that registers the kernel."""
    base = pcc_base.rstrip("/")
    kid = payload.get("id")
    if not isinstance(kid, str) or not kid:
        raise RegistrationChallengeError("kernel_id_missing",
            "Registration needs a kernel id: set kernel_id in the config file or pass --kernel-id.")
    try:
        assert_ed25519_available(public_key_hex, secret_key_hex)
    except (LogSigningRefused, TypeError, ValueError, AttributeError) as exc:
        raise RegistrationChallengeError("signing_key_unusable",
            f"This node's key cannot sign the gateway's registration challenge ({exc}). "
            "Install pcc-node[crypto] and use the node's own key file.") from exc
    host = gateway_challenge_host(base)
    pub = "0x" + _public_key_hex(public_key_hex)
    bound = binding(base, kid, public_key_hex, api_key)
    challenge, loaded, saved = None, False, False
    if persist_challenge:
        wait, reason = refusal_wait(bound)
        if wait > 0:
            log.warning(
                "Waiting %s s, until %s, before asking for a registration challenge again: the gateway refused "
                "this node's registration (%s) in a way a restart cannot fix. Remove %s and %s to ask now.",
                int(wait), wait_until_text(wait), reason, refusal_path(), hold_path())
            _sleep(wait)
        challenge = load_challenge(bound)
        loaded = challenge is not None
    if not loaded:
        hold = hold_remaining(bound)
        if hold > 0:
            log.warning("Waiting %s s before asking for a new registration challenge: an earlier one this node "
                        "received may still be open. Remove %s to ask now.", int(hold), hold_path())
            _sleep(hold)
        try:
            challenge = request_registration_challenge(base, api_key, kid, public_key_hex)
        except RegistrationError as exc:
            if exc.permanent and persist_challenge:
                save_refusal(bound, "challenge_request_403")
            raise
        if challenge is not None:
            save_hold(bound)
            if persist_challenge:
                saved = save_challenge(bound, challenge)
    body = dict(payload)
    body.update(signingKeyAlgorithm="ed25519", signingPublicKey=pub)
    if challenge is not None:
        raw = _validated_registration_bytes(challenge, kid, public_key_hex, host)
        signature = sign_ed25519_bytes(raw, public_key_hex, secret_key_hex)
        if saved or loaded:
            try:
                remove_challenge()
            except OSError as exc:
                raise RegistrationChallengeError("registration_challenge_store",
                    f"Cannot remove the stored registration challenge {store_path()} ({exc}), "
                    "so the node sent nothing. Remove the file and start again.") from exc
        body["registrationProof"] = {"challengeId": challenge["challengeId"], "signature": signature}
        try:
            status, data = pcc_request("POST", "/api/kernels", body=body, base_url=base, api_key=api_key)
        except (HTTPException, OSError) as exc:
            raise RegistrationError(exc.code if isinstance(exc, HTTPError) else 0,
                                    {"error": "registration_response_unreadable"}) from exc
        if 200 <= status < 300 or status == 409:
            clear_hold()
        if not 200 <= status < 300:
            permanent = status in (403, 409)
            if permanent and persist_challenge:
                save_refusal(bound, "registration_" + str(status))
            raise RegistrationError(status, data, _binding_conflict_hint(public_key_hex) if status == 409 else None,
                                    permanent=permanent)
    else:
        body["signingProof"] = sign_ed25519_utf8(kernel_signing_proof_message(kid), public_key_hex, secret_key_hex)
        try:
            status, data = pcc_request("POST", "/api/kernels", body=body, base_url=base, api_key=api_key)
        except (HTTPException, OSError) as exc:
            raise RegistrationError(exc.code if isinstance(exc, HTTPError) else 0,
                                    {"error": "registration_response_unreadable"}) from exc
        if not 200 <= status < 300:
            raise RegistrationError(status, data, _binding_conflict_hint(public_key_hex) if status == 409 else None)
    if not isinstance(data, dict):
        raise RegistrationError(0, {"error": "malformed_registration_response"})
    kernel = data.get("kernel")
    signing_key = kernel.get("signingKey") if isinstance(kernel, dict) else None
    if not (isinstance(signing_key, dict) and signing_key.get("algorithm") == "ed25519"
            and isinstance(signing_key.get("publicKey"), str) and signing_key["publicKey"].lower() == pub):
        error = RegistrationChallengeError("registration_not_bound",
            "The gateway accepted the registration but does not show this node's signing key on the kernel, "
            "so the node treats the registration as failed.")
        error.data["signingKey"] = signing_key
        raise error
    if persist_challenge:
        clear_refusal()
    return data


def _kernel_payload(config):
    return {
        "id": config.kernel_id,
        "name": config.kernel_name,
        "devices": config.devices,
        "approvalMode": config.approval_mode,
        "pricing": config.pricing,
        "publicKey": config.public_key,
        "registeredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def register_kernel(pcc_base, api_key, config, signer=None, persist_challenge=True):
    """Register this node's kernel on the PCC network.

    Parameters
    ----------
    pcc_base : str
        PCC gateway base URL.
    api_key : str
        Bearer token for authentication.
    config : NodeConfig
        The node configuration.
    signer : tuple of (str, str), optional
        (public hex, secret hex): when given, the kernel is registered with the gateway's registration challenge,
        or, for an older gateway without one, with a static signing proof.
    persist_challenge : bool, optional
        With signer only. True (the default) keeps a challenge the node has received but not sent beside the node key,
        for a restart. After a refusal that a restart cannot fix, it also leaves a refusal marker there, which the next
        registration with the same settings waits out.

    Returns
    -------
    dict
        The gateway's registration response, on a 2xx (200 upsert / 201 create).

    Raises
    ------
    RegistrationError
        On a refusal, unreadable response or malformed body, carrying the status and body, so callers fail CLOSED instead of
        mistaking an error for success (item 133).
    """
    if signer is not None:
        public_hex, secret_hex = signer
        return register_kernel_signed(pcc_base, api_key, _kernel_payload(config), public_hex, secret_hex,
                                      persist_challenge=persist_challenge)
    payload = _kernel_payload(config)

    try:
        status, data = pcc_request(
            "POST", "/api/kernels",
            body=payload,
            base_url=pcc_base,
            api_key=api_key,
        )
    except (HTTPException, OSError) as exc:
        # A read inside gateway_request's HTTPError handler can itself fail.
        # Preserve a refusal if the exception carries its status. Other read
        # failures carry no status through this API and become transport failure.
        status = exc.code if isinstance(exc, HTTPError) else 0
        raise RegistrationError(status, {"error": "registration_response_unreadable"}) from exc

    if status not in (200, 201):
        # A non-2xx must never be mistaken for success: raise so `start` and the daemon fail CLOSED and
        # never log "registered" / print "Node running" after a 401 (item 133, board N119 incident).
        log.warning(f"Kernel registration failed (HTTP {status}): {data}")
        raise RegistrationError(status, data)
    if not isinstance(data, dict):
        raise RegistrationError(0, {"error": "malformed_registration_response"})
    log.info(f"Kernel {config.kernel_id} registered on PCC")
    return data


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
