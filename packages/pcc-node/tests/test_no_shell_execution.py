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
   ``os.path``, ``os.environ``, ``sys.stdin``) (verdict 68f). That holds
   however the path is named: ``from subprocess import os``, ``import os.path
   as p`` and ``from os.path import os`` resolve to the same paths, and no
   path passes a dunder. A chain's head, or anything past it, is never bound
   to a name or passed as a value, where its attributes would escape these
   rules (``path = os.path``) (verdict 105e).
7. Nothing reaches a tracked module, an object's internals or a frame
   through any other object (verdict 105f). On any object, no attribute is
   named like a module the guard tracks (``pathlib.os``; ``.code`` stays
   usable, since HTTP errors carry it), no dunder is used but the plain few in
   ``ALLOWED_DUNDERS`` (``pathlib.__dict__``, ``().__class__``), and no frame
   or traceback attribute (``f_globals``, ``tb_frame``). ``getattr`` and
   ``hasattr`` take only a constant name, which those same rules judge, and
   are never passed as values. No import names a module through another
   module (``from pathlib import os``) or a dunder outside the allowlist
   (``from os import __dict__``), and a name is imported as one thing only
   (an alias reused for another module in an uncalled function would
   otherwise hide which module it is). ``inspect``, ``gc``, ``sys._getframe``,
   ``operator.attrgetter`` and ``breakpoint()`` are refused, and so is every
   module that turns a string into a module or a callable: ``pkgutil``,
   ``pydoc``, ``zipimport``, ``site`` and ``logging.config``.

The guard reads syntax. It tracks names bound by imports, flow-insensitively,
and it is not a sandbox: rules 1 and 3 stay the first barriers.
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
    "sys": {"modules", "_getframe", "_current_frames"},
    "operator": {"attrgetter", "methodcaller"},
    "logging": {"config"},  # dictConfig/fileConfig build any callable named by a string
}
# Modules with no business in pcc-node: each can run code or start processes.
REFUSED_IMPORTS = {"ctypes", "cffi", "multiprocessing", "webbrowser", "posix", "nt", "_posixsubprocess",
                   "commands", "codeop", "shelve", "builtins", "inspect", "gc",
                   "pkgutil", "pydoc", "zipimport", "site"}
REFUSED_BUILTINS = {"eval", "exec", "compile", "__import__", "breakpoint"}
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
# Rule 7: the dunders any object may use, the frame attributes none may, and the module names no
# attribute may carry (.code stays usable: HTTP errors carry it).
ALLOWED_DUNDERS = {"__name__", "__qualname__", "__doc__", "__init__", "__dataclass_fields__", "__version__"}
FRAME_ATTRS = {"f_globals", "f_locals", "f_builtins", "f_back", "f_code", "tb_frame", "tb_next",
               "gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code"}
REACH_NAMES = MODULE_NAMES - {"code"}


def _reaches(name):
    """Why an attribute or lookup of this name, on any object, breaks rule 7, or None."""
    if name in REACH_NAMES:
        return "names a module the guard tracks"
    if name.startswith("__") and name not in ALLOWED_DUNDERS:
        return "is a dunder"
    if name in FRAME_ATTRS:
        return "is a frame attribute"
    return None
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


def _tracked(tree):
    """The names a module binds to tracked modules or to paths into them, and the imports that break a rule.

    Returns (modules, names, prefixed, refusals):
    - modules: local name -> module, for `import subprocess as sp` and `import os.path` (which binds os);
    - names: local name -> (module, attr), for `from os import system as s`;
    - prefixed: local name -> (module, [attr, ...]), for `import os.path as p` and `from os.path import join`;
    - refusals: (node, reason) for each import that breaks a rule.
    """
    modules, names, prefixed, refusals = {}, {}, {}, []
    imported = {}  # local name -> {what it was imported as}, every scope (rule 7)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                parts = alias.name.split(".")
                imported.setdefault(alias.asname or parts[0], set()).add(alias.name if alias.asname else parts[0])
                if parts[0] in REFUSED_IMPORTS:
                    refusals.append((node, f"import {alias.name}"))
                if any(part in MODULE_NAMES for part in parts[1:]):
                    refusals.append((node, f"import {alias.name} reaches another module"))
                if parts[0] not in MODULES:
                    continue
                if len(parts) > 1 and parts[1] in REFUSED.get(parts[0], ()):
                    refusals.append((node, f"import {alias.name}"))
                if alias.asname is None:
                    modules[parts[0]] = parts[0]  # `import os.path` binds os itself
                elif len(parts) == 1:
                    modules[alias.asname] = parts[0]
                else:
                    prefixed[alias.asname] = (parts[0], parts[1:])
        elif isinstance(node, ast.ImportFrom):
            source = "." * node.level + (node.module or "")
            for alias in node.names:
                imported.setdefault(alias.asname or alias.name, set()).add(f"{source}:{alias.name}")
                if alias.name in MODULE_NAMES:
                    refusals.append((node, f"from {source} import {alias.name} reaches a module through another"))
                elif alias.name.startswith("__") and alias.name not in ALLOWED_DUNDERS:
                    refusals.append((node, f"from {source} import {alias.name}"))
            if not node.module:
                continue
            parts = node.module.split(".")
            if parts[0] in REFUSED_IMPORTS:
                refusals.append((node, f"from {node.module} import ..."))
            if parts[0] not in MODULES:
                continue
            if len(parts) > 1 and parts[1] in REFUSED.get(parts[0], ()):
                refusals.append((node, f"from {node.module} import ..."))
            for alias in node.names:
                if alias.name == "*":
                    refusals.append((node, f"from {node.module} import *"))
                    continue
                local = alias.asname or alias.name
                if len(parts) == 1:
                    names[local] = (node.module, alias.name)
                    if alias.name in REFUSED.get(node.module, ()):
                        refusals.append((node, f"from {node.module} import {alias.name}"))
                else:
                    prefixed[local] = (parts[0], [*parts[1:], alias.name])
                if any(part in MODULE_NAMES for part in parts[1:]):
                    refusals.append((node, f"from {node.module} import {alias.name} reaches another module"))
    tracked_locals = set(modules) | set(names) | set(prefixed)
    for local, sources in imported.items():
        if local in tracked_locals and len(sources) > 1:
            refusals.append((tree, f"{local} is imported as more than one thing ({', '.join(sorted(sources))})"))
    return modules, names, prefixed, refusals


def violations(source, filename="<src>"):
    """Every rule the source breaks, as "line: reason" strings."""
    tree = ast.parse(source, filename)
    modules, names, prefixed, refusals = _tracked(tree)
    found = []

    def bad(node, why):
        found.append(f"{getattr(node, 'lineno', 0)}: {why}")

    for node, why in refusals:
        bad(node, why)

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
            elif (node.id in names or node.id in prefixed) and id(node) not in attribute_bases \
                    and id(node) not in call_funcs:
                # An imported chain head (from os import path) passed on as a value (verdict 105e).
                module, attrs = (names[node.id][0], [names[node.id][1]]) if node.id in names else prefixed[node.id]
                if len(attrs) >= 2 or (module, attrs[0]) in SAFE_CHAINS:
                    bad(node, f"{'.'.join([module, *attrs])} used as a value")
        # Rebinding getattr/hasattr on another object (a module, from outside it).
        if isinstance(node, ast.Attribute) and node.attr in LOOKUPS and isinstance(node.ctx, (ast.Store, ast.Del)):
            bad(node, f"rebinds {node.attr} on another object")
        # Rule 7, on any object: no module name, dunder or frame attribute (verdict 105f).
        if isinstance(node, ast.Attribute):
            why = _reaches(node.attr)
            if why:
                bad(node, f".{node.attr} {why}")
        # getattr/hasattr: a constant name only, judged like an attribute, and never passed on.
        if isinstance(node, ast.Name) and node.id in LOOKUPS and id(node) not in call_funcs:
            bad(node, f"{node.id} used as a value can look up anything")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in LOOKUPS:
            name = node.args[1] if len(node.args) >= 2 else None
            if not (isinstance(name, ast.Constant) and isinstance(name.value, str)):
                bad(node, f"{node.func.id} with a computed name can look up anything")
            elif _reaches(name.value):
                bad(node, f"{node.func.id}(..., {name.value!r}): the name {_reaches(name.value)}")
        # Any reference to a refused attribute, called or not (invoke = os.system).
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in modules:
            module = modules[node.value.id]
            if node.attr in REFUSED.get(module, ()):
                bad(node, f"{module}.{node.attr}")
            elif node.attr.startswith("__"):
                bad(node, f"{module}.{node.attr}")
        # Any attribute path from a tracked module, however its root was imported: never to
        # another module or through a dunder, and past the first attribute only through
        # SAFE_CHAINS, one step deep.
        path = _attribute_path(node, modules, names, prefixed)
        if path is not None:
            module, attrs = path
            dotted = ".".join([module, *attrs])
            if attrs[-1] in MODULE_NAMES:
                bad(node, f"{dotted} reaches another module")
            elif any(a.startswith("__") for a in attrs):
                bad(node, f"{dotted} reaches a dunder")
            elif len(attrs) == 2 and (module, attrs[0]) not in SAFE_CHAINS:
                bad(node, f"{dotted} reaches past the module")
            elif len(attrs) > 2:
                bad(node, f"{dotted} reaches too deep")
            # A chain's head (os.path), or anything past it, bound to a name or passed as a value
            # takes its attributes out of sight of these rules (verdict 105e: path = os.path).
            if (id(node) not in attribute_bases and id(node) not in call_funcs
                    and (len(attrs) >= 2 or (module, attrs[0]) in SAFE_CHAINS)):
                bad(node, f"{dotted} used as a value")
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


def _attribute_path(node, modules, names=None, prefixed=None):
    """(module, [attr, ...]) when *node* is an attribute path from a tracked name, however it was imported."""
    attrs = []
    while isinstance(node, ast.Attribute):
        attrs.append(node.attr)
        node = node.value
    if not attrs or not isinstance(node, ast.Name):
        return None
    attrs.reverse()
    if node.id in modules:
        return modules[node.id], attrs
    if names and node.id in names:
        module, attr = names[node.id]
        return module, [attr, *attrs]
    if prefixed and node.id in prefixed:
        module, prefix = prefixed[node.id]
        return module, [*prefix, *attrs]
    return None


def chains_used(source):
    """The (module, attr) pairs a source reaches past: os.path in os.path.join."""
    tree = ast.parse(source)
    modules, names, prefixed, _ = _tracked(tree)
    used = set()
    for node in ast.walk(tree):
        path = _attribute_path(node, modules, names, prefixed)
        if path is not None and len(path[1]) >= 2:
            used.add((path[0], path[1][0]))
    return used


def executables_started(source):
    """The fixed executables a source starts, as written."""
    started = set()
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
        if name not in {a for _, a in ALLOWED_STARTS}:
            continue
        argv = node.args[0] if node.args else None
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
    # Verdict 105e (on #454): a module reached through an import, or through a name bound to a safe chain.
    "a module imported from another": "from subprocess import os as platform\nplatform.system('id')",
    "a safe chain bound to a name": "import os\npath = os.path\npath.os.system('id')",
    "a submodule import binds its root": "import os.path\nos.system('id')",
    "a submodule imported under a name": "import os.path as p\np.os.system('id')",
    "a module from a submodule's names": "from os.path import os as o\no.system('id')",
    "a safe chain imported by name": "from os import path\npath.os.system('id')",
    "a safe chain imported by name, passed on": "from os import environ\nrun_with(environ)",
    "a safe chain's head passed as a value": "import os\nrun_with(os.environ)",
    "a value past a safe chain": "import os\ng = os.path.genericpath\ng.os.system('id')",
    "a dunder past a safe chain": "import os\nk = os.environ.__class__\nk.__init__.__globals__['system']('id')",
    "a starred import from a submodule": "from os.path import *\njoin('a', 'b')",
    "a module imported from another, passed on": "from subprocess import os as platform\nrun_with(platform)",
    "a module path from a submodule's names": "from os.path import genericpath as g\ng.os.system('id')",
    "a dunder method past a safe chain": "import os\nos.path.__getattribute__('os').system('id')",
    # Verdict 105f (on #503): a dunder from-imported, a tracked module through an untracked one, an alias
    # imported as two modules, and the same routes through any object.
    "a dunder from-imported": "from os import __dict__ as namespace\nnamespace['system']('id')",
    "a tracked module from an untracked one": "from pathlib import os\nos.system('id')",
    "an alias imported as two modules": "import os as platform\n\ndef unused():\n    import yaml as platform\n\nplatform.system('id')",
    "a tracked module through an untracked module's attribute": "import shutil\nshutil.os.system('id')",
    "a dunder on an untracked module": "import pathlib\npathlib.__dict__['os'].system('id')",
    "the object graph from a literal": "classes = ().__class__.__base__.__subclasses__()",
    "getattr of a module name on any object": "import pathlib\ngetattr(pathlib, 'os').system('id')",
    "getattr with a computed name": "import pathlib\ngetattr(pathlib, name).system('id')",
    "getattr passed as a value": "import functools, pathlib\nfunctools.reduce(getattr, ['os'], pathlib).system('id')",
    "a frame's globals through a traceback": "import sys\nsys.exc_info()[2].tb_frame.f_globals['os'].system('id')",
    "sys._getframe": "import sys\nsys._getframe().f_globals['os'].system('id')",
    "import inspect": "import inspect, pathlib\ndict(inspect.getmembers(pathlib))['os'].system('id')",
    "import gc": "import gc\nm = [o for o in gc.get_objects() if getattr(o, '__name__', '') == 'os'][0]\nm.system('id')",
    "pkgutil.resolve_name": "import pkgutil\npkgutil.resolve_name('os').system('id')",
    "pydoc.locate": "import pydoc\npydoc.locate('os').system('id')",
    "import logging.config": "import logging.config\nlogging.config.dictConfig(spec)",
    "from logging import config": "from logging import config\nconfig.dictConfig(spec)",
    "from logging.config import dictConfig": "from logging.config import dictConfig\ndictConfig(spec)",
    "logging.config by attribute": "import logging\nlogging.config.dictConfig(spec)",
    "operator.attrgetter": "import operator, pathlib\noperator.attrgetter('os')(pathlib).system('id')",
    "breakpoint()": "breakpoint()",
    "a relative dunder import": "from . import __builtins__ as b\nb['eval'](x)",
    "a dotted import naming a module": "import xml.os",
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
    # Verdict 105e: what the stricter rule 6 still allows.
    "a constant bound to a name": "import os\nseparator = os.sep",
    "os.path from a submodule import": "import os.path\nfull = os.path.join('a', 'b')",
    "a safe chain imported by name, used in place": "from os import environ\nhome = environ.get('HOME')",
    # Verdict 105f: what rule 7 still allows (each is in the package today).
    "an HTTP error's code": "try:\n    pass\nexcept Exception as e:\n    status = e.code",
    "a type's name": "name = type(e).__name__",
    "super().__init__": "class A(B):\n    def __init__(self):\n        super().__init__()",
    "dataclass fields": "fields = cls.__dataclass_fields__",
    "the package's own version": "from . import __version__",
    "exc_info without frames": "import sys\nkind = sys.exc_info()[0]",
    "a constant hasattr on an object": "supported = hasattr(info, 'server')",
    "the same import in two scopes": "import os\n\ndef f():\n    import os\n    return os.getcwd()",
    "a logger": "import logging\nlog = logging.getLogger('pcc-node')\nlogging.basicConfig(level=logging.INFO)",
    "a rotating log file": "from logging.handlers import RotatingFileHandler\nhandler = RotatingFileHandler(path, maxBytes=1, backupCount=1)",
}


@pytest.mark.parametrize("label", sorted(EVASIONS))
def test_the_guard_catches(label):
    assert violations(EVASIONS[label]), label


@pytest.mark.parametrize("label", sorted(SAFE))
def test_the_guard_allows(label):
    assert violations(SAFE[label]) == [], label
