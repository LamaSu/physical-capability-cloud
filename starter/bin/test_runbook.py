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
            if "buyer" in path.relative_to(STARTER).parts:
                continue  # Its private staging recipe is checked below, without a literal redirection.
            for m in re.finditer(r"/api/auth/provision", text):
                window = text[m.end(): m.end() + 400]
                self.assertIn('--output "$capture_dir/provision.json"', window, f"{path.name}: provision output must use private staging")

    def test_every_provisioning_call_sends_its_own_public_key(self):
        # Rehearsal R0's P9: without publicKey, the response carries a server-made private key.
        # A body is either inline JSON, or a private file built just before the call (115c F5).
        calls = 0
        for path, text in text_files():
            if "buyer" in path.relative_to(STARTER).parts:
                buyer = json.loads(text)
                action = buyer["steps"][0]["actions"][0]
                recipe = "\n".join(action["recipe"])
                self.assertEqual(len(re.findall(r"\bcurl [^\n]*/api/auth/provision", recipe)), 1)
                self.assertIn('request["publicKey"] = public.hex()', recipe, "buyer path: provision without publicKey")
                self.assertIn('--data-binary @"$capture_dir/provision-request.json"', recipe)
                calls += 1
                continue
            for m in re.finditer(r"curl [^\n]*/api/auth/provision", text):
                calls += 1
                after = text[m.end(): m.end() + 300]
                body_file = re.search(r"--data-binary @(\S+)", after)
                if body_file:
                    before = text[max(0, m.start() - 600): m.start()]
                    self.assertEqual(body_file.group(1), '"$capture_dir/provision-request.json"', f"{path.name}: body must use private staging")
                    self.assertIn('"publicKey"', before, f"{path.name}: provision without publicKey")
                    self.assertIn('with open(Path(sys.argv[1]) / "provision-request.json", "x")', before, f"{path.name}: request must not overwrite")
                else:
                    self.assertIn('\\"publicKey\\"', after, f"{path.name}: provision without publicKey")
        self.assertEqual(calls, 2)  # the operator's own and the buyer's own; both require publicKey

    def test_the_buyer_path_provisions_once_into_a_private_file(self):
        # #603 (Opus r1 F1/F2): the buyer path provisions over direct HTTP with one recipe. It makes
        # .pcc private before generating its own signing key and capturing the response.
        # agent-md-provision-secrets.test.ts runs the recipe as
        # written and checks that nothing secret is printed.
        buyer = json.loads((STARTER / "buyer" / "buyer-path.json").read_text(encoding="utf-8"))
        provision = buyer["steps"][0]["actions"][0]
        self.assertEqual((provision["tool"], provision["route"]), (None, "/api/auth/provision"))
        calls = [line for line in provision["recipe"] if re.search(r"curl [^\n]*/api/auth/provision", line)]
        self.assertEqual(len(calls), 1)
        self.assertIn('--output "$capture_dir/provision.json"', calls[0])
        recipe = provision["recipe"]
        self.assertEqual(recipe[0], "set -euo pipefail")
        self.assertLess(next(i for i, line in enumerate(recipe) if "chmod 700 .pcc" in line), recipe.index(calls[0]))
        self.assertIn('capture_dir=$(mktemp -d .pcc/capture.XXXXXXXX) || fail \'Private capture setup failed.\'', recipe)
        self.assertIn('    os.link(stage / name, Path(".pcc") / name)', recipe)
        everywhere = [m for _, text in text_files() for m in re.finditer(r"curl [^\n]*/api/auth/provision", text)]
        self.assertEqual(len(everywhere), 2)  # the operator's own (runbook phase 0) and the buyer's own

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
        self.assertIn('--data-binary @"$capture_dir/provision-request.json"', provision)



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
            self.assertNotRegex(text, r"(?i)exercised by one test job|one test job on the device|takes test jobs only|one test run|session ok", path.name)

    def test_phase_7_points_at_the_envelope_check_where_it_is(self):
        # LOW: phase 6's sections were renumbered in round 4.
        self.assertNotIn("phase 6 step 2.", phase_text("07-operate.md"))


class TestSupplyCapture(unittest.TestCase):
    """Execute phase 0's capture with a curl stub; no sockets or optional Python modules."""

    def setUp(self):
        import os
        import shutil
        import subprocess
        import tempfile
        self.os, self.subprocess = os, subprocess
        self.temp = tempfile.TemporaryDirectory(prefix="pcc-supply-capture-")
        self.addCleanup(self.temp.cleanup)
        self.cwd = pathlib.Path(self.temp.name)
        self.private = self.cwd / ".pcc"
        self.private.mkdir(mode=0o700)
        self.bin = self.cwd / "mock-bin"
        self.bin.mkdir()
        self.git = shutil.which("git")
        if self.git is None:
            self.skipTest("Git is unavailable; supply capture repository checks need it")
        subprocess.run([self.git, "init", "-q", str(self.cwd)], check=True)
        (self.private / "base").write_text("http://127.0.0.1:4310\n")
        (self.private / "operator.json").write_text(json.dumps({"email": "operator@example.org", "name": "Bench plate reader"}))
        (self.private / "node-public-key").write_text("ab" * 32)
        # Construct fake credentials at runtime; their literals never enter the source diff.
        self.key = "pcc_" + "live_" + os.urandom(32).hex()
        self.wallet_key = "0x" + os.urandom(32).hex()
        self.response = {
            "api_key": self.key, "key_id": "supply-key", "trace_id": "tr_" + "ab" * 16,
            "ed25519": {"source": "byok", "public_key": "ab" * 32},
            "operator_wallet": {"source": "server-minted", "private_key": self.wallet_key},
            "usage": {"header": "Authorization: Bearer " + self.key},
        }
        curl_stub = self.bin / "curl"
        curl_stub.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
response = Path(os.environ["MOCK_RESPONSE"]).read_text()
Path(".pcc/curl-called").write_text("yes")
Path(".pcc/curl-options.json").write_text(json.dumps(args))
if "--data-binary" in args:
    request = Path(args[args.index("--data-binary") + 1].lstrip("@")).read_text()
    Path(".pcc/request-seen.json").write_text(request)
if os.environ.get("MOCK_DROP_IGNORE"):
    Path(".git/info/exclude").write_text("")
if os.environ.get("MOCK_RACE_HEADER"):
    Path(".pcc/auth.header").write_text("keep existing header\\n")
if "--dump-header" in args:
    Path(args[args.index("--dump-header") + 1]).write_text("HTTP/1.1 " + os.environ["MOCK_STATUS"] + "\\r\\nx-pcc-trace-id: " + os.environ.get("MOCK_TRACE_HEADER", "tr_" + "cd" * 16) + "\\r\\n\\r\\n")
if "--output" in args:
    Path(args[args.index("--output") + 1]).write_text(response)
else:
    sys.stdout.write(response)
if "--write-out" in args:
    sys.stdout.write(os.environ["MOCK_STATUS"])
sys.exit(int(os.environ.get("MOCK_CURL_EXIT", "0")))
''')
        curl_stub.chmod(0o700)
        # Observe actual hardlink publication rather than asserting an implementation string.
        (self.bin / "sitecustomize.py").write_text('''import os
original = os.link
def record_link(source, destination, *args, **kwargs):
    result = original(source, destination, *args, **kwargs)
    with open(".pcc/publish-links.jsonl", "a") as f:
        import json
        f.write(json.dumps([str(source), str(destination)]) + "\\n")
    return result
os.link = record_link
''')
        step = phase_text("00-prerequisites.md").split("## 4. ", 1)[1].split("## 5. ", 1)[0]
        blocks = re.findall(r"```bash\n(.*?)\n```", step, re.S)
        self.recipe = blocks[0]
        self.archive_recipe = blocks[1] if len(blocks) > 2 else None

    def run_capture(self, status="201", response=None, **extras):
        response_path = self.private / "test-response.json"
        response_path.write_text(json.dumps(self.response if response is None else response))
        env = dict(self.os.environ, PATH=str(self.bin) + self.os.pathsep + self.os.environ["PATH"],
                   PYTHONPATH=str(self.bin), MOCK_RESPONSE=str(response_path), MOCK_STATUS=status, **extras)
        result = self.subprocess.run(["bash", "-c", self.recipe], cwd=self.cwd, env=env,
                                     capture_output=True, text=True, timeout=20)
        for secret in (self.key, self.wallet_key):
            self.assertNotIn(secret, result.stdout + result.stderr)
        return result

    def run_archive(self):
        self.assertIsNotNone(self.archive_recipe, "Phase 0 must contain an executable private archive command")
        result = self.subprocess.run(["bash", "-c", self.archive_recipe], cwd=self.cwd,
                                     capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        for secret in (self.key, self.wallet_key): self.assertNotIn(secret, result.stdout + result.stderr)
        return result

    def assert_not_published(self):
        for name in ("provision.json", "api-key", "auth.header"):
            self.assertFalse((self.private / name).exists(), name)

    def test_success_checks_status_and_publishes_ignored_0600_files_atomically(self):
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("provision_status: provisioned", result.stdout)
        self.assertEqual((self.private / "api-key").read_text(), self.key)
        self.assertEqual((self.private / "auth.header").read_text(), "Authorization: Bearer " + self.key + "\n")
        for name in ("provision.json", "api-key", "auth.header"):
            path = self.private / name
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, name)
            ignored = self.subprocess.run([self.git, "check-ignore", "-q", "--", str(path)], cwd=self.cwd)
            self.assertEqual(ignored.returncode, 0, name)
        self.assertEqual(len((self.private / "publish-links.jsonl").read_text().splitlines()), 3)
        request = json.loads((self.private / "request-seen.json").read_text())
        self.assertEqual(request["publicKey"], "ab" * 32)
        self.assertFalse(list(self.private.glob("capture.*")))
        options = json.loads((self.private / "curl-options.json").read_text())
        self.assertGreaterEqual(int(options[options.index("--max-time") + 1]), 600)

    def test_non_201_never_imports_a_key_and_allows_a_corrected_rerun(self):
        for code in ("rate_limited", "invalid_type", "invalid_wallet_address", "invalid_email", "identifier_required", "provision_failed", "too_many_keys", "invalid_public_key"):
            with self.subTest(code=code):
                body = dict(self.response, error=code, message=self.key, retry_after_seconds=3600)
                body.pop("trace_id")
                result = self.run_capture("429", body)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("http_status: 429\n", result.stdout)
                self.assertIn("error: " + code + "\n", result.stdout)
                self.assertIn("retry_after_seconds: 3600\n", result.stdout)
                self.assertIn('trace_id: "' + 'tr_' + 'cd' * 16 + '"', result.stdout)
                self.assert_not_published()
                self.assertFalse(list(self.private.glob("capture.*")))
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejection_never_prints_free_text_error_or_noninteger_retry(self):
        result = self.run_capture("400", {"error": self.wallet_key, "message": self.key, "retry_after_seconds": self.key})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error: unrecognised\n", result.stdout)
        self.assertNotIn("retry_after_seconds:", result.stdout)
        self.assert_not_published()

    def test_malformed_or_server_minted_success_fails_closed(self):
        for ed25519 in ({"source": "server-minted", "private_key": self.wallet_key}, {"source": "byok", "private_key_pkcs8_base64": self.wallet_key}, None):
            with self.subTest(ed25519=ed25519):
                result = self.run_capture(response=dict(self.response, ed25519=ed25519))
                self.assertNotEqual(result.returncode, 0)
                self.assert_not_published()
                self.assertEqual(len(list(self.private.glob("capture.*"))), 1)
                self.run_archive()
                for leaf in (self.private / "archive").rglob("*"):
                    self.assertEqual(leaf.stat().st_mode & 0o777, 0o700 if leaf.is_dir() else 0o600)
                    self.assertEqual(self.subprocess.run([self.git, "check-ignore", "-q", "--", str(leaf)], cwd=self.cwd).returncode, 0)
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_existing_header_is_never_overwritten_or_requested_again(self):
        header = self.private / "auth.header"
        header.write_text("keep existing header\n")
        result = self.run_capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(header.read_text(), "keep existing header\n")
        self.assertFalse((self.private / "curl-called").exists())

    def test_header_created_during_request_is_never_overwritten(self):
        result = self.run_capture(MOCK_RACE_HEADER="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.private / "auth.header").read_text(), "keep existing header\n")
        self.assertFalse((self.private / "api-key").exists())
        self.assertFalse((self.private / "provision.json").exists())

    def test_lost_exclusion_after_response_refuses_publication(self):
        result = self.run_capture(MOCK_DROP_IGNORE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assert_not_published()

    def test_invalid_input_fails_before_staging_or_curl(self):
        (self.private / "operator.json").write_text("{}")
        result = self.run_capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(list(self.private.glob("capture.*")))
        self.assertFalse((self.private / "curl-called").exists())

    def test_capture_setup_failure_removes_unissued_staging_and_can_retry(self):
        stub = self.bin / "git"
        stub.write_text('#!/usr/bin/env python3\nimport os, sys\nif sys.argv[1] == "check-ignore" and sys.argv[-1].startswith(".pcc/capture."): sys.exit(1)\nos.execv(' + repr(self.git) + ', [' + repr(self.git) + '] + sys.argv[1:])\n')
        stub.chmod(0o700)
        result = self.run_capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.private / "curl-called").exists())
        self.assertFalse(list(self.private.glob("capture.*")))
        stub.unlink()
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_timeout_preserves_private_capture_and_explains_possible_issuance(self):
        result = self.run_capture(MOCK_CURL_EXIT="28")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("a key may have been issued", result.stderr)
        self.assertIn("validate", result.stderr)
        self.assert_not_published()
        captures = list(self.private.glob("capture.*"))
        self.assertEqual(len(captures), 1)
        self.assertEqual(captures[0].stat().st_mode & 0o777, 0o700)

    def test_outside_git_continues_with_a_fixed_note(self):
        import shutil
        shutil.rmtree(self.cwd / ".git")
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Outside a Git repository; private state uses filesystem permissions.", result.stdout)


    def test_secret_trace_values_in_body_and_headers_are_never_printed(self):
        result = self.run_capture("400", {"error": "invalid_email", "trace_id": self.key}, MOCK_TRACE_HEADER=self.wallet_key)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("trace_id: null\n", result.stdout)
        self.assert_not_published()

    def test_failed_git_detection_refuses_when_repository_markers_exist(self):
        # A failing Git command cannot quietly select the no-repository branch.
        broken_git = self.bin / "git"
        broken_git.write_text("#!/bin/sh\nexit 1\n")
        broken_git.chmod(0o700)
        result = self.run_capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Git repository detection failed; request refused.", result.stderr)
        self.assertFalse((self.private / "curl-called").exists())
        self.assertFalse(list(self.private.glob("capture.*")))

    def test_empty_git_directory_is_not_treated_as_a_repository(self):
        import shutil
        shutil.rmtree(self.cwd / ".git")
        (self.cwd / ".git").mkdir()
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Outside a Git repository; private state uses filesystem permissions.", result.stdout)

    def test_missing_python_has_its_own_fixed_message_before_staging(self):
        # An executable stub models a PATH entry that cannot run Python; command -v is insufficient.
        missing_python = self.bin / "python3"
        missing_python.write_text("#!/bin/sh\nexit 127\n")
        missing_python.chmod(0o700)
        result = self.run_capture()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Python3 is required; request refused.", result.stderr)
        self.assertFalse((self.private / "curl-called").exists())
        self.assertFalse(list(self.private.glob("capture.*")))

    def test_exact_archive_command_keeps_every_leaf_private_ignored_and_allows_rerun(self):
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        node_key = self.private / "node-keys.json"
        node_key.write_text(json.dumps({"private": self.wallet_key}))
        node_key.chmod(0o600)
        inputs = {name: (self.private / name).read_bytes() for name in ("node-keys.json", "node-public-key", "base", "operator.json")}
        capture = self.private / "capture.leftover"
        nested = capture / "nested"
        nested.mkdir(parents=True)
        capture.chmod(0o755)
        nested.chmod(0o755)
        (nested / "diagnostic.json").write_text(json.dumps({"secret": self.key}))
        (nested / "diagnostic.json").chmod(0o644)
        self.run_archive()
        destinations = list((self.private / "archive").iterdir())
        self.assertEqual(len(destinations), 1)
        self.assertRegex(destinations[0].name, r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}$")
        self.assertEqual({p.name for p in destinations[0].iterdir()}, {"provision.json", "api-key", "auth.header", "capture.leftover"})
        for leaf in (self.private / "archive").rglob("*"):
            self.assertFalse(leaf.is_symlink())
            self.assertEqual(leaf.stat().st_uid, self.os.getuid())
            self.assertEqual(leaf.stat().st_mode & 0o777, 0o700 if leaf.is_dir() else 0o600)
            self.assertEqual(self.subprocess.run([self.git, "check-ignore", "-q", "--", str(leaf)], cwd=self.cwd).returncode, 0)
        for name, content in inputs.items(): self.assertEqual((self.private / name).read_bytes(), content)
        self.assert_not_published()
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_exact_archive_without_git_outside_a_repository(self):
        import shutil
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        shutil.rmtree(self.cwd / ".git")
        python_only = self.cwd / "python-only"
        python_only.mkdir()
        (python_only / "python3").symlink_to(shutil.which("python3"))
        env = dict(self.os.environ, PATH=str(python_only))
        result = self.subprocess.run([shutil.which("bash"), "-c", self.archive_recipe],
                                     cwd=self.cwd, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        for secret in (self.key, self.wallet_key): self.assertNotIn(secret, result.stdout + result.stderr)
        self.assert_not_published()
        for leaf in (self.private / "archive").rglob("*"):
            self.assertFalse(leaf.is_symlink())
            self.assertEqual(leaf.stat().st_uid, self.os.getuid())
            self.assertEqual(leaf.stat().st_mode & 0o777, 0o700 if leaf.is_dir() else 0o600)


if __name__ == "__main__":
    unittest.main()
