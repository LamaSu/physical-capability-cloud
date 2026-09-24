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
import re

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


class KeyFileError(RuntimeError):
    """A key file that cannot be used as it is: malformed, holding a public key
    that does not belong to its secret, readable by other users, or about to be
    created inside a source checkout."""


def _strict_hex(value, byte_length):
    """Exactly ``byte_length`` bytes as ``2 * byte_length`` hex characters.

    ``bytes.fromhex`` skips whitespace, so it decodes ``" " + key`` to the same
    key; here nothing but hex digits is accepted (either case, no prefix).
    """
    if not isinstance(value, str) or re.fullmatch("[0-9a-fA-F]{%d}" % (byte_length * 2), value) is None:
        raise ValueError("expected %d bytes as %d hex characters" % (byte_length, byte_length * 2))
    return bytes.fromhex(value)


def _is_compromised(public_key):
    """Compare DECODED key bytes, so no spelling of a listed key escapes the list."""
    return bytes(public_key) in {bytes.fromhex(k) for k in COMPROMISED_PUBLIC_KEYS}


def _announcement_payload(announcement):
    """The bytes an announcement signature covers. Only a dict is an announcement."""
    if not isinstance(announcement, dict):
        raise TypeError("an announcement must be a dict, got " + type(announcement).__name__)
    return json.dumps(announcement, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


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

    Raises
    ------
    TypeError
        The announcement is not a dict.
    ValueError
        The secret is not exactly 64 hex characters, or the announcement holds
        a value JSON cannot represent.
    CompromisedKeyError
        The key pair is on the denylist: its signatures prove nothing.
    """
    payload = _announcement_payload(announcement)
    secret = _strict_hex(secret_key_hex, 32)

    if _HAS_NACL:
        sk = nacl.signing.SigningKey(secret)
        if _is_compromised(bytes(sk.verify_key)):
            raise CompromisedKeyError(
                "refusing to sign with a key pair whose secret was published; generate a new key pair"
            )
        return sk.sign(payload).signature.hex()

    # HMAC fallback (development only). Nothing verifies these: verification
    # needs pynacl and checks Ed25519, so a fallback signature never counts.
    sig = hmac.new(secret, payload, hashlib.sha256).hexdigest()
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
    try:
        # Decode first, then compare bytes: the denylist must see the key the
        # verifier will use, whatever whitespace or case it was spelled with.
        public = _strict_hex(public_key_hex, 32)
        if _is_compromised(public):
            log.error("refusing a signature by a compromised public key")
            return False
        signature = _strict_hex(signature_hex, 64)
        nacl.signing.VerifyKey(public).verify(_announcement_payload(announcement), signature)
        return True
    except Exception:  # noqa: BLE001 -- verification never raises; anything unexpected is "not verified"
        # A bad signature, malformed hex, a non-dict or non-JSON announcement,
        # or an error such as RecursionError on a pathological payload.
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


def _inside_checkout(directory):
    """True when *directory* is inside a git work tree. The walk stops at the
    user's home without checking it, so a dotfiles repository there does not
    count."""
    home = os.path.realpath(os.path.expanduser("~"))
    current = os.path.realpath(directory)
    while current != home and current != os.path.dirname(current):
        if os.path.exists(os.path.join(current, ".git")):
            return True
        current = os.path.dirname(current)
    return False


def _tighten_permissions(path):
    """A key file must be readable by its owner only: correct a wider mode, or refuse."""
    if os.name != "posix":
        return
    mode = os.stat(path).st_mode & 0o777
    if mode & 0o077:
        try:
            os.chmod(path, 0o600)
        except OSError as err:
            raise KeyFileError(
                "%s is readable by other users (mode %o) and cannot be corrected: %s" % (path, mode, err)
            ) from None
        log.warning("%s was mode %o; corrected to 0600", path, mode)


def load_or_create_keys(path=None):
    """Load existing keys from *path* (default :func:`default_key_path`), or
    create and save new ones there.

    Loading checks the pair, not just its label: both keys must be exactly 64
    hex characters, the public key is derived from the secret (with pynacl)
    and must match the stored one, and neither may be on the denylist. A file
    readable by other users is corrected to 0600. A new file is created 0600
    from the start, and never inside a source checkout.

    Raises
    ------
    CompromisedKeyError
        The pair is in :data:`COMPROMISED_PUBLIC_KEYS`; delete the file so a
        new pair is generated.
    KeyFileError
        The file is malformed, its public key does not belong to its secret,
        its mode cannot be corrected, or it would be created in a checkout.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    abs_path = os.path.abspath(path if path is not None else default_key_path())

    if os.path.exists(abs_path):
        _tighten_permissions(abs_path)
        with open(abs_path) as f:
            data = json.load(f)
        public_hex = data.get("public") if isinstance(data, dict) else None
        secret_hex = data.get("secret") if isinstance(data, dict) else None
        try:
            public = _strict_hex(public_hex, 32)
            secret = _strict_hex(secret_hex, 32)
        except ValueError:
            raise KeyFileError(
                abs_path + " does not hold a key pair of two 64-hex-character keys"
            ) from None
        derived = bytes(nacl.signing.SigningKey(secret).verify_key) if _HAS_NACL else None
        if _is_compromised(public) or (derived is not None and _is_compromised(derived)):
            raise CompromisedKeyError(
                abs_path + " holds a key pair whose secret was published in a public "
                "repository; delete the file and restart to generate a new key pair"
            )
        if derived is not None and derived != public:
            raise KeyFileError(
                abs_path + " holds a public key that does not belong to its secret key "
                "(a file made without pynacl is not an Ed25519 pair); delete it to generate a new pair"
            )
        if derived is None:
            log.warning("pynacl is not installed: cannot check that %s holds a matching key pair", abs_path)
        return public_hex, secret_hex

    parent = os.path.dirname(abs_path)
    if _inside_checkout(parent or os.getcwd()):
        raise KeyFileError(
            "refusing to create a key file inside a source checkout (" + abs_path + "): a key "
            "there is one `git add` away from being published. Use the default under "
            "~/.pcc-node or a path outside the repository."
        )
    if parent:
        os.makedirs(parent, mode=0o700, exist_ok=True)
    public_hex, secret_hex = generate_node_keys()
    # 0600 from the first byte, and never over an existing file.
    fd = os.open(abs_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f, indent=2)

    return public_hex, secret_hex
