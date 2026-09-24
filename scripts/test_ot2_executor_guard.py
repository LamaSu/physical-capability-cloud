#!/usr/bin/env python3
"""Tests for the N4a guard in ot2-executor.py and ot2-agent.py (stdlib only).

Run: python3 -m unittest -v scripts/test_ot2_executor_guard.py

The executor runs whatever the PCC relay hands it, shell commands included, so
it must refuse to start unless it is run explicitly as an unsafe, local-only
tool, and it must then talk only to the local addresses it checked (status
board row N4a; the real authorization fix is N4b). The fixture tests start
local HTTP servers that stand in for the gateway, the robot, a "public" host
and a proxy, run the real scripts as subprocesses, and assert which of them
were contacted: nothing may reach the public host or the proxy, and the robot
may receive no command.
"""

import http.server
import importlib
import json
import os
import ssl
import subprocess
import sys
import threading
import time
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
# Spellings that are not a canonical local IP literal. Several of them encode a
# public address (134744072 and 0x08080808 are 8.8.8.8), and a name resolves
# through DNS, so the guard refuses all of them.
BYPASS_BASES = [
    "http://134744072",
    "http://0x08080808",
    "http://017700000001",
    "http://2130706433",
    "http://127.1",
    "http://010.8.8.8",
    "http://0.0.0.0:3000",
    "http://[::ffff:8.8.8.8]",
    "http://[::ffff:127.0.0.1]",
    "http://[2001:4860:4860::8888]",
    "http://100.64.0.1",
    "http://spark:8080",
    "http://ot2.local",
    "http://gateway.localhost:8080",
    "http://localhost.:8080",
    "http://user@127.0.0.1:3000",
    "http://127.0.0.1:3000/?next=https://capability.network",
    "ftp://127.0.0.1",
    "//localhost:8080",
    "localhost:8080",
]
LOCAL_BASES = [
    "http://localhost:8080",
    "http://LOCALHOST:8080",
    "http://127.0.0.1:3000",
    "http://[::1]:8080",
    "http://192.168.108.72:8080",
    "https://192.168.1.10:8443",
    "http://10.0.0.2",
    "http://172.16.5.4",
    "http://169.254.1.1",
    "http://[fd00::5]:3000",
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

    def test_refuses_every_spelling_that_is_not_a_canonical_local_ip(self):
        for module in (executor, agent):
            for base in BYPASS_BASES:
                msg = module.start_guard(["--unsafe-local"], base, "x.py")
                self.assertIsNotNone(msg, f"{module.__name__} allowed {base!r}")

    def test_allows_a_local_or_private_gateway_with_the_flag(self):
        for module in (executor, agent):
            for base in LOCAL_BASES:
                self.assertIsNone(
                    module.start_guard(["--unsafe-local"], base, "x.py"),
                    f"{module.__name__} refused {base!r}",
                )

    def test_refuses_a_robot_base_that_is_not_local(self):
        for module in (executor, agent):
            for base in ("http://8.8.8.8:31950", "http://134744072:31950", "http://ot2.local:31950"):
                msg = module.start_guard(["--unsafe-local"], "http://127.0.0.1:3000", "x.py", ot2_base=base)
                self.assertIsNotNone(msg, base)
                self.assertIn("OT2_BASE", msg)

    def test_flag_must_be_exact(self):
        for bad in ("--unsafe", "--unsafe-local=1", "unsafe-local", "--UNSAFE-LOCAL"):
            self.assertIsNotNone(executor.start_guard([bad], "http://localhost", "x.py"), bad)


class LocalBaseTests(unittest.TestCase):
    """What the guard dials is the canonical address it checked."""

    def setUp(self):
        self.guard = importlib.import_module("ot2_local_guard")

    def test_localhost_is_pinned_to_the_loopback_address(self):
        self.assertEqual(self.guard.local_base("http://localhost:8080"), ("http://127.0.0.1:8080", None))
        self.assertEqual(self.guard.local_base("http://LOCALHOST"), ("http://127.0.0.1", None))

    def test_literals_come_back_canonical(self):
        self.assertEqual(self.guard.local_base("http://[::1]:8080/"), ("http://[::1]:8080", None))
        self.assertEqual(self.guard.local_base("https://192.168.1.10:8443/pcc/"), ("https://192.168.1.10:8443/pcc", None))

    def test_every_refusal_says_why(self):
        for base in BYPASS_BASES + PUBLIC_BASES:
            canonical, why = self.guard.local_base(base)
            self.assertIsNone(canonical, base)
            self.assertTrue(why, base)


class TransportTests(unittest.TestCase):
    """The single opener: no environment proxies, no redirects, verified TLS."""

    def setUp(self):
        guard = importlib.import_module("ot2_local_guard")
        self.handlers = guard.make_opener().handlers

    def test_ignores_proxy_environment_variables(self):
        import urllib.request as ur

        # ProxyHandler({}) replaces urllib's default, env-reading ProxyHandler and,
        # having no proxies, registers nothing: no handler may carry a proxy.
        proxies = [h for h in self.handlers if isinstance(h, ur.ProxyHandler) and h.proxies]
        self.assertEqual(proxies, [])

    def test_refuses_redirects(self):
        import urllib.request as ur

        redirect = [h for h in self.handlers if isinstance(h, ur.HTTPRedirectHandler)]
        self.assertEqual(len(redirect), 1)
        self.assertIsNone(redirect[0].redirect_request(None, None, 302, "Found", {}, "http://8.8.8.8/"))

    def test_verifies_tls(self):
        import urllib.request as ur

        https = [h for h in self.handlers if isinstance(h, ur.HTTPSHandler)]
        self.assertEqual(len(https), 1)
        self.assertEqual(https[0]._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(https[0]._context.check_hostname)


def run_script(args, env_overrides, timeout=30):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1"}
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, *args], cwd=HERE, env=env, capture_output=True, text=True, timeout=timeout
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


# ── Fixture servers ─────────────────────────────────────────────────────────


class Fixture:
    """A local HTTP server that records every request and answers from `respond`."""

    def __init__(self, respond):
        self.requests = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                fixture.requests.append((self.command, self.path, dict(self.headers)))
                status, headers, payload = respond(self.command, self.path)
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _serve

            def do_CONNECT(self):
                fixture.requests.append(("CONNECT", self.path, dict(self.headers)))
                self.send_response(403)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def paths(self):
        return [path for _, path, _ in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def robot_responder(method, path):
    if path.startswith("/health"):
        return 200, {}, {"name": "fixture-ot2", "api_version": "fixture"}
    if path.startswith("/pipettes"):
        return 200, {}, {"left": {}, "right": {}}
    return 200, {}, {}


def idle_gateway(method, path):
    if "/tool-call/pending" in path:
        return 200, {}, {"calls": [], "count": 0}
    if "/chat/pending" in path:
        return 200, {}, {"messages": [], "count": 0}
    if "/approvals" in path:
        return 200, {}, {"approvals": []}
    return 200, {}, {}


def hostile_executor_gateway(method, path):
    """What a public relay would hand out: a gantry move for the robot."""
    if "/tool-call/pending" in path:
        return 200, {}, {"calls": [{"id": "c1", "toolName": "ot2_home", "args": {}}], "count": 1}
    return 200, {}, {"name": "not-a-robot", "api_version": "x"}


def silent_host(method, path):
    # No jobs or chat, so the agent never calls Claude, even without the guard.
    return 200, {}, {}


def redirect_to(target):
    return lambda method, path: (302, {"Location": target.url + path}, {})


def start_script(args, env_overrides):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1", "POLL_INTERVAL": "1"}
    env.update(env_overrides)
    return subprocess.Popen(
        [sys.executable, *args],
        cwd=HERE,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def wait_for(predicate, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def stop(proc):
    proc.terminate()
    try:
        return proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        return proc.communicate()


PROXY_ENV_NAMES = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.fixtures = []

    def tearDown(self):
        for fixture in self.fixtures:
            fixture.close()

    def fixture(self, respond):
        f = Fixture(respond)
        self.fixtures.append(f)
        return f

    def run_until_polled(self, args, env, gateway, marker):
        proc = start_script(args, env)
        try:
            polled = wait_for(lambda: any(marker in p for p in gateway.paths()))
            time.sleep(1.5)  # one more poll cycle
        finally:
            out, err = stop(proc)
        self.assertTrue(polled, f"never polled {marker}: {err[-2000:]}")
        return out, err

    def test_executor_does_not_follow_a_redirect_off_the_local_gateway(self):
        public = self.fixture(hostile_executor_gateway)
        gateway = self.fixture(redirect_to(public))
        robot = self.fixture(robot_responder)
        env = {"PCC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url}
        self.run_until_polled(["ot2-executor.py", "--unsafe-local"], env, gateway, "/tool-call/pending")
        self.assertEqual(public.requests, [], "a redirect was followed to another host")
        self.assertEqual([r[:2] for r in robot.requests if r[0] != "GET"], [], "the robot got a command")

    def test_executor_ignores_proxy_environment_variables(self):
        proxy = self.fixture(hostile_executor_gateway)
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        env = {"PCC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url, "NO_PROXY": "", "no_proxy": ""}
        env.update({name: proxy.url for name in PROXY_ENV_NAMES})
        self.run_until_polled(["ot2-executor.py", "--unsafe-local"], env, gateway, "/tool-call/pending")
        self.assertEqual(proxy.requests, [], "a request went through the proxy")
        polls = [h for m, p, h in gateway.requests if "/tool-call/pending" in p]
        self.assertEqual(polls[0].get("Authorization"), "Bearer k")
        self.assertEqual([r[:2] for r in robot.requests if r[0] != "GET"], [], "the robot got a command")

    def test_agent_daemon_does_not_follow_a_redirect_off_the_local_gateway(self):
        public = self.fixture(silent_host)
        gateway = self.fixture(redirect_to(public))
        robot = self.fixture(robot_responder)
        env = {"PCC_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url}
        self.run_until_polled(["ot2-agent.py", "daemon", "--unsafe-local"], env, gateway, "/approvals")
        self.assertEqual(public.requests, [], "a redirect was followed to another host")

    def test_agent_daemon_ignores_proxy_environment_variables(self):
        proxy = self.fixture(silent_host)
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        env = {"PCC_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url,
               "NO_PROXY": "", "no_proxy": ""}
        env.update({name: proxy.url for name in PROXY_ENV_NAMES})
        self.run_until_polled(["ot2-agent.py", "daemon", "--unsafe-local"], env, gateway, "/approvals")
        self.assertEqual(proxy.requests, [], "a request went through the proxy")

    def test_bypass_spellings_are_refused_before_the_robot_is_touched(self):
        robot = self.fixture(robot_responder)
        for base in ("http://134744072", "http://0x08080808", "http://spark:3000", "http://0.0.0.0:9"):
            r = run_script(
                ["ot2-executor.py", "--unsafe-local"],
                {"PCC_API_KEY": "k", "PCC_BASE": base, "OT2_BASE": robot.url},
            )
            self.assertEqual(r.returncode, 2, f"{base}: {r.stderr}")
        self.assertEqual(robot.requests, [])

    def test_importing_a_script_and_calling_its_loop_or_helpers_is_refused(self):
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        env = {"PCC_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url}
        calls = {
            "ot2-executor": ("run()", "pcc('GET', '/api/health')", "ot2('GET', '/health')"),
            "ot2-agent": ("daemon_mode()", "pcc('GET', '/api/health')", "ot2('GET', '/health')"),
        }
        for module, snippets in calls.items():
            for snippet in snippets:
                code = f"import importlib; m = importlib.import_module({module!r}); m.{snippet}"
                try:
                    r = run_script(["-c", code], env, timeout=10)
                except subprocess.TimeoutExpired:
                    self.fail(f"{module}.{snippet} kept running without the guard")
                self.assertEqual(r.returncode, 2, f"{module}.{snippet}: {r.stderr[-500:]}")
                self.assertIn("REFUSED", r.stderr)
        self.assertEqual(gateway.requests, [])
        self.assertEqual(robot.requests, [])

    def test_agent_self_update_is_disabled(self):
        source = self.fixture(silent_host)
        result = json.loads(agent.execute_tool("ot2_self_update", {"url": source.url + "/agent.py"}))
        self.assertFalse(result["updated"])
        self.assertIn("disabled", result["error"])
        self.assertEqual(source.requests, [])


if __name__ == "__main__":
    unittest.main()
