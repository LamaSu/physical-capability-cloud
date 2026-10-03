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


OUTCOMES = ["ok", "failed", "blocked", "skipped", "budget_stop", "abandoned", "in_progress"]


def headings(text):
    """Markdown headings outside fenced code blocks."""
    found, fenced = set(), False
    for line in text.splitlines():
        if line.startswith("```"):
            fenced = not fenced
        elif not fenced and line.startswith("#"):
            found.add(line.lstrip("#").strip())
    return found


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


class TestIndex(unittest.TestCase):
    """R6: events map to what to do and where the runbook covers it."""

    def setUp(self):
        self.events = json.loads((RUNBOOK / "index.json").read_text(encoding="utf-8"))["events"]

    def test_the_runbook_points_at_the_index(self):
        book = json.loads((RUNBOOK / "runbook.json").read_text(encoding="utf-8"))
        self.assertEqual(book["index"], "index.json")

    def test_every_event_is_keyed_by_its_phase(self):
        self.assertGreater(len(self.events), 0)
        for key, event in self.events.items():
            self.assertRegex(key, r"^[a-z]+\.[a-z0-9-]+$")
            self.assertEqual(key.split(".")[0], event["phase"], key)
            self.assertIn(event["phase"], PHASES, key)
            self.assertTrue(event["trigger"] and event["do"], key)

    def test_every_event_points_at_a_real_section(self):
        for key, event in self.events.items():
            path = RUNBOOK / event["file"]
            self.assertTrue(path.is_file(), key)
            if event["section"] is not None:
                self.assertIn(event["section"], headings(path.read_text(encoding="utf-8")), key)

    def test_reports_use_the_contract(self):
        for key, event in self.events.items():
            if event["report"] is not None:
                self.assertEqual(event["report"]["phase"], event["phase"], key)
                self.assertIn(event["report"]["outcome"], OUTCOMES, key)


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

    def test_every_provisioning_call_sends_its_own_public_key(self):
        # Rehearsal R0's P9: without publicKey, the response carries a server-made private key.
        # A body is either inline JSON, or a private file built just before the call (115c F5).
        calls = 0
        for path, text in text_files():
            for m in re.finditer(r"curl [^\n]*/api/auth/provision", text):
                calls += 1
                after = text[m.end(): m.end() + 300]
                body_file = re.search(r"--data-binary @(\S+)", after)
                if body_file:
                    before = text[max(0, m.start() - 600): m.start()]
                    self.assertIn("> " + body_file.group(1), before, f"{path.name}: body file not built here")
                    self.assertIn('"publicKey"', before, f"{path.name}: provision without publicKey")
                else:
                    self.assertIn('\\"publicKey\\"', after, f"{path.name}: provision without publicKey")
        self.assertEqual(calls, 1)  # the operator's own; phase 6's buyer key went with its submission (115e)

    def test_no_key_is_expanded_onto_a_command_line(self):
        # A key in argv is readable by every user of the machine (ps, /proc/<pid>/cmdline).
        for path, text in text_files():
            for line in text.splitlines():
                self.assertNotRegex(line, r"Bearer \$|KEY=\"?\$\(", f"{path.name}: {line}")
                public = re.search(r"/api/(auth/provision|health|onboard/identify-device)\b", line)
                if re.search(r"\bcurl\b.*\$BASE/api/", line) and not public:
                    self.assertIn("-H @.pcc/", line, f"{path.name}: authenticated calls send the key from a header file")

    def test_the_private_state_is_git_ignored(self):
        self.assertIn(".pcc/", (STARTER / ".gitignore").read_text(encoding="utf-8").splitlines())


def phase_text(name):
    return (RUNBOOK / name).read_text(encoding="utf-8")


def between(text, start, end):
    i = text.index(start)
    return text[i:text.index(end, i + len(start))]


class TestRound2(unittest.TestCase):
    """Verdict 115b on #464: each of these failed at 932c0aef."""

    def setUp(self):
        self.book = json.loads((RUNBOOK / "runbook.json").read_text(encoding="utf-8"))

    def test_nothing_claims_a_verified_kernel_or_run(self):
        # F3: by-hand evidence is unverified; nothing may call the result verified.
        for path, text in text_files():
            for line in text.splitlines():
                if re.search(r"(?i)(?<!un)\bverified\b", line):
                    self.assertRegex(line, r"(?i)\bnot\b|\bnever\b|\buntil\b|\bisn't\b|\bno\b", f"{path.name}: {line}")

    def test_completed_is_sent_only_after_stored_evidence(self):
        # F2: the relay answers 200 with stored:false; that must never lead to "completed".
        finish = between(phase_text("06-verify.md"), "/api/operator/evidence", "/api/operator/job-status")
        self.assertIn('"stored"', finish)
        self.assertIn("jobId", finish)

    def test_prices_and_rates_come_from_the_humans_answers(self):
        # F4: no literal price in the capability, no literal license rate, no "default" rate.
        capability = between(phase_text("05-register.md"), "/api/capabilities\"", "**Check:**")
        self.assertNotRegex(capability, r'baseCost\\?"?:\s*\d')
        publish = phase_text("08-publish.md")
        self.assertNotRegex(publish, r'licenseBps\\?"?:\s*\d')
        self.assertNotRegex(publish, r"(?i)default(s)? (is|of|to)? ?50|50 by default")

    def test_register_device_creates_no_second_capability(self):
        # F4: register-device with `capabilities` auto-creates a zero-priced capability.
        device = between(phase_text("05-register.md"), "/api/setup/register-device", "**Check:**")
        self.assertNotIn("capabilities", device)

    def test_the_envelope_digest_is_rechecked_before_any_run(self):
        # F6: an edited envelope must not run on an old confirmation.
        for name in ("06-verify.md", "07-operate.md"):
            self.assertIn("envelope.confirmed.json", phase_text(name), name)

    def test_the_graph_matches_the_phases(self):
        # F8 and F5: no pcc-node start in register; the drill asks permission and claims only what it tests.
        phases = {p["id"]: p for p in self.book["phases"]}
        self.assertNotIn("pcc-node start", json.dumps(phases["register"]))
        self.assertTrue(any("emergency" in ask for ask in phases["verify"]["asksHuman"]))
        self.assertNotIn("made the node refuse", json.dumps(phases["verify"]))

    def test_there_is_no_production_default(self):
        # F9: a machine reading the graph must never fall back to production.
        self.assertIsNone(self.book["target"]["default"])

    def test_private_state_permissions_are_repaired(self):
        # F11: mkdir -p does not fix an existing permissive .pcc.
        self.assertIn("chmod 700 .pcc", phase_text("00-prerequisites.md"))

    def test_the_kernel_sends_a_physical_address_field(self):
        # The gateway reads only lat and lng from a location object; a text address is physicalAddress.
        kernel = between(phase_text("05-register.md"), "/api/kernels\"", "**Check:**")
        self.assertIn("physicalAddress", kernel)
        self.assertNotRegex(kernel, r'"location":\s*\{[^}]*"address"')

    def test_the_kernel_is_checked_before_its_signing_key_is_registered(self):
        # F7: a mistyped kernel id would sign, and create, another kernel.
        signing = between(phase_text("05-register.md"), "## 2.", "## 3.")
        self.assertRegex(signing, r"GET[^\n]*/api/kernels/")
        self.assertLess(signing.index("/api/kernels/"), signing.index("register_signing_key("))

    def test_the_gateway_must_check_operator_ownership(self):
        # F1: master's operator routes do not check who owns the kernel or job.
        self.assertRegex(phase_text("00-prerequisites.md"), r"(?i)ownership")

    def test_no_pcc_node_daemon_beside_the_loop(self):
        # 0.1.1's daemon takes no jobs and its heartbeat says so, which would hide the listing.
        self.assertRegex(phase_text("07-operate.md"), r"acceptingJobs")



class TestRound3(unittest.TestCase):
    """Verdict 115c on #464: each of these failed at cfc5605b."""

    def setUp(self):
        self.book = json.loads((RUNBOOK / "runbook.json").read_text(encoding="utf-8"))
        self.index = json.loads((RUNBOOK / "index.json").read_text(encoding="utf-8"))

    def test_the_test_job_moves_no_money_by_construction(self):
        # F1: paymentMethod "testnet-mock" never selected mock settlement, and the
        # price was checked only after the job and escrow existed.
        verify = phase_text("06-verify.md")
        for line in verify.splitlines():
            if "submit-from-discovery" in line:  # named only to warn against it, never called
                self.assertNotIn("curl", line)
                self.assertRegex(line, r"(?i)don't|never", line)
        self.assertNotIn("testnet-mock", verify)
        self.assertNotRegex(verify, r"curl[^\n]*/api/jobs/submit")  # no test job is submitted (115e)
        phases = {p["id"]: p for p in self.book["phases"]}
        self.assertNotRegex(json.dumps(phases["verify"]), r"(?i)quote equals|at the human's price")
        self.assertNotIn("verify.price-mismatch", self.index["events"])

    def test_no_wallet_is_promised_payouts_or_sent(self):
        # F2: provisioning makes a wallet the operator id, never the payout destination.
        prerequisites = phase_text("00-prerequisites.md")
        self.assertNotIn("walletAddress", between(prerequisites, "/api/auth/provision", "**Check:**"))
        for path, text in text_files():
            self.assertNotRegex(text, r"(?i)where settlement pays|payouts go only to the wallet", path.name)
        phases = {p["id"]: p for p in self.book["phases"]}
        self.assertNotRegex(json.dumps(phases["prerequisites"]["asksHuman"]), r"(?i)wallet")

    def test_completed_is_computed_never_typed(self):
        # F3: the only path to "completed" is code that checks the run, the receipt's
        # stored flag, its jobId and a bundleId; no command sends a literal completed.
        verify = phase_text("06-verify.md")
        self.assertNotRegex(verify, r'\\?"status\\?":\s*\\?"completed')
        finish = between(verify, "/api/operator/evidence", "/api/operator/job-status")
        for needed in ('"stored"', "bundleId", "jobId", "succeeded"):
            self.assertIn(needed, finish, needed)

    def test_a_default_policy_reads_as_stopped(self):
        # F4: a failed policy read answers 200 with the default policy (emergencyStop
        # false, source "default"); only a stored policy may read as clear.
        for name in ("06-verify.md", "07-operate.md"):
            text = phase_text(name)
            self.assertIn('"default"', text, name)
            self.assertIn("updatedAt", text, name)
        self.assertRegex(json.dumps(self.index["events"]["operate.estop-active"]), r"(?i)default")

    def test_no_personal_value_is_expanded_onto_a_command_line(self):
        # F5: the provisioning body is built in a private file, never on curl's command line.
        provision = between(phase_text("00-prerequisites.md"), "/api/auth/provision", "**Check:**")
        self.assertNotRegex(provision, r'-d "\{')
        self.assertIn("--data-binary @.pcc/", provision)



class TestRound4(unittest.TestCase):
    """Verdict 115d on #464: each of these failed at 7b155b24."""

    CHECK = 'print("CLEAR" if stored'

    def test_the_stop_is_read_before_anything_runs(self):
        # C1: phase 6 ran the device before its first policy read.
        verify = phase_text("06-verify.md")
        first_check = verify.index(self.CHECK)
        self.assertLess(first_check, verify.index("POST $DEV/runs"))
        run_step = between(verify, "5. **Read the stop, then run.**", "6. **")
        self.assertLess(run_step.index("CLEAR"), run_step.index("POST $DEV/runs"))
        self.assertRegex(between(phase_text("07-operate.md"), "5. **", "6. **"), r"immediately before the run")

    def test_the_gateway_cannot_run_the_test_job_itself(self):
        # C2 (115d, 115e): no runbook check can prove /api/jobs/submit will not start a job, so none is submitted.
        verify = phase_text("06-verify.md")
        for route in ("/api/jobs/submit", "submit-from-discovery", "/commit", "/api/job-offers"):
            self.assertNotRegex(verify, rf"curl[^\n]*{route}", route)
        self.assertNotRegex(verify, r"(?i)creates a queued job for your kernel and nothing else")

    def test_the_drill_claims_only_what_it_shows(self):
        # The current gateway queues a job for a stopped kernel; nothing may say it refuses one.
        for path, text in text_files():
            self.assertNotRegex(text, r"(?i)gateway (should )?refuse[sd]? (it|a new job|new jobs)", path.name)


class TestRound5(unittest.TestCase):
    """Verdict 115e on #464: each of these failed at 487ab597."""

    def setUp(self):
        self.index = json.loads((RUNBOOK / "index.json").read_text(encoding="utf-8"))

    def test_no_test_job_is_submitted_and_the_phase_says_so(self):
        # C2: /api/setup/detect omits DB-loaded runners, so no pre-submit check is sound.
        # No command anywhere creates a job, continued lines included.
        for path, text in text_files():
            joined = text.replace("\\\n", " ")
            for route in ("/api/jobs/submit", "submit-from-discovery", "/api/setup/test-job", "/api/job-offers", "/commit"):
                self.assertNotRegex(joined, rf"curl[^\n]*{route}", f"{path.name}: {route}")
        verify = phase_text("06-verify.md")
        self.assertNotIn("/api/setup/detect\" -H", verify)
        self.assertRegex(between(verify, "## 2.", "## 3."), r"bin/pcc-report verify blocked")
        self.assertIn("verify.test-job-blocked", self.index["events"])

    def test_the_drill_event_does_not_fail_on_documented_gateway_behaviour(self):
        # MEDIUM: the gateway queues a job for a stopped kernel; that is not a drill failure.
        trigger = self.index["events"]["verify.estop-drill-failed"]["trigger"]
        self.assertNotRegex(trigger, r"(?i)accepted a new job")

    def test_no_summary_says_a_test_job_ran(self):
        # C2 follow-through: the runbook no longer ends with a test job, so no summary may say it does.
        for path, text in text_files():
            self.assertNotRegex(text, r"(?i)exercised by one test job|one test job on the device|takes test jobs only", path.name)

    def test_phase_7_points_at_the_envelope_check_where_it_is(self):
        # LOW: phase 6's sections were renumbered in round 4.
        self.assertNotIn("phase 6 step 2.", phase_text("07-operate.md"))


if __name__ == "__main__":
    unittest.main()
