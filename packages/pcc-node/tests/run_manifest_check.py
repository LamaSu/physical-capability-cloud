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
case passed (no skipped, error or failure element). Standard library only.

Usage: python3 run_manifest_check.py COLLECTED_TXT JUNIT_XML
"""

import sys
import xml.etree.ElementTree as ET


def collected_ids(text):
    """The node IDs in ``pytest --collect-only -q`` output: one per line, before the summary."""
    ids = [line.strip() for line in text.splitlines() if "::" in line]
    return ids


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
        collected = collected_ids(fh.read())
    with open(argv[2], encoding="utf-8") as fh:
        executed = executed_cases(fh.read())
    found = problems(collected, executed)
    if found:
        print(f"run manifest check FAILED ({len(found)} problems):")
        for line in found:
            print("  " + line)
        return 1
    print(f"run manifest check passed: {len(collected)} tests collected independently, each ran once and passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
