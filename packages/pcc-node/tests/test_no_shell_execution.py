"""N66: a regression tripwire for shell and code-loading forms in pcc-node's source.

pcc_node/executor.py ran relay-supplied tool-call arguments with
``subprocess.run(cmd, shell=True)``: whoever could queue a tool call for a
kernel got a shell on the operator's machine. It was deleted.

This file reads the package's syntax trees, not its text (verdict 68b, finding
4: a regex scan missed ``shell=flag``, ``**{"shell": True}``, ``from os import
system``, ``getattr(subprocess, name)``, computed argv and ``/usr/bin/env sh``),
and fails when the package uses one of the forms below. It claims exactly
those forms, each pinned by a test case here (``EVASIONS``, ``IMPORT_EVASIONS``
or a package-level test). It is NOT a proof that pcc-node cannot start a
process or load code: three review rounds on #563 each found a new import form,
so the property is enforced at run time by pcc-node's audit hook (board row
N121, adk's #517), whose tests run this file's corpus under the hook.
``EVASIONS``, ``IMPORT_EVASIONS`` and ``SAFE`` stay plain data (label ->
source) for that, as does ``STARTS`` (label -> (source, expected starts)). A
form missing here is a MEDIUM on N121, not a hole in the property. What it
refuses:

1. A call to ``subprocess.run/call/check_call/check_output/Popen`` or
   ``asyncio.create_subprocess_exec`` whose first argument is not a list or
   tuple literal whose first item is one of ``EXECUTABLES``, by bare name (an
   allowlist: a list of shells cannot name every interpreter, verdict 68e,
   finding 2); ``shell=`` other than the literal ``False``; ``executable=``;
   ``**`` keyword expansion other than a dict with constant keys and no
   ``shell``; and a starter bound to another name or passed as a value
   (verdict 68d, finding 2).
2. ``os.system/popen/exec*/spawn*/posix_spawn*``, ``pty.spawn``,
   ``subprocess.getoutput/getstatusoutput`` and
   ``asyncio.create_subprocess_shell``, called by attribute, by an imported
   alias (``from os import system``) or through ``getattr``.
3. ``eval``, ``exec``, ``compile``, ``__import__``, ``importlib.import_module``,
   ``runpy``, ``pickle``/``marshal`` loads and ``yaml.load``: forms that load
   code or objects from data.
4. Checked-in bytecode: the package's ``.pyc`` files were removed.
5. ``getattr``/``hasattr`` with a constant name are judged as that attribute
   only where the name is demonstrably the builtin: nothing in the package
   rebinds it (a def, an assignment, a parameter, an import, ``globals()``,
   ``setattr``, an attribute store), and nothing imports ``builtins``
   (verdict 68e, finding 2).
6. A module reached through another module's attribute (``subprocess.os``),
   and an attribute chain past a tracked module's first attribute other than
   the few the package uses (``SAFE_CHAINS``: ``os.path``, ``os.environ``,
   ``sys.stdin``) (verdict 68f), however the path is named (``from subprocess
   import os``, ``import os.path as p``, ``from os.path import os``), or
   through a dunder; and a chain's head, or anything past it, bound to a name
   or passed as a value (``path = os.path``) (verdict 105e).
7. On any object (verdict 105f): an attribute named like a module the tripwire
   tracks (``pathlib.os``; ``.code`` is allowed, since HTTP errors carry it), a
   dunder outside ``ALLOWED_DUNDERS`` (``pathlib.__dict__``,
   ``().__class__``), and a frame or traceback attribute (``f_globals``,
   ``tb_frame``); ``getattr``/``hasattr`` with a computed name, or passed as a
   value; an import naming a module through another module (``from pathlib
   import os``) or a dunder outside the allowlist (``from os import
   __dict__``); a name imported as more than one thing; ``inspect``, ``gc``,
   ``sys._getframe``, ``operator.attrgetter`` and ``breakpoint()``; and the
   modules that turn a string into a module or a callable (``pkgutil``,
   ``pydoc``, ``zipimport``, ``site``, ``logging.config``).
8. An import of a module outside ``ALLOWED_IMPORTS`` (verdict 105g), the exact
   set the package imports today, kept exact by a census test, so a new
   module is a reviewed change; a private name (``_run_code``,
   ``_syscmd_ver``) reached through an imported module or imported from one;
   a refused builtin passed as a value (``map(eval, ...)``);
   ``ProcessPoolExecutor``, ``CGIHTTPRequestHandler``, ``click.edit`` and
   ``click.launch`` by name, anywhere, and ``click`` passed as a value; a
   package module importing a tracked module, or a name bound from one, from
   another package module (``from .helper import platform``, where helper.py
   did ``import os as platform``; ``from .bridge import run``, where bridge.py
   did ``from subprocess import run``); a star import from any module, the
   package's own included (``from .bridge import *``, #563 r2); and a
   first-party module bound as an object (``import pcc_node.bridge``, aliased
   or not, ``import pcc_node``, ``from . import bridge``), since a module
   object carries every name its module binds at any depth (#563 r3).
   ``executables_started()`` resolves calls exactly as ``violations()`` does.

It tracks names bound by imports, flow-insensitively. It is not a sandbox:
rules 1 and 3 stay the first barriers in the code, and the audit hook (N121)
is the enforcement.
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
# The executables pcc-node runs, by bare name (test_the_executables_allowlist_matches_the_resolved_starts keeps
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
# Rule 8: every module the package imports, exactly (test_the_package_imports_only_what_it_lists keeps this
# list exactly that). A new import is a reviewed change to it.
ALLOWED_IMPORTS = {
    "__future__", "ast", "base64", "click", "concurrent.futures", "cryptography.hazmat.primitives.ciphers.aead",
    "csv", "dataclasses", "datetime", "errno", "fcntl", "glob", "hashlib", "hmac", "html", "http.client",
    "http.server", "httpx", "ipaddress", "json", "logging", "logging.handlers", "math", "nacl.encoding",
    "nacl.exceptions", "nacl.signing", "os", "pathlib", "platform", "re", "secrets", "select", "shutil", "signal",
    "socket", "ssl", "stat", "subprocess", "sys", "threading", "time", "typing", "urllib.error", "urllib.parse",
    "urllib.request", "zeroconf",
}
# Names that start processes, refused anywhere (as an attribute of any object, or imported from any module).
REFUSED_ANYWHERE = {"ProcessPoolExecutor", "CGIHTTPRequestHandler"}
# click's helpers that start an editor or an opener process.
CLICK_REFUSED = {"edit", "launch"}
FRAME_ATTRS = {"f_globals", "f_locals", "f_builtins", "f_back", "f_code", "tb_frame", "tb_next",
               "gi_frame", "gi_code", "cr_frame", "cr_code", "ag_frame", "ag_code"}
# Deliberately over-broad (verdict 105g): every attribute of any object is checked against these
# names, so an ordinary field such as job.operator or device.site is refused too. Rename the field
# rather than shrink this set.
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
                if alias.name == "*":
                    # From any module, the package's own included: a star import binds names, a tracked
                    # module or starter among them, that no rule here can see (#563 r2).
                    refusals.append((node, f"from {source} import *: a star import binds names out of sight"))
                    continue
                if alias.name in REFUSED_ANYWHERE or (node.module == "click" and alias.name in CLICK_REFUSED):
                    refusals.append((node, f"from {source} import {alias.name} starts a process"))
                if node.level == 0 and alias.name.startswith("_") and not alias.name.startswith("__"):
                    refusals.append((node, f"from {source} import {alias.name}: a private name"))
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
                    continue  # refused above, from any module
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


def _call_target(func, modules, names):
    """(module, attr) a call resolves to through the source's own imports (_tracked), if it is one the guard
    tracks. violations() and executables_started() both resolve calls with this, and nothing else."""
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id in modules:
        return modules[func.value.id], func.attr
    if isinstance(func, ast.Name) and func.id in names:
        return names[func.id]
    return None


def violations(source, filename="<src>"):
    """Every rule the source breaks, as "line: reason" strings."""
    tree = ast.parse(source, filename)
    modules, names, prefixed, refusals = _tracked(tree)
    found = []

    def bad(node, why):
        found.append(f"{getattr(node, 'lineno', 0)}: {why}")

    for node, why in refusals:
        bad(node, why)

    # Names bound by any import (rule 8), and the ones bound to click.
    import_bound, click_names = set(), set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for alias in n.names:
                import_bound.add(alias.asname or alias.name.split(".")[0])
                if alias.name == "click":
                    click_names.add(alias.asname or "click")
        elif isinstance(n, ast.ImportFrom) and n.level == 0:
            import_bound.update(alias.asname or alias.name for alias in n.names)
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
            if node.attr in REFUSED_ANYWHERE:
                bad(node, f".{node.attr} starts a process")
            # Rule 8: no private name through an imported module (runpy._run_code, platform._syscmd_ver).
            if (isinstance(node.value, ast.Name) and node.value.id in import_bound
                    and node.attr.startswith("_") and not node.attr.startswith("__")):
                bad(node, f"{node.value.id}.{node.attr}: a private name of an imported module")
            if isinstance(node.value, ast.Name) and node.value.id in click_names and node.attr in CLICK_REFUSED:
                bad(node, f"click.{node.attr} starts a process")
        # Rule 8: a refused builtin passed as a value (map(eval, ...)); click passed as a value.
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and id(node) not in call_funcs:
            if node.id in REFUSED_BUILTINS:
                bad(node, f"{node.id} used as a value can run code from data")
            elif node.id in click_names and id(node) not in attribute_bases:
                bad(node, "click used as a value hides click.edit and click.launch")
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
        resolved = _call_target(func, modules, names)
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


def _own(module):
    """The package's own modules, imported absolutely (pcc_node.x), are not outside surface."""
    return module == PACKAGE.name or module.startswith(PACKAGE.name + ".")


def imported_modules(source):
    """Every absolute module a source imports from outside the package, by its full dotted name."""
    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names if not _own(alias.name))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module and not _own(node.module):
            found.add(node.module)
    return found


def import_violations(source):
    """Rule 8: imports of modules outside ALLOWED_IMPORTS."""
    return [f"imports {m}, which ALLOWED_IMPORTS does not list" for m in sorted(imported_modules(source) - ALLOWED_IMPORTS)]


def _module_names():
    """Each package source, by its dotted module name, and whether it is a package (__init__)."""
    out = {}
    for path in _sources():
        parts = list(path.relative_to(PACKAGE.parent).with_suffix("").parts)
        is_package = parts[-1] == "__init__"
        if is_package:
            parts = parts[:-1]
        out[".".join(parts)] = (path.read_text(encoding="utf-8"), is_package)
    return out


def _resolve(module, is_package, node):
    """The package module an ImportFrom names, absolute or relative, or None."""
    if node.level == 0:
        return node.module
    base = module.split(".") if is_package else module.split(".")[:-1]
    base = base[: len(base) - (node.level - 1)] if node.level > 1 else base
    return ".".join(base + ([node.module] if node.module else []))


def reexport_violations(sources):
    """Rule 8, across files: no module imports a name another package module binds to a tracked module,
    and no first-party module is bound as an object (#563 r3).

    A module object carries every name its module binds, under attribute paths of any depth
    (pcc_node.bridge.run, sub.bridge.run), values (b = bridge) and lookups (getattr(bridge, ...)), so it
    is refused outright: `import pcc_node` or `import pcc_node.x`, aliased or not, and `from . import x`
    or `from pcc_node import x` where x is one of the package's modules. Other modules import names from
    a module instead, and the check above sees each one.

    sources: {dotted module name: (source, is_package)}.
    """
    exported = {}
    for module, (source, _) in sources.items():
        modules, names, prefixed, _refusals = _tracked(ast.parse(source))
        exported[module] = set(modules) | set(names) | set(prefixed)
    found = []
    for module, (source, is_package) in sources.items():
        tree = ast.parse(source)
        local_modules = {}  # local name -> package module it is bound to (from . import helper)
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                target = _resolve(module, is_package, node)
                for alias in node.names:
                    if target in exported and alias.name in exported[target]:
                        found.append(f"{module}:{node.lineno}: imports {alias.name}, which {target} binds to a tracked module")
                    sub = f"{target}.{alias.name}" if target else alias.name
                    if sub in exported:
                        local_modules[alias.asname or alias.name] = sub
                        found.append(f"{module}:{node.lineno}: binds the first-party module {sub} as an object; "
                                     "import names from it instead")
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name in exported and alias.asname:
                        local_modules[alias.asname] = alias.name
                    if _own(alias.name):
                        found.append(f"{module}:{node.lineno}: import {alias.name} binds a first-party module "
                                     "as an object; import names from it instead")
        for node in ast.walk(tree):
            if (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                    and node.value.id in local_modules and node.attr in exported[local_modules[node.value.id]]):
                found.append(f"{module}:{node.lineno}: {node.value.id}.{node.attr} reaches a tracked module "
                             f"through {local_modules[node.value.id]}")
    return found


def executables_started(source):
    """The fixed executables a source starts, as written.

    A call counts only when it resolves to an allowed starter through the source's imports, by the
    same resolver violations() uses (_tracked, then _call_target): a local function or a method that
    only shares a starter's name is not a start (runtime.py's call("GET", path) is an HTTP request).
    """
    tree = ast.parse(source)
    modules, names, _prefixed, _refusals = _tracked(tree)
    started = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or _call_target(node.func, modules, names) not in ALLOWED_STARTS:
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


def test_no_module_uses_a_refused_form():
    hits = []
    for path in _sources():
        source = path.read_text(encoding="utf-8")
        for v in violations(source, str(path)) + import_violations(source):
            hits.append(f"{path.relative_to(PACKAGE)}:{v}")
    hits += reexport_violations(_module_names())
    assert hits == [], "pcc-node uses forms this tripwire refuses:\n" + "\n".join(hits)


def test_the_package_imports_only_what_it_lists():
    # A new import is a reviewed change to ALLOWED_IMPORTS; an unused entry is removed (verdict 105g).
    used = set()
    for path in _sources():
        used |= imported_modules(path.read_text(encoding="utf-8"))
    assert used == ALLOWED_IMPORTS


def test_the_executables_allowlist_matches_the_resolved_starts():
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


# The tripwire's own proof: each listed evasion is refused (the corpus the runtime audit hook's tests
# execute, N121), and the package's real, fixed-argv calls are not.
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
    # Verdict 105g (on #505): a builtin passed on, private surfaces, and process starters by name.
    "eval passed to map": "list(map(eval, [payload]))",
    "exec passed as a callback": "run_later(exec, payload)",
    "runpy._run_code": "from runpy import _run_code\n_run_code(payload, {})",
    "a private name by attribute": "import platform\nplatform._syscmd_ver()",
    "a private name of an untracked module": "import shutil\nshutil._copyxattr(a, b)",
    "ProcessPoolExecutor": "import concurrent.futures\n\ndef work():\n    return 1\n\nconcurrent.futures.ProcessPoolExecutor().submit(work).result()",
    "ProcessPoolExecutor imported": "from concurrent.futures import ProcessPoolExecutor\nProcessPoolExecutor().submit(work)",
    "ProcessPoolExecutor through a value": "import concurrent.futures as cf\npool = cf.ProcessPoolExecutor",
    "CGIHTTPRequestHandler": "from http.server import CGIHTTPRequestHandler\nhandler = CGIHTTPRequestHandler",
    "click.edit": "import click\nclick.edit(text)",
    "click.launch": "import click\nclick.launch(url)",
    "from click import launch": "from click import launch\nlaunch(url)",
    "click as a value": "import click\ntool = click\ntool.edit(text)",
    # #563 r1 (HIGH): a tracked module reached through a dotted import or a from import.
    "from asyncio.subprocess import create_subprocess_shell":
        "from asyncio.subprocess import create_subprocess_shell\nasync def launch(payload):\n"
        "    await create_subprocess_shell(payload)",
    "from asyncio.subprocess import create_subprocess_exec":
        "from asyncio.subprocess import create_subprocess_exec\ncreate_subprocess_exec(remote_exe)",
    "import asyncio.subprocess": "import asyncio.subprocess\nasyncio.subprocess.create_subprocess_shell(x)",
    "import asyncio.subprocess as asp": "import asyncio.subprocess as asp\nasp.create_subprocess_shell(x)",
    "from asyncio import subprocess": "from asyncio import subprocess as asp\nasp.create_subprocess_shell(x)",
    "from os.path import os": "from os.path import os\nos.system('id')",
    "import importlib.util binds importlib": "import importlib.util\nimportlib.import_module(name)",
    "from importlib import util": "from importlib import util\nutil.spec_from_file_location(n, p)",
    "from subprocess import os": "from subprocess import os\nos.system('id')",
    "from os import sys": "from os import sys\nsys.modules['os'].system('id')",
    # #563 r2 (HIGH): a tracked module re-exported by an untracked one, and star imports from anywhere.
    "from pathlib import os": "from pathlib import os as host_os\nhost_os.system('id')",
    "from shutil import os": "from shutil import os\nos.system('id')",
    "pathlib.os by attribute": "import pathlib\npathlib.os.system('id')",
    "a star import of a tracked module": "from os import *\nsystem('id')",
    "a star import of an untracked module": "from shutil import *\nos.system('id')",
    "a star import of the package's own module": "from .bridge import *\nrun(remote_argv, shell=True)",
}
# Rule 8 at the package level: modules outside ALLOWED_IMPORTS, each refused by import_violations().
IMPORT_EVASIONS = {
    "string.Formatter": "import pathlib\nfrom string import Formatter\nFormatter().get_field('0.os.system', (pathlib,), {})[0]('id')",
    "import string": "import string\nstring.Formatter().get_field('0.os', (pathlib,), {})",
    "import runpy": "import runpy\nrunpy._run_code(payload, {})",
    "import pickle": "import pickle\npickle._loads(blob)",
    "a submodule not listed": "import concurrent.futures.process",
    # #563 r2 / steward #6229: modules outside the census that run code or start a shell.
    "import importlib": "import importlib\nimportlib.import_module(name)",
    "import pydoc": "import pydoc\npydoc.pipepager(text, payload)",
    "from pdb import run": "from pdb import run\nrun(payload)",
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
    # Verdict 105g: what rule 8 still allows (each is in the package today).
    "a thread pool": "import concurrent.futures\nwith concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:\n    pool.submit(work)",
    "click's options and output": "import click\n\n@click.option('--x')\ndef f(x):\n    click.echo(x)",
    "click's parameter source": "import click\nif source == click.core.ParameterSource.COMMANDLINE:\n    pass",
    "a package-private helper": "from .crypto import _refuse_legacy\n_refuse_legacy(path)",
    # #563: a starter's own from import stays usable, judged at the call.
    "an imported starter with a fixed argv": "from subprocess import run\nrun(['arp', '-a'], capture_output=True)",
}


@pytest.mark.parametrize("label", sorted(EVASIONS))
def test_the_tripwire_refuses_each_evasion(label):
    assert violations(EVASIONS[label]), label


@pytest.mark.parametrize("label", sorted(IMPORT_EVASIONS))
def test_the_import_census_refuses_each_unlisted_module(label):
    assert import_violations(IMPORT_EVASIONS[label]), label


def test_the_census_allows_the_packages_own_modules():
    # pcc_node.x is the package itself, like a relative import; the operating runtime (#471) uses this form.
    # The census allows both lines; binding the module object (import pcc_node.http_util) is refused
    # separately, by reexport_violations() (test_binding_a_first_party_module_as_an_object_is_refused).
    assert import_violations("from pcc_node.log_capture import canonicalize\nimport pcc_node.http_util\n") == []
    assert import_violations("import pcc_nodes\n") != []  # only the package itself, not a lookalike


def test_a_module_reexported_across_files_is_refused():
    # Verdict 105g: helper.py binds os under another name; consumer.py imports it (or reaches it).
    helper = ("import os as platform\n", False)
    for consumer in ("from .helper import platform\nplatform.system('id')\n",
                     "from pcc_node.helper import platform\nplatform.system('id')\n",
                     "from . import helper\nhelper.platform.system('id')\n",
                     "import pcc_node.helper as h\nh.platform.system('id')\n"):
        sources = {"pcc_node.helper": helper, "pcc_node.consumer": (consumer, False)}
        assert reexport_violations(sources), consumer
    # A name that is not a tracked module may be shared.
    assert reexport_violations({"pcc_node.helper": ("VERSION = '1'\n", False),
                                "pcc_node.consumer": ("from .helper import VERSION\n", False)}) == []


def test_binding_a_first_party_module_as_an_object_is_refused():
    # #563 r3: a module object carries every name its module binds, at any depth and through values.
    bridge = ("from subprocess import run\n", False)
    for consumer in (
        "import pcc_node.bridge\npcc_node.bridge.run(remote_argv, shell=True)\n",  # astra's r3 reproduction
        "import pcc_node\npcc_node.bridge.run(remote_argv, shell=True)\n",
        "import pcc_node.bridge as b\nb.run(remote_argv, shell=True)\n",
        "from . import bridge\nb = bridge\nb.run(remote_argv, shell=True)\n",
        "from . import bridge\ngetattr(bridge, 'run')(remote_argv, shell=True)\n",
        "from pcc_node import bridge\n\ndef go(m):\n    m.run(remote_argv, shell=True)\n\ngo(bridge)\n",
    ):
        sources = {"pcc_node.bridge": bridge, "pcc_node.consumer": (consumer, False)}
        assert reexport_violations(sources), consumer
    # A subpackage's module, through the subpackage object.
    assert reexport_violations({"pcc_node.sub": ("", True), "pcc_node.sub.bridge": bridge,
                                "pcc_node.consumer": ("from pcc_node import sub\nsub.bridge.run(argv, shell=True)\n",
                                                      False)})
    # Refused even when the module binds nothing tracked today: it might tomorrow.
    assert reexport_violations({"pcc_node.helper": ("VERSION = '1'\n", False),
                                "pcc_node.consumer": ("from . import helper\n", False)})
    # Names imported from the package's modules stay usable, the package's own version among them.
    assert reexport_violations({"pcc_node.helper": ("VERSION = '1'\n", False),
                                "pcc_node.consumer": ("from .helper import VERSION\nfrom . import __version__\n",
                                                      False)}) == []


def test_a_starter_reexported_across_files_is_refused():
    # #563 r2: bridge.py imports a starter by name; consumer.py takes it from bridge, by name or as an attribute.
    bridge = ("from subprocess import run\n", False)
    for consumer in ("from .bridge import run\nrun(remote_argv, shell=True)\n",
                     "from pcc_node.bridge import run as go\ngo(remote_argv, shell=True)\n",
                     "from . import bridge\nbridge.run(remote_argv, shell=True)\n"):
        sources = {"pcc_node.bridge": bridge, "pcc_node.consumer": (consumer, False)}
        assert reexport_violations(sources), consumer


@pytest.mark.parametrize("label", sorted(SAFE))
def test_the_tripwire_allows_each_safe_form(label):
    assert violations(SAFE[label]) == [], label


# The starts inventory's own proof (#563): a start counts when it resolves to an allowed starter
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
def test_the_starts_inventory_counts_only_resolved_starters(label):
    source, expected = STARTS[label]
    assert executables_started(source) == expected, label
