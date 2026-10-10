"""ChatGPT r3 finding 1 (MEDIUM, pcc-node 0.1.1 r4): a refused daemon registration ends `pcc-node
start` with a nonzero exit, and "Node running" is printed only once the daemon is up.

At e7e6f821 `start` registered the kernel, printed "Node running", and then called run_daemon(),
which registered the kernel again. When that second registration was refused, the daemon removed
its PID and state files and returned normally, so the command exited 0 after claiming a node that
never ran. Now run_daemon() re-raises the refusal after the same cleanup (a direct caller cannot
mistake a daemon that never ran for one that stopped), and it calls ``on_running`` only after its
own registration succeeded and its first heartbeat went out; `start` prints the banner from there.

Both registrations here go through the real register_kernel(), pcc_request() and gateway transport
to a loopback gateway; only the gateway's answers are scripted.
"""

import json
import http.client
import io
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node import daemon
from pcc_node.cli import main
from pcc_node.config import NodeConfig
from pcc_node.register import RegistrationError

KERNELS = "/api/kernels"
BANNER = "Node running"


class Gateway:
    """A loopback PCC gateway. Each POST /api/kernels takes the next scripted answer; any other
    request (a heartbeat) is answered 200. Every request is recorded as (method, path)."""

    def __init__(self, *kernel_answers):
        self.kernel_answers = list(kernel_answers)
        self.requests = []
        gw = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                gw.requests.append((self.command, self.path))
                if self.command == "POST" and self.path == KERNELS:
                    code, answer = gw.kernel_answers.pop(0)
                else:
                    code, answer = 200, {}
                raw = json.dumps(answer).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PATCH = _serve

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def paths(self):
        return [path for _, path in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def surroundings(tmp_path, monkeypatch):
    """run_daemon's surroundings, isolated: its PID and state files live under tmp_path; no key file,
    network scan, camera, UI server or real signal handler is touched; and its first pause between
    loop passes stops it as a SIGTERM would. Returns the PID and state file paths."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    pid_file, state_file = str(tmp_path / "pcc-node.pid"), str(tmp_path / "pcc-node-state.json")
    monkeypatch.setattr(daemon, "PID_FILE", pid_file)
    monkeypatch.setattr(daemon, "STATE_FILE", state_file)
    monkeypatch.setattr(daemon, "load_or_create_keys", lambda *a, **k: ("ab" * 32, "cd" * 32))
    monkeypatch.setattr(daemon, "discover_network", lambda timeout=0.5: [])
    monkeypatch.setattr(daemon, "detect_camera_device", lambda: None)
    monkeypatch.setattr("pcc_node.ui_server.start_ui_server", lambda **kwargs: None)
    handlers = {}
    monkeypatch.setattr(daemon.signal, "signal", lambda signum, handler: handlers.__setitem__(signum, handler))

    def pause(_seconds):
        handlers[signal.SIGTERM](signal.SIGTERM, None)  # the operator stops the node

    monkeypatch.setattr(daemon.time, "sleep", pause)
    return pid_file, state_file


def _config(gateway):
    return NodeConfig(kernel_id="k1", kernel_name="bench", pcc_base=gateway.url, pcc_api_key="k",
                      devices=[], poll_interval=1, diagnostics_mode="off")


def _start(tmp_path, gateway):
    """`pcc-node start` against the loopback gateway, with the real kernel registration."""
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli._interactive", return_value=False), \
         mock.patch("pcc_node.cli.detect_all", return_value=[]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 32, "cd" * 32)), \
         mock.patch("pcc_node.cli.register_signing_key", return_value=(200, {})):
        return CliRunner().invoke(main, ["start", "-c", str(tmp_path / "node-config.json"), "--api-key", "k",
                                         "--pcc-base", gateway.url], env={"PCC_BASE": ""})


def test_start_exits_nonzero_when_the_daemons_own_registration_is_refused(surroundings, tmp_path):
    pid_file, state_file = surroundings
    with open(state_file, "w") as f:  # a stale state file from an earlier run
        json.dump({"kernel_id": "k-old", "pid": os.getpid()}, f)
    gateway = Gateway((201, {"id": "k1"}), (401, {"error": "unauthorized"}))
    try:
        result = _start(tmp_path, gateway)
    finally:
        gateway.close()
    assert result.exit_code == 1, result.output
    assert BANNER not in result.output and "Press Ctrl+C" not in result.output, result.output
    assert "Registration failed (HTTP 401)" in result.output, result.output
    assert gateway.paths() == [KERNELS, KERNELS]  # both registrations, then no heartbeat
    assert not os.path.exists(pid_file) and not os.path.exists(state_file)


def test_start_says_the_node_is_running_once_the_daemon_is_up(surroundings, tmp_path):
    pid_file, state_file = surroundings
    gateway = Gateway((201, {"id": "k1"}), (200, {"id": "k1"}))
    try:
        result = _start(tmp_path, gateway)
    finally:
        gateway.close()
    assert result.exit_code == 0, result.output
    assert BANNER in result.output and "does not take jobs" in result.output, result.output
    assert gateway.paths()[:3] == [KERNELS, KERNELS, "/api/operator/heartbeat"]
    assert not os.path.exists(pid_file) and not os.path.exists(state_file)  # stopped cleanly


def test_a_direct_caller_gets_the_refusal_raised_after_the_cleanup(surroundings):
    # A caller that is not `pcc-node start` (no on_running) must not see a normal return either.
    pid_file, state_file = surroundings
    with open(state_file, "w") as f:
        json.dump({"kernel_id": "k-old", "pid": os.getpid()}, f)
    gateway = Gateway((503, {"error": "unavailable"}))
    try:
        with pytest.raises(RegistrationError) as refused:
            daemon.run_daemon(_config(gateway))
    finally:
        gateway.close()
    assert refused.value.status == 503
    assert gateway.paths() == [KERNELS]  # no heartbeat: the kernel was never put online
    assert not os.path.exists(pid_file) and not os.path.exists(state_file)


def test_a_refused_daemon_never_reports_running(surroundings):
    running = []
    gateway = Gateway((401, {"error": "unauthorized"}))
    try:
        with pytest.raises(RegistrationError):
            daemon.run_daemon(_config(gateway), on_running=lambda: running.append(True))
    finally:
        gateway.close()
    assert running == []


def test_the_daemon_reports_running_only_after_its_registration_and_first_heartbeat(surroundings):
    seen = []
    gateway = Gateway((201, {"id": "k1"}))
    try:
        daemon.run_daemon(_config(gateway), on_running=lambda: seen.append(gateway.paths()))
    finally:
        gateway.close()
    assert seen == [[KERNELS, "/api/operator/heartbeat"]], seen


def test_a_banner_that_cannot_be_printed_does_not_stop_the_daemon(surroundings):
    pid_file, state_file = surroundings

    def broken_terminal():
        raise BrokenPipeError("stdout is gone")

    gateway = Gateway((201, {"id": "k1"}))
    try:
        daemon.run_daemon(_config(gateway), on_running=broken_terminal)
    finally:
        gateway.close()
    # The loop ran and the daemon stopped cleanly: an offline heartbeat, no PID or state left.
    assert gateway.paths()[-1] == "/api/operator/heartbeat"
    assert not os.path.exists(pid_file) and not os.path.exists(state_file)


class WireGateway:
    """Real urllib/HTTP parsing over scripted bytes; no sandbox socket is needed."""

    url = "http://127.0.0.1:3200"

    def __init__(self, monkeypatch, *answers):
        from pcc_node import http_util

        self.answers = list(answers)
        self.requests = []
        gateway = self
        real_open = http_util._GATEWAY_OPENER.open

        class Socket:
            def makefile(self, *args):
                raw = gateway.answers.pop(0) if gateway.answers else _wire_answer(200, b"{}")
                return io.BytesIO(raw)

            def sendall(self, data):
                pass

            def close(self):
                pass

        def connect(conn):
            conn.sock = Socket()

        def tracked_open(req, **kwargs):
            gateway.requests.append((req.get_method(), req.selector))
            return real_open(req, **kwargs)

        monkeypatch.setattr(http.client.HTTPConnection, "connect", connect)
        monkeypatch.setattr(http_util._GATEWAY_OPENER, "open", tracked_open)

    def paths(self):
        return [path for _, path in self.requests]


def _wire_answer(status, body, length=None):
    return (f"HTTP/1.1 {status} Answer\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(body) if length is None else length}\r\n"
            "Connection: close\r\n\r\n").encode() + body


@pytest.mark.parametrize("phase", ["first", "daemon"])
@pytest.mark.parametrize("answer, expected_status", [
    pytest.param(_wire_answer(401, b'{"error": "denied"}', 100), 0, id="truncated-refusal"),
    pytest.param(_wire_answer(201, b'{"id":"k1"}', 100), 0, id="truncated-success"),
    pytest.param(b"not an HTTP status\r\n\r\n", 0, id="malformed-status"),
    pytest.param(_wire_answer(201, b'{"id":'), 0, id="malformed-json"),
    pytest.param(_wire_answer(201, b'[]'), 0, id="unexpected-array"),
    pytest.param(_wire_answer(201, b'null'), 0, id="unexpected-null"),
])
def test_malformed_registration_stops_start(surroundings, tmp_path, monkeypatch,
                                           phase, answer, expected_status):
    pid_file, state_file = surroundings
    with open(state_file, "w") as f:
        json.dump({"kernel_id": "k-old", "pid": os.getpid()}, f)
    answers = ([_wire_answer(201, b'{"id":"k1"}')] if phase == "daemon" else []) + [answer]
    gateway = WireGateway(monkeypatch, *answers)
    running = []
    real_daemon = daemon.run_daemon

    def observed_daemon(config, *, on_running):
        def callback():
            running.append(True)
            on_running()
        return real_daemon(config, on_running=callback)

    monkeypatch.setattr("pcc_node.cli.run_daemon", observed_daemon)
    result = _start(tmp_path, gateway)
    assert result.exit_code == 1, result.output
    assert BANNER not in result.output and "Press Ctrl+C" not in result.output, result.output
    assert f"Registration failed (HTTP {expected_status})" in result.output, result.output
    assert running == []
    assert gateway.paths() == [KERNELS] * (2 if phase == "daemon" else 1)
    assert not os.path.exists(pid_file)
    if phase == "daemon":
        assert not os.path.exists(state_file)


def test_unexpected_registration_exception_cleans_up_and_never_runs(surroundings, monkeypatch):
    pid_file, state_file = surroundings
    with open(state_file, "w") as f:
        json.dump({"kernel_id": "k-old", "pid": os.getpid()}, f)
    register = mock.Mock(side_effect=RuntimeError("unexpected registration failure"))
    client = mock.Mock()
    monkeypatch.setattr(daemon, "register_kernel", register)
    monkeypatch.setattr(daemon, "PCCGatewayClient", client)
    running = []
    with pytest.raises(RegistrationError) as refused:
        daemon.run_daemon(NodeConfig(devices=[{"id": "d1"}]),
                          on_running=lambda: running.append(True))
    assert refused.value.status == 0
    assert running == []
    client.assert_not_called()
    assert not os.path.exists(pid_file) and not os.path.exists(state_file)


def test_complete_wire_registration_starts_normally(surroundings, tmp_path, monkeypatch):
    gateway = WireGateway(monkeypatch, _wire_answer(201, b'{"id":"k1"}'),
                          _wire_answer(200, b'{"id":"k1"}'))
    result = _start(tmp_path, gateway)
    assert result.exit_code == 0, result.output
    assert BANNER in result.output
    assert gateway.paths()[:3] == [KERNELS, KERNELS, "/api/operator/heartbeat"]
