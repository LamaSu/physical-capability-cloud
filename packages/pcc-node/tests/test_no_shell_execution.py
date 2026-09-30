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
   argument is a list or tuple literal whose first item is a fixed executable
   name, never a shell, ``env`` or ``busybox``, and never a variable. No
   ``shell=`` other than the literal ``False``, and no ``**`` keyword expansion.
2. Every other way to start a process or replace this one is refused:
   ``os.system/popen/exec*/spawn*/posix_spawn*``, ``pty.spawn``,
   ``subprocess.getoutput/getstatusoutput``,
   ``asyncio.create_subprocess_shell``, whether called by attribute, by an
   imported alias (``from os import system``) or through ``getattr``.
3. No code or objects are loaded from data: ``eval``, ``exec``, ``compile``,
   ``__import__``, ``importlib.import_module``, ``runpy``, ``pickle``/
   ``marshal`` loads and ``yaml.load`` are refused.
4. The package ships no bytecode. Its checked-in ``.pyc`` files were removed.
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
                   "commands", "codeop", "shelve"}
REFUSED_BUILTINS = {"eval", "exec", "compile", "__import__"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish", "ash", "env", "busybox",
          "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "python", "python3"}
MODULES = set(REFUSED) | {m for m, _ in ALLOWED_STARTS}


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
        elif isinstance(node, ast.ImportFrom) and node.module:
            if _root(node.module) in REFUSED_IMPORTS:
                bad(node, f"from {node.module} import ...")
            if node.module in MODULES:
                for alias in node.names:
                    names[alias.asname or alias.name] = (node.module, alias.name)
                    if alias.name == "*" or alias.name in REFUSED.get(node.module, ()):
                        bad(node, f"from {node.module} import {alias.name}")

    # Names used as the object of an attribute access (os in os.path.join).
    attribute_bases = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Attribute)}

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
                bad(node, f"module {modules[node.id]} used as a value")
            elif node.id == "__builtins__":
                bad(node, "__builtins__")
        # Any reference to a refused attribute, called or not (invoke = os.system).
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in modules:
            module = modules[node.value.id]
            if node.attr in REFUSED.get(module, ()):
                bad(node, f"{module}.{node.attr}")
            elif node.attr.startswith("__"):
                bad(node, f"{module}.{node.attr}")
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name) and func.id in REFUSED_BUILTINS:
            bad(node, f"{func.id}() runs code from data")
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
        elif pathlib.PurePath(first.value).name.lower() in SHELLS:
            bad(node, f"{module}.{attr}: {first.value!r} is a shell or interpreter")
    return found


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
}
SAFE = {
    "fixed argv": "import subprocess\nsubprocess.run(['v4l2-ctl', '--device', dev, '--all'], capture_output=True)",
    "shell=False": "import subprocess\nsubprocess.run(('arp', '-a'), shell=False)",
    "fixed exec": "import asyncio\nasyncio.create_subprocess_exec('ffmpeg', '-i', dev)",
    "yaml.safe_load": "import yaml\nyaml.safe_load(text)",
    "constant ** without shell": "import subprocess\nsubprocess.run(['git', 'status'], **{'check': True})",
}


@pytest.mark.parametrize("label", sorted(EVASIONS))
def test_the_guard_catches(label):
    assert violations(EVASIONS[label]), label


@pytest.mark.parametrize("label", sorted(SAFE))
def test_the_guard_allows(label):
    assert violations(SAFE[label]) == [], label
