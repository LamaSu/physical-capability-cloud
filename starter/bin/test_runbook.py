"""The runbook stays consistent with itself, with painpoints' reporting contract,
and with the truths the agent pack enforces. Standard library only:
python3 -m unittest discover -s starter/bin -p 'test_*.py'
"""

import json
import pathlib
import re
import unittest

STARTER = pathlib.Path(__file__).resolve().parents[1]
RUNBOOK = STARTER / "runbook"
PHASES = ["prerequisites", "identify", "intake", "research", "build", "register", "verify", "operate", "publish", "session"]


def text_files():
    for path in sorted(STARTER.rglob("*")):
        if path.is_file() and path.suffix in (".md", ".json") and ".pcc" not in path.parts:
            yield path, path.read_text(encoding="utf-8")


class TestPhaseGraph(unittest.TestCase):
    def setUp(self):
        self.book = json.loads((RUNBOOK / "runbook.json").read_text(encoding="utf-8"))

    def test_phases_are_the_contract_phases_in_order(self):
        self.assertEqual([p["id"] for p in self.book["phases"]], PHASES)
        self.assertEqual(self.book["reporting"], {**self.book["reporting"], "tool": "pcc_report_attempt", "contract": 1})

    def test_each_phase_links_to_the_next_and_has_checks(self):
        phases = self.book["phases"]
        for here, after in zip(phases, phases[1:] + [None]):
            self.assertEqual(here["next"], after["id"] if after else None, here["id"])
            self.assertTrue(here["goal"] and here["doneWhen"], here["id"])
            self.assertIsInstance(here["asksHuman"], list, here["id"])

    def test_each_phase_file_exists_and_reports_its_phase(self):
        for phase in self.book["phases"]:
            text = (RUNBOOK / phase["file"]).read_text(encoding="utf-8")
            self.assertIn(f"bin/pcc-report {phase['id']} ", text, phase["file"])

    def test_the_asking_rule_forbids_defaulting_money_and_safety(self):
        self.assertIn("never defaulted", self.book["askingRule"])


class TestTruths(unittest.TestCase):
    def test_no_call_goes_to_production(self):
        for path, text in text_files():
            for line in text.splitlines():
                if re.search(r"\bcurl\b", line):
                    self.assertNotIn("https://capability.network", line, f"{path.name}: {line}")

    def test_pcc_node_is_installed_with_crypto_and_a_real_version(self):
        installs = 0
        for path, text in text_files():
            for m in re.finditer(r"pip3? install [^\n`]*pcc-node[^\n`]*", text):
                installs += 1
                line = m.group(0)
                self.assertRegex(line, r"pcc-node\[crypto\]", f"{path.name}: {line}")
                self.assertRegex(line, r">=0\.1\.1|@[0-9a-f]{40}", f"{path.name}: {line}")
        self.assertGreater(installs, 0)

    def test_pcc_job_complete_and_test_job_appear_only_as_warnings(self):
        for path, text in text_files():
            for line in text.splitlines():
                if "pcc_job_complete" in line or "/api/setup/test-job" in line:
                    self.assertRegex(line, r"(?i)\bdon't\b|\bdo not\b|\bnot\b", f"{path.name}: {line}")

    def test_provisioning_output_goes_to_a_private_file_never_the_terminal(self):
        for path, text in text_files():
            for m in re.finditer(r"/api/auth/provision", text):
                window = text[m.end(): m.end() + 400]
                self.assertRegex(window, r"> \.pcc/", f"{path.name}: provision output must be written under .pcc/")

    def test_the_private_state_is_git_ignored(self):
        self.assertIn(".pcc/", (STARTER / ".gitignore").read_text(encoding="utf-8").splitlines())


if __name__ == "__main__":
    unittest.main()
