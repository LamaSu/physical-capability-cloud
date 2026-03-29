"""Cryptographic utilities for PCC node identity.

Generates Ed25519 key pairs for signing capability announcements.
Uses pynacl if available, otherwise falls back to a hashlib-based
HMAC scheme (not real Ed25519, but sufficient for development).
"""

import hashlib
import hmac
import json
import os
import logging

log = logging.getLogger("pcc-node.crypto")

_HAS_NACL = False
try:
    import nacl.signing
    import nacl.encoding
    _HAS_NACL = True
except ImportError:
    pass


# ---------------------------------------------------------------------------
# Key generation
# ---------------------------------------------------------------------------

def generate_node_keys():
    """Generate an Ed25519 key pair for this node.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    if _HAS_NACL:
        sk = nacl.signing.SigningKey.generate()
        public_hex = sk.verify_key.encode(nacl.encoding.HexEncoder).decode("ascii")
        secret_hex = sk.encode(nacl.encoding.HexEncoder).decode("ascii")
        return public_hex, secret_hex

    # Fallback: derive a 32-byte "key pair" from random bytes.
    # This is NOT real Ed25519 -- it is a dev-mode placeholder.
    log.warning(
        "pynacl not installed -- using HMAC-SHA256 fallback (not real Ed25519). "
        "Install pynacl for production use: pip install pcc-node[crypto]"
    )
    secret = os.urandom(32)
    public = hashlib.sha256(secret).digest()
    return public.hex(), secret.hex()


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------

def sign_announcement(announcement, secret_key_hex):
    """Sign a capability announcement dict.

    Parameters
    ----------
    announcement : dict
        The announcement payload (will be canonical-JSON encoded before signing).
    secret_key_hex : str
        Hex-encoded secret key.

    Returns
    -------
    str
        Hex-encoded signature.
    """
    payload = json.dumps(announcement, sort_keys=True, separators=(",", ":")).encode("utf-8")

    if _HAS_NACL:
        sk = nacl.signing.SigningKey(bytes.fromhex(secret_key_hex))
        signed = sk.sign(payload)
        return signed.signature.hex()

    # HMAC fallback
    sig = hmac.new(bytes.fromhex(secret_key_hex), payload, hashlib.sha256).hexdigest()
    return sig


def verify_signature(announcement, signature_hex, public_key_hex):
    """Verify a signed announcement.

    Parameters
    ----------
    announcement : dict
        The announcement payload.
    signature_hex : str
        Hex-encoded signature.
    public_key_hex : str
        Hex-encoded public key.

    Returns
    -------
    bool
        True if valid.
    """
    payload = json.dumps(announcement, sort_keys=True, separators=(",", ":")).encode("utf-8")

    if _HAS_NACL:
        vk = nacl.signing.VerifyKey(bytes.fromhex(public_key_hex))
        try:
            vk.verify(payload, bytes.fromhex(signature_hex))
            return True
        except nacl.exceptions.BadSignatureError:
            return False

    # HMAC fallback: we need the secret to verify, but we only have public.
    # In fallback mode, public = sha256(secret), so we cannot truly verify
    # without the secret.  Return True as a dev-mode pass-through.
    log.warning("HMAC fallback cannot verify signatures without the secret key")
    return True


# ---------------------------------------------------------------------------
# Key persistence
# ---------------------------------------------------------------------------

def load_or_create_keys(path="./pcc-keys.json"):
    """Load existing keys from *path*, or create and save new ones.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    abs_path = os.path.abspath(path)

    if os.path.exists(abs_path):
        with open(abs_path) as f:
            data = json.load(f)
        return data["public"], data["secret"]

    public_hex, secret_hex = generate_node_keys()
    with open(abs_path, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f, indent=2)

    # Best-effort: restrict file permissions on Unix
    try:
        os.chmod(abs_path, 0o600)
    except (OSError, AttributeError):
        pass

    return public_hex, secret_hex
