"""The runtime spawn guard behind the static no-shell guard (steward #5194/#5224, verdict 105i).

The static guard (test_no_shell_execution.py) reads the package's syntax, so a process start reached
a new way slips past it: 105i's four MEDIUMs are a Rule-8 name fetched with getattr, click.utils.launch
through the public submodule, typing.get_type_hints() evaluating data, and a `from .helper import *`
re-export. None is fixed at the syntax layer; each is closed here, at the spawn effect. pcc_node.
spawn_guard.install() adds an audit hook that refuses every process start or native load except a
subprocess.Popen of a device executable by bare name.

An audit hook cannot be removed once installed, so every case runs in its own child. The guard is NOT
a sandbox against native code; the threat model is contributor code reaching a process through
CPython's standard, audited APIs.
"""

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]  # packages/pcc-node, so a child's `import pcc_node` resolves


def _run_raw(code: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code], cwd=str(PKG), capture_output=True, text=True, timeout=90)


def _run_guarded(body: str) -> subprocess.CompletedProcess:
    return _run_raw("import pcc_node.spawn_guard as _g\n_g.install()\n" + textwrap.dedent(body))


def _attempt(op: str) -> subprocess.CompletedProcess:
    # Perform one spelling under the guard; the child prints exactly one of RAN / REFUSED / OTHER:<type>.
    body = (
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n" + textwrap.indent(textwrap.dedent(op), "    ") + "\n    print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
        "except BaseException as e:\n    print('OTHER:' + type(e).__name__)\n"
    )
    return _run_guarded(body)


# Spellings whose start happens in the calling thread, so SpawnRefused reaches it directly. The list
# replays astra's 68/105e-105g reaches and 105i's getattr / data-eval / re-export routes.
REFUSED_DIRECT = {
    "os.system": "import os; os.system('id')",
    "os.system via from-import alias": "from os import system as s; s('id')",
    "os module aliased (wildcard re-export, 105i M4)": "import os as platform; platform.system('id')",
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
    "runpy runs code that shells out": "import runpy, sys; sys.argv=['x']; exec(\"import os\\nos.system('id')\")",
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
    # The pool forks its worker in a management thread, so the refusal surfaces as a broken pool, not
    # SpawnRefused in the caller. The point is that the worker never ran: the result never comes back.
    r = _attempt(op)
    assert "RAN" not in r.stdout, f"a pool worker ran: {r.stdout!r} {r.stderr!r}"
    assert "OTHER:" in r.stdout or "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


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


def test_install_is_idempotent_and_reports_state():
    r = _run_guarded(
        "import pcc_node.spawn_guard as g\n"
        "g.install()  # again\n"
        "print('INSTALLED' if g.installed() else 'NOT')\n"
    )
    assert r.stdout.strip().splitlines()[-1] == "INSTALLED", (r.stdout, r.stderr)


def test_the_console_entry_installs_the_guard():
    # The guard goes on at the console entry (cli.run), which the installed `pcc-node` script runs and
    # which the suite bypasses by calling `main`/`run_daemon` directly -- so an unremovable hook never
    # lands in the shared test process. A RAW child calls cli.run with `main` stubbed (no command
    # dispatches), then checks the hook is live.
    r = _run_raw(
        "import pcc_node.cli as c\n"
        "c.main = lambda *a, **k: None   # don't dispatch a real command\n"
        "c.run()\n"
        "from pcc_node.spawn_guard import SpawnRefused, installed\n"
        "assert installed(), 'cli.run did not install the guard'\n"
        "import os\n"
        "try:\n"
        "    os.system('id'); print('NOT-REFUSED')\n"
        "except SpawnRefused:\n"
        "    print('REFUSED')\n"
    )
    assert r.stdout.strip().splitlines()[-1] == "REFUSED", (r.stdout, r.stderr)
