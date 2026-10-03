"""A runtime guard on process starts: an audit hook installed when pcc-node starts.

The no-shell guard (tests/test_no_shell_execution.py) reads the package's syntax. Static rules lose
to new spellings, so this one watches what CPython actually does (the steward's ruling after verdict
105g). :func:`install` adds a PEP 578 audit hook (``sys.addaudithook``) that refuses, by raising
:class:`SpawnRefused`, every audited event that starts a process or loads native code -- except a
``subprocess.Popen`` of one of the fixed executables pcc-node runs (:data:`EXECUTABLES`), by bare
name, as an argument list, with no shell, no ``executable=`` override, no per-call environment, and
an unchanged ``PATH``. That covers the same starts the static guard allows, however the call was
reached: an alias, a re-export, ``getattr``, ``string.Formatter``, ``exec``, or a process pool.

Refused events: ``subprocess.Popen`` (unless allowed as above); ``os.system``, ``os.exec``,
``os.spawn``, ``os.posix_spawn``, ``os.fork``, ``os.forkpty``, ``os.startfile``, ``pty.spawn``;
``ctypes.dlopen``; and ``_winapi.CreateProcess``.

Tamper resistance (verdict 105j HIGH 1). The 105i threat is evaluated Python, so the hook must not
decide anything from state evaluated Python can reassign. :func:`install` copies the policy
(:data:`EXECUTABLES` and the refused-event set, both frozen) and ``isinstance`` into closure locals,
so reassigning ``spawn_guard.EXECUTABLES``, mutating the refused set, or shadowing ``isinstance`` on
this module does not change the installed hook. It reads ``os.environ`` and ``os.fsdecode`` through
the ``os`` module, as the rest of the package does and as the static guard requires, so a
``spawn_guard.os`` reassignment is part of the object-graph boundary below, not a cheap policy bypass.

PATH / env (verdict 105j HIGH 2). A bare name resolves through ``PATH``, so an allowed start is
refused when the call passes its own ``env``, or when ``PATH`` differs from its value at startup --
either could point ``dd`` at an attacker's binary. pcc-node's own device calls pass no ``env`` and do
not touch ``PATH``.

Boundary. An audit hook is defense in depth, not a sandbox. It sees only what CPython audits, and it
is Python: code that reaches the interpreter's own object graph -- ``gc`` to find and rewrite the hook
object, ``ctypes`` or other native code, frame introspection -- can still get around any in-process
Python hook, and a dependency replaced on ``PYTHONPATH`` runs its own import-time code. Those belong
to the static import guard (#507 refuses ``gc``, ``ctypes`` and the like in package source) and to the
deployment (a trusted ``sys.path`` and vetted dependencies). Within that boundary the hook closes the
standard, audited spawn and native-load surface: the 105i reaches -- a ``getattr`` to
``ProcessPoolExecutor``, ``click.utils.launch``/``edit``, an allowlisted API that evaluates data, a
wildcard re-export of ``os`` -- all end in one of the refused events and are refused.

Placement. The hook cannot be removed once installed, so :func:`install` runs once, from the console
entry (:func:`pcc_node._entry.run`) before the CLI and its dependencies are imported, so no import-time
code runs ahead of it (verdict 105j HIGH 4). The tests call ``main`` and ``run_daemon`` directly and so
never install it in the shared test process. On Windows every ``subprocess.Popen`` (whose audit event
carries a rendered command-line string, not an argv list) and every ``_winapi.CreateProcess`` is
refused: pcc-node's device executables are POSIX, so the guard fails closed there.
"""

import os
import sys
import threading
from typing import Any, Tuple

# The executables pcc-node runs, by bare name: the documented allowlist. The static guard's census
# couples spawn_guard.EXECUTABLES to it; install() copies it into the hook's closure, so the hook is
# unaffected by any later reassignment of this name.
EXECUTABLES = frozenset({"arp", "dd", "ffmpeg", "journalctl", "sysctl", "v4l2-ctl"})

# Audited events that start a process or load native code. subprocess.Popen is handled on its own
# (it alone has an allowed case).
REFUSED_EVENTS = frozenset({
    "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "os.startfile",
    "pty.spawn", "ctypes.dlopen", "_winapi.CreateProcess",
})

_installed = False
_install_lock = threading.Lock()


class SpawnRefused(RuntimeError):
    """pcc-node's spawn guard refused a process start (or native code that could make one)."""


def install() -> None:
    """Install the spawn guard for the rest of this process (once; later calls do nothing)."""
    global _installed
    with _install_lock:
        if _installed:
            return
        # Capture everything the hook reads as closure locals now, so it reads nothing from this
        # module's (reassignable) globals -- the 105i threat is evaluated Python (verdict 105j HIGH 1).
        executables = frozenset(EXECUTABLES)
        refused = frozenset(REFUSED_EVENTS)
        _isinstance = isinstance
        _seqs = (list, tuple)
        trusted_path = os.environ.get("PATH")
        Refused = SpawnRefused

        def _bare(name: Any) -> str:
            try:
                return os.fsdecode(name)
            except TypeError:
                return ""

        def _hook(event: str, args: Tuple[Any, ...]) -> None:
            if event == "subprocess.Popen":
                executable, argv = args[0], args[1]
                if not _isinstance(argv, _seqs) or not argv:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: the arguments are not a list")
                first, chosen = _bare(argv[0]), _bare(executable)
                if first not in executables:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: {first!r} is not a device executable")
                if chosen != first:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: executable {chosen!r} replaces {first!r}")
                env = args[3] if len(args) > 3 else None
                if env is not None:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: a per-call env could repoint the bare name")
                if os.environ.get("PATH") != trusted_path:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: PATH changed since startup")
                return
            if event in refused:
                raise Refused(f"pcc-node spawn guard: refused {event}")

        sys.addaudithook(_hook)
        _installed = True


def installed() -> bool:
    """Whether this process has the spawn guard."""
    return _installed
