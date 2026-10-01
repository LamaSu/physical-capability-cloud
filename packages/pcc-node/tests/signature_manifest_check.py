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

pytest runs with external options neutralized: PYTEST_ADDOPTS and
PYTEST_PLUGINS are removed, plugin autoload is off, ini `addopts` is
overridden, and `--runxfail` makes an xfail marker run the test normally.
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
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONPATH"] = "."
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "manifest.xml")
        cmd = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--runxfail",
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
    if len(sys.argv) != 2 or sys.argv[1] not in ("positive", "negative"):
        fail("usage: signature_manifest_check.py positive|negative")
    mode = sys.argv[1]
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
