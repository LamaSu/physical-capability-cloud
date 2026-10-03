"""Cryptographic utilities for PCC node identity.

Generates Ed25519 key pairs for signing capability announcements.
Uses pynacl if available, otherwise falls back to a hashlib-based
HMAC scheme (not real Ed25519, but sufficient for development).
"""

import errno
import hashlib
import hmac
import json
import os
import logging
import stat

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


_POSIX = os.name != "nt"
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
# open(O_NOFOLLOW) on a symlink fails with ELOOP (Linux, macOS) or EMLINK (FreeBSD).
_SYMLINK_ERRNOS = (errno.ELOOP, errno.EMLINK)


def default_keys_path():
    """The key file this node uses: PCC_NODE_KEYS_FILE, else ~/.pcc-node/keys.json."""
    return os.environ.get("PCC_NODE_KEYS_FILE") or DEFAULT_KEYS_PATH


def _check_dir(directory):
    """Refuse a key directory another account owns or can write to (POSIX).

    Whoever can write the directory can swap the key file in it (verdict
    105b, finding 6).
    """
    if not _POSIX:
        return
    st = os.stat(directory)
    if st.st_uid not in (os.getuid(), 0):
        raise KeyFileError(f"{directory} is owned by another account (uid {st.st_uid})")
    if st.st_mode & 0o022:
        raise KeyFileError(
            f"{directory} is writable by other users (mode {oct(st.st_mode & 0o777)}), so a key file "
            f"in it could be swapped. Restrict it with: chmod go-w {directory}"
        )


def _read_key_file(path, legacy=False):
    """Read a key file through one no-follow descriptor, checked with fstat.

    It must be a regular file owned by this account that no one else can
    read or write; the checks and the read use the same descriptor, so the
    file cannot be swapped between them (verdict 105b, findings 5 and 6). A
    0.1.x (*legacy*) file that others could read may already have been
    copied: it is restricted to 0600 and refused, so the node gets a new
    identity instead of keeping an exposed one.
    """
    try:
        fd = os.open(path, os.O_RDONLY | _NOFOLLOW | _CLOEXEC)
    except OSError as exc:
        if exc.errno in _SYMLINK_ERRNOS:
            raise KeyFileError(f"{path} is a symbolic link: pcc-node reads its key only from a regular file") from None
        raise
    with os.fdopen(fd, "r", encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise KeyFileError(f"{path} is not a regular file")
        if _POSIX:
            if st.st_uid != os.getuid():
                raise KeyFileError(f"{path} is owned by another account (uid {st.st_uid})")
            mode = st.st_mode & 0o777
            if mode & 0o077 and legacy:
                os.fchmod(f.fileno(), 0o600)
                raise KeyFileError(
                    f"{os.path.abspath(path)}, pcc-node 0.1.x's key file, was readable by other users "
                    f"(mode {oct(mode)}), so its secret key may have been copied. It is now 0600 and will "
                    f"not be adopted: move it aside and run again to create a new identity, then register "
                    f"the node again."
                )
            if mode & 0o077:
                raise KeyFileError(
                    f"{path} is readable or writable by other users (mode {oct(mode)}). "
                    f"Restrict it with: chmod 600 {path}"
                )
        return f.read()


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
        # Signing uses pynacl now, so nothing signed with this pair verifies (verdict 105b, finding 9).
        raise KeyFileError(
            f"{path} was created without pynacl, so its public key is not an Ed25519 key and nothing "
            f"it signs can be verified. Move it aside, run again to create a real key, and register "
            f"the node again."
        )
    return public_hex, secret_hex


def _fsync_dir(directory):
    """Make a new directory entry durable (POSIX; best effort where unsupported)."""
    if not _POSIX:
        return
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _create_exclusive(path, public_hex, secret_hex):
    """Install a new owner-only key file atomically. False if *path* already exists.

    The pair is written and fsynced to a private temporary file, then linked
    into place: a failed write leaves no partial key file, and the link fails
    rather than replace a key another process created first (verdict 105b,
    finding 8).
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, mode=0o700, exist_ok=True)
    _check_dir(directory)
    tmp = os.path.join(directory, f".{os.path.basename(path)}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"public": public_hex, "secret": secret_hex}, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            return False
        except OSError:
            # A filesystem without hard links: rename, unless the key appeared meanwhile.
            if os.path.lexists(path):
                return False
            os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    _fsync_dir(directory)
    return True


def _adopt_legacy(legacy, path):
    """Copy a 0.1.x key file from the working directory to *path*, owner-only.

    Only a regular file that this account owns and no one else can read, in a
    directory no one else can write, is adopted (verdict 105b, finding 5).
    The legacy file, private as required, is left in place for the operator
    to delete, and nothing is copied unless it holds a matching key pair.
    """
    _check_dir(os.path.dirname(os.path.abspath(legacy)))
    public_hex, secret_hex = _parse_keys(legacy, _read_key_file(legacy, legacy=True))
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
    directory is adopted once if it is plainly this account's, so the node
    keeps its registered identity.

    A new file is created atomically and owner-only (0600, in a 0700
    directory). KeyFileError is raised for a key file that is a symlink, is
    not a regular file, belongs to another account, can be read or written by
    other users, sits in a directory others can write, or whose public key
    does not belong to its secret.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    if path is None:
        path = default_keys_path()
        if not os.path.lexists(path) and os.path.lexists(LEGACY_KEYS_PATH):
            _adopt_legacy(LEGACY_KEYS_PATH, path)
    abs_path = os.path.abspath(path)

    if not os.path.lexists(abs_path):
        public_hex, secret_hex = generate_node_keys()
        if _create_exclusive(abs_path, public_hex, secret_hex):
            return public_hex, secret_hex
        # Another process created it first: use that one.

    _check_dir(os.path.dirname(abs_path))
    return _parse_keys(abs_path, _read_key_file(abs_path))
