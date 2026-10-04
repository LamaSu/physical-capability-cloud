"""N117b: every test the suite holds ran, once, and passed: checked from outside the run.

The CI job's summary check sees only what pytest REPORTS: skipped, deselected, xfailed,
xpassed, errors. A test that never reaches the report leaves no word in that summary, because
a conftest's collect_ignore or a collection hook dropped it (astra on #563 r1, MEDIUM). This
script closes that gap by comparing two independent lists:

- collected: the node IDs a separate ``pytest --collect-only -q`` run finds, with ``-c
  /dev/null`` and ``--noconftest``, so no ini file and no conftest can hide a file or an item;
- executed: the test cases the real run reported in its JUnit XML (``junit_family=xunit1``,
  which records each case's file).

It fails unless the two lists hold the same node IDs, each exactly once, and every executed
case passed (no skipped, error or failure element).

The independent collection still imports every test module, so a module could change it from
inside: ``pytest_plugins`` loads a plugin whose collection hook drops items from BOTH lists
(astra on #572 r1, MEDIUM). Two checks close that route:

- no test module (every .py under tests/ but conftest.py, whose hooks the comparison already
  sees) binds a ``pytest_*`` name (``pytest_plugins`` among them), defines a ``pytest_*`` hook,
  writes a ``pytest_*`` attribute or into ``vars(...)``, calls ``globals()`` or ``locals()``, or
  touches ``.pluginmanager``;
- the independent collection's own summary ("N tests collected") must count exactly the IDs it
  listed, with nothing deselected: a hook that drops items after collection leaves the two apart.

Standard library only.

Usage: python3 run_manifest_check.py COLLECTED_TXT JUNIT_XML
"""

import ast
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

TESTS = pathlib.Path(__file__).resolve().parent
SUMMARY_RE = re.compile(r"^(?:(\d+)/)?(\d+) tests? collected(?: \((\d+) deselected\))?")


def collected_ids(text):
    """The node IDs in ``pytest --collect-only -q`` output: one per line, before the summary."""
    ids = [line.strip() for line in text.splitlines() if "::" in line]
    return ids


def summary_problems(text, ids):
    """Why the collection's own summary disagrees with the IDs it listed; [] if it agrees."""
    for line in text.splitlines():
        match = SUMMARY_RE.match(line.strip())
        if match:
            selected, collected, deselected = match.groups()
            if selected is not None or deselected is not None:
                return [f"the independent collection deselected tests: {line.strip()}"]
            if int(collected) != len(ids):
                return [f"the independent collection counted {collected} tests but listed {len(ids)}: "
                        "a hook dropped items after collection"]
            return []
    return ["the independent collection printed no 'N tests collected' summary"]


def plugin_problems(source):
    """Why a test module could install a pytest plugin or hook from inside; [] if it cannot."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name.startswith("pytest_"):
            found.append(f"defines {node.name}")
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)) and node.id.startswith("pytest_"):
            found.append(f"binds {node.id}")
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if (alias.asname or alias.name).startswith("pytest_"):
                    found.append(f"imports as {alias.asname or alias.name}")
        elif isinstance(node, ast.Attribute):
            if node.attr == "pluginmanager":
                found.append("touches .pluginmanager")
            elif isinstance(node.ctx, (ast.Store, ast.Del)) and node.attr.startswith("pytest_"):
                found.append(f"writes the attribute {node.attr}")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in ("globals", "locals"):
                found.append(f"calls {node.func.id}()")
            elif node.func.id == "setattr" and len(node.args) >= 2 and not (
                    isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str)
                    and not node.args[1].value.startswith("pytest_")):
                found.append("calls setattr with a pytest_* or computed name")
        if isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign, ast.Delete)):
            targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
            for target in targets:
                if (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Call)
                        and isinstance(target.value.func, ast.Name) and target.value.func.id == "vars"):
                    found.append("writes into vars(...)")
    return found


def module_problems(tests_dir=TESTS):
    """plugin_problems() for every test module but conftest.py, as readable lines."""
    found = []
    for path in sorted(tests_dir.rglob("*.py")):
        if path.name == "conftest.py" or "__pycache__" in path.parts:
            continue
        for why in plugin_problems(path.read_text(encoding="utf-8")):
            found.append(f"{path.relative_to(tests_dir.parent)} {why}: a test module must not install pytest plugins or hooks")
    return found


def executed_cases(xml_text):
    """[(node id, outcome)] for every testcase in an xunit1 JUnit report, in report order."""
    cases = []
    for case in ET.fromstring(xml_text).iter("testcase"):
        path, classname, name = case.get("file"), case.get("classname", ""), case.get("name", "")
        if not path or not path.endswith(".py") or not name:
            raise ValueError(f"testcase {classname!r} {name!r} has no file (run with -o junit_family=xunit1)")
        module = path[:-3].replace("/", ".")
        if classname != module and not classname.startswith(module + "."):
            raise ValueError(f"testcase {classname}::{name} does not belong to {path}")
        classes = classname[len(module) + 1:].split(".") if classname != module else []
        outcome = "passed"
        for child in case:
            if child.tag in ("skipped", "error", "failure"):
                outcome = child.tag
        cases.append(("::".join([path, *classes, name]), outcome))
    return cases


def problems(collected, executed):
    """Every way the run differs from the independent collection, as readable lines."""
    found = []
    executed_ids = [node for node, _ in executed]
    for label, ids in (("collected", collected), ("executed", executed_ids)):
        seen = set()
        for node in ids:
            if node in seen:
                found.append(f"{label} twice: {node}")
            seen.add(node)
    missing = sorted(set(collected) - set(executed_ids))
    extra = sorted(set(executed_ids) - set(collected))
    found += [f"never ran (collected without conftest or ini, absent from the run): {node}" for node in missing]
    found += [f"ran but not collected independently: {node}" for node in extra]
    found += [f"{outcome}: {node}" for node, outcome in executed if outcome != "passed"]
    if not collected:
        found.append("the independent collection found no tests")
    return found


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as fh:
        text = fh.read()
    collected = collected_ids(text)
    with open(argv[2], encoding="utf-8") as fh:
        executed = executed_cases(fh.read())
    found = module_problems() + summary_problems(text, collected) + problems(collected, executed)
    if found:
        print(f"run manifest check FAILED ({len(found)} problems):")
        for line in found:
            print("  " + line)
        return 1
    print(f"run manifest check passed: {len(collected)} tests collected independently, each ran once and passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
