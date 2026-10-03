"""The runtime spawn guard behind the static no-shell guard (steward #5194/#5224, verdicts 105i/j/k).

The static guard (test_no_shell_execution.py) reads syntax, so a process start reached a new way slips
past it. This guard watches what CPython does: pcc_node.spawn_guard.install() adds an audit hook that
refuses every process start or native load except a subprocess.Popen proven to run the very device
executable pinned at startup, with the node's own environment.

Everything runs in child processes, because an audit hook cannot be removed once installed. The 105j/k
tests confirm the hook is not disabled by the evaluated Python it contains (reassigning spawn_guard.os
or the module policy), does not trust a bare name through cwd/env/PATH games, and is installed before
the CLI's dependencies import. It is defense in depth, not a sandbox against Python that reaches the
interpreter object graph (gc/ctypes/frame) -- that is the static guard's and the deployment's boundary.
"""

from __future__ import annotations  # so `dict | None` hints parse on Python 3.8/3.9 too

import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]  # packages/pcc-node, so a child's `import pcc_node` resolves
ABSPATH = "/usr/bin:/bin:/usr/sbin:/sbin"  # a clean, all-absolute PATH for the allowed-executable tests

# The guard installs only on POSIX (install() is a no-op on Windows); these refusal tests would fail
# where the hook is intentionally absent (verdict 105l MEDIUM 5). Skip the module on Windows.
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="pcc-node spawn guard is POSIX-only")


def _run_raw(code: str, env: dict | None = None) -> subprocess.CompletedProcess:
    e = dict(os.environ)
    e.pop("PYTEST_CURRENT_TEST", None)  # a child must run as a real interpreter, not "under pytest"
    if env:
        e.update(env)
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], cwd=str(PKG), env=e,
                          capture_output=True, text=True, timeout=90)


def _run_guarded(body: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return _run_raw("import pcc_node.spawn_guard as _g\n_g.install()\n" + textwrap.dedent(body), env)


def _attempt(op: str, env: dict | None = None) -> subprocess.CompletedProcess:
    body = (
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n" + textwrap.indent(textwrap.dedent(op), "    ") + "\n    print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
        "except BaseException as e:\n    print('OTHER:' + type(e).__name__)\n"
    )
    return _run_guarded(body, env)


def _sentinel() -> str:
    fd, path = tempfile.mkstemp()  # honours TMPDIR; portable (verdict 105k LOW 1)
    os.close(fd)
    os.unlink(path)
    return path


def _fake_dir_with_dd():
    d = tempfile.mkdtemp()
    mark = Path(d, "RAN")
    fake = Path(d, "dd")
    fake.write_text(f'#!/bin/sh\n: > "{mark}"\n')
    fake.chmod(0o755)
    return d, mark


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
    r = _attempt(op)
    assert "RAN" not in r.stdout, f"a pool worker ran: {r.stdout!r} {r.stderr!r}"
    assert "OTHER:" in r.stdout or "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


# ---- the allowed case still works (clean absolute PATH, pinned binary) ----------------------------
def test_a_device_executable_still_runs_by_bare_name():
    r = _attempt("import subprocess; subprocess.run(['dd', '--version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
                 env={"PATH": ABSPATH})
    assert "RAN" in r.stdout, f"dd was refused: {r.stdout!r} {r.stderr!r}"


def test_asyncio_create_subprocess_exec_of_a_bare_executable_runs():
    r = _attempt(
        "import asyncio\n"
        "async def m():\n"
        "    p = await asyncio.create_subprocess_exec('dd', '--version',\n"
        "        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)\n"
        "    await p.wait()\n"
        "asyncio.run(m())",
        env={"PATH": ABSPATH},
    )
    assert "RAN" in r.stdout, f"create_subprocess_exec('dd') was refused: {r.stdout!r} {r.stderr!r}"


# ---- HIGH 1: not disable-able from ordinary evaluated / in-process Python --------------------------
def test_reassigning_spawn_guard_os_does_not_weaken_the_hook():
    # astra's 105k HIGH 1 repro: reassign spawn_guard.os so the hook "sees" an allowed dd while real
    # subprocess runs sh. The hook captured os.fsdecode/os.environ at install, so this does nothing.
    r = _run_raw(
        "import os, subprocess, types\n"
        "import pcc_node.spawn_guard as g\n"
        "g.install()\n"
        "g.os = types.SimpleNamespace(fsdecode=lambda v: 'dd', environ={'PATH': os.environ.get('PATH')})\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n    r = subprocess.run(['sh', '-c', 'exit 37']); print('RETURNCODE', r.returncode)\n"
        "except SpawnRefused:\n    print('REFUSED')\n",
        env={"PATH": ABSPATH},
    )
    assert "REFUSED" in r.stdout and "RETURNCODE 37" not in r.stdout, f"{r.stdout!r} {r.stderr!r}"


def test_evaluated_python_cannot_empty_the_policy():
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
    assert not ran and "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


def test_reassigning_the_module_policy_does_not_weaken_an_installed_hook():
    s = _sentinel()
    r = _run_guarded(
        "import pcc_node.spawn_guard as g, os\n"
        "g.EXECUTABLES = frozenset({'id', 'sh', 'touch'})\n"
        "g.REFUSED_EVENTS = frozenset()\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        f"try:\n    os.system('touch {s}'); print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
    )
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran and "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


# ---- HIGH 2: a bare name is bound to the pinned binary, not trusted through env / PATH / cwd -------
def test_a_per_call_env_is_refused():
    d, mark = _fake_dir_with_dd()
    r = _attempt(f"import subprocess; subprocess.run(['dd'], env={{'PATH': {d!r}}})", env={"PATH": ABSPATH})
    assert not mark.exists() and "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


def test_a_changed_process_PATH_is_refused():
    d, mark = _fake_dir_with_dd()
    r = _attempt(f"import os, subprocess\nos.environ['PATH'] = {d!r}\nsubprocess.run(['dd'])", env={"PATH": ABSPATH})
    assert not mark.exists() and "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


def test_a_cwd_is_refused():
    d, mark = _fake_dir_with_dd()
    r = _attempt(f"import subprocess; subprocess.run(['dd'], cwd={d!r})", env={"PATH": ABSPATH})
    assert not mark.exists() and "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


def test_a_relative_PATH_component_with_a_matching_cwd_is_refused():
    # Start with '.' on PATH and chdir into a dir holding a fake dd; PATH stays byte-identical. The
    # guard refuses because PATH has a relative component the cwd could (and here would) redirect.
    d, mark = _fake_dir_with_dd()
    r = _attempt(f"import os, subprocess\nos.chdir({d!r})\nsubprocess.run(['dd'])", env={"PATH": ".:" + ABSPATH})
    assert not mark.exists() and "REFUSED" in r.stdout, f"{r.stdout!r} {r.stderr!r}"


# ---- HIGH 3: no unguarded runnable entry; install happens before the CLI's imports ----------------
def test_python_dash_m_cli_is_refused_before_its_imports():
    # `python -m pcc_node.cli` must refuse ABOVE its imports (verdict 105l HIGH 3): a hostile `click`
    # (cli.py imports it at module top) on PYTHONPATH must not run its import-time spawn, because the
    # refusal is the first statement in the module.
    z = tempfile.mkdtemp()
    zmark = Path(z, "CRAN")
    Path(z, "click.py").write_text(f"import os\nos.system('touch {zmark}')\n")
    r = subprocess.run([sys.executable, "-m", "pcc_node.cli", "detect"], cwd=str(PKG),
                       env={**{k: v for k, v in os.environ.items() if k != "PYTEST_CURRENT_TEST"},
                            "PYTHONPATH": z + os.pathsep + str(PKG)},
                       capture_output=True, text=True, timeout=60)
    assert not zmark.exists(), f"an unguarded import-time spawn ran: {r.stdout!r} {r.stderr!r}"
    assert r.returncode != 0 and "Refused" in (r.stdout + r.stderr), f"did not fail closed: {r.stdout!r} {r.stderr!r}"


def test_the_entry_installs_the_guard_before_importing_the_cli():
    # astra 105k MEDIUM 2: prove the ordering. A hostile `click` shadow on PYTHONPATH spawns at import;
    # _entry.run() installs the guard, then imports the CLI (which imports click), so the spawn is
    # refused -- proving install precedes the CLI's dependency imports.
    s = _sentinel()
    d = tempfile.mkdtemp()
    Path(d, "click.py").write_text(f"import os\nos.system('touch {s}')\n")
    r = _run_raw(
        "import pcc_node._entry as e\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        "try:\n    e.run()\n    print('NO-REFUSAL')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
        "except BaseException as ex:\n    print('OTHER:' + type(ex).__name__)\n",
        env={"PYTHONPATH": d + os.pathsep + str(PKG)},
    )
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran, f"a hostile import-time spawn ran before the guard: {r.stdout!r} {r.stderr!r}"
    assert "REFUSED" in r.stdout, f"the shadowed import's spawn was not refused: {r.stdout!r} {r.stderr!r}"


def test_importing_the_entry_module_does_not_install_the_hook_in_process():
    r = _run_raw(
        "import sys, pcc_node._entry as e\n"
        "from pcc_node.spawn_guard import installed\n"
        "print('installed' if installed() else 'not-installed', 'cli' if 'pcc_node.cli' in sys.modules else 'no-cli')\n"
    )
    assert r.stdout.strip().splitlines()[-1] == "not-installed no-cli", (r.stdout, r.stderr)


def test_entry_refuses_to_run_when_landlock_is_unavailable():
    # verdict 105n HIGH1: _entry must NOT fail open. With Landlock unavailable (restrict()->False) and
    # no operator override, run() refuses BEFORE installing the hook or importing the CLI -- otherwise
    # the exec floor rests on AppArmor alone, which must grant python3 execute and cannot stop
    # `python3 -c ...`. Run in a child, since calling run() installs the unremovable hook.
    r = _run_raw(
        "import os\n"
        "os.environ.pop('PCC_ALLOW_NO_LANDLOCK', None)\n"
        "import pcc_node._entry as e, pcc_node._landlock as L, pcc_node.spawn_guard as g, pcc_node.cli as cli\n"
        "L.restrict = lambda paths: False\n"
        "reached = []\n"
        "g.install = lambda: reached.append('install')\n"
        "cli.main = lambda *a, **k: reached.append('main')\n"
        "try:\n    e.run()\n    print('NO-REFUSAL|' + ','.join(reached))\n"
        "except SystemExit:\n    print('REFUSED|' + ','.join(reached))\n"
    )
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
    assert last == "REFUSED|", f"entry did not fail closed on unavailable Landlock: {r.stdout!r} {r.stderr!r}"


def test_entry_runs_without_landlock_only_with_the_explicit_override():
    # The operator may consciously accept the weaker posture (AppArmor + hook only, runtime unarmed)
    # with PCC_ALLOW_NO_LANDLOCK=1; then run() proceeds -- installing the hook and entering the CLI.
    r = _run_raw(
        "import os\n"
        "os.environ['PCC_ALLOW_NO_LANDLOCK'] = '1'\n"
        "import pcc_node._entry as e, pcc_node._landlock as L, pcc_node.spawn_guard as g, pcc_node.cli as cli\n"
        "L.restrict = lambda paths: False\n"
        "reached = []\n"
        "g.install = lambda: reached.append('install')\n"
        "cli.main = lambda *a, **k: reached.append('main')\n"
        "e.run()\n"
        "print('RAN|' + ','.join(reached))\n"
    )
    last = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
    assert last == "RAN|install,main", f"override did not let the node run: {r.stdout!r} {r.stderr!r}"


# ---- MEDIUM 7 (105j) + MEDIUM 4 (105k): the click public-submodule launchers, proven refused -------
@pytest.mark.parametrize(
    "op",
    ["from click import termui; termui.launch('https://127.0.0.1:0/x')",
     "from click import termui; termui.edit('x')"],
    ids=["click.termui.launch", "click.termui.edit"],
)
def test_click_public_submodule_launchers_are_refused(op):
    pytest.importorskip("click")
    # Point every launcher click might use at a sentinel; the guard must refuse the spawn, so the
    # sentinel never appears and SpawnRefused (not an unrelated error) is what stops it.
    s = _sentinel()
    sentinel_cmd = f"touch {s}"
    r = _attempt(op, env={"BROWSER": sentinel_cmd, "EDITOR": sentinel_cmd, "VISUAL": sentinel_cmd, "PATH": ABSPATH})
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran, f"a click launcher spawned: {r.stdout!r} {r.stderr!r}"
    assert "REFUSED" in r.stdout, f"not a guard refusal: {r.stdout!r} {r.stderr!r}"


def test_a_real_cross_module_star_reexport_is_refused():
    s = _sentinel()
    d = tempfile.mkdtemp()
    Path(d, "helper_mod.py").write_text("import os as platform\n")
    Path(d, "consumer_mod.py").write_text("from helper_mod import *\n")
    r = _run_guarded(
        f"import sys; sys.path.insert(0, {d!r})\n"
        "import consumer_mod\n"
        "from pcc_node.spawn_guard import SpawnRefused\n"
        f"try:\n    consumer_mod.platform.system('touch {s}'); print('RAN')\n"
        "except SpawnRefused:\n    print('REFUSED')\n"
    )
    ran = os.path.exists(s)
    if ran:
        os.unlink(s)
    assert not ran and "REFUSED" in r.stdout, f"a cross-module re-export ran: {r.stdout!r} {r.stderr!r}"


def test_install_is_idempotent_and_reports_state():
    r = _run_guarded("import pcc_node.spawn_guard as g\ng.install()\nprint('INSTALLED' if g.installed() else 'NOT')\n")
    assert r.stdout.strip().splitlines()[-1] == "INSTALLED", (r.stdout, r.stderr)
