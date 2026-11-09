"""A host-wide hold on one physical device, and a durable record of each job's run (ADK item 12; astra 554, 565; steward #5981).

Two operating loops pointed at the same device, in one process or in two, must never drive
it at the same time, and a job must never run twice. Checking that the device is idle and
then running it are two separate steps, so they cannot provide this on their own.
HostDeviceLock provides it for every process on one host:

- **The device's identity is its serial, fixed at registration** (astra 565 F2; steward
  #5981, as #378 does for the OT-2). A URL is not an identity: localhost and 127.0.0.1, a
  CNAME or a second network interface all reach one device. So the hold is keyed by the
  device's registered serial, and the device must confirm it in ONE fixed place, the PCC
  device identity contract: ``GET /identity`` at the device's ROOT answering
  ``{"serial": "<its serial>"}`` (astra 565/573/580 F2). The device URL must be only
  ``scheme://host:port``, the rule the runtime already enforces, so no path prefix can move it. Nothing about where the serial is read can vary per binding, so two
  bindings of one device can't select two different values and hold it twice. When the lock
  is built, the device must report exactly the registered serial, or there is no lock and
  the loop can't start.
  Each time the hold is taken, inside the hold, it must report it again. The read uses no
  proxy (a proxy could answer for any device) and follows no redirect.
- **The hold.** ``acquire()`` takes an exclusive ``flock`` on a file named by the SHA-256 of
  the device's identity, without waiting. The kernel releases it when the holder closes it or
  exits, so a crashed loop never leaves the device held. Lock files are never deleted, so
  every process locks the same inode.
- **The run record** (astra 565 F1; steward #5981). Each job, keyed by its id alone (its
  execution identity, never a claim token), moves through durable states, each a marker
  file created with ``O_CREAT|O_EXCL`` and synced to disk before the step it guards:
  ``reserved`` (this host took the job; nothing sent yet), ``start_sent`` (written just
  before the device is driven), ``terminal`` (the run ended with a known outcome). A job
  whose ``start_sent`` has no ``terminal`` may have reached the device: it is never replayed,
  and only device reconciliation or a human resolves it. A ``terminal`` job never runs
  again. A safe retry is a new job (gateway #4835). Only ``reserved`` alone, with nothing
  sent, may go on. Markers are never removed; anything already at a marker's path, a
  symlink included, counts as present.

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

# The device URL rule the runtime already enforces (astra 580 F2: reuse, never reinvent):
# scheme://host:port and nothing else, so no path, query or fragment can move /identity.
from .runtime import _check_base_url

DEFAULT_DIRECTORY = os.path.join(os.path.expanduser("~"), ".pcc-node", "device-locks")
_RECORDS = "jobs"
#: The PCC device identity contract: every device the operating loop drives answers
#: GET IDENTITY_PATH with a JSON object whose IDENTITY_FIELD is its serial. Fixed, not per binding.
IDENTITY_PATH = "/identity"
IDENTITY_FIELD = "serial"
_MAX_TIMEOUT_S = 60.0
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
    """The device's origin, ``scheme://host:port``, by the runtime's own rule (runtime._check_base_url).

    A URL with a path (even ``/a``), a query, a fragment, credentials, or no explicit port is
    refused (BindingError, a ValueError), so the identity is always read at the device's root
    ``/identity``: a binding can't move it.
    """
    return _check_base_url(url)


def _printable(value: str) -> bool:
    return 1 <= len(value) <= _IDENTITY_MAX_CHARS and all(33 <= ord(c) <= 126 for c in value)


def _check_timeout(timeout_s: float) -> float:
    """A finite number of seconds in (0, 60]. None, a bool, or anything else is refused,
    never quietly read as "no timeout" (steward #5992)."""
    if isinstance(timeout_s, bool) or not isinstance(timeout_s, (int, float)):
        raise ValueError(f"timeout_s must be a number of seconds, not {timeout_s!r}")
    if not (0 < timeout_s <= _MAX_TIMEOUT_S):
        raise ValueError(f"timeout_s must be in (0, {_MAX_TIMEOUT_S:g}], not {timeout_s!r}")
    return float(timeout_s)


def read_device_identity(url: str, *, timeout_s: float = 5.0) -> str:
    """The serial the device at ``url`` reports: ``GET url + IDENTITY_PATH``, a JSON object,
    its ``IDENTITY_FIELD``.

    The value must be a string (or a non-bool integer) of 1-128 visible ASCII characters.
    Anything else, any HTTP status but 200, a redirect, or an answer over 64 KB raises
    :class:`DeviceLockError`.
    """
    base = _device_base(url)
    timeout_s = _check_timeout(timeout_s)
    path, field = IDENTITY_PATH, IDENTITY_FIELD
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

    ``device_url`` is the device binding's URL and ``serial`` the device's serial fixed at
    registration. The device reports its serial at the fixed identity contract
    (``GET /identity`` -> ``{"serial": ...}``); no binding chooses another place. Construction
    raises :class:`DeviceLockError` unless the device reports exactly that serial and the
    directory is this node's own, so a loop is never started without both.
    One object holds the device at most once: a second ``acquire()`` on the same object,
    before ``release()``, answers False.
    """

    def __init__(self, device_url: str, *, serial: str, directory: Optional[str] = None,
                 timeout_s: float = 5.0) -> None:
        if not isinstance(serial, str) or not _printable(serial):
            raise ValueError("a device lock needs the device's registered serial (1-128 visible ASCII characters)")
        self._url = device_url
        self._timeout = _check_timeout(timeout_s)
        self._serial = serial
        reported = read_device_identity(device_url, timeout_s=self._timeout)
        if reported != serial:
            raise DeviceLockError(errno.EPERM, "the device at this URL does not report its registered serial")
        directory = directory or DEFAULT_DIRECTORY
        parent = os.path.dirname(os.path.abspath(directory))
        if not os.path.isdir(parent):
            os.makedirs(parent, mode=0o700, exist_ok=True)
        self._dir: Optional[int] = _open_private_dir(directory)
        try:
            self._records: Optional[int] = _open_private_dir(_RECORDS, dir_fd=self._dir)
        except BaseException:
            os.close(self._dir)
            raise
        self._lock_name = _name("device:" + serial) + ".lock"
        self._mutex = threading.Lock()
        self._fd: Optional[int] = None

    @property
    def serial(self) -> str:
        """The registered serial the hold is keyed by."""
        return self._serial

    def acquire(self) -> bool:
        """Take the hold without waiting: True if this object now holds the device, False if
        anything else does (another process, or another lock object in this one).

        Inside the hold, the device must report its registered serial again. If it can't, or
        reports another, the hold is let go and :class:`DeviceLockError` is raised.
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
                now = read_device_identity(self._url, timeout_s=self._timeout)
            except BaseException:
                _let_go(fd)
                raise
            if now != self._serial:
                _let_go(fd)
                raise DeviceLockError(errno.EPERM, "the device at this URL no longer reports its registered serial")
            self._fd = fd
            return True

    def release(self) -> None:
        """Let go of the hold. The lock file stays, so the next holder locks the same inode."""
        with self._mutex:
            fd, self._fd = self._fd, None
        if fd is not None:
            _let_go(fd)

    # -- the run record -----------------------------------------------------------------

    def _present(self, name: str) -> bool:
        try:
            os.stat(name, dir_fd=self._records, follow_symlinks=False)
        except FileNotFoundError:
            return False
        except OSError as why:
            raise DeviceLockError(why.errno, f"job record unreadable: {why.strerror}") from why
        return True

    def _create(self, name: str, content: bytes, *, may_exist: bool = False) -> None:
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _FILE_FLAGS, 0o600, dir_fd=self._records)
        except FileExistsError:
            if may_exist:
                return
            raise DeviceLockError(errno.EEXIST, "job record already exists") from None
        except OSError as why:
            raise DeviceLockError(why.errno, f"job record cannot be created: {why.strerror}") from why
        try:
            if content:
                os.write(fd, content)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self._records)

    def reserve(self, job_key: str) -> str:
        """Take the job for a run on this host, durably, before anything is sent.

        Answers ``"reserved"`` (go on: nothing of it was sent to the device before),
        ``"start_sent"`` (an earlier attempt may have reached the device: it must be reconciled,
        never replayed) or ``"terminal"`` (it ran to a known end: never again). Raises
        :class:`DeviceLockError` if the record can't be read or made durable.
        """
        if not isinstance(job_key, str) or not job_key:
            raise ValueError("a job needs a key")
        base = _name(job_key)
        if self._present(base + ".terminal"):
            return "terminal"
        if self._present(base + ".start_sent"):
            return "start_sent"
        self._create(base + ".reserved", b"", may_exist=True)
        return "reserved"

    def mark_start_sent(self, job_key: str) -> None:
        """Record, durably and just before the device is driven, that this job's start is being sent."""
        self._create(_name(job_key) + ".start_sent", b"")

    def mark_terminal(self, job_key: str, outcome: str) -> None:
        """Record, durably, that this job's run ended with a known outcome."""
        self._create(_name(job_key) + ".terminal", str(outcome).encode("utf-8", "replace")[:256])

    def close(self) -> None:
        """Release the hold and close the directories."""
        self.release()
        records, self._records = self._records, None
        directory, self._dir = self._dir, None
        for fd in (records, directory):
            if fd is not None:
                os.close(fd)
