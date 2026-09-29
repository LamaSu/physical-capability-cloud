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

    # HMAC fallback: public = sha256(secret), so a signature cannot be checked
    # without the secret. Refuse it rather than pass it (fail closed).
    log.error("pynacl is not installed: cannot verify a signature, so it is treated as invalid")
    return False


# ---------------------------------------------------------------------------
# Key persistence
# ---------------------------------------------------------------------------

#: Where a node keeps its identity unless PCC_NODE_KEYS_FILE says otherwise.
#: Never the working directory: a key written into a checkout gets committed
#: (packages/pcc-node/pcc-keys.json was, N35a).
DEFAULT_KEYS_PATH = os.path.join(os.path.expanduser("~"), ".pcc-node", "keys.json")

#: Where pcc-node 0.1.x wrote it. Adopted once, so an upgrade keeps the
#: node's registered identity.
LEGACY_KEYS_PATH = "pcc-keys.json"


class KeyFileError(Exception):
    """The key file exists but must not be used as it is."""


def default_keys_path():
    """The key file this node uses: PCC_NODE_KEYS_FILE, else ~/.pcc-node/keys.json."""
    return os.environ.get("PCC_NODE_KEYS_FILE") or DEFAULT_KEYS_PATH


def _check_private(path):
    """Refuse a key file that other users can read or write (POSIX only)."""
    if os.name == "nt":
        return
    mode = os.stat(path).st_mode & 0o777
    if mode & 0o077:
        raise KeyFileError(
            f"{path} is readable or writable by other users (mode {oct(mode)}). "
            f"Restrict it with: chmod 600 {path}"
        )


def _parse_keys(path, text):
    """Return (public_hex, secret_hex) if the file holds a matching key pair."""
    try:
        data = json.loads(text)
        public_hex, secret_hex = data["public"], data["secret"]
        public, secret = bytes.fromhex(public_hex), bytes.fromhex(secret_hex)
    except (ValueError, KeyError, TypeError) as exc:
        raise KeyFileError(f"{path} is not a pcc-node key file ({type(exc).__name__})") from None
    if len(public) != 32 or len(secret) != 32:
        raise KeyFileError(f"{path}: each key must be 32 bytes")
    fallback = hmac.compare_digest(hashlib.sha256(secret).digest(), public)
    ed25519 = _HAS_NACL and hmac.compare_digest(
        nacl.signing.SigningKey(secret).verify_key.encode(), public
    )
    if not (ed25519 or fallback):
        raise KeyFileError(f"{path}: the public key does not belong to the secret key")
    if _HAS_NACL and not ed25519:
        log.warning(
            "%s was created without pynacl, so its public key is not an Ed25519 key and "
            "signatures made with it will not verify. Move it aside, restart to create a "
            "real key, and register the node again.", path,
        )
    return public_hex, secret_hex


def _create_exclusive(path, public_hex, secret_hex):
    """Write the key pair to a new owner-only file. False if *path* already exists."""
    os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    return True


def _adopt_legacy(legacy, path):
    """Copy a 0.1.x key file from the working directory to *path*, owner-only.

    The legacy file is left in place for the operator to delete, and nothing
    is copied unless it holds a matching key pair.
    """
    with open(legacy) as f:
        public_hex, secret_hex = _parse_keys(legacy, f.read())
    if _create_exclusive(path, public_hex, secret_hex):
        old = os.path.abspath(legacy)
        log.warning(
            "Copied this node's keys from %s to %s. The old file still holds the secret "
            "key: delete it once the node runs (rm %s).", old, path, old,
        )


def load_or_create_keys(path=None):
    """Load this node's key pair, creating it once.

    The default file is ~/.pcc-node/keys.json (or PCC_NODE_KEYS_FILE), never
    the working directory. A key file that pcc-node 0.1.x left in the working
    directory is adopted once, so the node keeps its registered identity.

    A new file is created exclusively and owner-only (0600, in a 0700
    directory). A key file that other users can read or write, or whose public
    key does not belong to its secret, raises KeyFileError.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    if path is None:
        path = default_keys_path()
        if not os.path.exists(path) and os.path.isfile(LEGACY_KEYS_PATH):
            _adopt_legacy(LEGACY_KEYS_PATH, path)
    abs_path = os.path.abspath(path)

    if not os.path.exists(abs_path):
        public_hex, secret_hex = generate_node_keys()
        if _create_exclusive(abs_path, public_hex, secret_hex):
            return public_hex, secret_hex
        # Another process created it first: use that one.

    _check_private(abs_path)
    with open(abs_path) as f:
        return _parse_keys(abs_path, f.read())
