"""A host-wide hold on one device, and a one-shot record of each job (ADK item 12, astra 554 F1).

Two operating loops pointed at the same device, in one process or in two, must never drive
it at the same time, and a claimed job must never run twice. Checking that the device is idle
and then running it are two separate steps, so they cannot provide this on their own.
HostDeviceLock provides it for every process on one host:

- **The hold.** ``acquire()`` takes an exclusive ``flock`` on a file named by the SHA-256 of
  the device's key, without waiting. The kernel releases it when the holder closes it or
  exits, so a crashed loop never leaves the device held. Lock files are never deleted, so
  every process locks the same inode.
- **The one-shot record.** ``consume(job_key)`` creates a marker named by the SHA-256 of the
  job's key with ``O_CREAT|O_EXCL`` and syncs it to disk BEFORE the device is driven. A job
  whose marker exists is never run again on this host, even after a crash or a restart.

Both live in a private directory: ``~/.pcc-node/device-locks`` by default, created 0700 if it
is missing, and refused unless it is a real directory owned by this user with mode exactly
0700. Files are opened relative to that directory, never through a symlink.

The boundary: this covers the honest node processes of one OS user on one host. Two users,
or two hosts, pointed at one device are outside it. One node host (and user) per device is
a deployment rule, and an authoritative rule across hosts belongs in the gateway's claim
route, not here.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import os
import stat
import threading
from typing import Optional
from urllib.parse import urlsplit

DEFAULT_DIRECTORY = os.path.join(os.path.expanduser("~"), ".pcc-node", "device-locks")
_CONSUMED = "consumed"
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
_FILE_FLAGS = os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


class DeviceLockError(OSError):
    """The lock directory or a file in it is not this node's own: nothing may be driven."""


def device_key(url: str) -> str:
    """A device URL's identity for locking: ``scheme://host:port``, lowercase, the port explicit.

    Two spellings of one device (``HTTP://Host`` and ``http://host:80``) get one key. It is an
    identity for honest processes on one host, not a security boundary.
    """
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    if scheme not in ("http", "https") or not host:
        raise ValueError(f"not a device URL: {url!r}")
    port = parts.port or (443 if scheme == "https" else 80)
    if ":" in host:
        host = f"[{host}]"
    return f"{scheme}://{host}:{port}"


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


class HostDeviceLock:
    """This host's exclusive hold on one device, and its record of the jobs run here.

    Construction raises :class:`DeviceLockError` when the directory is not this node's own,
    so a loop is never started without it. One object holds the device at most once:
    a second ``acquire()`` on the same object, before ``release()``, answers False.
    """

    def __init__(self, key: str, directory: Optional[str] = None) -> None:
        if not isinstance(key, str) or not key:
            raise ValueError("a device lock needs the device's key")
        directory = directory or DEFAULT_DIRECTORY
        parent = os.path.dirname(os.path.abspath(directory))
        if not os.path.isdir(parent):
            os.makedirs(parent, mode=0o700, exist_ok=True)
        self._dir = _open_private_dir(directory)
        try:
            self._consumed = _open_private_dir(_CONSUMED, dir_fd=self._dir)
        except BaseException:
            os.close(self._dir)
            raise
        self._lock_name = _name(key) + ".lock"
        self._mutex = threading.Lock()
        self._fd: Optional[int] = None

    def acquire(self) -> bool:
        """Take the hold without waiting: True if this object now holds the device, False if
        anything else does (another process, or another lock object in this one)."""
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
            self._fd = fd
            return True

    def release(self) -> None:
        """Let go of the hold. The lock file stays, so the next holder locks the same inode."""
        with self._mutex:
            fd, self._fd = self._fd, None
        if fd is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)

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
