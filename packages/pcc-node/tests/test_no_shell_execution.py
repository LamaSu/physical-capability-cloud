"""N66: pcc-node never hands a string to a shell, and never runs code it was sent.

pcc_node/executor.py ran relay-supplied tool-call arguments with
``subprocess.run(cmd, shell=True)``: whoever could queue a tool call for a
kernel got a shell on the operator's machine. It was deleted.

This guard keeps the class out by reading the package's syntax trees, not its
text (verdict 68b, finding 4: a regex scan missed ``shell=flag``,
``**{"shell": True}``, ``from os import system``, ``getattr(subprocess, name)``,
computed argv and ``/usr/bin/env sh``). The rules:

1. A process is started only by ``subprocess.run/call/check_call/
   check_output/Popen`` or ``asyncio.create_subprocess_exec``. Its first
   argument is a list or tuple literal whose first item is one of the fixed
   executables pcc-node runs (``EXECUTABLES``), by bare name: an allowlist,
   because a list of shells cannot name every interpreter (verdict 68e,
   finding 2). No ``shell=`` other than the literal ``False``, no
   ``executable=``, and no ``**`` keyword expansion (a dict with constant keys
   and no ``shell`` is allowed). A starter is only ever called directly:
   binding it to another name or passing it as a value is refused (verdict
   68d, finding 2).
2. Every other way to start a process or replace this one is refused:
   ``os.system/popen/exec*/spawn*/posix_spawn*``, ``pty.spawn``,
   ``subprocess.getoutput/getstatusoutput``,
   ``asyncio.create_subprocess_shell``, whether called by attribute, by an
   imported alias (``from os import system``) or through ``getattr``.
3. No code or objects are loaded from data: ``eval``, ``exec``, ``compile``,
   ``__import__``, ``importlib.import_module``, ``runpy``, ``pickle``/
   ``marshal`` loads and ``yaml.load`` are refused.
4. The package ships no bytecode. Its checked-in ``.pyc`` files were removed.
5. ``getattr``/``hasattr`` with a constant name is judged as that attribute
   only where the name is demonstrably the builtin: nothing in the package
   rebinds it (a def, an assignment, a parameter, an import, ``globals()``,
   ``setattr``, an attribute store), and nothing imports ``builtins``
   (verdict 68e, finding 2).
6. A module is never reached through another module's attribute
   (``subprocess.os``), and an attribute chain goes past a tracked module's
   first attribute only through the few the package uses (``SAFE_CHAINS``:
   ``os.path``, ``os.environ``, ``sys.stdin``) (verdict 68f).
7. A tracked module is imported whole, by its own name (``import X`` or
   ``import X as Y``), and only its starters are imported by name
   (``from subprocess import run``). A dotted import (``import
   asyncio.subprocess``, ``import os.path``), a ``from`` import of a
   submodule (``from asyncio.subprocess import create_subprocess_shell``)
   and any other ``from`` import (``from os import path``, ``from subprocess
   import os``) are refused: each binds a module or a function under a name
   the guard does not resolve (#563 r1, HIGH).
"""

import ast
import pathlib
import subprocess

import pytest

PACKAGE = pathlib.Path(__file__).resolve().parents[1] / "pcc_node"

ALLOWED_STARTS = {("subprocess", n) for n in ("run", "call", "check_call", "check_output", "Popen")}
ALLOWED_STARTS.add(("asyncio", "create_subprocess_exec"))
REFUSED = {
    "os": {"system", "popen", "execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe",
           "spawnl", "spawnle", "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe",
           "posix_spawn", "posix_spawnp", "fork", "forkpty", "startfile"},
    "pty": {"spawn", "fork"},
    "subprocess": {"getoutput", "getstatusoutput"},
    "asyncio": {"create_subprocess_shell"},
    "importlib": {"import_module", "__import__"},
    "runpy": {"run_module", "run_path"},
    "pickle": {"load", "loads", "Unpickler"},
    "marshal": {"load", "loads"},
    "yaml": {"load", "unsafe_load", "full_load", "load_all", "unsafe_load_all"},
    "code": {"interact", "InteractiveInterpreter", "InteractiveConsole"},
    "builtins": {"eval", "exec", "compile", "__import__"},
    "sys": {"modules"},
}
# Modules with no business in pcc-node: each can run code or start processes.
REFUSED_IMPORTS = {"ctypes", "cffi", "multiprocessing", "webbrowser", "posix", "nt", "_posixsubprocess",
                   "commands", "codeop", "shelve", "builtins"}
REFUSED_BUILTINS = {"eval", "exec", "compile", "__import__"}
# The executables pcc-node runs, by bare name (test_the_allowlist_is_what_the_package_runs keeps
# this list exactly that). A path, or any other executable, is refused.
EXECUTABLES = {"arp", "dd", "ffmpeg", "journalctl", "sysctl", "v4l2-ctl"}
MODULES = set(REFUSED) | {m for m, _ in ALLOWED_STARTS}
# Names of modules that must not be reached through another module (subprocess.os).
MODULE_NAMES = MODULES | REFUSED_IMPORTS
# The only chains past a tracked module's first attribute (test_the_safe_chains_are_what_the_package_uses
# keeps this list exactly what the package uses).
SAFE_CHAINS = {("os", "path"), ("os", "environ"), ("sys", "stdin")}
LOOKUPS = {"getattr", "hasattr"}
# Calls that rebind names behind the syntax tree's back.
REBINDERS = {"globals", "locals", "vars", "setattr", "delattr"}
_MATCH_BINDINGS = tuple(getattr(ast, n) for n in ("MatchAs", "MatchStar") if hasattr(ast, n))


def _bound_names(tree):
    """Every name the module binds, at any scope."""
    bound = set()
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(n.name)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            bound.add(n.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            bound.update((a.asname or a.name).split(".")[0] for a in n.names)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)
        elif _MATCH_BINDINGS and isinstance(n, _MATCH_BINDINGS) and n.name:
            bound.add(n.name)
        elif isinstance(n, getattr(ast, "MatchMapping", ())) and n.rest:
            bound.add(n.rest)
    return bound


def _root(name):
    return name.split(".")[0]


def violations(source, filename="<src>"):
    """Every rule the source breaks, as "line: reason" strings."""
    tree = ast.parse(source, filename)
    modules = {}  # local name -> module, for `import subprocess as sp`
    names = {}    # local name -> (module, attr), for `from os import system as s`
    found = []

    def bad(node, why):
        found.append(f"{getattr(node, 'lineno', 0)}: {why}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _root(alias.name) in REFUSED_IMPORTS:
                    bad(node, f"import {alias.name}")
                if alias.name in MODULES:
                    modules[alias.asname or alias.name] = alias.name
                elif _root(alias.name) in MODULES:
                    bad(node, f"import {alias.name}: a tracked module is imported whole, by its own name")
        elif isinstance(node, ast.ImportFrom) and node.module:
            if _root(node.module) in REFUSED_IMPORTS:
                bad(node, f"from {node.module} import ...")
            if node.module in MODULES:
                for alias in node.names:
                    names[alias.asname or alias.name] = (node.module, alias.name)
                    if alias.name == "*" or alias.name in REFUSED.get(node.module, ()):
                        bad(node, f"from {node.module} import {alias.name}")
                    elif (node.module, alias.name) not in ALLOWED_STARTS:
                        bad(node, f"from {node.module} import {alias.name}: only a starter is imported by name")
            elif _root(node.module) in MODULES:
                bad(node, f"from {node.module} import ...: a tracked module's submodule")

    # Names used as the object of an attribute access (os in os.path.join), and called expressions.
    attribute_bases = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    call_funcs = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
    # getattr/hasattr(module, "constant") names one attribute, like module.constant does, so it
    # is judged as that attribute; a computed name still counts as the module used as a value.
    # Only while the lookup is the builtin: a module that rebinds the name gets no exemption.
    builtin_lookups = LOOKUPS - _bound_names(tree)
    constant_lookups = {
        id(n.args[0]): n.args[1].value
        for n in ast.walk(tree)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in builtin_lookups
        and len(n.args) >= 2 and isinstance(n.args[0], ast.Name) and n.args[0].id in modules
        and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str)
    }

    def target(func):
        """(module, attr) a call resolves to, if it is one we track."""
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in modules:
            return modules[func.value.id], func.attr
        if isinstance(func, ast.Name) and func.id in names:
            return names[func.id]
        return None

    for node in ast.walk(tree):
        # A module object used as a value (assigned, passed, vars(os)) hides its calls.
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id in modules and id(node) not in attribute_bases:
                module, attr = modules[node.id], constant_lookups.get(id(node))
                if attr is None:
                    bad(node, f"module {module} used as a value")
                elif attr in REFUSED.get(module, ()) or attr.startswith("__") or (module, attr) in ALLOWED_STARTS:
                    bad(node, f"{module}.{attr} through getattr")
            elif node.id == "__builtins__":
                bad(node, "__builtins__")
        # Rebinding getattr/hasattr on another object (a module, from outside it).
        if isinstance(node, ast.Attribute) and node.attr in LOOKUPS and isinstance(node.ctx, (ast.Store, ast.Del)):
            bad(node, f"rebinds {node.attr} on another object")
        # Any reference to a refused attribute, called or not (invoke = os.system).
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in modules:
            module = modules[node.value.id]
            if node.attr in REFUSED.get(module, ()):
                bad(node, f"{module}.{node.attr}")
            elif node.attr.startswith("__"):
                bad(node, f"{module}.{node.attr}")
        # Any attribute path from a tracked module: never to another module, and past the
        # first attribute only through SAFE_CHAINS, one step deep.
        path = _attribute_path(node, modules)
        if path is not None:
            module, attrs = path
            dotted = ".".join([module, *attrs])
            if attrs[-1] in MODULE_NAMES:
                bad(node, f"{dotted} reaches another module")
            elif len(attrs) == 2 and (module, attrs[0]) not in SAFE_CHAINS:
                bad(node, f"{dotted} reaches past the module")
            elif len(attrs) > 2:
                bad(node, f"{dotted} reaches too deep")
        # An allowed starter bound to another name, or passed as a value, escapes the call checks.
        if id(node) not in call_funcs:
            ref = None
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in modules:
                ref = (modules[node.value.id], node.attr)
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in names:
                ref = names[node.id]
            if ref in ALLOWED_STARTS:
                bad(node, f"{ref[0]}.{ref[1]} used as a value")
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id in REFUSED_BUILTINS:
            bad(node, f"{func.id}() runs code from data")
            continue
        if isinstance(func, ast.Name) and func.id in REBINDERS:
            bad(node, f"{func.id}() can rebind names out of the guard's sight")
            continue
        resolved = target(func)
        if resolved is None or (resolved[0], resolved[1]) not in ALLOWED_STARTS:
            continue
        module, attr = resolved
        for kw in node.keywords:
            if kw.arg is None:
                spread = kw.value
                constant_keys = isinstance(spread, ast.Dict) and all(
                    isinstance(k, ast.Constant) and isinstance(k.value, str) for k in spread.keys)
                if not constant_keys or any(k.value == "shell" for k in spread.keys):
                    bad(node, f"{module}.{attr}(**...) can hide shell=True")
            elif kw.arg == "shell" and not (isinstance(kw.value, ast.Constant) and kw.value.value is False):
                bad(node, f"{module}.{attr}(shell=...)")
            elif kw.arg == "executable":
                bad(node, f"{module}.{attr}(executable=...) replaces the fixed executable")
        argv = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == "args"), None)
        if attr == "create_subprocess_exec":
            first = argv
        elif isinstance(argv, (ast.List, ast.Tuple)) and argv.elts:
            first = argv.elts[0]
        else:
            bad(node, f"{module}.{attr} argv must be a list literal")
            continue
        if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
            bad(node, f"{module}.{attr}: the executable must be a fixed string")
        elif first.value not in EXECUTABLES:
            bad(node, f"{module}.{attr}: {first.value!r} is not one of the executables pcc-node runs")
    return found


def _attribute_path(node, modules):
    """(module, [attr, ...]) when *node* is an attribute path from a tracked module name."""
    attrs = []
    while isinstance(node, ast.Attribute):
        attrs.append(node.attr)
        node = node.value
    if attrs and isinstance(node, ast.Name) and node.id in modules:
        return modules[node.id], attrs[::-1]
    return None


def chains_used(source):
    """The (module, attr) pairs a source reaches past: os.path in os.path.join."""
    tree = ast.parse(source)
    modules = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in MODULES:
                    modules[alias.asname or alias.name] = alias.name
    used = set()
    for node in ast.walk(tree):
        path = _attribute_path(node, modules)
        if path is not None and len(path[1]) >= 2:
            used.add((path[0], path[1][0]))
    return used


def executables_started(source):
    """The fixed executables a source starts, as written.

    A call counts only when it resolves, through the source's imports, to an allowed starter,
    as violations() resolves it: a local function or method that happens to be named call or
    run is not a starter (runtime.py's call("GET", path) is an HTTP request). These are the
    only import forms rule 7 permits, so every start the package can contain is counted; a
    start reached any other way (from asyncio.subprocess import ...) is refused outright.
    """
    tree = ast.parse(source)
    modules = {}  # local name -> module, for `import subprocess as sp`
    names = {}    # local name -> (module, attr), for `from subprocess import run`
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in MODULES:
                    modules[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom) and node.module in MODULES:
            for alias in node.names:
                names[alias.asname or alias.name] = (node.module, alias.name)
    started = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in modules:
            resolved = (modules[func.value.id], func.attr)
        elif isinstance(func, ast.Name):
            resolved = names.get(func.id)
        else:
            resolved = None
        if resolved not in ALLOWED_STARTS:
            continue
        argv = node.args[0] if node.args else next((k.value for k in node.keywords if k.arg == "args"), None)
        first = argv.elts[0] if isinstance(argv, (ast.List, ast.Tuple)) and argv.elts else argv
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            started.add(first.value)
    return started


def _sources():
    return sorted(p for p in PACKAGE.rglob("*.py") if "__pycache__" not in p.parts)


def test_the_package_sources_are_scanned():
    names = {p.name for p in _sources()}
    assert "job_executor.py" in names and "daemon.py" in names and "camera.py" in names


def test_no_module_starts_a_shell_or_runs_code_it_was_sent():
    hits = []
    for path in _sources():
        for v in violations(path.read_text(encoding="utf-8"), str(path)):
            hits.append(f"{path.relative_to(PACKAGE)}:{v}")
    assert hits == [], "pcc-node must never start a shell or run code it was sent:\n" + "\n".join(hits)


def test_the_allowlist_is_what_the_package_runs():
    # A new executable is a reviewed change to EXECUTABLES; an unused entry is removed.
    started = set()
    for path in _sources():
        started |= executables_started(path.read_text(encoding="utf-8"))
    assert started == EXECUTABLES


def test_the_safe_chains_are_what_the_package_uses():
    # A new chain is a reviewed change to SAFE_CHAINS; an unused entry is removed.
    used = set()
    for path in _sources():
        used |= chains_used(path.read_text(encoding="utf-8"))
    assert used == SAFE_CHAINS


def test_the_relay_shell_executor_is_gone():
    assert not (PACKAGE / "executor.py").exists()


def test_no_bytecode_is_checked_in():
    try:
        tracked = subprocess.run(["git", "ls-files", "--", str(PACKAGE.parent)],
                                 capture_output=True, text=True, check=True, cwd=PACKAGE.parent).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        pytest.skip("not a git checkout")
    assert [p for p in tracked if p.endswith((".pyc", ".pyo"))] == []


# The guard's own proof: each evasion verdict 68b listed is caught, and the
# package's real, fixed-argv calls are not.
EVASIONS = {
    "shell=flag": "import subprocess\nsubprocess.run(['ls'], shell=flag)",
    "shell=True": "import subprocess\nsubprocess.run(['ls'], shell=True)",
    "**kwargs": "import subprocess\nsubprocess.run(['ls'], **{'shell': True})",
    "from os import system": "from os import system\nsystem('id')",
    "aliased system": "from os import system as s\ns('id')",
    "from subprocess import getoutput": "from subprocess import getoutput\ngetoutput('id')",
    "getattr(subprocess, name)": "import subprocess\ngetattr(subprocess, name)('id')",
    "getattr(os, 'system')": "import os\ngetattr(os, 'system')('id')",
    "computed argv": "import subprocess\nsubprocess.run(argv)",
    "a remote string": "import subprocess\nsubprocess.run(remote_string)",
    "Popen(remote_argv)": "import subprocess as sp\nsp.Popen(remote_argv)",
    "variable executable": "import subprocess\nsubprocess.run([tool, '-x'])",
    "/usr/bin/env sh": "import subprocess\nsubprocess.run(['/usr/bin/env', 'sh', '-c', x])",
    "busybox": "import subprocess\nsubprocess.run(['busybox', 'sh'])",
    "/usr/local/bin/bash": "import subprocess\nsubprocess.run(['/usr/local/bin/bash', '-c', x])",
    "exec remote executable": "import asyncio\nasyncio.create_subprocess_exec(remote_exe)",
    "create_subprocess_shell": "import asyncio\nasyncio.create_subprocess_shell(x)",
    "os.execv": "import os\nos.execv('/bin/ls', ['ls'])",
    "os.posix_spawn": "import os\nos.posix_spawn('/bin/ls', ['ls'], {})",
    "pty.spawn": "import pty\npty.spawn('/bin/ls')",
    "eval": "eval(payload)",
    "exec": "exec(payload)",
    "compile": "compile(payload, 'x', 'exec')",
    "__import__": "__import__(name)",
    "importlib": "import importlib\nimportlib.import_module(name)",
    "runpy": "import runpy\nrunpy.run_path(p)",
    "pickle.loads": "import pickle\npickle.loads(blob)",
    "marshal.loads": "import marshal\nmarshal.loads(blob)",
    "yaml.load": "import yaml\nyaml.load(text)",
    "from pickle import loads": "from pickle import loads\nloads(blob)",
    # Verdict 68c, finding 2: aliases through assignment and nesting, and the
    # modules and attributes the first AST guard did not track.
    "assignment alias": "import os\ninvoke = os.system\ninvoke(payload)",
    "lambda wrapper": "import os\nrun = lambda c: os.system(c)",
    "ctypes": "import ctypes\nctypes.CDLL(None).system(b'id')",
    "multiprocessing": "import multiprocessing\nmultiprocessing.Process(target=f).start()",
    "webbrowser": "import webbrowser\nwebbrowser.open(url)",
    "os.startfile": "import os\nos.startfile(path)",
    "sys.modules": "import sys\nsys.modules['os'].system('id')",
    "builtins.eval": "import builtins\nbuiltins.eval(x)",
    "__builtins__": "__builtins__['eval'](x)",
    "vars(os)": "import os\nvars(os)['system']('id')",
    "os.__dict__": "import os\nos.__dict__['system']('id')",
    "subprocess module passed around": "import subprocess\nrunner = subprocess\nrunner.run(x, shell=True)",
    # Verdict 68d, finding 2: an allowed starter bound to another name, and executable=.
    "starter alias": "import subprocess\ninvoke = subprocess.run\ninvoke(remote_argv, shell=True)",
    "imported starter alias": "from subprocess import run\ninvoke = run\ninvoke(remote_argv, shell=True)",
    "starter passed as a value": "import subprocess\nloop.run_in_executor(None, subprocess.run, argv)",
    "executable=/bin/sh": "import subprocess\nsubprocess.run(['ignored', '-c', payload], executable='/bin/sh')",
    "executable= variable": "import subprocess as sp\nsp.Popen(['ls'], executable=exe)",
    "getattr of a starter": "import subprocess\ngetattr(subprocess, 'run')(x, shell=True)",
    "getattr of a dunder": "import os\ngetattr(os, '__dict__')['system']('id')",
    # Verdict 68e, finding 2: a shadowed getattr, and interpreters the shell list did not name.
    "shadowed getattr": "import subprocess\ndef getattr(obj, name):\n    return obj.run\ngetattr(subprocess, 'harmless')(['ignored'], shell=True)",
    "getattr rebound by assignment": "import subprocess\ngetattr = lambda o, n: o.run\ngetattr(subprocess, 'x')(['ls'], shell=True)",
    "getattr as a parameter": "import subprocess\ndef f(getattr):\n    getattr(subprocess, 'x')(['ls'], shell=True)",
    "getattr imported": "import subprocess\nfrom helpers import picker as getattr\ngetattr(subprocess, 'x')(['ls'])",
    "getattr through globals()": "import subprocess\nglobals()['getattr'] = f\ngetattr(subprocess, 'x')(['ls'])",
    "getattr rebound on another module": "import pcc_node.camera as cam\ncam.getattr = lambda o, n: o.run",
    # Verdict 68f (on #442): a module reached through another module's attribute.
    "nested module attribute": "import subprocess\nsubprocess.os.system('id')",
    "nested module as a value": "import subprocess\nposix = subprocess.os\nposix.system('id')",
    "refused module through another": "import subprocess\nsubprocess._posixsubprocess.fork_exec(a)",
    "sys through os": "import os\nos.sys.modules['os'].system('id')",
    "a module through a safe chain": "import os\nos.path.os.system('id')",
    "an unlisted chain": "import subprocess\nsignal_number = subprocess.signal.SIGKILL",
    "too deep through a safe chain": "import os\nos.path.sep.join(parts)",
    "import builtins": "import builtins\nprint_ = builtins.print",
    "builtins rebound": "import builtins, subprocess\nbuiltins.getattr = f\ngetattr(subprocess, 'x')(['ls'])",
    "perl -e": "import subprocess\nsubprocess.run(['perl', '-e', payload])",
    "ruby -e": "import subprocess\nsubprocess.run(['ruby', '-e', payload])",
    "node -e": "import subprocess\nsubprocess.run(['node', '-e', payload])",
    "awk": "import subprocess\nsubprocess.run(['awk', payload])",
    "a path to an allowed name": "import subprocess\nsubprocess.run(['/tmp/x/arp', '-a'])",
    # #563 r1 (HIGH): a tracked module reached through a dotted import or a from import.
    "from asyncio.subprocess import create_subprocess_shell":
        "from asyncio.subprocess import create_subprocess_shell\nasync def launch(payload):\n"
        "    await create_subprocess_shell(payload)",
    "from asyncio.subprocess import create_subprocess_exec":
        "from asyncio.subprocess import create_subprocess_exec\ncreate_subprocess_exec(remote_exe)",
    "import asyncio.subprocess": "import asyncio.subprocess\nasyncio.subprocess.create_subprocess_shell(x)",
    "import asyncio.subprocess as asp": "import asyncio.subprocess as asp\nasp.create_subprocess_shell(x)",
    "from asyncio import subprocess": "from asyncio import subprocess as asp\nasp.create_subprocess_shell(x)",
    "import os.path binds os": "import os.path\nos.system('id')",
    "from os import path": "from os import path\npath.os.system('id')",
    "from os.path import os": "from os.path import os\nos.system('id')",
    "import importlib.util binds importlib": "import importlib.util\nimportlib.import_module(name)",
    "from importlib import util": "from importlib import util\nutil.spec_from_file_location(n, p)",
    "from subprocess import os": "from subprocess import os\nos.system('id')",
    "from os import sys": "from os import sys\nsys.modules['os'].system('id')",
}
SAFE = {
    "fixed argv": "import subprocess\nsubprocess.run(['v4l2-ctl', '--device', dev, '--all'], capture_output=True)",
    "shell=False": "import subprocess\nsubprocess.run(('arp', '-a'), shell=False)",
    "fixed exec": "import asyncio\nasyncio.create_subprocess_exec('ffmpeg', '-i', dev)",
    "yaml.safe_load": "import yaml\nyaml.safe_load(text)",
    "constant ** without shell": "import subprocess\nsubprocess.run(['journalctl', '-n', '20'], **{'check': True})",
    # A constant, harmless attribute through getattr: #447's ui_server.py and #454 use these.
    "constant getattr": "import os\nflags = os.O_WRONLY | getattr(os, 'O_NOFOLLOW', 0)",
    "constant hasattr": "import os\nsupported = hasattr(os, 'O_CLOEXEC')",
    "os.path chain": "import os\nfull = os.path.join('a', 'b')",
    "os.environ chain": "import os\nvalue = os.environ.get('X')",
    "sys.stdin chain": "import sys\ninteractive = sys.stdin.isatty()",
    "an unrelated name that contains getattr": "import os\nmy_getattr = 1\nflags = getattr(os, 'O_NOFOLLOW', 0)",
    # Rule 7 keeps the starters' own from import: it is judged at the call.
    "an imported starter with a fixed argv": "from subprocess import run\nrun(['arp', '-a'], capture_output=True)",
    "an aliased module import": "import subprocess as sp\nsp.run(['dd', 'if=/dev/zero', 'count=1'])",
}


@pytest.mark.parametrize("label", sorted(EVASIONS))
def test_the_guard_catches(label):
    assert violations(EVASIONS[label]), label


@pytest.mark.parametrize("label", sorted(SAFE))
def test_the_guard_allows(label):
    assert violations(SAFE[label]) == [], label


# The allowlist check's own proof: a start counts when it resolves to an allowed starter
# through any import form, and a call that only shares a starter's name does not count.
STARTS = {
    "subprocess.run": ("import subprocess\nsubprocess.run(['arp', '-a'])", {"arp"}),
    "an aliased module": ("import subprocess as sp\nsp.Popen(('dd', 'if=x'))", {"dd"}),
    "an imported starter": ("from subprocess import check_output\ncheck_output(['sysctl', '-n', 'x'])", {"sysctl"}),
    "an aliased starter": ("from subprocess import call as c\nc(['journalctl'])", {"journalctl"}),
    "args= keyword": ("import subprocess\nsubprocess.run(args=['v4l2-ctl', '--all'])", {"v4l2-ctl"}),
    "create_subprocess_exec": ("import asyncio\nasyncio.create_subprocess_exec('ffmpeg', '-i', dev)", {"ffmpeg"}),
    "a local function named call": ("def call(method, path):\n    return method\ncall('GET', '/status')", set()),
    "a method named run": ("client.run(['GET', '/x'])", set()),
    "a starter name from another module": ("from helpers import run\nrun(['GET'])", set()),
}


@pytest.mark.parametrize("label", sorted(STARTS))
def test_the_allowlist_check_counts_only_real_starts(label):
    source, expected = STARTS[label]
    assert executables_started(source) == expected, label
