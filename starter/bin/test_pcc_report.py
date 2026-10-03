"""Tests for bin/pcc-report (attempt reporting contract v1). Standard library only:
python3 -m unittest discover -s starter/bin -p 'test_*.py'
"""

import contextlib
import http.server
import importlib.machinery
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import threading
import unittest
import uuid

HERE = pathlib.Path(__file__).resolve().parent
_loader = importlib.machinery.SourceFileLoader("pcc_report", str(HERE / "pcc-report"))
_spec = importlib.util.spec_from_loader("pcc_report", _loader)
pcc_report = importlib.util.module_from_spec(_spec)
_loader.exec_module(pcc_report)


class _Capture(http.server.BaseHTTPRequestHandler):
    bodies = []

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        _Capture.bodies.append((self.path, json.loads(self.rfile.read(length))))
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def log_message(self, *args):
        pass


class InATempDir(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._cwd = os.getcwd()
        os.chdir(self._tmp.name)

    def tearDown(self):
        os.chdir(self._cwd)
        self._tmp.cleanup()

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = pcc_report.main(list(argv))
        return code, out.getvalue()


class TestRedaction(unittest.TestCase):
    def test_removes_keys_tokens_and_emails(self):
        fake_key = "pcc_" + "live_" + "AbCdEf0123456789"  # split so secret scanners do not flag the fixture
        text = ("Bearer abcdefghijklmnopqrstuvwxyz0123 " + fake_key + " "
                "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N "
                "0x" + "ab" * 32 + " sk-proj-ABCDEFGHIJKLMNOPQRST ghp_ABCDEFGHIJKLMNOPQRSTUVWX ops@example.com")
        clean = pcc_report.redact(text)
        for secret in ("abcdefghijklmnopqrstuvwxyz0123", "pcc_live_", "eyJhbGci", "ab" * 32, "sk-proj-", "ghp_", "ops@example.com"):
            self.assertNotIn(secret, clean)

    def test_removes_the_private_keys_a_provisioning_response_carries(self):
        # Built at runtime so no literal here looks like a key to a secret scanner.
        b64 = "MC4CAQAwBQYDK2VwBCIEI" + "Gx9Qm2Rt7Vb3Kp8Wz1Lc5Nd" + "Yh4Fs6Uj0"
        pem = "-----BEGIN " + "PRIVATE KEY-----\n" + b64 + "\n-----END " + "PRIVATE KEY-----"
        field = '{"private_' + 'key_pkcs8_base64": "' + b64 + '", "name": "bench"}'
        for text in (pem, pem[:60], field, "the key was " + b64):
            clean = pcc_report.redact(text)
            self.assertNotIn(b64[:24], clean, text[:30])
        self.assertIn('"name": "bench"', pcc_report.redact(field))
        short = '{"pass' + 'word": "not-long-but-secret"}'  # too short for the base64 rule
        self.assertNotIn("not-long-but-secret", pcc_report.redact(short))

    def test_keeps_paths_and_prose_that_only_look_long(self):
        for text in ("POST /api/operators/operator/status/channels/test answered 404",
                     "registerdeviceanswered500twiceandthenstoppedcompletely"):
            self.assertEqual(pcc_report.redact(text), text)

    def test_keeps_a_40_hex_public_address(self):
        address = "0x" + "12" * 20
        self.assertIn(address, pcc_report.redact(f"payout to {address}"))


class TestBody(InATempDir):
    def test_seq_counts_up_within_one_attempt(self):
        first = pcc_report.next_seq()
        second = pcc_report.next_seq()
        self.assertEqual(first[0], second[0])
        uuid.UUID(first[0], version=4)
        self.assertEqual((first[1], second[1]), (0, 1))

    def test_body_follows_contract_v1_and_never_carries_a_transcript(self):
        code, out = self.run_main("register", "failed", "POST /api/kernels 400 for ops@example.com", "--kernel-id", "k-1", "--dry-run")
        self.assertEqual(code, 0)
        body = json.loads(out)
        self.assertEqual((body["kind"], body["contract"], body["phase"], body["outcome"], body["seq"]), ("attempt", 1, "register", "failed", 0))
        self.assertEqual(body["consent"], {"transcript": False})
        self.assertNotIn("transcript", body)
        self.assertNotIn("ops@example.com", body["summary"])
        self.assertEqual(body["ids"], {"kernelId": "k-1"})
        self.assertEqual(body["tokens"]["source"], "unknown")

    def test_a_proposal_path_loses_its_query_string(self):
        _, out = self.run_main("build", "ok", "done", "--proposal-target", "runbook",
                               "--proposal-path", "runbook/04-build.md?token=abc", "--proposal-text", "say where the envelope file goes", "--dry-run")
        self.assertEqual(json.loads(out)["proposal"]["path"], "runbook/04-build.md")

    def test_unknown_phases_and_outcomes_are_refused(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                pcc_report.main(["deploy", "ok", "x", "--dry-run"])
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                pcc_report.main(["build", "great", "x", "--dry-run"])


class TestSending(InATempDir):
    def setUp(self):
        super().setUp()
        _Capture.bodies = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Capture)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        os.makedirs(".pcc", exist_ok=True)
        with open(".pcc/base", "w") as f:
            f.write(f"http://127.0.0.1:{self.server.server_port}/\n")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        super().tearDown()

    def test_each_phase_posts_to_feedback_and_the_session_rolls_them_up(self):
        self.assertEqual(self.run_main("prerequisites", "ok", "gateway and key ready")[1].strip(), "201")
        self.run_main("identify", "ok", "SIM-PR1 found")
        self.run_main("register", "blocked", "register-device 400")
        self.run_main("session", "abandoned", "stopped at register")
        paths = {path for path, _ in _Capture.bodies}
        self.assertEqual(paths, {"/api/feedback"})
        session = _Capture.bodies[-1][1]
        self.assertEqual(session["phase"], "session")
        self.assertEqual(session["seq"], 3)
        self.assertEqual(session["phases"], [
            {"phase": "prerequisites", "outcome": "ok"},
            {"phase": "identify", "outcome": "ok"},
            {"phase": "register", "outcome": "blocked"},
        ])

    def test_an_unreachable_gateway_never_blocks_onboarding(self):
        with open(".pcc/base", "w") as f:
            f.write("http://127.0.0.1:9/\n")
        code, out = self.run_main("identify", "ok", "x")
        self.assertEqual((code, out.strip()), (0, "0"))


class TestNeverBlocks(InATempDir):
    """Verdict 115b, findings 10 and 11: each failed at 932c0aef."""

    def test_a_malformed_gateway_address_does_not_raise(self):
        os.makedirs(".pcc", exist_ok=True)
        with open(".pcc/base", "w") as f:
            f.write("not a url\n")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pcc_report.main(["identify", "ok", "x"]), 0)

    def test_unwritable_state_does_not_raise(self):
        with open(".pcc", "w") as f:
            f.write("a file where the state folder should be")
        os.environ["PCC_BASE"] = "http://127.0.0.1:9"
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(pcc_report.main(["identify", "ok", "x"]), 0)
        finally:
            del os.environ["PCC_BASE"]

    @unittest.skipIf(os.name == "nt", "POSIX modes")
    def test_a_permissive_state_folder_is_made_private(self):
        os.makedirs(".pcc", exist_ok=True)
        os.chmod(".pcc", 0o777)
        with contextlib.redirect_stdout(io.StringIO()):
            pcc_report.main(["identify", "ok", "x", "--dry-run"])
        self.assertEqual(os.stat(".pcc").st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
