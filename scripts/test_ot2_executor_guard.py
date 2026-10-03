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
may receive no command. The boundary tests call the scripts' own http(), tool
dispatchers and uploads directly, because the guard has to hold at the lowest
HTTP boundary, not only in the loops.

ApprovalRunsOnceTests covers a different hazard in ot2-agent.py: the gateway keeps
listing an approval as "approved" after its job ran, so the daemon must send each
approval to the agent at most once. They drive the real daemon loop with the PCC
calls, the agent turn, the camera and the sleep replaced, and count how often an
approved job reaches the agent.
"""

import contextlib
import errno
import hashlib
import http.server
import importlib
import importlib.util
import json
import logging
import os
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
from urllib.parse import quote, unquote

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
    "http://[fe80::1%25eth0]:8080",
    "http://[fe80::1%eth0]:8080",
    "http://127.0.0.%31:3000",
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
    # stdin is closed, so an interactive mode that should have been refused cannot
    # read a prompt and call out.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1"}
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, *args], cwd=HERE, env=env, stdin=subprocess.DEVNULL,
        capture_output=True, text=True, timeout=timeout,
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

    def __init__(self, respond, tls=None):
        self.requests = []
        self.bodies = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                fixture.bodies.append(self.rfile.read(length) if length else b"")
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
        scheme = "http"
        if tls is not None:
            self.server.socket = tls.wrap_socket(self.server.socket, server_side=True)
            scheme = "https"
        self.url = f"{scheme}://127.0.0.1:{self.server.server_address[1]}"
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
        stdin=subprocess.DEVNULL,
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


class FixtureCase(unittest.TestCase):
    """Base for tests that run fixture servers. It holds no tests of its own."""

    def setUp(self):
        self.fixtures = []

    def tearDown(self):
        for fixture in self.fixtures:
            fixture.close()

    def fixture(self, respond, tls=None):
        f = Fixture(respond, tls=tls)
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


class FixtureTests(FixtureCase):
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
        self.assertEqual([r[:2] for r in robot.requests if r[0] != "GET"], [], "the robot got a command")

    def test_agent_daemon_ignores_proxy_environment_variables(self):
        proxy = self.fixture(silent_host)
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        env = {"PCC_API_KEY": "k", "ANTHROPIC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url,
               "NO_PROXY": "", "no_proxy": ""}
        env.update({name: proxy.url for name in PROXY_ENV_NAMES})
        self.run_until_polled(["ot2-agent.py", "daemon", "--unsafe-local"], env, gateway, "/approvals")
        self.assertEqual(proxy.requests, [], "a request went through the proxy")
        self.assertEqual([r[:2] for r in robot.requests if r[0] != "GET"], [], "the robot got a command")

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
        marker = os.path.join(tempfile.mkdtemp(), "shell-ran")
        shell = f"execute_tool('ot2_shell', {{'command': 'touch {marker}'}})"
        upload = "execute_tool('ot2_protocol_upload', {'filename': 'p.py', 'content': 'x'})"
        # N4a F1: the actual dispatcher, reached directly by an importer, must be
        # guarded too -- not just the public execute_tool() wrapper.
        shell_direct = f"_execute_tool('ot2_shell', {{'command': 'touch {marker}'}})"
        common = (f"http('GET', {gateway.url + '/x'!r})", f"http('GET', {robot.url + '/health'!r})", shell, upload)
        calls = {
            "ot2-executor": ("run()", "pcc('GET', '/api/health')", "ot2('GET', '/health')") + common,
            "ot2-agent": ("daemon_mode()", "interactive_mode()", "pcc('GET', '/api/health')",
                          "ot2('GET', '/health')", "claude([], [], 'x')", shell_direct) + common,
        }
        for module, snippets in calls.items():
            for snippet in snippets:
                # A dead local port stands in for the Claude API, so a broken guard fails
                # here without calling out.
                code = (f"import importlib; m = importlib.import_module({module!r}); "
                        f"m.ANTHROPIC_API = 'http://127.0.0.1:9'; m.{snippet}")
                try:
                    r = run_script(["-c", code], env, timeout=10)
                except subprocess.TimeoutExpired:
                    self.fail(f"{module}.{snippet} kept running without the guard")
                self.assertEqual(r.returncode, 2, f"{module}.{snippet}: {r.stderr[-500:]}")
                self.assertIn("REFUSED", r.stderr)
        self.assertEqual(gateway.requests, [])
        self.assertEqual(robot.requests, [])
        self.assertFalse(os.path.exists(marker), "the shell tool ran without a start")

    def test_agent_self_update_is_disabled(self):
        source = self.fixture(silent_host)
        robot = self.fixture(robot_responder)
        code = (
            "import importlib, json; m = importlib.import_module('ot2-agent'); "
            f"assert m.start_interactive(['--unsafe-local'], {robot.url!r}, 't') is None; "
            f"print(m.execute_tool('ot2_self_update', {{'url': {source.url + '/agent.py'!r}}}))"
        )
        r = run_script(["-c", code], {})
        self.assertEqual(r.returncode, 0, r.stderr)
        result = json.loads(r.stdout)
        self.assertFalse(result["updated"])
        self.assertIn("disabled", result["error"])
        self.assertEqual(source.requests, [])


def started(module, gateway, robot, snippet):
    """Python for a subprocess: import `module`, accept a relay start, then run `snippet`."""
    return (
        f"import importlib, json; m = importlib.import_module({module!r}); "
        f"assert m.start_guard(['--unsafe-local'], {gateway.url!r}, 't', ot2_base={robot.url!r}) is None; "
        + snippet
    )


class BoundaryTests(FixtureCase):
    """Round 2 (astra): the checks must sit at the lowest HTTP boundary and at tool execution."""

    def test_allow_external_accepts_only_the_claude_api(self):
        # N4a F2: after a start, allow_external registers the fixed Claude API
        # origin and NO other. A rejected origin is never authorized. Runs
        # in-process, so the guard's module state is saved and restored.
        import ot2_local_guard as g
        saved = (g.GUARD.mode, list(g.GUARD.external), g.GUARD.pcc_base, g.GUARD.ot2_base)
        try:
            g.GUARD.mode, g.GUARD.external, g.GUARD.pcc_base, g.GUARD.ot2_base = "interactive", [], None, None
            g.allow_external("https://api.anthropic.com")
            self.assertTrue(g._authorized("https://api.anthropic.com/v1/messages"))
            for bad in ("https://example.com", "https://api.anthropic.com.evil.com", "https://evil/api.anthropic.com"):
                with self.assertRaises(ValueError, msg=f"allow_external accepted {bad!r}"):
                    g.allow_external(bad)
                self.assertFalse(g._authorized(bad + "/x"), f"{bad!r} is authorized after rejection")
        finally:
            g.GUARD.mode, g.GUARD.external, g.GUARD.pcc_base, g.GUARD.ot2_base = saved

    def test_an_accepted_start_still_refuses_every_destination_outside_its_bases(self):
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        other = self.fixture(silent_host)
        port = gateway.url.rsplit(":", 1)[1]
        for module in ("ot2-executor", "ot2-agent"):
            ok = run_script(["-c", started(module, gateway, robot, f"print(m.http('GET', {gateway.url + '/ok'!r})[0])")], {})
            self.assertEqual((ok.returncode, ok.stdout.strip()), (0, "200"), ok.stderr)
            for url in (
                other.url + "/x",
                gateway.url + "/api/../x",
                gateway.url + "/api/%2e%2e/x",
                # N4a F3: encoded separators / backslashes a proxy might decode
                # outside the base must be refused, like %2e already is.
                gateway.url + "/%2f../admin",
                gateway.url + "/api/%2f../admin",
                gateway.url + "/x%5cy",
                f"http://127.0.0.1:{port}.evil/x",
                f"http://user@127.0.0.1:{port}/x",
                f"http://localhost:{port}/x",
                "https://api.anthropic.com/v1/messages",
            ):
                r = run_script(["-c", started(module, gateway, robot, f"m.http('GET', {url!r})")], {})
                self.assertEqual(r.returncode, 2, f"{module} {url}: {r.stderr[-300:]}")
                self.assertIn("REFUSED", r.stderr)
        self.assertEqual(other.requests, [])
        self.assertEqual(gateway.paths(), ["/ok", "/ok"])

    def test_every_agent_mode_needs_the_flag(self):
        robot = self.fixture(robot_responder)
        for mode in ("interactive", "health"):
            r = run_script(["ot2-agent.py", mode], {"OT2_BASE": robot.url})
            self.assertEqual(r.returncode, 2, f"{mode}: {r.stderr}")
            self.assertIn("REFUSED", r.stderr)
        self.assertEqual(robot.requests, [])
        r = run_script(["ot2-agent.py", "health", "--unsafe-local"], {"OT2_BASE": robot.url})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["name"], "fixture-ot2")
        self.assertEqual([r[:2] for r in robot.requests], [("GET", "/health")])
        self.assertEqual(run_script(["ot2-agent.py", "bogus"], {}).returncode, 1)

    def test_no_script_keeps_a_second_transport(self):
        for name in ("ot2-executor.py", "ot2-agent.py", "ot2_local_guard.py"):
            with open(os.path.join(HERE, name), encoding="utf-8") as f:
                source = f.read()
            for word in ("curl", "wget", "urlopen", "http.client", "import socket", "import requests"):
                self.assertFalse(word in source, f"{name} still has a second transport: {word!r}")


class UploadTests(FixtureCase):
    """Protocol uploads go through the guard's transport as multipart, never a subprocess."""

    def upload(self, module, gateway, robot, filename="dye.py", content="print('dye')", env=None):
        snippet = f"print(m.execute_tool('ot2_protocol_upload', {{'filename': {filename!r}, 'content': {content!r}}}))"
        return run_script(["-c", started(module, gateway, robot, snippet)], env or {})

    def test_upload_is_multipart_to_the_robot_only(self):
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        for module in ("ot2-executor", "ot2-agent"):
            r = self.upload(module, gateway, robot)
            self.assertEqual(r.returncode, 0, r.stderr)
        posts = [(i, req) for i, req in enumerate(robot.requests) if req[0] == "POST"]
        self.assertEqual([req[1] for _, req in posts], ["/protocols", "/protocols"])
        for i, req in posts:
            headers = {k.lower(): v for k, v in req[2].items()}
            self.assertTrue(headers["content-type"].startswith("multipart/form-data; boundary="))
            self.assertEqual(headers["opentrons-version"], "2")
            self.assertIn(b'name="files"; filename="dye.py"', robot.bodies[i])
            self.assertIn(b"print('dye')", robot.bodies[i])
        self.assertEqual(gateway.requests, [])

    def test_unsafe_filenames_are_refused_before_anything_is_sent(self):
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(robot_responder)
        for name in ("../../etc/x.py", "a b.py", "", ".hidden.py", "x\ny.py"):
            r = self.upload("ot2-executor", gateway, robot, filename=name)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("refused filename", r.stdout)
        self.assertEqual(robot.requests, [])

    def test_an_upload_ignores_redirects_proxies_and_curl_config(self):
        public = self.fixture(silent_host)
        proxy = self.fixture(silent_host)
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(redirect_to(public))
        env = {name: proxy.url for name in PROXY_ENV_NAMES}
        env.update({"NO_PROXY": "", "no_proxy": ""})
        # A hostile curl config (round 2 uploaded with curl): follow redirects, no TLS checks.
        home = tempfile.mkdtemp()
        with open(os.path.join(home, ".curlrc"), "w") as f:
            f.write("location\ninsecure\n")
        env.update({"HOME": home, "CURL_HOME": home, "XDG_CONFIG_HOME": home})
        for module in ("ot2-executor", "ot2-agent"):
            r = self.upload(module, gateway, robot, env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([req[1] for req in robot.requests], ["/protocols", "/protocols"])
        self.assertEqual(public.requests, [], "an upload redirect was followed")
        self.assertEqual(proxy.requests, [], "an upload went through the proxy")

    def test_the_executor_does_not_follow_a_robot_redirect(self):
        public = self.fixture(robot_responder)
        gateway = self.fixture(idle_gateway)
        robot = self.fixture(redirect_to(public))
        r = run_script(["ot2-executor.py", "--unsafe-local"], {"PCC_API_KEY": "k", "PCC_BASE": gateway.url, "OT2_BASE": robot.url})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("Cannot reach OT-2", r.stdout)
        self.assertEqual(public.requests, [])
        self.assertEqual(gateway.requests, [])


@unittest.skipUnless(shutil.which("openssl"), "needs the openssl CLI to make a test certificate")
class TlsTests(FixtureCase):
    """A real handshake: an untrusted certificate fails before any HTTP request; PCC_CA_FILE trusts it."""

    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp()
        self.cert = os.path.join(self.tmp, "cert.pem")
        key = os.path.join(self.tmp, "key.pem")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
             "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", self.cert],
            check=True, capture_output=True,
        )
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.cert, key)
        self.gateway = self.fixture(idle_gateway, tls=context)
        self.robot = self.fixture(robot_responder)

    def fetch(self, env):
        snippet = f"print(json.dumps(m.http('GET', {self.gateway.url + '/x'!r})))"
        return run_script(["-c", started("ot2-executor", self.gateway, self.robot, snippet)], env)

    def test_an_untrusted_certificate_fails_the_handshake(self):
        r = self.fetch({})
        self.assertEqual(r.returncode, 0, r.stderr)
        status, body = json.loads(r.stdout)
        self.assertEqual(status, 0)
        self.assertIn("CERTIFICATE_VERIFY_FAILED", json.dumps(body))
        self.assertEqual(self.gateway.requests, [], "an HTTP request crossed a failed handshake")

    def test_pcc_ca_file_trusts_a_local_gateway_certificate(self):
        r = self.fetch({"PCC_CA_FILE": self.cert})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)[0], 200)
        self.assertEqual(self.gateway.paths(), ["/x"])


# ── Each approval runs once ─────────────────────────────────────────────────


class StopPolling(BaseException):
    """Raised by the fake sleep to end daemon_mode() after a set number of polls."""


def fresh_agent():
    """A new copy of ot2-agent.py, as a restarted process would load it: nothing in memory."""
    spec = importlib.util.spec_from_file_location("ot2_agent_restarted", os.path.join(HERE, "ot2-agent.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def approval(n, **fields):
    """An approved record shaped like a row of the gateway's pending_approvals table."""
    record = {
        "id": f"approval-{n}",
        "kernelId": "kernel-nanoclaw",
        "jobId": f"job-{n}",
        "submittedBy": "agent-test",
        "jobSummary": {"capabilityType": "liquid-handler", "parameters": {"task": f"mix plate {n}"}},
        "status": "approved",
    }
    record.update(fields)
    return record


def without(record, *names):
    return {key: value for key, value in record.items() if key not in names}


def approving_gateway(record):
    """A gateway that lists `record` as approved on every poll, consumes it exactly once
    (gateway WP-C semantics: 200 {"consumed": true} the first call, 409 after), and plays the
    Claude API under /anthropic."""
    consumed = {"done": False}

    def respond(method, path):
        if method == "POST" and path.startswith("/anthropic/v1/messages"):
            return 200, {}, {"stop_reason": "end_turn", "content": [{"type": "text", "text": "done"}]}
        if method == "POST" and "/api/operator/approvals/" in path and path.endswith("/consume"):
            if not consumed["done"]:
                consumed["done"] = True
                return 200, {}, {"consumed": True}
            return 409, {}, {"error": "approval_not_consumable", "status": "consumed"}
        if "/api/operator/approvals" in path:
            return 200, {}, {"approvals": [record]}
        if "/chat/pending" in path:
            return 200, {}, {"messages": []}
        return 200, {}, {}

    return respond


# One start of the agent, run in a child process: the real daemon loop for three polls, the Claude
# API played by the gateway fixture, and a sleep that ends the process by itself.
THREE_POLLS = """
import importlib, types
m = importlib.import_module('ot2-agent')
assert m.start_guard(['--unsafe-local'], {gateway!r}, 't', ot2_base={robot!r}) is None
m.ANTHROPIC_API = {gateway!r} + '/anthropic'
m.PCC_API_KEY = m.ANTHROPIC_API_KEY = 'k'
m.push_camera_frame = lambda: None
def sleep(seconds):
    sleep.polls += 1
    if sleep.polls >= 3:
        raise SystemExit(0)
sleep.polls = 0
m.time = types.SimpleNamespace(sleep=sleep)
m.daemon_mode()
"""


class DaemonLoopTestCase(FixtureCase):
    """Shared machinery for tests that drive ot2-agent.py's real daemon loop (or poll_once())
    against a temp state dir, with an accepted N4a start and a quieted logger. Holds no tests
    of its own; ApprovalRunsOnceTests and GatewayConsumeTests both build on it.
    """

    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Four levels down, so an id that climbed out of the state dir would still land inside self.tmp.
        self.state = os.path.join(self.tmp, "one", "two", "three", "handled")
        patched_env = mock.patch.dict(os.environ, {"OT2_AGENT_STATE_DIR": self.state})
        patched_env.start()
        self.addCleanup(patched_env.stop)
        logger = logging.getLogger("ot2-agent")
        self.addCleanup(logger.setLevel, logger.level)
        logger.setLevel(logging.CRITICAL + 1)  # quiet; drive() captures what the tests read
        # daemon_mode() needs an accepted start (N4a). Other tests leave the guard as they found it
        # or not, so start it here and put it back exactly as it was.
        import ot2_local_guard as g

        saved = (g.GUARD.mode, g.GUARD.pcc_base, g.GUARD.ot2_base, list(g.GUARD.external))
        self.addCleanup(self.restore_guard, g, saved)
        local = "http://127.0.0.1:9"
        self.assertIsNone(agent.start_guard(["--unsafe-local"], local, "run-once test", ot2_base=local))
        self.logs = []
        self.calls = []

    @staticmethod
    def restore_guard(g, saved):
        g.GUARD.mode, g.GUARD.pcc_base, g.GUARD.ot2_base, g.GUARD.external = saved

    def markers(self):
        return sorted(os.listdir(self.state)) if os.path.isdir(self.state) else []

    def drive(self, polls, module=None, on_turn=None, consume=None):
        """Run the real daemon loop for len(polls) polls; return the prompts it sent to the agent.

        polls[i] is what GET /api/operator/approvals returns on poll i. on_turn(messages), if given,
        runs at each dispatch, after the prompt is recorded (it may raise). self.logs gets what the
        agent logged.

        consume, if given, replaces the default gateway consume responder: consume(approval_id, n)
        -> (status, body), where n counts calls to POST .../approvals/<id>/consume for that
        approval_id, starting at 0, and may raise to simulate a transport failure. The default
        answers 200 {"consumed": True} the first time per approval id, then 409
        {"error": "approval_not_consumable"} after -- the real consume contract (gateway WP-C,
        #445). self.calls records every consume call and every dispatch, in order, as
        ("consume", raw_path, approval_id, status, body) or ("dispatch", prompt), so a test can
        assert that a consume call happened, and in what order, relative to a dispatch."""
        module = module or agent
        sent = []
        self.calls = []
        seen = {"polls": 0, "sleeps": 0}
        consume_counts = {}

        def default_consume(approval_id, n):
            if n == 0:
                return 200, {"consumed": True, "approvalId": approval_id}
            return 409, {"error": "approval_not_consumable", "status": "consumed"}

        responder = default_consume if consume is None else consume
        consume_prefix = "/api/operator/approvals/"
        consume_suffix = "/consume"

        def pcc(method, path, body=None):
            if method == "GET" and "/api/operator/approvals" in path:
                approvals = polls[seen["polls"]]
                seen["polls"] += 1
                return 200, {"approvals": approvals}
            if method == "GET" and "/api/ot2/chat/pending" in path:
                return 200, {"messages": []}
            if method == "POST" and path.startswith(consume_prefix) and path.endswith(consume_suffix):
                raw_id = path[len(consume_prefix):-len(consume_suffix)]
                approval_id = unquote(raw_id)
                n = consume_counts.get(approval_id, 0)
                consume_counts[approval_id] = n + 1
                try:
                    status, resp_body = responder(approval_id, n)
                except Exception:
                    self.calls.append(("consume-error", path, approval_id, n))
                    raise
                self.calls.append(("consume", path, approval_id, status, resp_body))
                return status, resp_body
            return 200, {}

        def run_agent_turn(messages, tools=None):
            sent.append(messages[0]["content"])
            self.calls.append(("dispatch", messages[0]["content"]))
            if on_turn:
                on_turn(messages)
            return messages

        def sleep(seconds):
            seen["sleeps"] += 1
            if seen["sleeps"] >= len(polls):
                raise StopPolling()

        with contextlib.ExitStack() as patches:
            patches.enter_context(mock.patch.object(module, "pcc", pcc))
            patches.enter_context(mock.patch.object(module, "run_agent_turn", run_agent_turn))
            patches.enter_context(mock.patch.object(module, "push_camera_frame", lambda: None))
            patches.enter_context(mock.patch.object(module, "time", types.SimpleNamespace(sleep=sleep)))
            with self.assertLogs("ot2-agent", level="INFO") as captured, self.assertRaises(StopPolling):
                module.daemon_mode()
        self.logs = captured.output
        self.assertEqual(seen["polls"], len(polls))
        return sent

    def fail_open(self, make_error):
        """Make os.open raise make_error() for files in the state dir; every other open is real."""
        real_open = os.open
        state = self.state

        def open_or_fail(path, flags, *args, **kwargs):
            if os.fspath(path).startswith(state):
                raise make_error()
            return real_open(path, flags, *args, **kwargs)

        return mock.patch.object(os, "open", open_or_fail)

    def error_lines(self):
        return [line for line in self.logs if line.startswith("ERROR")]


class ApprovalRunsOnceTests(DaemonLoopTestCase):
    """The daemon sends each approved job to the agent at most once (steward P0 #4698, readmodels #4558).

    GET /api/operator/approvals?status=approved lists every approval whose status is "approved", and
    no gateway route moves one out of that status, so the daemon sees the same record on every poll
    (every POLL_INTERVAL seconds). Unmarked, each poll sends the job to the agent again and the robot
    can run the same protocol again and again. These tests run the real daemon_mode() loop, the real
    claim and the real handle_job(); only the PCC calls, the agent turn, the camera and the sleep are
    replaced. (Since WP-C, a successful dispatch also needs the gateway to consume the approval; the
    default drive() responder grants that consume the first time it is asked for a given id, so these
    tests keep exercising exactly what they did before that layer existed. GatewayConsumeTests covers
    the consume outcomes themselves.)
    """

    # -- the bug: one approval, many polls ---------------------------------------------------

    def test_an_approval_that_stays_approved_is_sent_to_the_agent_once(self):
        sent = self.drive([[approval(1)]] * 5)
        self.assertEqual(len(sent), 1, f"one approval, five polls, {len(sent)} dispatches")
        self.assertIn("Job ID: job-1", sent[0])

    def test_a_restart_does_not_run_a_handled_approval_again(self):
        self.assertEqual(len(self.drive([[approval(1)]] * 3)), 1)
        restarted = fresh_agent()
        self.assertIsNot(restarted, agent)
        self.assertEqual(self.drive([[approval(1)]] * 3, module=restarted), [])

    def test_a_restarted_agent_process_does_not_call_claude_again(self):
        gateway = self.fixture(approving_gateway(approval(1)))
        robot = self.fixture(robot_responder)
        code = THREE_POLLS.format(gateway=gateway.url, robot=robot.url)

        def claude_calls():
            return [path for path in gateway.paths() if path.startswith("/anthropic/v1/messages")]

        first = run_script(["-c", code], {"OT2_AGENT_STATE_DIR": self.state})
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(len(claude_calls()), 1, f"three polls of one approval reached Claude {len(claude_calls())} times")
        second = run_script(["-c", code], {"OT2_AGENT_STATE_DIR": self.state})
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(len(claude_calls()), 1, "a restarted process ran the approval again")
        self.assertIn("already handled", second.stderr)

    def test_different_approvals_each_run_once(self):
        a, b = approval(1), approval(2)
        sent = self.drive([[a], [a, b], [b, a], [a, b], [a]])
        self.assertEqual(len(sent), 2, sent)
        self.assertEqual(sum("Job ID: job-1" in prompt for prompt in sent), 1)
        self.assertEqual(sum("Job ID: job-2" in prompt for prompt in sent), 1)
        self.assertEqual(len(self.markers()), 2)

    def test_a_reapproval_of_the_same_job_is_a_new_approval_and_runs_once_more(self):
        first, again = approval(1), approval(2, jobId="job-1")  # same job, new approval id
        sent = self.drive([[first], [first], [first, again], [first, again]])
        self.assertEqual(len(sent), 2, sent)
        self.assertTrue(all("Job ID: job-1" in prompt for prompt in sent))

    def test_a_job_that_crashes_the_agent_turn_is_not_run_again(self):
        def crash(messages):
            raise RuntimeError("the agent turn died")

        sent = self.drive([[approval(1)]] * 4, on_turn=crash)
        self.assertEqual(len(sent), 1, "a crashed run was repeated")
        self.assertTrue(any("Error in poll loop" in line for line in self.logs), "the crash never happened")

    def test_the_mark_exists_before_the_job_reaches_the_agent(self):
        markers_at_dispatch = []
        self.drive([[approval(1)]] * 2, on_turn=lambda messages: markers_at_dispatch.append(len(self.markers())))
        self.assertEqual(markers_at_dispatch, [1])

    def test_a_handled_approval_is_logged_once_not_on_every_poll(self):
        module = fresh_agent()  # a new process: its "already logged" memory is empty
        self.assertTrue(module.claim_job_once(approval(1)))
        sent = self.drive([[approval(1)]] * 6, module=module)
        self.assertEqual(sent, [])
        self.assertEqual(len([line for line in self.logs if "already handled" in line]), 1, self.logs)
        self.assertEqual(self.error_lines(), [])

    # -- the key: what identifies an approval -------------------------------------------------

    def test_an_approval_with_no_usable_id_is_never_run(self):
        good = approval(9)
        bad = [
            without(approval(1), "id", "jobId"),
            approval(2, id=None, jobId=None),
            approval(3, id="", jobId=""),
            approval(4, id="   ", jobId="  "),
            approval(5, id=["approval-5"]),  # present but no identity: it must not fall back to its jobId
            approval(6, id={"approval": 6}),
            approval(7, id=True),
            approval(8, id=1.5),
            "approval-10",  # not even a record
            None,
            12,
            ["approval-11"],
        ]
        sent = self.drive([bad + [good]] * 3)
        self.assertEqual(len(sent), 1, sent)  # a refusal does not stop the approvals after it
        self.assertIn("Job ID: job-9", sent[0])
        self.assertEqual(self.markers(), [hashlib.sha256(b"approval-9").hexdigest()])
        self.assertTrue(self.error_lines(), "refusals must be logged as errors")
        self.assertFalse(any("Error in poll loop" in line for line in self.logs), self.logs)

    def test_with_server_consume_off_the_key_is_the_approval_id_then_the_job_id(self):
        records = [without(approval(1), "id"), approval(2, id=""), approval(3, id=42)]
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": "off"}):
            sent = self.drive([records] * 3)
        self.assertEqual(len(sent), 3, sent)
        self.assertEqual(
            self.markers(),
            sorted(hashlib.sha256(key).hexdigest() for key in (b"job-1", b"job-2", b"42")),
        )

    def test_under_the_default_a_jobid_only_record_is_refused_but_an_integer_id_is_consumed(self):
        records = [without(approval(1), "id"), approval(2, id=""), approval(3, id=42)]
        sent = self.drive([records] * 3)
        # consume_on_gateway() can only consume a usable `id`. The two jobId-only records are
        # refused without a gateway call and never dispatched; the integer id is consumed and runs.
        self.assertEqual(len(sent), 1, sent)
        self.assertIn("Job ID: job-3", sent[0])
        consumed = [c for c in self.calls if c[0] == "consume"]
        self.assertEqual(len(consumed), 1, consumed)
        self.assertEqual(consumed[0][2], "42")  # consume_on_gateway sends str(id)
        # All three are claimed on this machine, and a "refused" outcome keeps the mark, so none
        # of the three is retried either -- same marker set as under OT2_AGENT_SERVER_CONSUME=off.
        self.assertEqual(
            self.markers(),
            sorted(hashlib.sha256(key).hexdigest() for key in (b"job-1", b"job-2", b"42")),
        )

    # -- the marker ---------------------------------------------------------------------------

    def test_the_marker_is_named_by_the_hash_of_the_key_and_holds_the_key_job_id_and_utc_time(self):
        self.assertTrue(agent.claim_job_once(approval(7)))
        digest = hashlib.sha256(b"approval-7").hexdigest()
        self.assertEqual(self.markers(), [digest])
        path = os.path.join(self.state, digest)
        with open(path, encoding="utf-8") as marker:
            content = json.load(marker)
        self.assertEqual(content["key"], "approval-7")
        self.assertEqual(content["jobId"], "job-7")
        self.assertRegex(content["claimedAt"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        if os.name == "posix":  # the umask may only remove bits
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode) & 0o077, 0, "the marker is not private")
            self.assertEqual(stat.S_IMODE(os.stat(self.state).st_mode) & 0o077, 0, "the state dir is not private")
        self.assertFalse(agent.claim_job_once(approval(7)))
        self.assertTrue(agent.claim_job_once({"id": "approval-8"}))  # no jobId: recorded as null
        with open(os.path.join(self.state, hashlib.sha256(b"approval-8").hexdigest()), encoding="utf-8") as marker:
            self.assertIsNone(json.load(marker)["jobId"])

    def test_a_hostile_id_cannot_place_a_marker_outside_the_state_dir(self):
        backslash = chr(92)
        hostile = [
            "../../escape",
            "../../../../escape-deep",
            "../handled-sibling",
            "..",
            ".",
            "a/b/c",
            os.path.join(self.tmp, "absolute-escape"),
            backslash.join(["..", "..", "windows-escape"]),
            "x" * 100000,
            "nul" + chr(0) + "byte",
            "lone" + chr(0xD800) + "surrogate",
            "caf" + chr(0xE9),
            "trailing space ",
            "-rf",
        ]
        for key in hostile:
            with self.subTest(key=key[:30]):
                self.assertTrue(agent.claim_job_once({"id": key, "jobId": "job-h"}))
                self.assertFalse(agent.claim_job_once({"id": key, "jobId": "job-h"}), "claimed twice")
        names = self.markers()
        self.assertEqual(len(names), len(hostile), "one marker per distinct id")
        for name in names:
            self.assertRegex(name, r"^[0-9a-f]{64}$")
            self.assertLess(os.path.getsize(os.path.join(self.state, name)), 4096, "a huge id made a huge marker")
        ancestors = {self.tmp, os.path.join(self.tmp, "one"), os.path.join(self.tmp, "one", "two"),
                     os.path.join(self.tmp, "one", "two", "three"), self.state}
        for root, dirs, files in os.walk(self.tmp):
            self.assertIn(root, ancestors, f"a directory was created outside the state dir: {root}")
            if root != self.state:
                self.assertEqual(files, [], f"a file was created outside the state dir: {root}")

    def test_a_hostile_id_runs_once_through_the_daemon(self):
        sent = self.drive([[approval(1, id="../../escape")]] * 3)
        self.assertEqual(len(sent), 1)
        self.assertEqual(self.markers(), [hashlib.sha256(b"../../escape").hexdigest()])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "one", "two", "escape")))

    def test_two_threads_claiming_the_same_approval_get_exactly_one_true(self):
        threads_per_round = 8
        for round_no in range(25):
            record = approval(round_no)
            barrier = threading.Barrier(threads_per_round)
            results = []

            def claim():
                barrier.wait(timeout=10)
                results.append(agent.claim_job_once(record))

            threads = [threading.Thread(target=claim) for _ in range(threads_per_round)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
            self.assertEqual(results.count(True), 1, f"round {round_no}: {results}")
            self.assertEqual(results.count(False), threads_per_round - 1, f"round {round_no}: {results}")
        self.assertEqual(len(self.markers()), 25)

    # -- failing closed -----------------------------------------------------------------------

    def test_a_marker_that_cannot_be_created_means_the_job_does_not_run(self):
        errors = {
            "permission denied": lambda: PermissionError(errno.EACCES, "Permission denied"),
            "disk full": lambda: OSError(errno.ENOSPC, "No space left on device"),
            "read-only file system": lambda: OSError(errno.EROFS, "Read-only file system"),
            "too many open files": lambda: OSError(errno.EMFILE, "Too many open files"),
        }
        for label, make_error in errors.items():
            with self.subTest(label), self.fail_open(make_error):
                self.assertEqual(self.drive([[approval(1)]] * 3), [])
                self.assertEqual(self.markers(), [])
                self.assertTrue(self.error_lines(), "a failure to mark must be logged as an error")
                self.assertFalse(any("Error in poll loop" in line for line in self.logs), self.logs)

    def test_an_approval_that_could_not_be_marked_runs_once_when_the_directory_is_fixed(self):
        with self.fail_open(lambda: OSError(errno.ENOSPC, "No space left on device")):
            self.assertEqual(self.drive([[approval(1)]] * 2), [])
        self.assertEqual(len(self.drive([[approval(1)]] * 3)), 1)

    def test_a_state_path_that_cannot_be_a_directory_means_the_job_does_not_run(self):
        # Breaking the path works even as root, where a chmod would not. The FileExistsError that
        # makedirs raises for a file is not "already handled".
        blocker = os.path.join(self.tmp, "blocker")
        with open(blocker, "w") as handle:
            handle.write("not a directory")
        for state in (blocker, os.path.join(blocker, "handled")):
            with self.subTest(state=state), mock.patch.dict(os.environ, {"OT2_AGENT_STATE_DIR": state}):
                self.assertEqual(self.drive([[approval(1)]] * 3), [])
                self.assertTrue(self.error_lines())
                self.assertFalse(any("already handled" in line for line in self.logs), self.logs)
                self.assertFalse(any("Error in poll loop" in line for line in self.logs), self.logs)
        with open(blocker) as handle:
            self.assertEqual(handle.read(), "not a directory")

    @unittest.skipUnless(os.name == "posix" and os.geteuid() != 0, "needs a non-root POSIX user for chmod to bite")
    def test_a_read_only_state_dir_means_the_job_does_not_run(self):
        os.makedirs(self.state)
        os.chmod(self.state, 0o500)
        self.addCleanup(os.chmod, self.state, 0o700)
        self.assertEqual(self.drive([[approval(1)]] * 3), [])
        self.assertTrue(self.error_lines())
        self.assertEqual(os.listdir(self.state), [])

    def test_a_marker_that_cannot_be_written_still_blocks_the_job(self):
        # Once the marker exists the approval never runs again, whatever fails after that:
        # the cost is a lost run, never a repeated one.
        with mock.patch.object(os, "fsync", side_effect=OSError(errno.EIO, "Input/output error")):
            self.assertEqual(self.drive([[approval(1)]] * 2), [])
        self.assertTrue(self.error_lines())
        self.assertEqual(len(self.markers()), 1)
        self.assertEqual(self.drive([[approval(1)]] * 2), [], "the run came back once the disk recovered")

    # -- where the markers live -----------------------------------------------------------------

    def test_the_default_state_dir_is_per_user(self):
        home = os.path.join(self.tmp, "home")
        with mock.patch.dict(os.environ, {"HOME": home, "USERPROFILE": home}):
            os.environ.pop("OT2_AGENT_STATE_DIR")
            expected = os.path.join(home, ".pcc", "ot2-agent", "handled")
            self.assertEqual(agent.handled_dir(), expected)
            self.assertTrue(agent.claim_job_once(approval(1)))
            self.assertFalse(agent.claim_job_once(approval(1)))
        self.assertEqual(os.listdir(expected), [hashlib.sha256(b"approval-1").hexdigest()])

    def test_an_unresolvable_home_fails_closed_instead_of_writing_into_the_working_directory(self):
        with mock.patch.dict(os.environ, {}):
            os.environ.pop("OT2_AGENT_STATE_DIR")
            with mock.patch.object(os.path, "expanduser", lambda path: path):  # no home directory
                self.assertFalse(agent.claim_job_once(approval(1)))
        self.assertFalse(os.path.exists("~"), "a directory named ~ was made in the working directory")


class GatewayConsumeTests(DaemonLoopTestCase):
    """The gateway's consume route is the second layer: a local claim is necessary but not
    sufficient (steward P0 #4698; gateway WP-C, PR #445). These drive the same real
    daemon_mode()/poll_once() loop as ApprovalRunsOnceTests, through the same drive(), but
    exercise consume_on_gateway()'s outcomes -- consumed, refused and retry -- instead of
    leaving every approval consumed on the first ask.
    """

    def test_200_consumed_dispatches_once_and_consume_happens_before_dispatch_with_a_quoted_id(self):
        approval_id = "gw 200 ok?"  # a space and a question mark: proves the path is quoted
        sent = self.drive([[approval(1, id=approval_id)]] * 3)
        self.assertEqual(len(sent), 1, sent)
        self.assertEqual(
            [c[0] for c in self.calls], ["consume", "dispatch"],
            "consume must happen before the dispatch it gates",
        )
        _, raw_path, seen_id, status, resp_body = self.calls[0]
        self.assertEqual(seen_id, approval_id)
        self.assertEqual(status, 200)
        self.assertEqual(resp_body, {"consumed": True, "approvalId": approval_id})
        self.assertEqual(raw_path, "/api/operator/approvals/" + quote(approval_id, safe="") + "/consume")
        self.assertNotIn(" ", raw_path)
        self.assertNotIn("?", raw_path)
        self.assertEqual(unquote(raw_path), "/api/operator/approvals/" + approval_id + "/consume")

    def test_409_approval_not_consumable_never_dispatches_and_consume_is_asked_once(self):
        def refuse(approval_id, n):
            return 409, {"error": "approval_not_consumable", "status": "consumed"}

        sent = self.drive([[approval(2, id="gw-409-conflict")]] * 3, consume=refuse)
        self.assertEqual(sent, [])
        self.assertEqual(len([c for c in self.calls if c[0] == "consume"]), 1)
        self.assertEqual(self.markers(), [hashlib.sha256(b"gw-409-conflict").hexdigest()])

    def test_409_kernel_emergency_stopped_never_dispatches_and_logs_a_warning(self):
        def estop(approval_id, n):
            return 409, {"error": "kernel_emergency_stopped"}

        sent = self.drive([[approval(3, id="gw-409-estop")]] * 3, consume=estop)
        self.assertEqual(sent, [])
        self.assertEqual(len([c for c in self.calls if c[0] == "consume"]), 1)
        warnings = [line for line in self.logs if line.startswith("WARNING")]
        self.assertTrue(any("emergency stop" in line for line in warnings), self.logs)

    def test_404_is_asked_every_poll_releases_the_marker_and_logs_one_error_mentioning_the_env_var(self):
        def not_found(approval_id, n):
            return 404, {}

        sent = self.drive([[approval(4, id="gw-404")]] * 3, consume=not_found)
        self.assertEqual(sent, [])
        self.assertEqual(len([c for c in self.calls if c[0] == "consume"]), 3, "asked on every poll")
        self.assertEqual(self.markers(), [], "the marker must not survive a retry outcome")
        errors = self.error_lines()
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("OT2_AGENT_SERVER_CONSUME", errors[0])

    def test_503_then_200_dispatches_once_on_the_second_poll(self):
        def flaky(approval_id, n):
            if n == 0:
                return 503, {"error": "unavailable"}
            return 200, {"consumed": True}

        sent = self.drive([[approval(5, id="gw-503-then-200")]] * 2, consume=flaky)
        self.assertEqual(len(sent), 1, sent)
        consumed = [c for c in self.calls if c[0] == "consume"]
        self.assertEqual([c[3] for c in consumed], [503, 200])

    def test_a_transport_error_then_200_dispatches_once_on_the_second_poll(self):
        def flaky(approval_id, n):
            if n == 0:
                raise OSError("network down")
            return 200, {"consumed": True}

        sent = self.drive([[approval(6, id="gw-raises-then-200")]] * 2, consume=flaky)
        self.assertEqual(len(sent), 1, sent)
        self.assertTrue(
            any("Could not ask the gateway" in line for line in self.error_lines()), self.logs,
        )

    def test_200_without_consumed_true_is_not_dispatched_and_is_released(self):
        # #499 r1 MEDIUM: non-dictionary bodies too (a string, a list, None).
        bodies = ({}, {"consumed": "yes"}, "consumed", ["consumed", True], None)
        for i, body in enumerate(bodies):
            with self.subTest(body=body):
                approval_id = "gw-200-notrue-{}".format(i)

                def not_true(_approval_id, _n, body=body):
                    return 200, body

                sent = self.drive([[approval(7, id=approval_id)]] * 2, consume=not_true)
                self.assertEqual(sent, [])
                self.assertEqual(self.markers(), [], "a 200 without consumed:true must release the mark")

    def test_server_consume_off_never_calls_the_gateway_and_warns_at_start(self):
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": "off"}):
            sent = self.drive([[approval(8, id="gw-off")]] * 2)
        self.assertEqual(len(sent), 1, sent)
        self.assertEqual([c for c in self.calls if c[0] == "consume"], [])
        self.assertTrue(
            any("NOT enforced" in line for line in self.logs if line.startswith("WARNING")), self.logs,
        )

    def test_server_consume_off_is_case_and_whitespace_insensitive(self):
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": " OFF "}):
            sent = self.drive([[approval(9, id="gw-off-padded")]] * 2)
        self.assertEqual(len(sent), 1, sent)
        self.assertEqual([c for c in self.calls if c[0] == "consume"], [])

    def test_an_invalid_server_consume_value_behaves_as_required_and_logs_once(self):
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": "maybe"}):
            sent = self.drive([[approval(10, id="gw-invalid-mode")]] * 2)
        self.assertEqual(len(sent), 1, sent)
        self.assertEqual(len([c for c in self.calls if c[0] == "consume"]), 1)
        mode_errors = [line for line in self.error_lines() if "OT2_AGENT_SERVER_CONSUME" in line]
        self.assertEqual(len(mode_errors), 1, self.logs)

    def test_a_release_failure_after_a_retry_leaves_the_approval_blocked(self):
        approval_id = "gw-release-fails"
        digest = hashlib.sha256(approval_id.encode("utf-8")).hexdigest()
        marker = os.path.join(self.state, digest)
        real_remove = os.remove

        def remove_or_fail(path, *args, **kwargs):
            if path == marker:
                raise PermissionError("cannot remove marker")
            return real_remove(path, *args, **kwargs)

        def unavailable(_approval_id, _n):
            return 503, {"error": "unavailable"}

        with mock.patch.object(os, "remove", remove_or_fail):
            sent = self.drive([[approval(11, id=approval_id)]] * 3, consume=unavailable)
        self.assertEqual(sent, [])
        self.assertEqual(
            len([c for c in self.calls if c[0] == "consume"]), 1,
            "a marker that could not be released must block later polls from asking again",
        )
        self.assertEqual(self.markers(), [digest])

    def test_a_restarted_daemon_does_not_consume_an_already_claimed_approval_again(self):
        approval_id = "gw-restart"
        first_sent = self.drive([[approval(12, id=approval_id)]] * 2)
        self.assertEqual(len(first_sent), 1, first_sent)
        restarted = fresh_agent()
        second_sent = self.drive([[approval(12, id=approval_id)]] * 2, module=restarted)
        self.assertEqual(second_sent, [])
        self.assertEqual([c for c in self.calls if c[0] == "consume"], [])


if __name__ == "__main__":
    unittest.main()


# One claim of one approval in a separate process, released together with its twin by a "go"
# file: two live daemons racing on one state directory (#499 r1 MEDIUM).
RACE_CLAIM = r"""
import importlib.util, os, sys, time
sys.path.insert(0, {here!r})
spec = importlib.util.spec_from_file_location("ot2_agent_race", os.path.join({here!r}, "ot2-agent.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
deadline = time.time() + 30
while not os.path.exists({go!r}):
    if time.time() > deadline:
        sys.exit(3)
    time.sleep(0.001)
print("CLAIM", m.claim_job_once({{"id": "race-1", "jobId": "job-race"}}))
"""


class MarkDurabilityTests(DaemonLoopTestCase):
    """#499 r1 CRITICAL: a mark that cannot be made durable must not let a job run when the mark is
    the only record (OT2_AGENT_SERVER_CONSUME=off). File fsync alone does not make the directory
    entry durable, and new state directories must be synced into their parents."""

    @staticmethod
    def _directory_fsync_fails():
        """os.fsync succeeds on files and raises EIO on directories."""
        real_fsync = os.fsync

        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EIO, "injected EIO on a directory fsync")
            return real_fsync(fd)

        return mock.patch("os.fsync", fsync)

    def test_with_consume_off_a_mark_that_cannot_be_made_durable_is_not_dispatched(self):
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": "off"}), self._directory_fsync_fails():
            sent = self.drive([[approval(20, id="dur-1")]] * 2)
        self.assertEqual(sent, [])
        self.assertEqual(len(self.markers()), 1, "the mark is kept: it still blocks this machine")
        self.assertTrue(any("durable" in line for line in self.logs if line.startswith("ERROR")), self.logs)

    def test_with_consume_off_a_lost_mark_after_a_power_cut_still_runs_the_approval_at_most_once(self):
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": "off"}):
            with self._directory_fsync_fails():
                first = self.drive([[approval(21, id="dur-2")]])
            # The power cut: the mark's directory entry never reached the disk.
            for name in self.markers():
                os.remove(os.path.join(self.state, name))
            restarted = fresh_agent()
            second = self.drive([[approval(21, id="dur-2")]] * 2, module=restarted)
        self.assertEqual(len(first) + len(second), 1, (first, second))

    def test_with_consume_required_a_non_durable_mark_still_runs_once_because_the_gateway_is_the_record(self):
        with self._directory_fsync_fails():
            sent = self.drive([[approval(22, id="dur-3")]] * 2)
        self.assertEqual(len(sent), 1, sent)
        self.assertTrue(
            any("cannot be made durable" in line for line in self.logs if line.startswith("WARNING")), self.logs,
        )

    @unittest.skipUnless(os.path.isdir("/proc/self/fd"), "needs /proc/self/fd to name a directory fd")
    def test_every_new_state_directory_is_synced_into_its_parent(self):
        synced = []
        real_fsync = os.fsync

        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                synced.append(os.path.realpath(os.readlink("/proc/self/fd/%d" % fd)))
            return real_fsync(fd)

        self.assertFalse(os.path.exists(self.state))
        with mock.patch.dict(os.environ, {"OT2_AGENT_SERVER_CONSUME": "off"}), mock.patch("os.fsync", fsync):
            sent = self.drive([[approval(23, id="dur-4")]])
        self.assertEqual(len(sent), 1, sent)
        state = os.path.realpath(self.state)
        expected = {os.path.dirname(state), state}
        walk = os.path.dirname(state)
        while walk != os.path.realpath(self.tmp):
            walk = os.path.dirname(walk)
            expected.add(walk)
        missing = expected - set(synced)
        self.assertEqual(missing, set(), "directories never synced: {}".format(sorted(missing)))

    def test_two_processes_racing_on_one_approval_claim_it_exactly_once(self):
        go = os.path.join(self.tmp, "go")
        script = RACE_CLAIM.format(here=HERE, go=go)
        env = dict(os.environ, OT2_AGENT_STATE_DIR=self.state)
        procs = [
            subprocess.Popen([sys.executable, "-c", script], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for _ in range(2)
        ]
        time.sleep(0.5)  # both are waiting on the go file
        with open(go, "w"):
            pass
        outputs = []
        for proc in procs:
            out, _err = proc.communicate(timeout=60)
            self.assertEqual(proc.returncode, 0, out)
            outputs.append(out.decode("ascii", "replace").strip().splitlines()[-1])
        self.assertEqual(sorted(outputs), ["CLAIM False", "CLAIM True"], outputs)
