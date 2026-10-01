#!/usr/bin/env python3
"""CI gate for the LO-EV-1 signature half (board row R20; cross-family review A01c-q2).

The evidence-signature-parity workflow runs this script twice:

  positive  (PyNaCl installed): every test in the manifest must be collected and
            PASS. Nothing may be skipped, deselected, xfailed, xpassed or missing.
  negative  (PyNaCl absent): every test in the manifest must be collected and
            FAIL on the PyNaCl requirement itself. That proves the positive run
            cannot pass by skipping.

The manifest is derived, not hand-kept:
  - the test functions are every function in test_signing_preimage_parity.py
    that takes the `nacl` fixture (checked against the five named below, so a
    new PyNaCl test cannot run unenforced, and a removed one is noticed);
  - their parameters are the golden vectors in goldens.json.

pytest runs isolated from everything but the test module and the code it
tests (reviews A01d, A01e):
  - `python -I -B`: no PYTHONPATH and no script or working directory on
    sys.path, so a repository sitecustomize.py or usercustomize.py is never
    imported; no user site-packages; no bytecode written;
  - `-c os.devnull --rootdir <package>`: no ini file is read;
  - `--noconftest`: no conftest.py hook can replace a test body or a report;
  - PYTEST_ADDOPTS and PYTEST_PLUGINS removed, plugin autoload off;
  - `--runxfail`: an xfail marker runs the test normally.
A test module can still name plugins (`pytest_plugins`) or hooks itself, so
the module is checked first (`refuse_hooks`): it may import only json, os,
pathlib, pytest, pcc_node and nacl; it may bind no `pytest_*` name; it may not
call __import__, exec, eval, compile, globals, vars or setattr; and it may not
assign an attribute of an imported module. `selftest` proves that check
refuses each of those shapes. What remains is the test module's own code: a
change to it, or to this script or the workflow, is a code change reviewed
like any other.
Results are read from pytest's JUnit XML, never from its text summary.
Stdlib only.
"""
import ast
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
TEST_FILE = os.path.join("tests", "test_signing_preimage_parity.py")
MODULE = "tests.test_signing_preimage_parity"
PYNACL_PHRASE = "PCC_REQUIRE_PYNACL=1 but PyNaCl is not importable"

# Each PyNaCl test function and the golden section it is parametrized over.
MANIFEST = {
    "test_signing_preimage_signature_parity": "signing_preimage",
    "test_raw32_signature_never_verifies_against_the_preimage": "signing_preimage",
    "test_session_delegation_signature_parity": "session_delegation",
    "test_sorted_key_delegation_is_rejected": "session_delegation",
    "test_session_revocation_signature_parity": "session_revocation",
}


def fail(msg):
    print("signature manifest: FAIL: " + msg)
    sys.exit(1)


ALLOWED_IMPORTS = {"json", "os", "pathlib", "pytest", "pcc_node", "nacl"}
FORBIDDEN_CALLS = {"__import__", "exec", "eval", "compile", "globals", "vars", "setattr"}


def hook_problems(source):
    """Why a test module could install pytest plugins or hooks, or patch an imported module; [] if it cannot."""
    tree = ast.parse(source)
    imported = set()
    problems = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add((alias.asname or alias.name).split(".")[0])
                if alias.name.split(".")[0] not in ALLOWED_IMPORTS:
                    problems.append("imports %s" % alias.name)
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imported.add(alias.asname or alias.name)
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                problems.append("imports from %s%s" % ("." * node.level, node.module or ""))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name.startswith("pytest_"):
            problems.append("defines %s" % node.name)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id.startswith("pytest_"):
            problems.append("binds %s" % node.id)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in FORBIDDEN_CALLS:
            problems.append("calls %s" % node.func.id)
    for node in ast.walk(tree):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, (ast.AugAssign, ast.AnnAssign)) else []
        for target in targets:
            base = target
            while isinstance(base, (ast.Attribute, ast.Subscript)):
                base = base.value
            if base is not target and isinstance(base, ast.Name) and base.id in imported:
                problems.append("assigns into %s" % base.id)
    return problems


def refuse_hooks():
    with open(os.path.join(PKG, TEST_FILE), encoding="utf-8") as f:
        problems = hook_problems(f.read())
    if problems:
        fail("%s could change how pytest runs it: %s" % (TEST_FILE, "; ".join(sorted(set(problems)))))


def selftest():
    """Each shape that can install a plugin or hook, or patch pytest, must be refused; the real module must pass."""
    hostile = {
        "pytest_plugins": 'pytest_plugins = ("signature_bypass_plugin",)\n',
        "annotated pytest_plugins": 'pytest_plugins: tuple = ("x",)\n',
        "a hook function": "def pytest_pyfunc_call(pyfuncitem):\n    return True\n",
        "a hook in a class": "class T:\n    def pytest_runtest_call(self, item):\n        pass\n",
        "a foreign import": "import importlib\n",
        "a relative import": "from . import helper\n",
        "a foreign from-import": "from _pytest import python\n",
        "__import__": '__import__("signature_bypass_plugin")\n',
        "exec": 'exec("x = 1")\n',
        "setattr": 'import pytest\nsetattr(pytest, "x", 1)\n',
        "patching pytest": "import pytest\npytest.hookimpl = None\n",
        "patching through an alias": "import nacl.signing as signing\nsigning.VerifyKey.verify = None\n",
        "globals": 'globals()["pytest_plugins"] = ("x",)\n',
    }
    for label, source in hostile.items():
        if not hook_problems(source):
            fail("selftest: %s was not refused" % label)
    refuse_hooks()
    print("signature manifest: ok, selftest refused all %d hostile shapes and the test module passes" % len(hostile))


def _takes_nacl(fn):
    """A test function (pytest collects `test*`) that takes the `nacl` fixture."""
    return isinstance(fn, ast.FunctionDef) and fn.name.startswith("test") and any(a.arg == "nacl" for a in fn.args.args)


def nacl_consumers():
    """Every test in the module that takes the `nacl` fixture, module-level or in a class."""
    with open(os.path.join(PKG, TEST_FILE), encoding="utf-8") as f:
        tree = ast.parse(f.read())
    found = set()
    for node in tree.body:
        if _takes_nacl(node):
            found.add(node.name)
        if isinstance(node, ast.ClassDef):
            found.update("%s.%s" % (node.name, item.name) for item in node.body if _takes_nacl(item))
    return found


def expected_ids():
    refuse_hooks()
    consumers = nacl_consumers()
    if set(consumers) != set(MANIFEST):
        fail("the PyNaCl tests in %s are %s, but the manifest names %s" % (
            TEST_FILE, sorted(consumers), sorted(MANIFEST)))
    with open(os.path.join(HERE, "goldens.json"), encoding="utf-8") as f:
        goldens = json.load(f)
    ids = set()
    for fn, section in MANIFEST.items():
        names = [g["name"] for g in goldens[section]]
        if not names:
            fail("golden section %s is empty" % section)
        if len(set(names)) != len(names):
            fail("golden section %s has duplicate names" % section)
        for name in names:
            if not all(0x20 < ord(c) < 0x7F for c in name) or "[" in name or "]" in name:
                fail("golden name %r is not plain printable ASCII" % name)
            ids.add("%s[%s]" % (fn, name))
    return ids


def run_manifest():
    """Run exactly the manifest's functions; return (exit code, {test id: outcome, detail})."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTEST_ADDOPTS", "PYTEST_PLUGINS")}
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
    env["PCC_REQUIRE_PYNACL"] = "1"
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "manifest.xml")
        cmd = [sys.executable, "-I", "-B", "-m", "pytest", "-q", "-c", os.devnull, "--rootdir", PKG,
               "-p", "no:cacheprovider", "--noconftest", "--runxfail",
               "-o", "addopts=", "-o", "junit_family=xunit2", "--junitxml", report]
        cmd += ["%s::%s" % (TEST_FILE, fn) for fn in sorted(MANIFEST)]
        proc = subprocess.run(cmd, cwd=PKG, env=env, capture_output=True, text=True)
        print("\n".join((proc.stdout + proc.stderr).strip().splitlines()[-3:]))
        if not os.path.exists(report):
            fail("pytest wrote no JUnit report (exit %d)" % proc.returncode)
        root = ET.parse(report).getroot()
    results = {}
    for case in root.iter("testcase"):
        if case.get("classname") != MODULE:
            fail("unexpected test case %s.%s" % (case.get("classname"), case.get("name")))
        tid = case.get("name")
        if tid in results:
            fail("test %s reported twice" % tid)
        kinds = [child.tag for child in case if child.tag in ("skipped", "failure", "error")]
        detail = " ".join((child.get("message") or "") + " " + (child.text or "")
                          for child in case if child.tag in ("skipped", "failure", "error"))
        results[tid] = ("passed" if not kinds else "+".join(kinds), detail)
    return proc.returncode, results


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("positive", "negative", "selftest"):
        fail("usage: signature_manifest_check.py positive|negative|selftest")
    mode = sys.argv[1]
    if mode == "selftest":
        selftest()
        return
    expected = expected_ids()
    rc, results = run_manifest()
    missing = sorted(expected - set(results))
    extra = sorted(set(results) - expected)
    if missing:
        fail("%d manifest tests did not run, e.g. %s" % (len(missing), missing[:3]))
    if extra:
        fail("%d tests ran that the manifest does not name, e.g. %s" % (len(extra), extra[:3]))
    if mode == "positive":
        bad = sorted(t for t, (outcome, _) in results.items() if outcome != "passed")
        if rc != 0 or bad:
            fail("exit %d; not passed: %s" % (rc, bad[:5]))
        print("signature manifest: ok, all %d PyNaCl tests ran and passed" % len(expected))
    else:
        if rc == 0:
            fail("pytest passed without PyNaCl: the signature half can hide")
        bad = sorted(t for t, (outcome, detail) in results.items()
                     if outcome == "passed" or "skipped" in outcome or PYNACL_PHRASE not in detail)
        if bad:
            fail("%d tests did not fail on the PyNaCl requirement, e.g. %s" % (len(bad), bad[:3]))
        print("signature manifest: ok, all %d PyNaCl tests failed on the PyNaCl requirement" % len(expected))


if __name__ == "__main__":
    main()
