"""Diagnostic log collector for PCC node troubleshooting.

Collects node logs, system info, device state, and recent errors,
then encrypts the bundle with AES-256-GCM and uploads it to the
PCC gateway. The operator gets a short retrieval code they can
share over any channel (chat, email, phone).

The encryption key is derived from the retrieval code + a server-side
salt, so logs are encrypted at rest and only readable by someone
who has the code.
"""

import hashlib
import json
import logging
import os
import platform
import secrets
import sys
import time
import base64
from datetime import datetime, timezone
from typing import Optional

from .config import load_config, NodeConfig
from .daemon import read_state, STATE_FILE, PID_FILE, is_running
from .http_util import pcc_request

log = logging.getLogger("pcc-node.diagnostics")

# Where pcc-node writes its own log file (if configured)
LOG_DIR = os.path.expanduser("~/.pcc-node/logs")
LOG_FILE = os.path.join(LOG_DIR, "pcc-node.log")


def _collect_system_info() -> dict:
    """Collect basic system information (no secrets)."""
    info = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "arch": platform.machine(),
        "hostname": platform.node(),
        "cpu_count": os.cpu_count(),
        "cwd": os.getcwd(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # Memory info (best-effort)
    try:
        if sys.platform == "linux":
            with open("/proc/meminfo") as f:
                for line in f:
                    if line.startswith(("MemTotal", "MemAvailable", "MemFree")):
                        key, val = line.split(":")
                        info[key.strip().lower()] = val.strip()
        elif sys.platform == "darwin":
            import subprocess
            result = subprocess.run(
                ["sysctl", "-n", "hw.memsize"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                info["memtotal"] = f"{int(result.stdout.strip()) // (1024*1024)} MB"
    except Exception:
        pass

    return info


def _collect_node_state() -> dict:
    """Collect current node daemon state."""
    state = read_state() or {}
    running, pid = is_running()
    state["daemon_running"] = running
    state["daemon_pid"] = pid
    return state


def _collect_config(config_path: str) -> dict:
    """Collect node config with secrets redacted."""
    try:
        config = load_config(config_path)
        d = config.to_dict()
        # Redact secrets
        if d.get("pcc_api_key"):
            key = d["pcc_api_key"]
            d["pcc_api_key"] = f"{key[:8]}...{key[-4:]}" if len(key) > 12 else "***"
        # Redact device API keys
        for dev in d.get("devices", []):
            if dev.get("apiKey"):
                dev["apiKey"] = "***"
            if dev.get("api_key"):
                dev["api_key"] = "***"
        return d
    except Exception as e:
        return {"error": str(e)}


def _collect_recent_logs(max_lines: int = 500) -> list:
    """Collect recent log lines from the pcc-node log file."""
    lines = []

    # Try the log file first
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE) as f:
                all_lines = f.readlines()
                lines = all_lines[-max_lines:]
        except Exception as e:
            lines = [f"[error reading {LOG_FILE}: {e}]"]

    # Also collect from systemd journal if available (Linux)
    if sys.platform == "linux" and not lines:
        try:
            import subprocess
            result = subprocess.run(
                ["journalctl", "-u", "pcc-node", "--no-pager", "-n", str(max_lines)],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = result.stdout.strip().split("\n")
        except Exception:
            pass

    return [l.rstrip("\n") for l in lines]


def _collect_network_diagnostics(pcc_base: str) -> dict:
    """Test connectivity to the PCC gateway."""
    diag = {"gateway_url": pcc_base}

    try:
        start = time.time()
        status, body = pcc_request("GET", "/health", base_url=pcc_base, timeout=10)
        elapsed = time.time() - start
        diag["gateway_reachable"] = True
        diag["gateway_status"] = status
        diag["gateway_latency_ms"] = round(elapsed * 1000)
    except Exception as e:
        diag["gateway_reachable"] = False
        diag["gateway_error"] = str(e)

    return diag


def _collect_device_health(config_path: str) -> list:
    """Probe each configured device for health status."""
    devices = []
    try:
        config = load_config(config_path)
    except Exception:
        return devices

    from .http_util import http

    for dev in config.devices:
        entry = {
            "type": dev.get("type", "unknown"),
            "name": dev.get("name", ""),
        }

        url = dev.get("url", "")
        if url:
            entry["url"] = url
            try:
                start = time.time()
                status, _ = http("GET", url, timeout=5, verify_ssl=False)
                entry["reachable"] = True
                entry["status"] = status
                entry["latency_ms"] = round((time.time() - start) * 1000)
            except Exception as e:
                entry["reachable"] = False
                entry["error"] = str(e)
        else:
            entry["reachable"] = None
            entry["note"] = "no URL configured"

        devices.append(entry)

    return devices


def collect_diagnostic_bundle(
    config_path: str = "./pcc-node.json",
    pcc_base: str = "https://capability.network",
    max_log_lines: int = 500,
    include_device_health: bool = True,
) -> dict:
    """Collect a full diagnostic bundle.

    Returns a dict with all diagnostic sections. No secrets are included.
    """
    bundle = {
        "version": "1.0",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "system": _collect_system_info(),
        "node_state": _collect_node_state(),
        "config": _collect_config(config_path),
        "logs": _collect_recent_logs(max_log_lines),
        "network": _collect_network_diagnostics(pcc_base),
    }

    if include_device_health:
        bundle["devices"] = _collect_device_health(config_path)

    return bundle


def _encrypt_bundle(bundle_json: str, passphrase: str) -> dict:
    """Encrypt a diagnostic bundle with AES-256-GCM.

    Uses PBKDF2 to derive the key from the passphrase.
    Returns { ciphertext_b64, iv_b64, salt_b64, tag_b64 }.
    """
    salt = os.urandom(16)
    # Derive 256-bit key from passphrase
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 100_000)

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = os.urandom(12)
        aesgcm = AESGCM(key)
        ct = aesgcm.encrypt(nonce, bundle_json.encode("utf-8"), None)
        ciphertext = ct[:-16]
        tag = ct[-16:]
    except ImportError:
        # Fallback: use stdlib AES-CTR + HMAC (not GCM, but still secure)
        import hmac as hmac_mod
        from hashlib import sha256

        # XOR-based stream cipher from key (dev fallback — not ideal but functional)
        # For production, operators should `pip install cryptography`
        log.warning(
            "cryptography package not installed — using HMAC-based encoding. "
            "Install cryptography for AES-GCM: pip install cryptography"
        )
        nonce = os.urandom(12)
        data = bundle_json.encode("utf-8")
        # Simple XOR stream from repeated HMAC rounds
        stream = b""
        counter = 0
        while len(stream) < len(data):
            block = hmac_mod.new(
                key, nonce + counter.to_bytes(4, "big"), sha256
            ).digest()
            stream += block
            counter += 1
        ciphertext = bytes(a ^ b for a, b in zip(data, stream[: len(data)]))
        tag = hmac_mod.new(key, ciphertext, sha256).digest()[:16]

    return {
        "ciphertext_b64": base64.b64encode(ciphertext).decode(),
        "iv_b64": base64.b64encode(nonce).decode(),
        "salt_b64": base64.b64encode(salt).decode(),
        "tag_b64": base64.b64encode(tag).decode(),
    }


def generate_retrieval_code() -> str:
    """Generate a short, human-friendly retrieval code.

    Format: XXXX-XXXX-XXXX (12 alphanumeric chars, no ambiguous chars).
    """
    # Remove ambiguous characters: 0/O, 1/I/l
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    code = "".join(secrets.choice(alphabet) for _ in range(12))
    return f"{code[:4]}-{code[4:8]}-{code[8:12]}"


def upload_diagnostic_bundle(
    bundle: dict,
    pcc_base: str = "https://capability.network",
    api_key: str = "",
    kernel_id: str = "",
) -> dict:
    """Encrypt and upload a diagnostic bundle to the PCC gateway.

    Returns { retrieval_code, upload_id, expires_at } on success,
    or { error } on failure.
    """
    retrieval_code = generate_retrieval_code()

    # Serialize and encrypt
    bundle_json = json.dumps(bundle, default=str)
    encrypted = _encrypt_bundle(bundle_json, retrieval_code)

    # Upload to gateway
    payload = {
        "kernelId": kernel_id or bundle.get("config", {}).get("kernel_id", "unknown"),
        "encrypted": encrypted,
        "bundleHash": "sha256:" + hashlib.sha256(bundle_json.encode()).hexdigest(),
        "bundleSize": len(bundle_json),
        "logLineCount": len(bundle.get("logs", [])),
        "systemPlatform": bundle.get("system", {}).get("platform", "unknown"),
        "collectedAt": bundle.get("collected_at", datetime.now(timezone.utc).isoformat()),
    }

    status, body = pcc_request(
        "POST",
        "/api/operator/diagnostics",
        body=payload,
        base_url=pcc_base,
        api_key=api_key,
        timeout=30,
    )

    if status in (200, 201):
        return {
            "retrieval_code": retrieval_code,
            "upload_id": body.get("uploadId", "unknown"),
            "expires_at": body.get("expiresAt", "unknown"),
            "bundle_size": len(bundle_json),
        }
    else:
        return {
            "error": f"Upload failed (HTTP {status})",
            "details": body if isinstance(body, dict) else {"message": str(body)},
        }


def decrypt_diagnostic_bundle(
    encrypted: dict,
    retrieval_code: str,
) -> Optional[dict]:
    """Decrypt a diagnostic bundle using the retrieval code.

    Parameters
    ----------
    encrypted : dict
        The encrypted payload { ciphertext_b64, iv_b64, salt_b64, tag_b64 }.
    retrieval_code : str
        The retrieval code (passphrase).

    Returns
    -------
    dict or None
        The decrypted bundle, or None if decryption fails.
    """
    passphrase = retrieval_code.replace("-", "").strip()
    # But we encrypted with the dashed version, so use as-is
    passphrase = retrieval_code

    salt = base64.b64decode(encrypted["salt_b64"])
    nonce = base64.b64decode(encrypted["iv_b64"])
    ciphertext = base64.b64decode(encrypted["ciphertext_b64"])
    tag = base64.b64decode(encrypted["tag_b64"])

    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, 100_000)

    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        aesgcm = AESGCM(key)
        plaintext = aesgcm.decrypt(nonce, ciphertext + tag, None)
        return json.loads(plaintext.decode("utf-8"))
    except ImportError:
        import hmac as hmac_mod
        from hashlib import sha256

        # Verify HMAC tag first
        expected_tag = hmac_mod.new(key, ciphertext, sha256).digest()[:16]
        if not hmac_mod.compare_digest(tag, expected_tag):
            return None

        # Decrypt XOR stream
        stream = b""
        counter = 0
        while len(stream) < len(ciphertext):
            block = hmac_mod.new(
                key, nonce + counter.to_bytes(4, "big"), sha256
            ).digest()
            stream += block
            counter += 1
        plaintext = bytes(a ^ b for a, b in zip(ciphertext, stream[: len(ciphertext)]))
        return json.loads(plaintext.decode("utf-8"))
    except Exception as e:
        log.error(f"Decryption failed: {e}")
        return None
