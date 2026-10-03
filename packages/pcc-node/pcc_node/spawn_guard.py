"""A runtime guard on process starts: an audit hook installed when pcc-node starts.

The no-shell guard (tests/test_no_shell_execution.py) reads the package's syntax. Static rules lose
to new spellings, so this one watches what CPython actually does (the steward's ruling after 105g).
:func:`install` adds a PEP 578 audit hook (``sys.addaudithook``) that refuses, by raising
:class:`SpawnRefused`, every audited event that starts a process or loads native code -- except a
``subprocess.Popen`` of one of the fixed executables pcc-node runs (:data:`EXECUTABLES`), checked
against the binary pinned at startup (best-effort -- the hard guarantee is the OS layer; see
Boundary). However the call was reached -- an alias, a re-export, ``getattr``, ``string.Formatter``,
``exec``, a process pool -- the event is what it sees.

Refused events: ``subprocess.Popen`` (unless allowed as below); ``os.system``, ``os.exec``,
``os.spawn``, ``os.posix_spawn``, ``os.fork``, ``os.forkpty``, ``os.startfile``, ``pty.spawn``;
``ctypes.dlopen``; ``_winapi.CreateProcess``.

Tamper resistance (verdict 105j/105k HIGH 1). The 105i threat is evaluated Python, so the hook must
not decide anything from state evaluated Python can reassign. :func:`install` copies into closure
locals: the policy (:data:`EXECUTABLES`, the refused set, both frozen), ``isinstance`` and the
sequence types, and the *functions* the hook calls -- ``os.fsdecode``, ``os.getenv``, ``shutil.which``
and ``os.stat``. The hook dereferences no module global, so reassigning ``spawn_guard.os`` /
``spawn_guard.shutil`` or the module policy, or shadowing a builtin, cannot weaken it. (Rebinding the
real ``os.environ`` name does not help an attacker: the OS resolves ``PATH`` from the C environment,
which only in-place ``os.environ[...]`` mutation changes -- and ``os.getenv`` reflects that and the
guard refuses it.)

Executable identity, not a bare name (verdict 105k HIGH 2). At install each allowed name is resolved
against the absolute components of the startup ``PATH`` and pinned by its inode ``(st_dev, st_ino)``.
An allowed ``subprocess.Popen`` must: pass an argv list whose argv[0] is a pinned name with no
``executable=`` override; pass no per-call ``env`` and no ``cwd``; run with the startup ``PATH``
unchanged and containing no relative or empty component (which ``cwd`` could redirect); and resolve,
right now, to the pinned realpath and inode (so a replaced, symlinked or shadowed binary is refused).

Scope. The hook is installed only on POSIX. pcc-node's device executables are POSIX tools; on Windows
the ``subprocess.Popen`` audit event carries a rendered command line, not an argv list, and a sound
check of ``_winapi.CreateProcess``'s application-name against the pinned paths needs a Windows host to
test -- that is tracked follow-up, so on Windows :func:`install` is a no-op and the node runs
unguarded (as it did before this layer existed).

Boundary (steward ruling 10/03, after 105j/105k/105l). This hook is the ACCIDENTAL-spawn check: it
catches a careless or mistaken spawn in pcc-node's own code, however reached. It is NOT a sandbox
against code already running in the process. Ordinary in-process Python -- no ``gc``/``ctypes``/frame
needed -- can still defeat the *allowed* path: mutate a captured function's ``__code__`` so the hook
misreads the executable (105l HIGH 1), or pass a ``preexec_fn`` (absent from the ``subprocess.Popen``
audit tuple, so the hook cannot see it) or race a thread to swap the binary between the audit-time
``stat`` and ``execvp`` -- an irreducible TOCTOU (105l HIGH 2). The HARD guarantee -- that pcc-node can
execute only the pinned utilities -- is enforced below this hook, by two kernel layers together
(verdict 105n): a Landlock execute restriction applied in process (:mod:`pcc_node._landlock`, which
blocks re-executing the interpreter and every non-pinned binary, and is mandatory) and an AppArmor
profile applied at deploy time (:mod:`deploy/apparmor/pcc-node`, which closes the ELF-loader gadget
Landlock leaves). See ``deploy/README.md``. The hook still runs before the CLI and its dependencies import
(:func:`pcc_node._entry.run`), so an accidental import-time spawn is refused; the tests call
``main``/``run_daemon`` directly and never install it in-process.
"""

import os
import shutil
import sys
import threading
from typing import Any, Tuple

# The executables pcc-node runs, by bare name: the documented allowlist (the static guard's census
# couples spawn_guard.EXECUTABLES to it). install() pins each to an absolute path + inode and closes
# over the result, so reassigning this name cannot weaken an installed hook.
EXECUTABLES = frozenset({"arp", "dd", "ffmpeg", "journalctl", "sysctl", "v4l2-ctl"})

# Audited events that start a process or load native code. subprocess.Popen is handled on its own.
REFUSED_EVENTS = frozenset({
    "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "os.startfile",
    "pty.spawn", "ctypes.dlopen", "_winapi.CreateProcess",
})

_installed = False
_install_lock = threading.Lock()


class SpawnRefused(RuntimeError):
    """pcc-node's spawn guard refused a process start (or native code that could make one)."""


def install() -> None:
    """Install the spawn guard for the rest of this process (once; later calls do nothing).

    POSIX only: on Windows it is a no-op (see the module docstring's Scope note).
    """
    global _installed
    with _install_lock:
        if _installed or sys.platform == "win32":
            return
        # Capture every name the hook uses as a closure local, from the real modules, now -- the hook
        # dereferences no module global (verdict 105k HIGH 1). These are attribute reads, which the
        # static no-shell guard allows (unlike binding the bare `os` module).
        executables = frozenset(EXECUTABLES)
        refused = frozenset(REFUSED_EVENTS)
        _isinstance = isinstance
        _seqs = (list, tuple)
        _fsdecode = os.fsdecode
        _getenv = os.getenv
        _which = shutil.which
        _stat = os.stat
        Refused = SpawnRefused

        def _absolute_path(value: Any) -> str:
            # The PATH to resolve against: only its absolute (POSIX, "/"-rooted) components, in order.
            # A relative or empty component is where cwd/chdir could point a bare name at an attacker's
            # binary. The guard is POSIX-only, so the separator is ":".
            try:
                text = _fsdecode(value)
            except TypeError:
                return ""
            return ":".join(c for c in text.split(":") if c.startswith("/"))

        def _pin(name: str, path: str):
            p = _which(name, path=path or None)
            if p is None:
                return None
            try:
                st = _stat(p)
            except OSError:
                return None
            return (st.st_dev, st.st_ino)  # the inode: identity independent of path or symlink

        startup_path = _getenv("PATH") or ""
        startup_absolute = _absolute_path(startup_path)
        pinned = {name: _pin(name, startup_absolute) for name in executables}
        pinned = {name: ident for name, ident in pinned.items() if ident is not None}

        def _bare(value: Any) -> str:
            try:
                return _fsdecode(value)
            except TypeError:
                return ""

        def _hook(event: str, args: Tuple[Any, ...]) -> None:
            if event == "subprocess.Popen":
                executable, argv = args[0], args[1]
                if not _isinstance(argv, _seqs) or not argv:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: the arguments are not a list")
                first, chosen = _bare(argv[0]), _bare(executable)
                if chosen != first:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: executable {chosen!r} replaces {first!r}")
                if first not in pinned:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: {first!r} is not a device executable pinned at startup")
                if (args[3] if len(args) > 3 else None) is not None:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: a per-call env could repoint the bare name")
                if (args[2] if len(args) > 2 else None) is not None:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: a cwd could repoint the bare name")
                live = _getenv("PATH") or ""
                if live != startup_path:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: PATH changed since startup")
                if _absolute_path(live) != live:
                    raise Refused("pcc-node spawn guard: refused subprocess.Popen: PATH has a relative or empty component")
                resolved = _which(first, path=startup_absolute or None)
                if resolved is None:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: {first!r} no longer resolves on PATH")
                try:
                    st = _stat(resolved)
                except OSError:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: cannot stat {first!r}")
                if (st.st_dev, st.st_ino) != pinned[first]:
                    raise Refused(f"pcc-node spawn guard: refused subprocess.Popen: {first!r} is not the binary pinned at startup")
                return
            if event in refused:
                raise Refused(f"pcc-node spawn guard: refused {event}")

        sys.addaudithook(_hook)
        _installed = True


def installed() -> bool:
    """Whether this process has the spawn guard."""
    return _installed
