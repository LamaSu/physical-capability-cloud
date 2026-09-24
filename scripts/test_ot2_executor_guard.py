#!/usr/bin/env python3
"""Tests for the N4a start guard in ot2-executor.py and ot2-agent.py (stdlib only).

Run: python3 -m unittest -v scripts/test_ot2_executor_guard.py

The executor runs whatever the PCC relay hands it, shell commands included, so
it must refuse to start unless it is run explicitly as an unsafe, local-only
tool (status board row N4a; the real authorization fix is N4b).
"""

import importlib
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
executor = importlib.import_module("ot2-executor")
agent = importlib.import_module("ot2-agent")

PUBLIC_BASES = [
    "https://capability.network",
    "https://pcc-gateway-staging.up.railway.app",
    "https://refer-proxy-joint-cleaning.trycloudflare.com",
    "http://8.8.8.8:8080",
    "https://localhost.example.com",
    "http://capability.network.",
    "",
    "not a url",
]
LOCAL_BASES = [
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://[::1]:8080",
    "http://192.168.108.72:8080",
    "http://10.0.0.2",
    "http://172.16.5.4",
    "http://169.254.1.1",
    "http://spark:8080",
    "http://ot2.local",
    "http://gateway.localhost:8080",
]


class StartGuardTests(unittest.TestCase):
    """start_guard(argv, pcc_base, name) returns None to allow, else the refusal."""

    def test_refuses_without_the_flag_even_for_a_local_gateway(self):
        for module in (executor, agent):
            for base in ("http://localhost:8080", "https://capability.network"):
                msg = module.start_guard([], base, "x.py")
                self.assertIsNotNone(msg, f"{module.__name__} started without the flag for {base}")
                self.assertIn("REFUSED", msg)
                self.assertIn("N4b", msg)
                self.assertIn("--unsafe-local", msg)

    def test_refuses_a_public_or_unparseable_gateway_even_with_the_flag(self):
        for module in (executor, agent):
            for base in PUBLIC_BASES:
                msg = module.start_guard(["--unsafe-local"], base, "x.py")
                self.assertIsNotNone(msg, f"{module.__name__} allowed {base!r}")
                self.assertIn("REFUSED", msg)

    def test_allows_a_local_or_private_gateway_with_the_flag(self):
        for module in (executor, agent):
            for base in LOCAL_BASES:
                self.assertIsNone(
                    module.start_guard(["--unsafe-local"], base, "x.py"),
                    f"{module.__name__} refused {base!r}",
                )

    def test_flag_must_be_exact(self):
        for bad in ("--unsafe", "--unsafe-local=1", "unsafe-local", "--UNSAFE-LOCAL"):
            self.assertIsNotNone(executor.start_guard([bad], "http://localhost", "x.py"), bad)


def run_script(args, env_overrides):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1"}
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, *args], cwd=HERE, env=env, capture_output=True, text=True, timeout=30
    )


class ExecutorEntryPointTests(unittest.TestCase):
    """The refusal happens before any network call, with exit code 2."""

    def test_default_start_is_refused(self):
        r = run_script(["ot2-executor.py"], {"PCC_API_KEY": "k", "PCC_BASE": "https://capability.network"})
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("REFUSED", r.stderr)

    def test_flag_with_the_public_gateway_is_refused(self):
        r = run_script(
            ["ot2-executor.py", "--unsafe-local"],
            {"PCC_API_KEY": "k", "PCC_BASE": "https://capability.network"},
        )
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("public PCC gateway", r.stderr)

    def test_default_pcc_base_is_the_public_gateway_and_is_refused(self):
        r = run_script(["ot2-executor.py", "--unsafe-local"], {"PCC_API_KEY": "k"})
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_flag_with_a_local_gateway_passes_the_guard(self):
        # With no API key the script stops right after the guard, before any network call.
        r = run_script(["ot2-executor.py", "--unsafe-local"], {"PCC_BASE": "http://127.0.0.1:9"})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("ERROR: Set PCC_API_KEY", r.stdout)
        self.assertIn("UNSAFE LOCAL MODE", r.stderr)


class AgentDaemonEntryPointTests(unittest.TestCase):
    def test_daemon_without_the_flag_is_refused(self):
        r = run_script(
            ["ot2-agent.py", "daemon"],
            {"PCC_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "PCC_BASE": "http://127.0.0.1:9"},
        )
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn("REFUSED", r.stderr)

    def test_daemon_with_the_public_gateway_is_refused(self):
        r = run_script(
            ["ot2-agent.py", "daemon", "--unsafe-local"],
            {"PCC_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "PCC_BASE": "https://capability.network"},
        )
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_daemon_with_a_local_gateway_passes_the_guard(self):
        # With no Anthropic key the agent stops right after the guard, before any network call.
        r = run_script(["ot2-agent.py", "daemon", "--unsafe-local"], {"PCC_BASE": "http://localhost:9"})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("ERROR: Set ANTHROPIC_API_KEY", r.stdout)


if __name__ == "__main__":
    unittest.main()
