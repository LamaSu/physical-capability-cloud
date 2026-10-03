"""A runtime guard on process starts: an audit hook installed when pcc-node starts.

The no-shell guard (tests/test_no_shell_execution.py) reads the package's syntax. Static
rules lose to new spellings, so this one watches what CPython actually does instead (the
steward's ruling after verdict 105g). :func:`install` adds a PEP 578 audit hook
(``sys.addaudithook``) that refuses, by raising :class:`SpawnRefused`, every audited
event that starts a process or loads native code. The one exception is a
``subprocess.Popen`` of one of the fixed executables pcc-node runs (:data:`EXECUTABLES`),
by bare name, as an argument list, with no shell and no ``executable=`` override. That
covers the same starts the static guard allows, however the call was reached: through an
alias, a re-export, ``getattr``, ``string.Formatter``, ``exec`` or a process pool.

Refused events:
- ``subprocess.Popen``, unless it is an allowed start as above;
- ``os.system``, ``os.exec``, ``os.spawn``, ``os.posix_spawn``, ``os.fork``,
  ``os.forkpty``, ``os.startfile``, ``pty.spawn``;
- ``ctypes.dlopen`` (native code could start a process without any audited call);
- ``_winapi.CreateProcess``, except the one start an allowed ``subprocess.Popen`` makes on
  Windows, matched by its exact command line.

Boundary: an audit hook is not a sandbox. It sees only what CPython audits. Native code
that is already loaded, or a C extension that calls the C library itself, goes around it.
The threat model is contributor code reaching a process through CPython's standard APIs.
The hook cannot be removed once installed, so :func:`install` runs once, at the console entry
point (``pcc_node.cli.run``) the installed ``pcc-node`` script uses; tests call ``main`` and
``run_daemon`` directly and so bypass it, keeping an unremovable hook out of the shared test
process. Optional modules that load native code when imported (zeroconf, through ifaddr) are
imported first, so they still work.
"""

import os
import subprocess
import sys
import threading
from typing import Any, Tuple

# The executables pcc-node runs, by bare name. The static guard's EXECUTABLES must be the
# same set (test_the_runtime_guard_allows_what_the_static_guard_allows).
EXECUTABLES = frozenset({"arp", "dd", "ffmpeg", "journalctl", "sysctl", "v4l2-ctl"})

REFUSED_EVENTS = frozenset({
    "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "os.startfile",
    "pty.spawn", "ctypes.dlopen",
})

_installed = False
_install_lock = threading.Lock()
_permit = threading.local()  # Windows: the command line an allowed Popen may hand to CreateProcess


class SpawnRefused(RuntimeError):
    """pcc-node's spawn guard refused a process start (or native code that could make one)."""


def _bare(name: Any) -> str:
    try:
        text = os.fsdecode(name)
    except TypeError:
        return ""
    return text


def _allowed_start(executable: Any, args: Any) -> Tuple[bool, str]:
    """Whether a subprocess.Popen event is an allowed start, and why not if it is not."""
    if not isinstance(args, (list, tuple)) or not args:
        return False, "the arguments are not a list"
    first, chosen = _bare(args[0]), _bare(executable)
    if first not in EXECUTABLES:
        return False, f"{first!r} is not one of the executables pcc-node runs"
    if chosen != first:
        return False, f"executable {chosen!r} replaces {first!r}"
    return True, ""


def _hook(event: str, args: Tuple[Any, ...]) -> None:
    if event == "subprocess.Popen":
        executable, argv = args[0], args[1]
        ok, why = _allowed_start(executable, argv)
        if not ok:
            raise SpawnRefused(f"pcc-node spawn guard: refused {event}: {why}")
        if sys.platform == "win32":
            _permit.command_line = subprocess.list2cmdline([_bare(a) for a in argv])
        return
    if event == "_winapi.CreateProcess":
        expected = getattr(_permit, "command_line", None)
        _permit.command_line = None
        if expected is not None and len(args) > 1 and args[1] == expected:
            return  # the start an allowed subprocess.Popen just made
        raise SpawnRefused(f"pcc-node spawn guard: refused {event}")
    if event in REFUSED_EVENTS:
        raise SpawnRefused(f"pcc-node spawn guard: refused {event}")


def install() -> None:
    """Install the spawn guard for the rest of this process (once; later calls do nothing)."""
    global _installed
    with _install_lock:
        if _installed:
            return
        try:
            import zeroconf  # noqa: F401  # ifaddr opens libc through ctypes when imported
        except ImportError:
            pass
        sys.addaudithook(_hook)
        _installed = True


def installed() -> bool:
    """Whether this process has the spawn guard."""
    return _installed
