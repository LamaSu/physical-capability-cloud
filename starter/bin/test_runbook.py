"""The runbook stays consistent with itself, with painpoints' reporting contract,
and with the truths the agent pack enforces. Standard library only:
python3 -m unittest discover -s starter/bin -p 'test_*.py'
"""

import ast
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

STARTER = pathlib.Path(__file__).resolve().parents[1]
RUNBOOK = STARTER / "runbook"
PHASES = ["prerequisites", "identify", "intake", "research", "build", "register", "verify", "operate", "publish", "session"]
PIN = "700dcfe9581bb75dad9206b8db49ae6f68ebe6e6"
PINNED = f"pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@{PIN}#subdirectory=packages/pcc-node"
INSTALL = re.compile(r"\b(?:pip3?|pipx|uv\s+pip|uv\s+tool)\b[^\n`;&|]*?\binstall\b[^\n`;&|]*pcc-node[^\n`;&|]*", re.I)
SPEC = re.compile(r"pcc-node(?:\[[^\]]*\])?\s*[<>=!~]")


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

    def assert_key_leak_guidance_covers_selected_path(self, guidance):
        # F3 follow-up: rotation must delete the same key that step 3 selected.
        signing = between(phase_text("00-prerequisites.md"), "## 3.", "## 4.")
        examples = re.findall(r"(?ms)^python3 - <<'EOF'[^\n]*\n(.*?)^EOF$", signing)
        self.assertEqual(len(examples), 1, "step 3 must have one node key example")
        selections = [
            node.value for node in ast.parse(examples[0]).body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "key_path" for target in node.targets)
        ]
        self.assertEqual(len(selections), 1, "step 3 must select one key path")
        calls = [node for node in ast.walk(selections[0]) if isinstance(node, ast.Call)]
        environment_names = [
            call.args[0].value for call in calls if ast.unparse(call.func) == "os.environ.get"
        ]
        default_paths = [
            call.args[0].value for call in calls if ast.unparse(call.func) == "os.path.expanduser"
        ]
        self.assertTrue(environment_names, "step 3 must select key path overrides")
        self.assertEqual(len(default_paths), 1, "step 3 must select one default key path")
        for reference in environment_names + default_paths:
            self.assertIn(reference, guidance, f"prerequisites.key-leaked must mention {reference}")

    def test_key_leak_guidance_covers_step_3_key_path_selection(self):
        self.assert_key_leak_guidance_covers_selected_path(self.events["prerequisites.key-leaked"]["do"])

    def test_key_leak_guidance_rejects_a_missing_key_path_override(self):
        guidance = self.events["prerequisites.key-leaked"]["do"].replace("PCC_NODE_KEY_PATH", "")
        with self.assertRaisesRegex(AssertionError, "prerequisites.key-leaked must mention PCC_NODE_KEY_PATH"):
            self.assert_key_leak_guidance_covers_selected_path(guidance)


class TestTruths(unittest.TestCase):
    def test_no_call_goes_to_production(self):
        for path, text in text_files():
            for line in text.splitlines():
                if re.search(r"\bcurl\b", line):
                    self.assertNotIn("https://capability.network", line, f"{path.name}: {line}")

    def test_pcc_node_is_installed_with_crypto_from_the_pinned_commit(self):
        installs = 0
        for path, text in text_files():
            for m in INSTALL.finditer(text):
                installs += 1
                line = m.group(0)
                self.assertRegex(line, r"pcc-node\[crypto\]", f"{path.name}: {line}")
                self.assertIn(PINNED, line, f"{path.name}: {line}")
                self.assertNotRegex(line, SPEC, f"{path.name}: {line}")
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
        # Without publicKey, the API key has no signing key on file.
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

    def assert_no_server_private_key_claims(self, text, name):
        # E17e NC2: provisioning binds our public key; it never supplies a private one.
        verbs = r"(?:generat\w*|creat\w*|return\w*|contain\w*|send\w*|provid\w*|receiv\w*|mak\w*|made|issu\w*|includ\w*|hand\w*)"
        private_key = r"\bprivate(?:[\s_]+signing)?[\s_]+key\b"
        negated = re.compile(
            rf"(?i)\b(?:never|does not|doesn't|will not|won't)\s+(?:{verbs}\s+(?:or|and)\s+)*"
            rf"{verbs}\s+(?:back\s+)?(?:(?:a|the|your|its|any)\s+)?{private_key}"
        )
        claim = re.compile(
            rf"(?i)\b(?:server|gateway|api)[- ](?:made|generated|created|issued)\s+{private_key}|"
            rf"\b(?:server|gateway|api|response)\b[^!?\n]*\b{verbs}\b[^!?\n]*{private_key}|"
            rf"\b(?:return\w*|receiv\w*|hand\w*)\b[^!?\n]*{private_key}|"
            rf"{private_key}[^!?\n]*\b(?:returned|received)\b"
        )
        for sentence in re.split(r"(?<=[.!?])\s+|\n", text):
            self.assertNotRegex(negated.sub("", sentence), claim, f"{name}: {sentence}")

    def test_no_text_claims_a_server_made_or_returned_private_key(self):
        for path, text in text_files():
            self.assert_no_server_private_key_claims(text, path.name)

    def test_private_key_claim_check_rejects_near_miss_wording(self):
        # E17g N5: these three paraphrases escaped the original NC2 regression pin.
        for text in (
            "Provisioning gets a gateway-made private key back in the response.",
            "Provisioning without it hands back a fresh private signing key.",
            "The response then includes `ed25519.private_key`.",
            "The gateway makes a private key.",
            "The API issues a private signing key.",
        ):
            with self.subTest(text=text):
                with self.assertRaises(AssertionError):
                    self.assert_no_server_private_key_claims(text, "negative control")
        self.assert_no_server_private_key_claims(
            "The gateway never generates or returns a private signing key.", "allowed guidance"
        )

    def test_secrets_are_not_claimed_to_live_only_in_onboarding_state(self):
        # The node signing key lives outside the onboarding folder, including its .pcc/.
        for path, text in text_files():
            self.assertNotRegex(
                text, r"(?i)\b(?:secrets|keys)\b[*_`]*\s+live\s+only\s+in\s+[*_`]*\.pcc/", path.name
            )

    def test_every_node_key_call_uses_the_selected_external_path(self):
        # R2, NC3 and NC5: older releases default to a key inside the onboarding folder.
        expected = ast.parse(
            'os.environ.get("PCC_NODE_KEY_PATH") or os.environ.get("PCC_NODE_KEYS_FILE") or os.path.expanduser("~/.pcc-node/keys.json")',
            mode="eval",
        ).body
        sources = list(text_files())
        sources.extend(
            (path, path.read_text(encoding="utf-8"))
            for path in sorted(STARTER.rglob("*"))
            if path.is_file() and (path.suffix == ".py" or path.name == "pcc-report")
            and ".pcc" not in path.parts
        )
        phase_locations = {}
        for path, text in sources:
            if path.suffix in (".md", ".json"):
                # Check the count too, so an added call outside an example cannot escape the test.
                documented_calls = len(re.findall(r"\bload_or_create_keys\s*\(", text))
                examples = []
                for language, code in re.findall(r"(?ms)^```([^\n]*)\n(.*?)^```", text):
                    if language.strip() == "python":
                        examples.append(code)
                    else:
                        examples.extend(re.findall(r"(?ms)^python3 - <<'EOF'[^\n]*\n(.*?)^EOF$", code))
            else:
                documented_calls = None
                examples = [text]
            found = 0
            for code in examples:
                tree = ast.parse(code)
                for call in ast.walk(tree):
                    if not (isinstance(call, ast.Call) and (
                        isinstance(call.func, ast.Name) and call.func.id == "load_or_create_keys"
                        or isinstance(call.func, ast.Attribute) and call.func.attr == "load_or_create_keys"
                    )):
                        continue
                    found += 1
                    self.assertEqual(len(call.args), 1, f"{path.name}: pass the selected key path explicitly")
                    self.assertFalse(call.keywords, f"{path.name}: use the same explicit path argument")
                    location = call.args[0]
                    if isinstance(location, ast.Name):
                        bindings = [
                            node.value for node in tree.body
                            if isinstance(node, ast.Assign) and node.lineno < call.lineno
                            and any(isinstance(target, ast.Name) and target.id == location.id for target in node.targets)
                        ]
                        self.assertTrue(bindings, f"{path.name}: key path must be built here")
                        location = bindings[-1]
                    self.assertEqual(ast.dump(location), ast.dump(expected), f"{path.name}: key path must select PCC_NODE_KEY_PATH, PCC_NODE_KEYS_FILE or ~/.pcc-node/keys.json")
                    phase_locations.setdefault(path.name, []).append(ast.dump(location))
            if documented_calls is not None:
                self.assertEqual(found, documented_calls, f"{path.name}: every key call must be in a checked Python example")
        # L3: phase 5 must reopen exactly the location chosen in phase 0.
        self.assertEqual(phase_locations["00-prerequisites.md"], [ast.dump(expected)])
        self.assertEqual(phase_locations["05-register.md"], phase_locations["00-prerequisites.md"])

    def assert_node_key_location_guard(self, text, name):
        # r2 has no location checks: both snippets must refuse before creating directories.
        examples = [
            code for code in re.findall(r"(?ms)^python3 - <<'EOF'[^\n]*\n(.*?)^EOF$", text)
            if re.search(r"\bload_or_create_keys\s*\(", code)
        ]
        self.assertEqual(len(examples), 1, f"{name}: expected one node key example")
        code = examples[0]
        tree = ast.parse(code)
        selected = [
            i for i, node in enumerate(tree.body)
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "key_path" for target in node.targets)
        ]
        self.assertEqual(len(selected), 1, f"{name}: expected one key path selection")
        guard = tree.body[selected[0] + 1]
        expected = ast.parse(
            'if not os.path.isabs(key_path) or os.path.realpath(key_path).startswith(os.path.realpath(".") + os.sep):\n'
            '    raise SystemExit("The node key location must be an absolute path outside this folder and every source checkout")'
        ).body[0]
        self.assertEqual(
            ast.dump(guard), ast.dump(expected),
            f"{name}: key path guard must refuse non-absolute and in-folder paths immediately after selection",
        )
        return ast.get_source_segment(code, guard)

    def test_both_node_key_snippets_guard_the_selected_location(self):
        for name in ("00-prerequisites.md", "05-register.md"):
            with self.subTest(name=name):
                self.assert_node_key_location_guard(phase_text(name), name)

    def test_removing_either_node_key_guard_is_rejected(self):
        for name in ("00-prerequisites.md", "05-register.md"):
            with self.subTest(name=name):
                text = phase_text(name)
                guard = self.assert_node_key_location_guard(text, name)
                without_guard = text.replace(guard, "", 1)
                with self.assertRaisesRegex(AssertionError, "key path guard must refuse"):
                    self.assert_node_key_location_guard(without_guard, name)

    def test_node_key_location_guidance_requires_linux_and_an_external_home(self):
        # E17e NC4: retain the location constraints even when an older release cannot enforce them.
        signing = between(phase_text("00-prerequisites.md"), "## 3.", "## 4.")
        self.assertRegex(signing, r"(?i)Linux only")
        self.assertIn("PCC_NODE_KEY_PATH", signing)
        self.assertIn("~/.pcc-node/keys.json", signing)
        self.assertIn("Your home and the key directory must be outside every source checkout", signing)

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
        kernel = between(phase_text("05-register.md"), "kernel-fields.json <<'JSON'", "\nJSON\n")
        self.assertIn("physicalAddress", kernel)
        self.assertNotRegex(kernel, r'"location":\s*\{[^}]*"address"')

    def test_the_kernel_is_checked_before_its_signing_key_is_registered(self):
        # F7: a mistyped kernel id would sign, and create, another kernel.
        signing = between(phase_text("05-register.md"), "## 2.", "## 3.")
        self.assertRegex(signing, r"GET[^\n]*/api/kernels/")
        self.assertLess(signing.index("/api/kernels/"), signing.index("register_kernel_signed("))

    def test_the_gateway_must_check_operator_ownership(self):
        # F1: master's operator routes do not check who owns the kernel or job.
        self.assertRegex(phase_text("00-prerequisites.md"), r"(?i)ownership")

    def test_no_pcc_node_daemon_beside_the_loop(self):
        # 0.1.1's daemon takes no jobs and its heartbeat says so, which would hide the listing.
        self.assertRegex(phase_text("07-operate.md"), r"acceptingJobs")



class TestOneCallRegistration(unittest.TestCase):
    """Phase 5 creates the kernel and registers its signing key in one call."""

    def test_the_kernel_and_its_key_are_registered_in_one_call(self):
        text = phase_text("05-register.md")
        self.assertNotIn("register_signing_key", text)
        self.assertEqual(len(re.findall(r"\bregister_kernel_signed\s*\(", text)), 1)
        signing = between(text, "## 2.", "## 3.")
        examples = [
            code for code in re.findall(r"(?ms)^python3 - <<'EOF'[^\n]*\n(.*?)^EOF$", signing)
            if "register_kernel_signed(" in code
        ]
        self.assertEqual(len(examples), 1)
        tree = ast.parse(examples[0])
        calls = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call) and ast.unparse(node.func) == "register_kernel_signed"
        ]
        self.assertEqual(len(calls), 1)
        call = calls[0]
        self.assertEqual(len(call.args), 5)
        self.assertFalse(call.keywords)
        self.assertIsInstance(call.args[2], ast.Name)
        bindings = [
            node.value for node in tree.body
            if isinstance(node, ast.Assign) and node.lineno < call.lineno
            and any(isinstance(target, ast.Name) and target.id == call.args[2].id
                    for target in node.targets)
        ]
        self.assertTrue(bindings)
        self.assertIn("kernel-fields.json", ast.unparse(bindings[-1]))
        self.assertIn("kernel-id", ast.unparse(bindings[-1]))
        self.assertEqual(ast.unparse(call), "register_kernel_signed(read('base'), read('api-key'), payload, pub, sec)")
        k = next(i for i, statement in enumerate(tree.body) if any(node is call for node in ast.walk(statement)))
        b = max(
            i for i, statement in enumerate(tree.body[:k])
            if isinstance(statement, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "payload" for target in statement.targets)
        )
        self.assertFalse(any(
            isinstance(node, ast.Name) and node.id == "payload"
            for statement in tree.body[b + 1:k] for node in ast.walk(statement)
        ))
        self.assertLess(k + 1, len(tree.body))
        self.assertEqual(ast.unparse(tree.body[k + 1]), "json.dump(data, open('.pcc/kernel.json', 'w'))")

    def test_step_1_sends_nothing_and_picks_the_id(self):
        text = phase_text("05-register.md")
        self.assertNotRegex(text, r'-X POST "\$BASE/api/kernels"')
        kernel = between(text, "## 1.", "## 2.")
        self.assertIn("secrets.token_hex", kernel)
        self.assertNotIn("curl", kernel)
        self.assertIn("[ -s .pcc/kernel-id ] ||", kernel)

    def test_the_id_is_checked_by_its_status_code_first(self):
        signing = between(phase_text("05-register.md"), "## 2.", "## 3.")
        before = signing[:signing.index("register_kernel_signed(")]
        self.assertIn("404", before)
        self.assertIn("%{http_code}", before)
        self.assertNotIn("ready for its key", signing)

    def test_the_starter_names_no_pcc_node_version(self):
        for path, text in text_files():
            self.assertNotRegex(text, r"(?<![\d.])0\.1\.\d+\b", path.name)

    def test_the_signing_refusal_names_the_one_call(self):
        index = json.loads((RUNBOOK / "index.json").read_text(encoding="utf-8"))
        trigger = index["events"]["register.signing-refused"]["trigger"]
        self.assertIn("register_kernel_signed", trigger)
        self.assertIn("signing_key_unusable", trigger)
        self.assertNotRegex(trigger, r"register_signing_key|LogSigningRefused")
        self.assertIn('If it refuses with "pynacl" or `signing_key_unusable`:', phase_text("05-register.md"))

    def test_the_install_check_finds_the_one_call(self):
        install = between(phase_text("00-prerequisites.md"), "## 2.", "## 3.")
        self.assertIn('python3 -c "from pcc_node.register import register_kernel_signed" && echo "pcc-node OK"', install)
        self.assertNotIn("pcc-node --version", install)
        book = json.loads((RUNBOOK / "runbook.json").read_text(encoding="utf-8"))
        prerequisites = next(phase for phase in book["phases"] if phase["id"] == "prerequisites")
        self.assertTrue(any("register_kernel_signed" in entry for entry in prerequisites["doneWhen"]))


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


class TestProvisionPause(unittest.TestCase):
    """Execute phase 0's real block, including its shell failure handling."""

    PAUSED = {"error": "feature_paused", "feature": "key_minting",
              "message": "Creating API keys is paused."}

    def run_provision(self, status, body, transport_exit=0, *, raw_body=None, after="", leftover_body=None):
        section = between(phase_text("00-prerequisites.md"), "## 4.", "## 5.")
        block = re.search(r"```bash\n(.*?)\n```", section, re.S)
        self.assertIsNotNone(block, "section 4 must contain its provision block")
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            state = root / ".pcc"
            state.mkdir()
            (state / "base").write_text("http://127.0.0.1:4310", encoding="utf-8")
            (state / "operator.json").write_text(
                json.dumps({"email": "operator@example.org", "name": "Bench"}), encoding="utf-8")
            (state / "node-public-key").write_text("ab" * 32, encoding="utf-8")
            if leftover_body is not None:
                (state / "provision.json").write_text(json.dumps(leftover_body), encoding="utf-8")
            if raw_body is None:
                (root / "body.json").write_text(json.dumps(body), encoding="utf-8")
            else:
                (root / "body.json").write_bytes(raw_body)
            binaries = root / "bin"
            binaries.mkdir()
            curl = binaries / "curl"
            curl.write_text(
                "#!" + sys.executable + "\n"
                "import os, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "code = int(os.environ['PCC_TEST_CURL_EXIT'])\n"
                "if not code:\n"
                "    body = pathlib.Path('body.json').read_bytes()\n"
                "    if '-o' in args:\n"
                "        pathlib.Path(args[args.index('-o') + 1]).write_bytes(body)\n"
                "    else:\n"
                "        sys.stdout.buffer.write(body)\n"
                "if '-w' in args:\n"
                "    sys.stdout.flush()\n"
                "    sys.stdout.write(os.environ['PCC_TEST_HTTP_STATUS'])\n"
                "sys.exit(code)\n", encoding="utf-8")
            curl.chmod(0o755)
            chmod = binaries / "chmod"
            chmod.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PCC_TEST_CHMOD_LOG"\n'
                'exec /bin/chmod "$@"\n', encoding="utf-8")
            chmod.chmod(0o755)
            environment = dict(os.environ, PATH=str(binaries) + os.pathsep + os.environ.get("PATH", ""),
                               PCC_TEST_CURL_EXIT=str(transport_exit), PCC_TEST_HTTP_STATUS=str(status),
                               PCC_TEST_CHMOD_LOG=str(root / "chmod.log"))
            result = subprocess.run(["bash"], input=block.group(1) + "\n" + after, text=True, capture_output=True,
                                    cwd=str(root), env=environment, timeout=10)
            files = {path.name: (path.read_bytes() if raw_body is not None and path.name == "provision.json"
                                 else path.read_text(encoding="utf-8")) for path in state.iterdir()}
            return result, files, (root / "chmod.log").exists()

    def assert_no_key(self, files):
        self.assertNotIn("api-key", files)
        self.assertNotIn("auth.header", files)

    def test_paused_provision_prints_only_the_message_and_stops_before_chmod(self):
        result, files, chmod_ran = self.run_provision(409, self.PAUSED)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((result.stdout + result.stderr).strip(), self.PAUSED["message"])
        self.assert_no_key(files)
        self.assertFalse(chmod_ran, "chmod must run only after the Python block succeeds")
        self.assertEqual(files["provision.status"], "409")
        self.assertEqual(json.loads(files["provision.json"]), self.PAUSED)

    def test_a_stopped_block_leaves_its_shell_running(self):
        result, files, chmod_ran = self.run_provision(409, self.PAUSED, after='echo "after $?"')
        self.assertEqual(result.stderr, self.PAUSED["message"] + "\n")
        self.assertEqual(result.stdout, "after 1\n")
        self.assert_no_key(files)
        self.assertFalse(chmod_ran, "chmod must run only after the Python block succeeds")

    def test_success_captures_the_key_without_printing_any_reply(self):
        key = "pcc-test-secret-sentinel"
        result, files, chmod_ran = self.run_provision(201, {"api_key": key, "message": "sentinel-response"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, "")
        self.assertEqual(files["api-key"], key)
        self.assertEqual(files["auth.header"], "Authorization: Bearer " + key + "\n")
        self.assertTrue(chmod_ran)

    def test_other_replies_never_print_body_values_or_write_a_key(self):
        sentinel = "sentinel-not-for-output"
        cases = [
            (409, {"error": "conflict", "message": sentinel}, 0),
            (500, {"error": "x", "detail": sentinel}, 0),
            (200, {}, 0),
            (409, dict(self.PAUSED, message="Creating\x1bAPI keys"), 0),
            (200, self.PAUSED, 0),
            ("000", None, 7),
        ]
        for status, body, transport_exit in cases:
            with self.subTest(status=status, body=body, transport_exit=transport_exit):
                result, files, _ = self.run_provision(status, body, transport_exit)
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_key(files)
                output = result.stdout + result.stderr
                for hidden in (sentinel, "\x1b", "Creating", "API keys", self.PAUSED["message"]):
                    self.assertNotIn(hidden, output)

    def test_a_reply_that_is_not_json_prints_nothing_from_it(self):
        sentinel = "sentinel-not-for-output"
        cases = [
            (502, b"<html>sentinel-not-for-output</html>"),
            (409, b"\xffsentinel-not-for-output"),
        ]
        for status, raw_body in cases:
            with self.subTest(status=status, raw_body=raw_body):
                result, files, _ = self.run_provision(status, None, raw_body=raw_body)
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_key(files)
                output = result.stdout + result.stderr
                self.assertNotIn(sentinel, output)
                self.assertNotIn("\x1b", output)

    def test_pause_requires_a_409_object_and_the_exact_error(self):
        sentinel = "sentinel-pause-definition"
        cases = [(status, dict(self.PAUSED, message=sentinel)) for status in (201, 403, 500)]
        cases += [(409, {"error": error, "message": sentinel}) for error in
                  ("FEATURE_PAUSED", "feature_paused ", "prefix_feature_paused", "feature_paused_suffix", None, 7)]
        cases += [(409, {"message": sentinel}), (409, ["feature_paused", sentinel]),
                  (409, "feature_paused"), (409, None)]
        for status, body in cases:
            with self.subTest(status=status, body=body):
                result, files, _ = self.run_provision(status, body)
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_key(files)
                self.assertNotIn(sentinel, result.stdout + result.stderr)

    def test_pause_messages_must_be_nonempty_strings_without_any_cc_character(self):
        bodies = [{"error": "feature_paused", "feature": "key_minting"}]
        bodies += [dict(self.PAUSED, message=message) for message in ("", 7, ["x"], None)]
        bodies += [dict(self.PAUSED, message="sentinel" + chr(codepoint) + "hidden")
                   for codepoint in list(range(0x20)) + list(range(0x7f, 0xa0))]
        for body in bodies:
            with self.subTest(body=body):
                result, files, _ = self.run_provision(409, body)
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_key(files)
                output = result.stdout + result.stderr
                message = body.get("message")
                if message == "":
                    self.assertNotEqual(output, "\n", "an empty message must not be printed")
                elif not isinstance(message, str):
                    self.assertNotIn(str(message), output, "a nonstring message must not be printed")
                self.assertNotIn("sentinel", output)
                self.assertNotIn("hidden", output)
                self.assertNotIn("\x1b", output)

    def test_usable_messages_are_preserved_including_non_cc_unicode_and_spaces(self):
        for message in ("Creating\u00a0API\u200b keys is paused.", " ", " first and last "):
            with self.subTest(message=message):
                result, files, chmod_ran = self.run_provision(409, dict(self.PAUSED, message=message))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout + result.stderr, message + "\n")
                self.assert_no_key(files)
                self.assertFalse(chmod_ran)

    def test_api_keys_must_be_nonempty_strings(self):
        for key in ("", 7, ["sentinel"], None):
            with self.subTest(key=key):
                result, files, _ = self.run_provision(201, {"api_key": key})
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_key(files)
                self.assertNotIn("sentinel", result.stdout + result.stderr)

    def test_other_stops_exit_1_skip_the_chmod_and_print_nothing(self):
        sentinel = "sentinel-not-for-output"
        cases = [
            (409, {"error": "conflict", "message": sentinel}, 0, None),
            (500, {"error": "x", "detail": sentinel}, 0, None),
            (200, {}, 0, None),
            (409, dict(self.PAUSED, message="Creating\x1bAPI keys"), 0, None),
            (200, self.PAUSED, 0, None),
            ("000", None, 7, None),
            (409, ["feature_paused", sentinel], 0, None),
            (201, {"api_key": ""}, 0, None),
            (502, None, 0, b"<html>sentinel-not-for-output</html>"),
            (409, None, 0, b"\xffsentinel-not-for-output"),
        ]
        for status, body, transport_exit, raw_body in cases:
            with self.subTest(status=status, body=body, transport_exit=transport_exit, raw_body=raw_body):
                result, files, chmod_ran = self.run_provision(status, body, transport_exit, raw_body=raw_body)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(chmod_ran)
                self.assertEqual(result.stdout + result.stderr, "")

    def test_no_new_body_never_reuses_a_leftover_reply(self):
        result, files, chmod_ran = self.run_provision(
            "000", None, 7, leftover_body={"api_key": "sentinel-leftover-api-key"})
        self.assertEqual(result.returncode, 1)
        self.assert_no_key(files)
        self.assertFalse(chmod_ran)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_pause_guidance_is_verbatim_and_in_its_phase(self):
        texts = [
            ("00-prerequisites.md", "If the block stops and prints only a message, PCC has paused that feature (HTTP 409, error `feature_paused`). Tell the human the message. Don't retry it unless the human asks, and don't try another endpoint to get round the pause. An API key the operator already has still works."),
            ("01-identify.md", "It answers 409 with error `feature_paused` when PCC has paused device identification. Tell the human the reply's message, then use the manual."),
            ("05-register.md", "If a call in this phase refuses with error `feature_paused`, PCC has paused that feature. Tell the human the message, keep `.pcc/kernel-id`, and report this phase blocked. Don't retry it unless the human asks."),
        ]
        for name, paragraph in texts:
            with self.subTest(name=name):
                self.assertIn("\n\n" + paragraph + "\n", phase_text(name))

    def test_pause_events_are_exact_and_follow_the_phase_events(self):
        events = json.loads((RUNBOOK / "index.json").read_text(encoding="utf-8"))["events"]
        expected = {
            "prerequisites.provision-paused": {
                "phase": "prerequisites",
                "trigger": "The provision step stops and prints only a message: PCC has paused that feature (HTTP 409, error feature_paused).",
                "do": "Tell the human the message. Don't retry it unless the human asks, and don't try another endpoint to get round the pause. An API key the operator already has still works.",
                "file": "00-prerequisites.md",
                "section": "4. An operator API key, captured without logging it",
                "report": {"phase": "prerequisites", "outcome": "blocked"},
            },
            "register.paused": {
                "phase": "register",
                "trigger": "A register call answers HTTP 409 with error feature_paused.",
                "do": "PCC has paused that feature. Tell the human the message and keep .pcc/kernel-id. Don't retry it unless the human asks, and don't try another endpoint to get round the pause.",
                "file": "05-register.md",
                "section": "2. The kernel's signing key",
                "report": {"phase": "register", "outcome": "blocked"},
            },
        }
        for name, event in expected.items():
            with self.subTest(name=name):
                self.assertEqual(events.get(name), event)
                phase_events = [key for key, value in events.items() if value["phase"] == event["phase"]]
                self.assertEqual(phase_events[-1], name)


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


if __name__ == "__main__":
    unittest.main()
