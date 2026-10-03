"""A host-wide hold on one physical device, and a one-shot record of each job (ADK item 12; astra 554, 565).

Two operating loops pointed at the same device, in one process or in two, must never drive
it at the same time, and a job must never run twice. Checking that the device is idle and
then running it are two separate steps, so they cannot provide this on their own.
HostDeviceLock provides it for every process on one host:

- **The device's identity is its own** (astra 565 F2). A URL is not an identity: localhost
  and 127.0.0.1, a CNAME or a second network interface all reach one device. So the hold is
  keyed by what the device reports about itself. The device binding names an identity
  endpoint, a path and a JSON field (for example ``GET /identity`` answering
  ``{"serial": "PR-0001"}``). It is read when the lock is built, so without an answer
  there is no lock and the loop can't start. It is read again each time the hold is taken,
  inside the hold: a device that now reports another identity is refused. The read uses no
  proxy (a proxy could answer for any device) and follows no redirect.
- **The hold.** ``acquire()`` takes an exclusive ``flock`` on a file named by the SHA-256 of
  the device's identity, without waiting. The kernel releases it when the holder closes it or
  exits, so a crashed loop never leaves the device held. Lock files are never deleted, so
  every process locks the same inode.
- **The one-shot record** (astra 565 F1). ``consume(job_key)`` creates a marker named by the
  SHA-256 of the job's key with ``O_CREAT|O_EXCL`` and syncs it to disk BEFORE the device is
  driven. The loop keys it by the job's id alone, so a job runs at most once on this host,
  under any claim. A run whose device state is unknown is never replayed: it waits for a
  human or a new job. A re-run is a new job (gateway #4835). Markers are never removed.

Both live in a private directory: ``~/.pcc-node/device-locks`` by default, created 0700 if it
is missing, and refused unless it is a real directory owned by this user with mode exactly
0700. Files are opened relative to that directory, never through a symlink.

The boundary: this covers the honest node processes of one OS user on one host, on a network
where a device's answers are its own. Two users, or two hosts, pointed at one device are
outside it. The gateway's claim route must serialize by this same device identity (#4835;
per kernel is not enough when two kernels can bind one device). Until it does, one node host
per device is a deployment rule.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import http.client
import json
import os
import stat
import threading
import urllib.error
import urllib.request
from typing import Optional
from urllib.parse import urlsplit

DEFAULT_DIRECTORY = os.path.join(os.path.expanduser("~"), ".pcc-node", "device-locks")
_CONSUMED = "consumed"
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
_FILE_FLAGS = os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
_IDENTITY_MAX_BYTES = 64 * 1024
_IDENTITY_MAX_CHARS = 128


class DeviceLockError(OSError):
    """The device's identity, the lock directory, or a file in it can't be trusted: nothing may be driven."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect is an answer from somewhere else, never the device's identity."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


def _device_base(url: str) -> str:
    parts = urlsplit(url) if isinstance(url, str) else None
    if parts is None or parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"not a device URL: {url!r}")
    return url.rstrip("/")


def _printable(value: str) -> bool:
    return 1 <= len(value) <= _IDENTITY_MAX_CHARS and all(33 <= ord(c) <= 126 for c in value)


def read_device_identity(url: str, path: str, field: str, *, timeout_s: float = 5.0) -> str:
    """What the device at ``url`` says it is: ``GET url+path``, a JSON object, its ``field``.

    The value must be a string (or a non-bool integer) of 1-128 visible ASCII characters.
    Anything else, any HTTP status but 200, a redirect, or an answer over 64 KB raises
    :class:`DeviceLockError`.
    """
    base = _device_base(url)
    if (not isinstance(path, str) or not path.startswith("/") or "?" in path or "#" in path
            or ".." in path.split("/")):
        raise ValueError(f"not an identity path: {path!r}")
    if not isinstance(field, str) or not field:
        raise ValueError("an identity needs the field that holds it")
    request = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    try:
        with _OPENER.open(request, timeout=timeout_s) as answer:
            status = answer.status
            raw = answer.read(_IDENTITY_MAX_BYTES + 1)
    except (OSError, ValueError, http.client.HTTPException) as why:  # URLError and HTTPError are OSErrors
        raise DeviceLockError(errno.EIO, f"device identity unreadable at {path}: {why}") from why
    if status != 200:
        raise DeviceLockError(errno.EIO, f"device identity answered HTTP {status}")
    if len(raw) > _IDENTITY_MAX_BYTES:
        raise DeviceLockError(errno.EIO, "device identity answer is too large")
    try:
        document = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as why:
        raise DeviceLockError(errno.EIO, "device identity answer is not JSON") from why
    value = document.get(field) if isinstance(document, dict) else None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise DeviceLockError(errno.EIO, f"device identity has no usable {field!r}")
    value = str(value)
    if not _printable(value):
        raise DeviceLockError(errno.EIO, f"device identity {field!r} is not 1-128 visible ASCII characters")
    return value


def _name(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _open_private_dir(path: str, dir_fd: Optional[int] = None) -> int:
    """Create ``path`` 0700 if it is missing, then open it without following a symlink and
    refuse it unless it is a directory owned by this user with mode exactly 0700."""
    try:
        os.mkdir(path, 0o700, dir_fd=dir_fd)
    except FileExistsError:
        pass
    try:
        fd = os.open(path, _DIR_FLAGS, dir_fd=dir_fd)
    except OSError as why:
        raise DeviceLockError(why.errno, f"device lock directory {path!r} cannot be opened: {why.strerror}") from why
    info = os.fstat(fd)
    problem = None
    if not stat.S_ISDIR(info.st_mode):
        problem = "is not a directory"
    elif info.st_uid != os.geteuid():
        problem = "is not owned by this user"
    elif stat.S_IMODE(info.st_mode) != 0o700:
        problem = f"is mode {stat.S_IMODE(info.st_mode):04o}, not 0700"
    if problem:
        os.close(fd)
        raise DeviceLockError(errno.EPERM, f"device lock directory {path!r} {problem}")
    return fd


def _let_go(fd: int) -> None:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


class HostDeviceLock:
    """This host's exclusive hold on one physical device, and its record of the jobs run here.

    ``device_url`` is the device binding's URL. ``identity_path`` and ``identity_field`` name
    where the device reports its identity. Construction reads that identity and raises
    :class:`DeviceLockError` if it can't, or if the directory is not this node's own, so a loop
    is never started without both. One object holds the device at most once: a second
    ``acquire()`` on the same object, before ``release()``, answers False.
    """

    def __init__(self, device_url: str, *, identity_path: str, identity_field: str,
                 directory: Optional[str] = None, timeout_s: float = 5.0) -> None:
        self._url, self._path, self._field, self._timeout = device_url, identity_path, identity_field, timeout_s
        self._identity = read_device_identity(device_url, identity_path, identity_field, timeout_s=timeout_s)
        directory = directory or DEFAULT_DIRECTORY
        parent = os.path.dirname(os.path.abspath(directory))
        if not os.path.isdir(parent):
            os.makedirs(parent, mode=0o700, exist_ok=True)
        self._dir: Optional[int] = _open_private_dir(directory)
        try:
            self._consumed: Optional[int] = _open_private_dir(_CONSUMED, dir_fd=self._dir)
        except BaseException:
            os.close(self._dir)
            raise
        self._lock_name = _name("device:" + self._identity) + ".lock"
        self._mutex = threading.Lock()
        self._fd: Optional[int] = None

    @property
    def identity(self) -> str:
        """The identity the device reported when this lock was built: what the hold is keyed by."""
        return self._identity

    def acquire(self) -> bool:
        """Take the hold without waiting: True if this object now holds the device, False if
        anything else does (another process, or another lock object in this one).

        Inside the hold, the device is asked who it is again. If it can't answer, or now reports
        another identity, the hold is let go and :class:`DeviceLockError` is raised.
        """
        with self._mutex:
            if self._fd is not None:
                return False
            try:
                fd = os.open(self._lock_name, os.O_RDWR | os.O_CREAT | _FILE_FLAGS, 0o600, dir_fd=self._dir)
            except OSError as why:
                raise DeviceLockError(why.errno, f"device lock file cannot be opened: {why.strerror}") from why
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                os.close(fd)
                raise DeviceLockError(errno.EPERM, "device lock file is not this user's regular file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as why:
                os.close(fd)
                if why.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
                    return False
                raise DeviceLockError(why.errno, f"device lock cannot be taken: {why.strerror}") from why
            try:
                now = read_device_identity(self._url, self._path, self._field, timeout_s=self._timeout)
            except BaseException:
                _let_go(fd)
                raise
            if now != self._identity:
                _let_go(fd)
                raise DeviceLockError(errno.EPERM, "the device at this URL now reports another identity")
            self._fd = fd
            return True

    def release(self) -> None:
        """Let go of the hold. The lock file stays, so the next holder locks the same inode."""
        with self._mutex:
            fd, self._fd = self._fd, None
        if fd is not None:
            _let_go(fd)

    def consume(self, job_key: str) -> bool:
        """Record, before the device is driven, that this job runs now.

        True the first time for a key; False if the job was ever started on this host.
        Raises :class:`DeviceLockError` if the record cannot be made durable, so a job is
        never run without it.
        """
        if not isinstance(job_key, str) or not job_key:
            raise ValueError("a job needs a key")
        try:
            fd = os.open(_name(job_key), os.O_WRONLY | os.O_CREAT | os.O_EXCL | _FILE_FLAGS, 0o600,
                         dir_fd=self._consumed)
        except FileExistsError:
            return False
        except OSError as why:
            raise DeviceLockError(why.errno, f"job record cannot be created: {why.strerror}") from why
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self._consumed)
        return True

    def close(self) -> None:
        """Release the hold and close the directories."""
        self.release()
        consumed, self._consumed = self._consumed, None
        directory, self._dir = self._dir, None
        for fd in (consumed, directory):
            if fd is not None:
                os.close(fd)
