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
"""

import http.server
import importlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
