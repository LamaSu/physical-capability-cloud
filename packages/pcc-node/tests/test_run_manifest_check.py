"""N117b: the run manifest check's own proof (tests/run_manifest_check.py)."""

import pathlib
import subprocess
import sys

import pytest

from tests.run_manifest_check import (collected_ids, executed_cases, module_problems, plugin_problems, problems,
                                      summary_problems)

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


# #572 r1 (MEDIUM): a test module must not install a plugin that drops items from both lists.
HOSTILE_MODULES = {
    "pytest_plugins": 'pytest_plugins = ("tests.bypass",)\n',
    "annotated pytest_plugins": 'pytest_plugins: tuple = ("tests.bypass",)\n',
    "pytest_plugins by import": "from tests.bypass import plugins as pytest_plugins\n",
    "a hook function": "def pytest_collection_modifyitems(config, items):\n    items.clear()\n",
    "a hook in a class": "class Plugin:\n    def pytest_collection_modifyitems(self, items):\n        items.clear()\n",
    "a hook bound by assignment": "pytest_collection_modifyitems = drop\n",
    "globals()": 'globals()["pytest_plugins"] = ("tests.bypass",)\n',
    "vars() write": 'import sys\nvars(sys.modules[__name__])["pytest_plugins"] = ("x",)\n',
    "an attribute write": 'import sys\nsys.modules[__name__].pytest_plugins = ("x",)\n',
    "setattr pytest_plugins": 'import sys\nsetattr(sys.modules[__name__], "pytest_plugins", ("x",))\n',
    "setattr computed": "import sys\nsetattr(sys.modules[__name__], name, value)\n",
    "the plugin manager": "def test_x(request):\n    request.config.pluginmanager.register(Plugin())\n",
}
SAFE_MODULES = {
    "reading vars()": "import ui_server\nnames = [n for n, _ in vars(ui_server).items()]\n",
    "monkeypatch.setattr": 'def test_x(monkeypatch):\n    monkeypatch.setattr(cli, "DIAG_ACK_PATH", "x")\n',
    "setattr with a plain constant name": 'setattr(obj, "timeout", 5)\n',
    "an ordinary test": "import pytest\n\n@pytest.mark.parametrize('x', [1])\ndef test_x(x):\n    assert x\n",
}


@pytest.mark.parametrize("label", sorted(HOSTILE_MODULES))
def test_a_module_that_could_install_a_plugin_is_refused(label):
    assert plugin_problems(HOSTILE_MODULES[label]), label


@pytest.mark.parametrize("label", sorted(SAFE_MODULES))
def test_ordinary_test_code_is_allowed(label):
    assert plugin_problems(SAFE_MODULES[label]) == [], label


def test_the_suites_own_modules_pass(tmp_path):
    assert module_problems() == []
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "conftest.py").write_text("def pytest_collection_modifyitems(items):\n    pass\n")  # the diff sees conftest
    (tests / "test_a.py").write_text('pytest_plugins = ("tests.bypass",)\n')
    (tests / "bypass.py").write_text("def pytest_collection_modifyitems(config, items):\n    items.clear()\n")
    assert [line.split(" ")[0] for line in module_problems(tests)] == ["tests/bypass.py", "tests/test_a.py"]


def test_the_collection_summary_must_count_what_it_listed():
    ids = collected_ids(COLLECTED)
    assert summary_problems(COLLECTED, ids) == []
    assert summary_problems("tests/test_a.py::test_one\n\n1 test collected in 0.01s\n", ["tests/test_a.py::test_one"]) == []
    # A hook that drops items after collection: pytest still counts them in its summary.
    assert summary_problems(COLLECTED.replace("3 tests collected", "5 tests collected"), ids) == [
        "the independent collection counted 5 tests but listed 3: a hook dropped items after collection"]
    assert summary_problems(COLLECTED.replace("3 tests collected", "3/5 tests collected (2 deselected)"), ids)
    assert summary_problems("tests/test_a.py::test_one\n", ["tests/test_a.py::test_one"]) == [
        "the independent collection printed no 'N tests collected' summary"]
