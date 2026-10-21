"""The runbook stays consistent with itself, with painpoints' reporting contract,
and with the truths the agent pack enforces. Standard library only:
python3 -m unittest discover -s starter/bin -p 'test_*.py'
"""

import ast
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

    def test_signing_refused_names_the_selected_key_file(self):
        # AT24: the incident path must select the same external key file as phase 0.
        guidance = self.events["register.signing-refused"]["do"]
        selections = ("PCC_NODE_KEY_PATH if set", "PCC_NODE_KEYS_FILE if set", "~/.pcc-node/keys.json")
        positions = [guidance.index(selection) for selection in selections]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(guidance.count(".pcc/node-keys.json"), 1)
        self.assertIn("folders onboarded earlier used .pcc/node-keys.json", guidance)


class TestTruths(unittest.TestCase):
    def test_step_4_names_the_api_key_header_once_for_node_calls(self):
        # AT23: Step 1 kept the selected-key-file claim and the canonical call guidance.
        phase = phase_text("00-prerequisites.md")
        self.assertEqual(phase.count("Node calls that use the operator API key send it with"), 1)
        self.assertEqual(phase.count("Every later call sends the key"), 0)
        section3 = between(phase, "## 3.", "## 4.")
        self.assertEqual(section3.count("the gateway never generates or returns a private signing key"), 1)

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
        # Without publicKey, the API key has no signing key on file.
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
    Path(args[args.index("--dump-header") + 1]).write_text("HTTP/1.1 " + os.environ["MOCK_STATUS"] + "\\r\\nx-pcc-trace-id: " + os.environ.get("MOCK_TRACE_HEADER", "tr_" + "cd" * 16) + "\\r\\n" + os.environ.get("MOCK_EXTRA_HEADERS", "") + "\\r\\n")
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
                   PYTHONPATH=self.os.pathsep.join(filter(None, (str(self.bin), self.os.environ.get("PYTHONPATH")))),
                   MOCK_RESPONSE=str(response_path), MOCK_STATUS=status, **extras)
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

    def require_outside_git_temp(self):
        import tempfile
        probe = self.subprocess.run([self.git, "-C", tempfile.gettempdir(), "rev-parse", "--git-dir"], capture_output=True)
        if probe.returncode == 0:
            self.skipTest("Temporary directory is inside a Git repository; outside-repository recipe test skipped")

    def test_capture_sitecustomize_preserves_inherited_pythonpath(self):
        from unittest import mock
        inherited = self.cwd / "inherited-python"
        inherited.mkdir()
        (inherited / "inherited_provider_marker.py").write_text('from pathlib import Path\nPath(".pcc/inherited-path-used").write_text("yes")\n')
        sitecustomize = self.bin / "sitecustomize.py"
        sitecustomize.write_text(sitecustomize.read_text() + "\nimport inherited_provider_marker\n")
        with mock.patch.dict(self.os.environ, {"PYTHONPATH": str(inherited)}):
            result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.private / "inherited-path-used").exists())

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

    def test_exclusion_append_preserves_a_rule_without_a_trailing_newline(self):
        exclude = self.cwd / ".git/info/exclude"
        exclude.write_bytes(b"*.log")
        (self.cwd / "app.log").write_text("keep ignored\n")
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        ignored = self.subprocess.run([self.git, "check-ignore", "-q", "--", "app.log"], cwd=self.cwd)
        self.assertEqual(ignored.returncode, 0)
        self.assertEqual(exclude.read_bytes(), b"*.log\n.pcc/\n")

    def test_exclusion_append_is_not_repeated_on_a_corrected_rerun(self):
        result = self.run_capture("400", {"error": "invalid_email"})
        self.assertNotEqual(result.returncode, 0)
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = (self.cwd / ".git/info/exclude").read_text().splitlines()
        self.assertEqual(lines.count(".pcc/"), 1)

    def test_existing_ignore_provisions_with_a_read_only_exclude_file(self):
        (self.cwd / ".gitignore").write_text(".pcc/\n")
        exclude = self.cwd / ".git/info/exclude"
        before = exclude.read_bytes()
        exclude.chmod(0o400)
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(exclude.read_bytes(), before)

    def test_existing_ignore_provisions_with_no_git_info_directory(self):
        import shutil
        (self.cwd / ".gitignore").write_text(".pcc/\n")
        shutil.rmtree(self.cwd / ".git/info")
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertFalse((self.cwd / ".git/info").exists())

    def test_impossible_exclusion_append_has_only_its_fixed_message(self):
        import shutil
        shutil.rmtree(self.cwd / ".git/info")
        result = self.run_capture()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "Git exclusion setup failed.\n")
        self.assertFalse((self.private / "curl-called").exists())
        self.assertFalse(list(self.private.glob("capture.*")))

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

    def test_server_failure_has_its_own_fixed_advice(self):
        result = self.run_capture("500", {"error": "provision_failed"})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "Provision server failure; a key may exist server-side and counts toward the 5-key cap; report once with the printed trace_id; do not loop.\n")
        self.assertIn("http_status: 500\n", result.stdout)
        self.assertIn("trace_id:", result.stdout)
        self.assert_not_published()
        self.assertFalse(list(self.private.glob("capture.*")))

    def test_rate_limit_has_its_own_fixed_advice(self):
        result = self.run_capture("429", {"error": "rate_limited", "retry_after_seconds": 3600})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "Provision request limited; honor retry_after_seconds; do not loop.\n")
        self.assertIn("retry_after_seconds: 3600\n", result.stdout)
        self.assert_not_published()

    def test_retry_after_ascii_digits_are_used_when_body_has_no_integer(self):
        result = self.run_capture("429", {"error": "rate_limited"}, MOCK_EXTRA_HEADERS="Retry-After: 42\r\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("retry_after_seconds: 42\n", result.stdout)

    def test_retry_after_http_date_is_not_printed(self):
        result = self.run_capture("429", {"error": "rate_limited"}, MOCK_EXTRA_HEADERS="Retry-After: Wed, 21 Oct 2026 07:28:00 GMT\r\n")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("retry_after_seconds:", result.stdout)

    def test_integer_body_retry_wins_over_retry_after_header(self):
        result = self.run_capture("429", {"error": "rate_limited", "retry_after_seconds": 3600}, MOCK_EXTRA_HEADERS="Retry-After: 42\r\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("retry_after_seconds: 3600\n", result.stdout)
        self.assertNotIn("retry_after_seconds: 42\n", result.stdout)

    def test_unknown_413_error_prints_only_fixed_rejection_fields(self):
        result = self.run_capture("413", {"error": self.wallet_key, "message": self.key})
        self.assertEqual(result.returncode, 1)
        self.assertIn("http_status: 413\nerror: unrecognised\n", result.stdout)
        self.assertIn("trace_id:", result.stdout)
        self.assert_not_published()

    def test_transport_failure_has_actionable_possible_issuance_advice(self):
        result = self.run_capture(MOCK_CURL_EXIT="56")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "Provision request failed; a key may have been issued and cannot be recovered; it counts toward the 5-key cap. Report the failure once; archive the capture with the archive command, then provision again at most once; stop and report if that fails too. A new key cannot revoke the lost one; only the gateway admin can. Tell the human.\n")

    def test_capture_recovery_guidance_describes_one_retry_and_who_can_revoke(self):
        step = phase_text("00-prerequisites.md").split("## 4. ", 1)[1].split("## 5. ", 1)[0]
        # AT21: Step 1 moved the Node-call paragraph; do not silently consume the rest of the phase.
        self.assertIn("Node calls that use the operator API key", step)
        prose = step.split("The recipe requires", 1)[1].split("Node calls that use the operator API key", 1)[0]
        for text in ("cannot be recovered", "5-key cap", "report the failure once", "archive command", "at most once", "stop and report", "only the gateway admin can"):
            self.assertIn(text, prose.lower())
        self.assertNotIn("find and validate the key", prose)

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

    def assert_invalid_api_key_is_refused(self, invalid_key):
        result = self.run_capture(response=dict(self.response, api_key=invalid_key))
        self.assertEqual(result.returncode, 1)
        self.assert_not_published()
        self.assertNotIn(invalid_key, result.stdout + result.stderr)
        self.assertEqual(len(list(self.private.glob("capture.*"))), 1)

    def test_uppercase_api_key_hex_is_refused_before_publication(self):
        self.assert_invalid_api_key_is_refused("pcc_" + "live_" + "A" * 64)

    def test_api_key_with_63_hex_digits_is_refused_before_publication(self):
        self.assert_invalid_api_key_is_refused(self.key[:-1])

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

    def test_ineffective_chmod_refuses_before_staging_or_curl(self):
        self.private.chmod(0o755)
        chmod = self.bin / "chmod"
        chmod.write_text("#!/bin/sh\nexit 0\n")
        chmod.chmod(0o700)
        result = self.run_capture()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "Private directory verification failed.\n")
        self.assertFalse(list(self.private.glob("capture.*")))
        self.assertFalse((self.private / "curl-called").exists())
        self.assert_not_published()

    def test_invalid_gateway_base_file_fails_before_staging_or_curl(self):
        import shutil
        for base in (None, "", "http://example.com", "http://localhost:4310", "https://x.example/", "https://user@x.example", "https://x.example?q=1", "https://x.example#part", "https://x.example/a b"):
            with self.subTest(base=base):
                path = self.private / "base"
                if base is None: path.unlink()
                else: path.write_text(base + "\n")
                result = self.run_capture()
                try:
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stderr, "Invalid gateway base file; request refused.\n")
                    self.assert_not_published()
                    self.assertFalse(list(self.private.glob("capture.*")))
                    self.assertFalse((self.private / "curl-called").exists())
                finally:
                    for name in ("provision.json", "api-key", "auth.header", "curl-called"):
                        path = self.private / name
                        if path.exists(): path.unlink()
                    for capture in self.private.glob("capture.*"): shutil.rmtree(capture)

    def test_https_and_loopback_gateway_base_files_are_accepted(self):
        for base in ("https://fixture.invalid", "http://127.0.0.1:4310", "http://[::1]:4310"):
            with self.subTest(base=base):
                (self.private / "base").write_text(base + "\n\n")
                result = self.run_capture()
                self.assertEqual(result.returncode, 0, result.stderr)
                options = json.loads((self.private / "curl-options.json").read_text())
                self.assertIn(base + "/api/auth/provision", options)
                self.run_archive()

    def assert_unsent_curl_failure_can_retry(self, code):
        result = self.run_capture(MOCK_CURL_EXIT=str(code))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "Provision request not sent; no key was issued.\n")
        self.assert_not_published()
        self.assertFalse(list(self.private.glob("capture.*")))
        result = self.run_capture()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_curl_exit_1_is_unsent_and_can_retry(self):
        self.assert_unsent_curl_failure_can_retry(1)

    def test_curl_exit_3_is_unsent_and_can_retry(self):
        self.assert_unsent_curl_failure_can_retry(3)

    def test_curl_exit_6_is_unsent_and_can_retry(self):
        self.assert_unsent_curl_failure_can_retry(6)

    def test_curl_exit_7_is_unsent_and_can_retry(self):
        self.assert_unsent_curl_failure_can_retry(7)

    def test_curl_exit_28_and_56_preserve_a_possible_issuance_capture(self):
        for code in (28, 56):
            with self.subTest(code=code):
                result = self.run_capture(MOCK_CURL_EXIT=str(code))
                self.assertEqual(result.returncode, 1)
                self.assertIn("a key may have been issued", result.stderr)
                self.assert_not_published()
                self.assertEqual(len(list(self.private.glob("capture.*"))), 1)
                self.run_archive()

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
        self.assertEqual(result.stderr, "Provision request timed out; a key may have been issued and cannot be recovered; it counts toward the 5-key cap. Report the failure once; archive the capture with the archive command, then provision again at most once; stop and report if that fails too. A new key cannot revoke the lost one; only the gateway admin can. Tell the human.\n")
        self.assert_not_published()
        captures = list(self.private.glob("capture.*"))
        self.assertEqual(len(captures), 1)
        self.assertEqual(captures[0].stat().st_mode & 0o777, 0o700)

    def test_outside_git_continues_with_a_fixed_note(self):
        import shutil
        self.require_outside_git_temp()
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
        self.require_outside_git_temp()
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
        self.require_outside_git_temp()
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
