"""The runtime spawn guard behind the static no-shell guard (steward #5194/#5224, verdicts 105i/105j).

The static guard (test_no_shell_execution.py) reads the package's syntax, so a process start reached a
new way slips past it. This guard watches what CPython actually does: pcc_node.spawn_guard.install()
adds an audit hook that refuses every process start or native load except a subprocess.Popen of a bare
device executable with the node's own environment.

Everything runs in child processes, because an audit hook cannot be removed once installed. The 105j
tests additionally confirm the hook is NOT disabled by the same evaluated Python it is meant to contain
(HIGH 1), does not trust an attacker-controlled PATH/env (HIGH 2), and is installed before the CLI's
dependencies import (HIGH 4). The guard is defense in depth, not a sandbox against Python that reaches
the interpreter's object graph (gc/ctypes/frame) -- that is the static import guard's and the
deployment's boundary.
"""

import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]  # packages/pcc-node, so a child's `import pcc_node` resolves
TMP = "/mnt/sparkbulk/tmp"


def _run_raw(code: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env.pop("PYTEST_CURRENT_TEST", None)  # a child must run as a real interpreter, not "under pytest"
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=str(PKG), env=env,
                          capture_output=True, text=True, timeout=90)


def _run_guarded(body: str) -> subprocess.CompletedProcess:
    return _run_raw("import pcc_node.spawn_guard as _g\n_g.install()\n" + textwrap.dedent(body))


def _attempt(op: str) -> subprocess.CompletedProcess:
    body = (
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n" + textwrap.indent(textwrap.dedent(op), "    ") + "\n    print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
        "except BaseException as e:\n    print('OTHER:' + type(e).__name__)\n"
    )
    return _run_guarded(body)


# ---- the standard spawn surface, reached every which way (astra 68/105e-105g and 105i) ------------
REFUSED_DIRECT = {
    "os.system": "import os; os.system('id')",
    "os.system via from-import alias": "from os import system as s; s('id')",
    "os aliased then .system (direct)": "import os as platform; platform.system('id')",
    "os.popen (opens a shell)": "import os; os.popen('id').read()",
    "subprocess shell=True": "import subprocess; subprocess.run('id', shell=True)",
    "subprocess bare, not allowlisted": "import subprocess; subprocess.run(['id'])",
    "subprocess full path to an allowed name": "import subprocess; subprocess.run(['/bin/dd', '--version'])",
    "subprocess executable= override": "import subprocess; subprocess.run(['dd', '--version'], executable='/bin/sh')",
    "os.execv": "import os; os.execv('/bin/true', ['/bin/true'])",
    "os.posix_spawn": "import os; os.posix_spawn('/bin/true', ['/bin/true'], {})",
    "os.fork": "import os; os.fork()",
    "os.forkpty": "import os; os.forkpty()",
    "pty.spawn": "import pty; pty.spawn('/bin/true')",
    "ctypes.CDLL": "import ctypes; ctypes.CDLL('libc.so.6')",
    "ctypes.cdll.LoadLibrary": "import ctypes; ctypes.cdll.LoadLibrary('libc.so.6')",
    "typing.get_type_hints evaluates data (105i M3)":
        "import typing\n"
        "C = type('C', (), {'__annotations__': {'x': \"__import__('os').system('id')\"}})\n"
        "typing.get_type_hints(C)",
}


@pytest.mark.parametrize("name", sorted(REFUSED_DIRECT))
def test_a_process_start_reached_any_of_these_ways_is_refused(name):
    r = _attempt(REFUSED_DIRECT[name])
    assert "REFUSED" in r.stdout, f"{name!r} was not refused: {r.stdout!r} {r.stderr!r}"
    assert "RAN" not in r.stdout, f"{name!r} ran: {r.stdout!r}"


@pytest.mark.parametrize(
    "op",
    [
        "import concurrent.futures as cf\nwith cf.ProcessPoolExecutor(max_workers=1) as ex:\n    ex.submit(abs, -7).result()",
        "import concurrent.futures as cf\nP = getattr(cf, 'ProcessPoolExecutor')\nwith P(max_workers=1) as ex:\n    ex.submit(abs, -7).result()",
    ],
    ids=["ProcessPoolExecutor", "ProcessPoolExecutor via getattr (105i M1)"],
)
def test_a_process_pool_cannot_start_a_worker(op):
    # The pool forks its worker off the caller's thread, so the refusal surfaces as a broken pool, not
    # SpawnRefused in the caller. The point is that the worker never ran: no result comes back.
    r = _attempt(op)
    assert "RAN" not in r.stdout, f"a pool worker ran: {r.stdout!r} {r.stderr!r}"
    assert "OTHER:" in r.stdout or "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


# ---- the allowed case still works ----------------------------------------------------------------
def test_a_device_executable_still_runs_by_bare_name():
    r = _attempt("import subprocess; subprocess.run(['dd', '--version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)")
    assert "RAN" in r.stdout, f"dd was refused: {r.stdout!r} {r.stderr!r}"


def test_asyncio_create_subprocess_exec_of_a_bare_executable_runs():
    r = _attempt(
        "import asyncio\n"
        "async def m():\n"
        "    p = await asyncio.create_subprocess_exec('dd', '--version',\n"
        "        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)\n"
        "    await p.wait()\n"
        "asyncio.run(m())"
    )
    assert "RAN" in r.stdout, f"create_subprocess_exec('dd') was refused: {r.stdout!r} {r.stderr!r}"


# ---- HIGH 1: the policy is not disable-able from evaluated / in-process Python --------------------
def _sentinel():
    fd, path = tempfile.mkstemp(dir=TMP)
    os.close(fd); os.unlink(path)
    return path


def test_evaluated_python_cannot_empty_the_policy():
    # astra's 105j HIGH 1 reproduction: a type-hint annotation that first empties REFUSED_EVENTS, then
    # spawns. The hook reads a closure copy of the policy, so emptying the module global does nothing.
    s = _sentinel()
    ann = ("__import__('pcc_node.spawn_guard', fromlist=['x']).__dict__.__setitem__("
           "'REFUSED_EVENTS', frozenset()) or __import__('os').system('touch " + s + "')")
    r = _run_guarded(
        "import typing\n"
        f"C = type('C', (), {{'__annotations__': {{'x': {ann!r}}}}})\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n    typing.get_type_hints(C); print('NO-EXCEPTION')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
        "except BaseException as e:\n    print('OTHER:' + type(e).__name__)\n"
    )
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran, f"the os.system bypass ran: {r.stdout!r} {r.stderr!r}"
    assert "REFUSED" in r.stdout, f"not refused: {r.stdout!r} {r.stderr!r}"


def test_reassigning_the_module_policy_does_not_weaken_an_installed_hook():
    # After install(), reassigning EXECUTABLES / REFUSED_EVENTS on the module must not change the hook.
    s = _sentinel()
    r = _run_guarded(
        "import pcc_node.spawn_guard as g, os\n"
        "g.EXECUTABLES = frozenset({'id', 'sh', 'touch'})\n"
        "g.REFUSED_EVENTS = frozenset()\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n"
        f"    os.system('touch {s}'); print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
    )
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran and "REFUSED" in r.stdout, f"reassigning the policy weakened the hook: {r.stdout!r} {r.stderr!r}"


# ---- HIGH 2: a bare name is not allowed through an attacker's env / PATH --------------------------
def _fake_dd():
    d = tempfile.mkdtemp(dir=TMP)
    mark = Path(d, "RAN")
    fake = Path(d, "dd")
    fake.write_text(f'#!/bin/sh\n: > "{mark}"\n')
    fake.chmod(0o755)
    return d, mark


def test_a_per_call_env_is_refused():
    d, mark = _fake_dd()
    r = _attempt(f"import subprocess; subprocess.run(['dd'], env={{'PATH': {d!r}}})")
    assert not mark.exists(), f"a fake dd ran via per-call env: {r.stdout!r} {r.stderr!r}"
    assert "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


def test_a_changed_process_PATH_is_refused():
    d, mark = _fake_dd()
    r = _attempt(f"import os, subprocess\nos.environ['PATH'] = {d!r}\nsubprocess.run(['dd'])")
    assert not mark.exists(), f"a fake dd ran via a mutated PATH: {r.stdout!r} {r.stderr!r}"
    assert "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


# ---- MEDIUM 7: the 105i reaches that were untested --------------------------------------------------
@pytest.mark.parametrize(
    "op",
    ["from click import utils; utils.launch('https://127.0.0.1:0/x')",
     "from click import utils; utils.edit('x')"],
    ids=["click.utils.launch", "click.utils.edit"],
)
def test_click_public_submodule_launchers_are_refused(op):
    pytest.importorskip("click")
    r = _attempt(op)
    # click opens the URL/editor through a non-allowlisted subprocess; it must not complete.
    assert "RAN" not in r.stdout, f"a click launcher ran: {r.stdout!r} {r.stderr!r}"


def test_a_real_cross_module_star_reexport_is_refused():
    # A genuine two-module `import *` re-export of os (not a same-file alias): helper re-exports os as
    # `platform`; consumer does `from helper import *` and calls platform.system.
    s = _sentinel()
    d = tempfile.mkdtemp(dir=TMP)
    Path(d, "helper_mod.py").write_text("import os as platform\n")
    Path(d, "consumer_mod.py").write_text("from helper_mod import *\n")
    r = _run_guarded(
        f"import sys; sys.path.insert(0, {d!r})\n"
        "import consumer_mod\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n"
        f"    consumer_mod.platform.system('touch {s}'); print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
    )
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran and "REFUSED" in r.stdout, f"a cross-module re-export ran: {r.stdout!r} {r.stderr!r}"


# ---- HIGH 4 / wiring ------------------------------------------------------------------------------
def test_importing_the_entry_module_does_not_install_the_hook_in_process():
    # Importing pcc_node._entry must not install the hook (that would poison any in-process importer);
    # and it must not import the CLI at module load, so run() can install before the CLI's deps load.
    r = _run_raw(
        "import sys, pcc_node._entry as e\n"
        "from pcc_node.spawn_guard import installed\n"
        "print('installed' if installed() else 'not-installed', 'cli' if 'pcc_node.cli' in sys.modules else 'no-cli')\n"
    )
    assert r.stdout.strip().splitlines()[-1] == "not-installed no-cli", (r.stdout, r.stderr)


def test_the_console_entry_installs_the_guard_then_dispatches():
    # cli.run via _entry.run installs the guard, then imports and calls the CLI. Stub main so nothing
    # dispatches; after run() the hook is live and the CLI has been imported (so it loaded under it).
    r = _run_raw(
        "import pcc_node.cli as c\n"
        "c.main = lambda *a, **k: None\n"
        "import pcc_node._entry as e\n"
        "e.run()\n"
        "import sys\n"
        "from pcc_node.spawn_guard import SpawnRefused, installed\n"
        "assert installed() and 'pcc_node.cli' in sys.modules, 'entry did not install + import cli'\n"
        "import os\n"
        "try:\n    os.system('id'); print('NOT-REFUSED')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
    )
    assert r.stdout.strip().splitlines()[-1] == "REFUSED", (r.stdout, r.stderr)


def test_install_is_idempotent_and_reports_state():
    r = _run_guarded("import pcc_node.spawn_guard as g\ng.install()\nprint('INSTALLED' if g.installed() else 'NOT')\n")
    assert r.stdout.strip().splitlines()[-1] == "INSTALLED", (r.stdout, r.stderr)
