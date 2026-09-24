"""Cryptographic utilities for PCC node identity.

Generates Ed25519 key pairs for signing capability announcements.
Uses pynacl if available, otherwise falls back to a hashlib-based
HMAC scheme for signing (not real Ed25519; development only). Verification
never falls back: without pynacl no signature verifies.
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
    import nacl.exceptions
    _HAS_NACL = True
except ImportError:
    pass

# Public halves of key pairs whose SECRET was committed to a public
# repository. A signature by one of these keys proves nothing, so it never
# verifies, and a key file holding one is refused (N35b).
#   - packages/pcc-node/pcc-keys.json, committed at master ac86a404
COMPROMISED_PUBLIC_KEYS = frozenset({
    "4145722275a24983ebda639a0cc0bcda8072eed3a6cf38b56135859a56c51d36",
})


class CompromisedKeyError(RuntimeError):
    """A key file holds a key pair that must never be used again."""


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
    # Fails CLOSED. Without pynacl nothing here can check an Ed25519
    # signature (the HMAC fallback needs the secret), so no signature counts
    # as verified -- this used to return True as a "dev-mode pass-through".
    if not _HAS_NACL:
        log.error("pynacl is not installed: refusing to treat a signature as verified")
        return False
    if not isinstance(public_key_hex, str) or public_key_hex.lower() in COMPROMISED_PUBLIC_KEYS:
        log.error("refusing a signature by a compromised or malformed public key")
        return False
    try:
        payload = json.dumps(announcement, sort_keys=True, separators=(",", ":")).encode("utf-8")
        vk = nacl.signing.VerifyKey(bytes.fromhex(public_key_hex))
        vk.verify(payload, bytes.fromhex(signature_hex))
        return True
    except (nacl.exceptions.BadSignatureError, ValueError, TypeError):
        # Bad signature, malformed hex, wrong key/signature length, or an
        # announcement that is not JSON-serializable.
        return False


# ---------------------------------------------------------------------------
# Key persistence
# ---------------------------------------------------------------------------

def default_key_path():
    """Where a node keeps its key pair by default: under the user's home,
    never inside a source checkout. The old default, ``./pcc-keys.json``,
    resolved to a key file committed to the repository whenever the node ran
    from the package directory."""
    return os.path.join(os.path.expanduser("~"), ".pcc-node", "keys.json")


def load_or_create_keys(path=None):
    """Load existing keys from *path* (default :func:`default_key_path`), or
    create and save new ones there.

    Raises :class:`CompromisedKeyError` for a key file holding a key pair in
    :data:`COMPROMISED_PUBLIC_KEYS`; the operator must delete it so a new pair
    is generated.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    abs_path = os.path.abspath(path if path is not None else default_key_path())

    if os.path.exists(abs_path):
        with open(abs_path) as f:
            data = json.load(f)
        if str(data.get("public", "")).lower() in COMPROMISED_PUBLIC_KEYS:
            raise CompromisedKeyError(
                abs_path + " holds a key pair whose secret was published in a public "
                "repository; delete the file and restart to generate a new key pair"
            )
        return data["public"], data["secret"]

    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, mode=0o700, exist_ok=True)
    public_hex, secret_hex = generate_node_keys()
    with open(abs_path, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f, indent=2)

    # Best-effort: restrict file permissions on Unix
    try:
        os.chmod(abs_path, 0o600)
    except (OSError, AttributeError):
        pass

    return public_hex, secret_hex
