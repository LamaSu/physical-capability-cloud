"""N117b: the run manifest check's own proof (tests/run_manifest_check.py)."""

import pathlib
import subprocess
import sys

import pytest

from tests.run_manifest_check import collected_ids, executed_cases, problems

CHECK = pathlib.Path(__file__).resolve().parent / "run_manifest_check.py"

COLLECTED = """tests/test_a.py::test_one
tests/test_a.py::TestThing::test_two
tests/test_b.py::Outer::Inner::test_three[x-1]

3 tests collected in 0.01s
"""


def junit(*cases):
    body = "".join(cases)
    return f'<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">{body}</testsuite></testsuites>'


def case(classname, name, file, child=""):
    return f'<testcase classname="{classname}" name="{name}" file="{file}" line="1" time="0.0">{child}</testcase>'


ALL_PASSED = junit(
    case("tests.test_a", "test_one", "tests/test_a.py"),
    case("tests.test_a.TestThing", "test_two", "tests/test_a.py"),
    case("tests.test_b.Outer.Inner", "test_three[x-1]", "tests/test_b.py"),
)


def test_node_ids_are_rebuilt_from_xunit1_cases():
    assert [node for node, _ in executed_cases(ALL_PASSED)] == collected_ids(COLLECTED)
    assert problems(collected_ids(COLLECTED), executed_cases(ALL_PASSED)) == []


def test_a_test_dropped_from_the_run_is_reported():
    # What a conftest's collect_ignore or a collection hook does: the summary has no word for it.
    run = junit(case("tests.test_a", "test_one", "tests/test_a.py"),
                case("tests.test_a.TestThing", "test_two", "tests/test_a.py"))
    assert problems(collected_ids(COLLECTED), executed_cases(run)) == [
        "never ran (collected without conftest or ini, absent from the run): tests/test_b.py::Outer::Inner::test_three[x-1]"]


@pytest.mark.parametrize("child", ['<skipped message="x"/>', '<error message="x"/>', '<failure message="x"/>'])
def test_a_case_that_did_not_pass_is_reported(child):
    run = junit(case("tests.test_a", "test_one", "tests/test_a.py", child),
                case("tests.test_a.TestThing", "test_two", "tests/test_a.py"),
                case("tests.test_b.Outer.Inner", "test_three[x-1]", "tests/test_b.py"))
    tag = child[1:].split(" ")[0]
    assert problems(collected_ids(COLLECTED), executed_cases(run)) == [f"{tag}: tests/test_a.py::test_one"]


def test_a_case_the_collection_never_saw_is_reported():
    run = ALL_PASSED.replace("</testsuite>", case("tests.test_c", "test_made_up", "tests/test_c.py") + "</testsuite>")
    assert problems(collected_ids(COLLECTED), executed_cases(run)) == [
        "ran but not collected independently: tests/test_c.py::test_made_up"]


def test_a_case_reported_twice_is_reported():
    run = ALL_PASSED.replace("</testsuite>", case("tests.test_a", "test_one", "tests/test_a.py") + "</testsuite>")
    assert problems(collected_ids(COLLECTED), executed_cases(run)) == ["executed twice: tests/test_a.py::test_one"]


def test_an_empty_collection_fails():
    assert problems([], []) == ["the independent collection found no tests"]


def test_a_report_without_files_is_refused():
    # xunit2, pytest's default, records no file: the check can't place a case, so it refuses the report.
    with pytest.raises(ValueError):
        executed_cases(junit('<testcase classname="tests.test_a" name="test_one" time="0.0"/>'))


def test_a_case_that_names_another_file_is_refused():
    with pytest.raises(ValueError):
        executed_cases(junit(case("tests.test_b", "test_one", "tests/test_a.py")))


def test_the_command_line_exit_codes(tmp_path):
    collected = tmp_path / "collected.txt"
    collected.write_text(COLLECTED)
    report = tmp_path / "junit.xml"
    report.write_text(ALL_PASSED)
    ok = subprocess.run([sys.executable, "-I", "-B", str(CHECK), str(collected), str(report)],
                        capture_output=True, text=True, timeout=30)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    report.write_text(junit(case("tests.test_a", "test_one", "tests/test_a.py")))
    bad = subprocess.run([sys.executable, "-I", "-B", str(CHECK), str(collected), str(report)],
                         capture_output=True, text=True, timeout=30)
    assert bad.returncode == 1
    assert "never ran" in bad.stdout
