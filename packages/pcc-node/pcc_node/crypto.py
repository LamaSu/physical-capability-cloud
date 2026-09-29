"""Cryptographic utilities for PCC node identity.

Generates, loads and uses Ed25519 key pairs for signing capability
announcements. PyNaCl is REQUIRED for every key operation. Without it a node
cannot create, load or sign with a key (CryptoUnavailableError), because it
cannot derive the Ed25519 public key that the denylist and the pair check
need. Verification never falls back either: without PyNaCl no signature
verifies.
"""

import errno
import json
import os
import logging
import re
import stat

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


class CryptoUnavailableError(RuntimeError):
    """PyNaCl is not installed, so no key can be created, loaded or used."""


def _require_nacl(action):
    if not _HAS_NACL:
        raise CryptoUnavailableError(
            "PyNaCl is required to %s: without it the node cannot establish its Ed25519 "
            "identity or check it against the denylist. Install pcc-node[crypto]." % action
        )


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
    _require_nacl("create an Ed25519 key pair")
    sk = nacl.signing.SigningKey.generate()
    public_hex = sk.verify_key.encode(nacl.encoding.HexEncoder).decode("ascii")
    secret_hex = sk.encode(nacl.encoding.HexEncoder).decode("ascii")
    return public_hex, secret_hex


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
    CryptoUnavailableError
        PyNaCl is not installed: nothing could check the key, and nothing would
        verify the signature.
    """
    payload = _announcement_payload(announcement)
    secret = _strict_hex(secret_key_hex, 32)
    _require_nacl("sign")
    sk = nacl.signing.SigningKey(secret)
    if _is_compromised(bytes(sk.verify_key)):
        raise CompromisedKeyError(
            "refusing to sign with a key pair whose secret was published; generate a new key pair"
        )
    return sk.sign(payload).signature.hex()


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

KEY_PATH_ENV = "PCC_NODE_KEY_PATH"


def default_key_path():
    """Where a node keeps its key pair: ``$PCC_NODE_KEY_PATH`` when set,
    otherwise ``~/.pcc-node/keys.json``. Either way the file must lie outside
    every source checkout (see :func:`load_or_create_keys`). The old default,
    ``./pcc-keys.json``, resolved to a key file committed to the repository
    whenever the node ran from the package directory."""
    override = os.environ.get(KEY_PATH_ENV)
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".pcc-node", "keys.json")


def _checkout_root(directory):
    """The git work tree holding *directory* (symlinks resolved), or None.
    Every ancestor up to the filesystem root counts, the user's home included:
    a key file anywhere in a work tree is one ``git add`` from being published."""
    current = os.path.realpath(directory)
    while True:
        if os.path.exists(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def _refuse_checkout(abs_path):
    root = _checkout_root(os.path.dirname(abs_path) or os.getcwd())
    if root is not None:
        raise KeyFileError(
            "refusing to use a key file inside a source checkout (%s is under %s): a key there "
            "is one `git add` away from being published. Set %s to a path outside every "
            "repository." % (abs_path, root, KEY_PATH_ENV)
        )


def _check_directory(directory):
    """The key's directory must belong to this user and be writable by no one
    else, or another user could swap the key file. POSIX only: Windows ACLs are
    not modelled here."""
    if os.name != "posix":
        return
    st = os.stat(directory)
    if st.st_uid != os.getuid():
        raise KeyFileError("%s is not owned by this user; keep the key in a directory you own" % directory)
    if st.st_mode & 0o022:
        raise KeyFileError(
            "%s is writable by other users (mode %o); run chmod 700 on it" % (directory, st.st_mode & 0o777)
        )


def _read_key_file(abs_path):
    """Open the key file itself, never through a symbolic link, and judge the
    same open file it reads: a regular file owned by this user, readable by the
    owner only (a wider mode is corrected on that descriptor, or refused)."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(abs_path, flags)
    except OSError as err:
        if err.errno == errno.ELOOP:
            raise KeyFileError(abs_path + " is a symbolic link; a key file must be a regular file") from None
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise KeyFileError(abs_path + " is not a regular file")
        if os.name == "posix":
            if st.st_uid != os.getuid():
                raise KeyFileError(abs_path + " is not owned by this user")
            mode = st.st_mode & 0o777
            if mode & 0o077:
                try:
                    os.fchmod(fd, 0o600)
                except OSError as err:
                    raise KeyFileError(
                        "%s is readable by other users (mode %o) and cannot be corrected: %s" % (abs_path, mode, err)
                    ) from None
                log.warning("%s was mode %o; corrected to 0600", abs_path, mode)
        f = os.fdopen(fd, "r", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise
    with f:
        try:
            return json.load(f)
        except ValueError:
            raise KeyFileError(abs_path + " is not a JSON key file") from None


def load_or_create_keys(path=None):
    """Load existing keys from *path* (default :func:`default_key_path`), or
    create and save new ones there.

    Before anything is read or written, the location must lie outside every
    source checkout (symlinks resolved, the user's home included) in a
    directory owned by this user and writable by no one else. An existing file
    is read through one descriptor opened without following symbolic links.
    Loading checks the pair, not just its label: both keys are exactly 64 hex
    characters, the public key derived from the secret must match the stored
    one, and neither may be on the denylist. A new file is created 0600 from
    the first byte, never over an existing path.

    Raises
    ------
    CryptoUnavailableError
        PyNaCl is not installed, so the pair cannot be checked or used.
    CompromisedKeyError
        The pair is in :data:`COMPROMISED_PUBLIC_KEYS`; delete the file so a
        new pair is generated.
    KeyFileError
        The location is inside a checkout, the directory or file is not this
        user's own, the file is a symbolic link, malformed, or holds a public
        key that does not belong to its secret.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    _require_nacl("load or create the node's key pair")
    abs_path = os.path.abspath(path if path is not None else default_key_path())
    _refuse_checkout(abs_path)
    parent = os.path.dirname(abs_path)

    if os.path.lexists(abs_path):
        _check_directory(os.path.realpath(parent))
        data = _read_key_file(abs_path)
        public_hex = data.get("public") if isinstance(data, dict) else None
        secret_hex = data.get("secret") if isinstance(data, dict) else None
        try:
            public = _strict_hex(public_hex, 32)
            secret = _strict_hex(secret_hex, 32)
        except ValueError:
            raise KeyFileError(
                abs_path + " does not hold a key pair of two 64-hex-character keys"
            ) from None
        derived = bytes(nacl.signing.SigningKey(secret).verify_key)
        if _is_compromised(public) or _is_compromised(derived):
            raise CompromisedKeyError(
                abs_path + " holds a key pair whose secret was published in a public "
                "repository; delete the file and restart to generate a new key pair"
            )
        if derived != public:
            raise KeyFileError(
                abs_path + " holds a public key that does not belong to its secret key; "
                "delete it to generate a new pair"
            )
        return public_hex, secret_hex

    os.makedirs(parent, mode=0o700, exist_ok=True)
    _check_directory(os.path.realpath(parent))
    public_hex, secret_hex = generate_node_keys()
    # 0600 from the first byte, never over an existing path, never through a link.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(abs_path, flags, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"public": public_hex, "secret": secret_hex}, f, indent=2)

    return public_hex, secret_hex
