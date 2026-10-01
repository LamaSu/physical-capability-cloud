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
import sys

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
    that does not belong to its secret, readable by other users, with more than
    one name, or, at the moment it is loaded or created, inside a source
    checkout. Also raised where the platform cannot check that location."""


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
    except Exception:  # noqa: BLE001 -- any Exception is "not verified"
        # A bad signature, malformed hex, a non-dict or non-JSON announcement,
        # or an error such as RecursionError on a pathological payload.
        # KeyboardInterrupt and SystemExit are not Exceptions: they propagate,
        # so the call raises instead of returning, and never returns True.
        return False


# ---------------------------------------------------------------------------
# Key persistence
# ---------------------------------------------------------------------------

KEY_PATH_ENV = "PCC_NODE_KEY_PATH"


def default_key_path():
    """Where a node keeps its key pair: ``$PCC_NODE_KEY_PATH`` when set,
    otherwise ``~/.pcc-node/keys.json``. Either way the location is checked when
    the key is loaded or created (see :func:`load_or_create_keys`), and the file
    must then lie outside every source checkout. The old default,
    ``./pcc-keys.json``, resolved to a key file committed to the repository
    whenever the node ran from the package directory."""
    override = os.environ.get(KEY_PATH_ENV)
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".pcc-node", "keys.json")


# A sanity bound, not a limit anyone meets: ".." reaches the filesystem root long before.
_MAX_ANCESTORS = 4096


def _require_descriptor_support():
    """Fail closed where the location checks cannot be bound to the directory
    the key file is opened through.

    That binding needs file calls relative to a directory descriptor (``dir_fd``
    on ``os.open``, ``os.stat``, ``os.mkdir`` and ``os.unlink``, and
    ``follow_symlinks=False`` on ``os.stat``) and the ``O_DIRECTORY`` and
    ``O_NOFOLLOW`` open flags. POSIX systems have them; native Windows has
    none. Falling back to pathnames there would bring back the race this design
    closes, so the key is refused instead (A02b F1).

    The calls are matched by name, so an ``os`` function that something has
    wrapped is not mistaken for one the platform lacks.
    """
    with_dir_fd = {call.__name__ for call in os.supports_dir_fd}
    if (
        not {"open", "stat", "mkdir", "unlink"} <= with_dir_fd
        or "stat" not in {call.__name__ for call in os.supports_follow_symlinks}
        or not hasattr(os, "O_DIRECTORY")
        or not hasattr(os, "O_NOFOLLOW")
    ):
        raise KeyFileError(
            "this platform cannot open a key file relative to a verified directory (that needs dir_fd "
            "support in os.open, os.stat, os.mkdir and os.unlink, and the O_DIRECTORY and O_NOFOLLOW "
            "flags), so it cannot prove where the key lives; refusing to load or create a key here"
        )


_LINUX = sys.platform.startswith("linux")


def _unescape_mountinfo(field):
    """mountinfo writes a space, tab, newline or backslash in a path as a 3-digit octal escape."""
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), field)


def _mount_id_of(fd):
    """The mount id of an open descriptor (Linux, /proc/self/fdinfo)."""
    try:
        with open("/proc/self/fdinfo/%d" % fd, encoding="ascii") as f:
            return next(line.split()[1] for line in f if line.startswith("mnt_id:"))
    except (OSError, StopIteration, IndexError):
        raise _unreadable_mounts() from None


def _unreadable_mounts():
    return KeyFileError(
        "cannot read this process's mounts from /proc, so the key's location cannot be proven to be "
        "outside every source checkout; a location that is not proven is not used"
    )


def _mountinfo():
    """Every mount record this process can see (Linux, /proc/self/mountinfo), each
    ``{"id", "devno", "root", "mountpoint", "fstype", "source", "super"}``. ``root``
    is the path inside the filesystem the mount shows. Any unreadable or malformed
    record refuses: the six fixed fields, the ``-`` separator, and the fstype,
    source and super-options fields after it are all mandatory (review A02e)."""
    try:
        records = []
        with open("/proc/self/mountinfo", encoding="utf-8", errors="surrogateescape") as f:
            for line in f:
                fields = line.split()
                sep = fields.index("-")
                if sep < 6 or len(fields) < sep + 4:
                    raise ValueError("malformed mountinfo record")
                records.append({
                    "id": fields[0], "devno": fields[2], "root": _unescape_mountinfo(fields[3]),
                    "mountpoint": _unescape_mountinfo(fields[4]), "fstype": fields[sep + 1],
                    "source": _unescape_mountinfo(fields[sep + 2]), "super": fields[sep + 3],
                })
        if not records:
            raise ValueError("no mounts")
        return records
    except (OSError, ValueError, IndexError):
        raise _unreadable_mounts() from None


def _mount_of(fd):
    """The mount an open descriptor lives on (a :func:`_mountinfo` record), or None off
    Linux. On Linux an unreadable or malformed /proc refuses."""
    if not _LINUX:
        return None
    mnt_id = _mount_id_of(fd)
    for record in _mountinfo():
        if record["id"] == mnt_id:
            return record
    raise _unreadable_mounts()


# Filesystems whose files live in backing directories elsewhere (an overlay's upper
# directory receives every new file): the backing paths are not evaluated, so a key
# on one is refused (review A02e).
_UNION_FSTYPES = {"overlay", "aufs", "unionfs", "fuse.unionfs", "fuse.unionfs-fuse", "fuse.mergerfs"}


def _whole_filesystem(mount):
    """Does the mount show its whole filesystem (mount root ``/``, or a btrfs
    subvolume mounted as such)? A bind mount of a subtree does not. Other names of
    a whole filesystem (the same filesystem mounted again, or a btrfs top level
    showing the subvolume) are checked separately, by :func:`_refuse_aliases`."""
    if mount is None or mount["root"] == "/":
        return True
    return mount["fstype"] == "btrfs" and ("subvol=" + mount["root"]) in mount["super"].split(",")


def _refuse_bind_mounted(fd, key_path, what):
    mount = _mount_of(fd)
    if mount is not None and mount["fstype"] in _UNION_FSTYPES:
        raise KeyFileError(
            "refusing to use a key file on a union filesystem (%s %s is on a %s mount): its files are written "
            "to backing directories this check does not evaluate, and one may be inside a source checkout. Keep "
            "the key on an ordinary filesystem." % (key_path, what, mount["fstype"])
        )
    if not _whole_filesystem(mount):
        raise KeyFileError(
            "refusing to use a key file reached through a bind mount of a subtree (%s %s is on a mount of "
            "%r): the same file has other names this process cannot check, and one may be inside a source "
            "checkout. Keep the key on a filesystem mounted whole." % (key_path, what, mount["root"])
        )
    return mount


def _alias_paths(fs_path, mine, mounts):
    """Every other path, in this process's mounts, that shows the directory whose path
    inside its filesystem is *fs_path* (it lives on mount *mine*): each other mount of
    the same filesystem (the same device; for btrfs, the same source device) whose
    root contains *fs_path*."""
    same_fs = (lambda r: r["fstype"] == "btrfs" and r["source"] == mine["source"]) if mine["fstype"] == "btrfs" \
        else (lambda r: r["devno"] == mine["devno"])
    aliases = []
    for record in mounts:
        if record["id"] == mine["id"] or not same_fs(record):
            continue
        root = record["root"].rstrip("/")
        if fs_path != record["root"] and not fs_path.startswith(root + "/"):
            continue
        aliases.append(record["mountpoint"].rstrip("/") + fs_path[len(root):] or "/")
    return aliases


def _refuse_aliases(dir_fd, key_path):
    """Every other mount-visible name of the key's directory must lie outside every
    checkout too (review A02e): the same filesystem mounted again whole, a tmpfs
    mounted inside a checkout and bound elsewhere, a btrfs top level showing the
    subvolume. A name that resolves to another directory, or to nothing, is shadowed
    in this view and is not a name of this directory here. Linux only."""
    if not _LINUX:
        return
    mine = _mount_of(dir_fd)
    try:
        here = os.readlink("/proc/self/fd/%d" % dir_fd)
    except OSError:
        raise _unreadable_mounts() from None
    point = mine["mountpoint"].rstrip("/")
    if not here.startswith("/") or (here != (point or "/") and not here.startswith(point + "/")):
        raise _unreadable_mounts()
    rel = here[len(point):]
    fs_path = (mine["root"].rstrip("/") + rel) or "/"
    st = os.fstat(dir_fd)
    for alias in _alias_paths(fs_path, mine, _mountinfo()):
        try:
            alias_fd = os.open(alias, _directory_flags())
        except FileNotFoundError:
            continue
        except OSError as err:
            raise KeyFileError(
                "%s has another name, %s, that cannot be checked (%s); a location that is not proven is not "
                "used" % (key_path, alias, err)
            ) from None
        try:
            alias_st = os.fstat(alias_fd)
            if (alias_st.st_dev, alias_st.st_ino) == (st.st_dev, st.st_ino):
                _refuse_checkout(alias_fd, key_path, aliases=False)
        finally:
            os.close(alias_fd)


def _directory_flags():
    return os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0)


def _refuse_checkout(dir_fd, key_path, aliases=True):
    """Refuse when the directory open as *dir_fd* lies inside a git work tree.

    Decided from the open directory, never from a pathname. From *dir_fd* the
    walk goes up through ``..``, relative to each level's own descriptor, to
    this process's root directory (the level that IS ``/``: a bind mount can
    make another directory's ``..`` report that directory's own device and
    inode, so "``..`` is itself" does not prove the root; review A02c), and a
    ``.git``
    entry of ANY kind at ANY level, the starting directory included, means a
    work tree: a directory, a file (a linked work tree or a submodule), even a
    dangling symbolic link. The answer is about the directory the key file is
    then opened in, however the pathname that led there is pointed later. The
    user's home counts like any other directory: a key anywhere in a work tree
    is one ``git add`` from being published. A walk that cannot finish (an
    unreadable ancestor) refuses too: a location that is not proven is not used.

    On Linux every other mount-visible name of the directory is walked the same
    way (:func:`_refuse_aliases`), and no level may be on a union filesystem or a
    bind mount of a subtree.

    Descriptors opened here are closed here; *dir_fd* stays the caller's.
    """
    flags = _directory_flags()
    if aliases:
        # The directory's own mount is judged first: a union or subtree mount is refused
        # outright, before its other names are looked for.
        _refuse_bind_mounted(dir_fd, key_path, "has a directory that")
        _refuse_aliases(dir_fd, key_path)
    current = dir_fd
    try:
        root_fd = os.open("/", flags)
        try:
            root = os.fstat(root_fd)
            root_mount = _mount_of(root_fd)
        finally:
            os.close(root_fd)
        # The root is this process's "/" AND its mount: "/" bind-mounted somewhere below a
        # checkout has the same device and inode, on another mount (review A02d).
        root_id = (root.st_dev, root.st_ino, root_mount["id"] if root_mount else None)
        for level in range(_MAX_ANCESTORS):
            try:
                os.stat(".git", dir_fd=current, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                where = "in its directory" if level == 0 else "%d level%s above its directory" % (
                    level, "" if level == 1 else "s")
                raise KeyFileError(
                    "refusing to use a key file inside a source checkout (%s: a .git entry was found %s): "
                    "a key there is one `git add` away from being published. Set %s to a path outside "
                    "every repository." % (key_path, where, KEY_PATH_ENV)
                )
            here = os.fstat(current)
            mount = _refuse_bind_mounted(current, key_path, "has a directory that")
            if (here.st_dev, here.st_ino, mount["id"] if mount else None) == root_id:
                return  # this level IS the process's root directory: every level has been looked at
            above = os.open("..", flags, dir_fd=current)
            if current != dir_fd:
                os.close(current)
            current = above
        raise KeyFileError(
            "%s lies more than %d directories deep, so it cannot be proven to be outside a source "
            "checkout" % (key_path, _MAX_ANCESTORS)
        )
    except OSError as err:
        raise KeyFileError(
            "cannot tell whether %s is inside a source checkout (%s); a location that is not proven "
            "is not used" % (key_path, err)
        ) from None
    finally:
        if current != dir_fd:
            os.close(current)


def _check_directory(dir_fd, directory):
    """The key's directory, judged on the open descriptor, must belong to this
    user and be writable by no one else, or another user could swap the key
    file. (POSIX owners and modes: a platform without them never gets here, see
    :func:`_require_descriptor_support`.)"""
    st = os.fstat(dir_fd)
    if st.st_uid != os.getuid():
        raise KeyFileError("%s is not owned by this user; keep the key in a directory you own" % directory)
    if st.st_mode & 0o022:
        raise KeyFileError(
            "%s is writable by other users (mode %o); run chmod 700 on it" % (directory, st.st_mode & 0o777)
        )


def _open_key_directory(parent, key_path):
    """Open the directory the key file lives in, ONCE, and return its descriptor.

    Everything after this goes through that descriptor: the checkout check, the
    owner and mode check, and opening or creating the key file. The pathname
    *parent* is resolved to a directory once, here (when part of it does not
    exist yet, the deepest part that does is opened), so a directory link
    swapped afterwards changes nothing. Directories that do not exist yet are
    created (0700) one level at a time, relative to the descriptor of the level
    above, and only once the deepest existing directory has been shown to lie
    outside every checkout; the directory finally used is checked again.
    """
    flags = _directory_flags()
    missing = []
    probe = parent
    while True:
        try:
            dir_fd = os.open(probe, flags)
            break
        except FileNotFoundError:
            head, tail = os.path.split(probe)
            if not tail or head == probe:
                raise
            missing.append(tail)
            probe = head
    try:
        _refuse_checkout(dir_fd, key_path)
        if missing:
            for name in reversed(missing):
                try:
                    os.mkdir(name, 0o700, dir_fd=dir_fd)
                except FileExistsError:
                    pass
                child = os.open(name, flags | os.O_NOFOLLOW, dir_fd=dir_fd)
                dir_fd, above = child, dir_fd
                os.close(above)
            _refuse_checkout(dir_fd, key_path)
        _check_directory(dir_fd, parent)
        return dir_fd
    except BaseException:
        os.close(dir_fd)
        raise


def _judge_key_file(fd, key_path):
    """Judge the open file itself, never a name that may lead elsewhere: a
    regular file owned by this user, with exactly one name (a second hard link
    may sit inside a source checkout, where this file is published with it),
    readable by the owner only (a wider mode is corrected on this descriptor,
    or refused)."""
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        raise KeyFileError(key_path + " is not a regular file")
    # st_nlink counts hard links only: a bind mount of the file, or of a directory
    # above it, adds a name without adding a link (review A02d).
    _refuse_bind_mounted(fd, key_path, "itself")
    if st.st_uid != os.getuid():
        raise KeyFileError(key_path + " is not owned by this user")
    if st.st_nlink != 1:
        raise KeyFileError(
            "%s has %d hard links; a key file must have exactly one name, because another may sit "
            "inside a source checkout" % (key_path, st.st_nlink)
        )
    mode = st.st_mode & 0o777
    if mode & 0o077:
        try:
            os.fchmod(fd, 0o600)
        except OSError as err:
            raise KeyFileError(
                "%s is readable by other users (mode %o) and cannot be corrected: %s" % (key_path, mode, err)
            ) from None
        log.warning("%s was mode %o; corrected to 0600", key_path, mode)


_MAX_KEY_FILE_BYTES = 64 * 1024


def _read_key_file(dir_fd, name, key_path):
    """Open the key file *name* relative to the verified directory, never
    through a symbolic link, judge that same open file and parse it. Returns
    ``(fd, data)``: the descriptor stays OPEN, so the caller judges the same
    file again as its last step (review A02c). FileNotFoundError when there is
    no such file."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(name, flags, dir_fd=dir_fd)
    except OSError as err:
        if err.errno == errno.ELOOP:
            raise KeyFileError(key_path + " is a symbolic link; a key file must be a regular file") from None
        raise
    try:
        _judge_key_file(fd, key_path)
        chunks = []
        size = 0
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            size += len(chunk)
            if size > _MAX_KEY_FILE_BYTES:
                raise KeyFileError(key_path + " is too large to be a key file")
            chunks.append(chunk)
        try:
            data = json.loads(b"".join(chunks).decode("utf-8"))
        except ValueError:
            raise KeyFileError(key_path + " is not a JSON key file") from None
    except BaseException:
        os.close(fd)
        raise
    return fd, data


def _create_key_file(dir_fd, name, key_path, public_hex, secret_hex):
    """Create the key file *name* in the verified directory: 0600 from the
    first byte, never over an existing name, never through a link. The new
    descriptor is judged like an existing key file before the secret is
    written. Returns the descriptor, still OPEN: the caller judges the same
    file again as its last step, and on any refusal scrubs it through this
    descriptor before removing it (review A02c)."""
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(name, flags, 0o600, dir_fd=dir_fd)
    try:
        _judge_key_file(fd, key_path)
        payload = json.dumps({"public": public_hex, "secret": secret_hex}, indent=2).encode("utf-8")
        written = 0
        while written < len(payload):
            written += os.write(fd, payload[written:])
        os.fsync(fd)
    except BaseException as err:
        try:
            _scrub_and_remove(dir_fd, name, fd, key_path, err)
        finally:
            os.close(fd)
        raise
    return fd


def _scrub_and_remove(dir_fd, name, fd, key_path, cause):
    """A new key file that must not stay: empty it through its own descriptor
    first (so no secret survives even if removal fails), then remove its name.
    The descriptor is closed by the caller. A failed removal is reported, never
    treated as success."""
    emptied = False
    try:
        os.ftruncate(fd, 0)
        os.fsync(fd)
        emptied = True
    except OSError:
        # Truncation refused: overwrite every byte with zeros through the same descriptor instead.
        try:
            size = os.fstat(fd).st_size
            written = 0
            while written < size:
                n = os.pwrite(fd, b"\0" * min(65536, size - written), written)
                if n <= 0:
                    raise OSError(errno.EIO, "pwrite made no progress")
                written += n
            os.fsync(fd)
            emptied = True
        except OSError:
            emptied = False
    try:
        os.unlink(name, dir_fd=dir_fd)
    except OSError as err:
        if emptied:
            raise KeyFileError(
                "%s was refused, and the new key file could not be removed (it was emptied first: no secret "
                "remains in it): %s" % (key_path, err)
            ) from cause
        raise KeyFileError(
            "%s was refused, and the new key file could neither be emptied nor removed: THE SECRET MAY REMAIN "
            "in it. Delete %s by hand: %s" % (key_path, key_path, err)
        ) from cause


def load_or_create_keys(path=None):
    """Load existing keys from *path* (default :func:`default_key_path`), or
    create and save new ones there.

    The location is checked when the key is loaded or created, which for a
    daemon means at every start; nothing watches it afterwards, so a repository
    created around a key that is already loaded is not noticed until the next
    start. Within one call the checks are repeated as its LAST step, on the same
    open directory and the same open key file; what another process of this
    user changes after that step is outside any check (such a process can read
    the key anyway). A key created in this call and then refused is emptied
    through its descriptor (truncated, or else overwritten with zeros) before
    its name is removed; a failed removal is reported, and says plainly when
    the secret may remain.

    What is proven is relative to this process's view: no checkout is visible
    above the key through this process's root and mounts, the key has one hard
    link, and (on Linux) neither the key nor any directory above it is reached
    through a bind mount of a subtree, which would give it names this process
    cannot see. A checkout hidden above this process's root (a chroot or a
    mount namespace that shows only part of a tree) cannot be seen from here.

    Before anything is read or written, the directory the key file lives in is
    opened once and judged as that open directory, never by pathname. It, and
    every directory above it up to the filesystem root (the user's home
    included), must hold no ``.git`` entry, so the key lies outside every source
    checkout; and it must be owned by this user and writable by no one else.
    The key file is then opened or created relative to that same directory,
    never through a symbolic link. An existing file must be a regular file
    owned by this user with exactly one name (a second hard link could sit in a
    checkout); a new file is created 0600 from the first byte, never over an
    existing name. Directories that do not exist yet are created 0700. Where
    the platform cannot do this (no ``dir_fd`` calls, no ``O_DIRECTORY`` or
    ``O_NOFOLLOW``: native Windows), the key is refused.

    Loading checks the pair, not just its label: both keys are exactly 64 hex
    characters, the public key derived from the secret must match the stored
    one, and neither may be on the denylist.

    Raises
    ------
    CryptoUnavailableError
        PyNaCl is not installed, so the pair cannot be checked or used.
    CompromisedKeyError
        The pair is in :data:`COMPROMISED_PUBLIC_KEYS`; delete the file so a
        new pair is generated.
    KeyFileError
        The location is inside a checkout (or cannot be proven to be outside
        one) or the platform cannot check it, the directory or file is not this
        user's own, the file is a symbolic link or has more than one name, or
        it is malformed or holds a public key that does not belong to its
        secret.

    Returns
    -------
    tuple[str, str]
        (public_key_hex, secret_key_hex)
    """
    _require_nacl("load or create the node's key pair")
    _require_descriptor_support()
    abs_path = os.path.abspath(path if path is not None else default_key_path())
    parent, name = os.path.split(abs_path)
    if not name:
        raise KeyFileError(abs_path + " does not name a file")

    dir_fd = _open_key_directory(parent, abs_path)
    key_fd = None
    try:
        created = None
        try:
            key_fd, data = _read_key_file(dir_fd, name, abs_path)
        except FileNotFoundError:
            created = generate_node_keys()
            key_fd = _create_key_file(dir_fd, name, abs_path, *created)
        try:
            public_hex, secret_hex = created if created is not None else _checked_pair(data, abs_path)
            # The LAST step before the key is returned, on the same open directory and the
            # same open key file: no .git anywhere above the directory, and the file still a
            # regular, owner-only file of this user with exactly one name (review A02c). A
            # change another process of this user makes after this point is outside what any
            # check can stop: such a process can read the key anyway.
            _refuse_checkout(dir_fd, abs_path)
            _judge_key_file(key_fd, abs_path)
        except BaseException as err:
            if created is not None:
                _scrub_and_remove(dir_fd, name, key_fd, abs_path, err)
            raise
        return public_hex, secret_hex
    finally:
        if key_fd is not None:
            os.close(key_fd)
        os.close(dir_fd)


def _checked_pair(data, abs_path):
    """The key pair a loaded file holds, checked: two 64-hex-character keys, the
    public key derived from the secret, and neither on the denylist."""
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
