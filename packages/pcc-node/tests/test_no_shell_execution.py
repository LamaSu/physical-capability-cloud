"""N66: pcc-node never hands a string to a shell.

pcc_node/executor.py ran relay-supplied tool-call arguments with
``subprocess.run(cmd, shell=True)``: whoever could queue a tool call for a
kernel got a shell on the operator's machine. Nothing called it (the daemon
uses job_executor.JobExecutor), but it shipped in the pip package, so it was
deleted. This scan keeps the class out: no module in the package may start a
shell, and every subprocess call passes an argument list.
"""

import pathlib
import re

PACKAGE = pathlib.Path(__file__).resolve().parents[1] / "pcc_node"

SHELL_PATTERNS = {
    "shell=True": re.compile(r"shell\s*=\s*True"),
    "os.system": re.compile(r"\bos\.system\s*\("),
    "os.popen": re.compile(r"\bos\.popen\s*\("),
    "subprocess.getoutput": re.compile(r"\bsubprocess\.getstatusoutput\s*\(|\bsubprocess\.getoutput\s*\("),
}


def _sources():
    return sorted(p for p in PACKAGE.rglob("*.py") if "__pycache__" not in p.parts)


def test_the_package_sources_are_scanned():
    names = {p.name for p in _sources()}
    assert "job_executor.py" in names and "daemon.py" in names


def test_no_module_starts_a_shell():
    hits = []
    for path in _sources():
        text = path.read_text(encoding="utf-8")
        for label, pattern in SHELL_PATTERNS.items():
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                hits.append(f"{path.relative_to(PACKAGE)}:{line}: {label}")
    assert hits == [], "a shell must never run in pcc-node:\n" + "\n".join(hits)


def test_the_relay_shell_executor_is_gone():
    assert not (PACKAGE / "executor.py").exists()
