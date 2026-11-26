"""The operating command composes the real loop, stop reader, and grant gate."""

import ast
import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace

from click.testing import CliRunner

from pcc_node import cli
from pcc_node.operating import devicelock, operate, runtime
from pcc_node.ws_client import PCCGatewayClient
from tests.test_operating_reconcile import Gateway, binding, keys


class StopAfterPasses:
    def __init__(self, clock, passes=4):
        self.clock = clock
        self.passes = passes
        self.stopped = False
        self.waits = []

    def is_set(self):
        return self.stopped

    def set(self):
        self.stopped = True

    def wait(self, seconds):
        self.waits.append(seconds)
        self.clock[0] += seconds
        self.passes -= 1
        if self.passes <= 0:
            self.set()
        return self.stopped


def operate_run(tmp_path, monkeypatch, *, answers=None, state="done", gateway=None,
                device_request=None, watch_wait=None, passes=4):
    monkeypatch.setattr(cli, "_setup_logging", lambda verbose: None)
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    monkeypatch.setattr(devicelock, "read_device_identity", lambda *args, **kwargs: "serial-1")
    now = [100.0]
    event = StopAfterPasses(now, passes=passes)
    gateway = gateway if gateway is not None else Gateway()
    if answers is not None:
        gateway.polls = list(answers) * 12
    device_log, heartbeats, messages = [], [], []

    def request(method, url, body=None, **kwargs):
        device_log.append((method, url, body, kwargs))
        if device_request is not None:
            return device_request(method, url, body, **kwargs)
        if url.endswith("/status"):
            return runtime._Answer(200, {"state": "idle"}, True)
        if method == "POST":
            return runtime._Answer(201, {"id": "run-1"}, True)
        return runtime._Answer(200, {"status": state}, True)

    def post(self, path, payload):
        heartbeats.append((path, payload))
        return 200, {}

    monkeypatch.setattr(runtime, "_request", request)
    monkeypatch.setattr(PCCGatewayClient, "_post", post)
    client = PCCGatewayClient("https://gateway.example", "key-1", "kernel-1")
    code = operate.run(binding(), "https://gateway.example", "key-1", "kernel-1", *keys(), event,
                       request=gateway, heartbeat_client=client, clock=lambda: now[0], unix_clock=lambda: 1000.0,
                       watch_wait=watch_wait, message=messages.append)
    return SimpleNamespace(code=code, gateway=gateway, device_log=device_log, heartbeats=heartbeats,
                           event=event, messages=messages,
                           claims=lambda: [entry for entry in gateway.calls if entry[1].endswith("/claim")])


def stopped_poll(tmp_path, monkeypatch, body):
    result = operate_run(tmp_path, monkeypatch, answers=[(200, body)])
    assert result.code == 0 and not result.claims() and result.device_log == []
    assert len(result.event.waits) == 4 and all(seconds == 5.0 for seconds in result.event.waits)
    clear = operate_run(tmp_path, monkeypatch)
    assert clear.code == 0 and len(clear.claims()) == 1
    assert any(method == "POST" and url.endswith("/runs") for method, url, *_ in clear.device_log)


def queued_body(state):
    return {"emergencyStop": state, "jobs": [{"id": "job-1", "capabilityType": "lab.absorbance"}]}


def test_GS1_stopped_poll_sends_no_claim(tmp_path, monkeypatch):
    stopped_poll(tmp_path, monkeypatch, queued_body("stopped"))


def test_GS1_unavailable_poll_sends_no_claim(tmp_path, monkeypatch):
    stopped_poll(tmp_path, monkeypatch, queued_body("unavailable"))


def test_GS1_absent_field_sends_no_claim(tmp_path, monkeypatch):
    stopped_poll(tmp_path, monkeypatch, {"jobs": [{"id": "job-1", "capabilityType": "lab.absorbance"}]})


def test_GS1_malformed_field_sends_no_claim(tmp_path, monkeypatch):
    stopped_poll(tmp_path, monkeypatch, queued_body(["clear"]))


def test_GS1_claim_poll_stop_after_fresh_clear_sends_no_claim(tmp_path, monkeypatch):
    gateway = Gateway()
    gateway.polls = [(200, queued_body("clear"))] + [(200, queued_body("stopped"))] * 12
    result = operate_run(tmp_path, monkeypatch, gateway=gateway)
    assert result.code == 0 and not result.claims()
    assert result.device_log and all(method == "GET" and url.endswith("/status")
                                     for method, url, *_ in result.device_log)
    assert len([entry for entry in gateway.calls if entry[1].startswith("/api/operator/jobs?")]) >= 2
    clear = operate_run(tmp_path, monkeypatch)
    assert clear.code == 0 and len(clear.claims()) == 1


def test_GS1_stop_file_sends_no_claim(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "_setup_logging", lambda verbose: None)
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    devicelock.write_stop()
    result = operate_run(tmp_path, monkeypatch)
    assert result.code == 0 and not result.claims() and result.device_log == []
    devicelock.clear_stop()
    clear = operate_run(tmp_path, monkeypatch)
    assert clear.code == 0 and len(clear.claims()) == 1


def test_GS1_open_breaker_sends_no_claim(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "_setup_logging", lambda verbose: None)
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    devicelock.write_breaker("serial-1")
    result = operate_run(tmp_path, monkeypatch)
    assert result.code == 0 and not result.claims() and result.device_log == []
    assert result.heartbeats[0][1]["reason"] == "circuit_open"
    file = tmp_path / "binding.json"
    file.write_text(json.dumps(binding()))
    assert CliRunner().invoke(cli.main, ["operate", "--binding", str(file), "--reset-breaker"]).exit_code == 0
    clear = operate_run(tmp_path, monkeypatch)
    assert clear.code == 0 and len(clear.claims()) == 1


def test_OP1_operate_is_run_loops_only_caller():
    root = Path(__file__).resolve().parents[1]
    callers = []
    for file in (root / "pcc_node").rglob("*.py"):
        for node in ast.walk(ast.parse(file.read_text())):
            if isinstance(node, ast.Call):
                if ((isinstance(node.func, ast.Name) and node.func.id == "run_loop")
                        or (isinstance(node.func, ast.Attribute) and node.func.attr == "run_loop")):
                    callers.append(file.relative_to(root).as_posix())
    assert callers == ["pcc_node/operating/operate.py"]
    assert hashlib.sha256((root / "tests/test_daemon_takes_no_jobs.py").read_bytes()).hexdigest() == (
        "0cb3daafd1c5ccc16f1a0abc0c29929ff4690dc33925d13b70ce384877a3d5b7")


def test_HB1_failed_run_heartbeat_carries_status_and_reason(tmp_path, monkeypatch):
    result = operate_run(tmp_path, monkeypatch, state="failed")
    assert result.code == 0 and len(result.claims()) == 1
    bodies = [body for _, body in result.heartbeats]
    assert bodies[0]["status"] == "online" and "reason" not in bodies[0]
    assert bodies[1]["status"] == "error" and bodies[1]["reason"] == "run_failed"
    assert all(body["acceptingJobs"] is False for body in bodies)
    next_dir = tmp_path / "passed"
    next_dir.mkdir(mode=0o700)
    clear = operate_run(next_dir, monkeypatch)
    assert clear.code == 0 and clear.heartbeats[1][1]["status"] == "online"
    assert "reason" not in clear.heartbeats[1][1]


def test_HB1_passed_run_heartbeat_is_online(tmp_path, monkeypatch):
    result = operate_run(tmp_path, monkeypatch)
    assert result.code == 0 and len(result.claims()) == 1 and len(result.heartbeats) >= 2
    assert all(body["status"] == "online" and "reason" not in body and body["acceptingJobs"] is False
               for _, body in result.heartbeats)
    evidence = [body for _, path, body in result.gateway.calls if path == "/api/operator/evidence"]
    assert len(evidence) == 1
    assert all(event["type"] == "log_hash_chain_entry" for event in evidence[0]["evidence"]["bundle"]["logChain"])


def invalid_stop(tmp_path, monkeypatch, stops):
    device_log, gateway_log, identities, key_reads = [], [], [], []
    monkeypatch.setattr(cli, "_setup_logging", lambda verbose: None)
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    monkeypatch.setattr(devicelock, "read_device_identity", lambda *args, **kwargs: identities.append(args))
    monkeypatch.setattr(runtime, "_request", lambda *args, **kwargs: device_log.append(args))
    monkeypatch.setattr(operate, "pcc_request", lambda *args, **kwargs: gateway_log.append(args))
    monkeypatch.setattr(PCCGatewayClient, "_post", lambda *args, **kwargs: gateway_log.append(args))
    monkeypatch.setattr(cli, "_load_node_keys", lambda: key_reads.append(True))
    for stop in stops:
        data = binding()
        if stop is None:
            del data["device"]["stop"]
        else:
            data["device"]["stop"] = stop
        file = tmp_path / "binding.json"
        file.write_text(json.dumps(data))
        result = CliRunner().invoke(cli.main, ["operate", "--binding", str(file)])
        assert result.exit_code == 1 and "device_stop_undeclared" in result.output
        assert device_log == [] and gateway_log == [] and identities == [] and key_reads == []
    good = binding()
    assert operate.validate_binding(good) is good
    clear = operate_run(tmp_path, monkeypatch)
    assert clear.code == 0 and len(clear.claims()) == 1


def test_SD1_binding_without_stop_exits_before_any_request(tmp_path, monkeypatch):
    invalid_stop(tmp_path, monkeypatch, [None])


def test_SD1_binding_with_invalid_stop_exits_before_any_request(tmp_path, monkeypatch):
    invalid_stop(tmp_path, monkeypatch, [{"method": "GET", "path": "/runs/{runId}/cancel"},
                                      {"method": "POST", "path": "/cancel"},
                                      {"method": "POST", "path": "/runs/{runId}/{runId}"}])


def test_local_stop_during_run_calls_cancel_and_sends_one_device_stop(tmp_path, monkeypatch):
    first_poll = threading.Event()
    cancelled = threading.Event()
    original = runtime.AdapterRuntime.cancel

    def cancel(self):
        original(self)
        cancelled.set()

    def wait(seconds):
        assert first_poll.wait(timeout=5.0)
        return False

    def request(method, url, body=None, **kwargs):
        if url.endswith("/status"):
            return runtime._Answer(200, {"state": "idle"}, True)
        if url.endswith("/cancel"):
            return runtime._Answer(200, {}, True)
        if method == "POST":
            return runtime._Answer(201, {"id": "run-1"}, True)
        devicelock.write_stop()
        first_poll.set()
        assert cancelled.wait(timeout=5.0)
        return runtime._Answer(200, {"status": "running"}, True)

    monkeypatch.setattr(runtime.AdapterRuntime, "cancel", cancel)
    result = operate_run(tmp_path, monkeypatch, device_request=request, watch_wait=wait)
    assert result.code == 0 and cancelled.is_set() and len(result.claims()) == 1
    stops = [entry for entry in result.device_log if entry[1].endswith("/cancel")]
    assert len(stops) == 1 and stops[0][0] == "POST"
    completions = [body for _, path, body in result.gateway.calls if path == "/api/operator/job-status"]
    assert len(completions) == 1 and completions[0]["status"] == "failed"
    assert completions[0]["metadata"]["reason"] == "cancelled:device_state_unknown"
    devicelock.clear_stop()
    next_dir = tmp_path / "passed"
    next_dir.mkdir(mode=0o700)
    clear = operate_run(next_dir, monkeypatch)
    assert clear.code == 0 and len(clear.claims()) == 1
    assert not [entry for entry in clear.device_log if entry[1].endswith("/cancel")]


def test_completion_refusal_and_completion_exception_end_operate(tmp_path, monkeypatch):
    for cause in ("refused", "unreadable"):
        directory = tmp_path / cause
        directory.mkdir(mode=0o700)
        gateway = Gateway()
        original = gateway.__call__

        def request(method, path, body=None, **kwargs):
            if path == "/api/operator/job-status":
                gateway.calls.append((method, path, body))
                if cause == "unreadable":
                    raise ValueError("completion unavailable")
                return 200, {"updated": False}
            return original(method, path, body, **kwargs)

        class Transport:
            calls = gateway.calls
            def __call__(self, method, path, body=None, **kwargs):
                return request(method, path, body, **kwargs)
        result = operate_run(directory, monkeypatch, gateway=Transport())
        assert result.code == 1 and len(result.messages) == 1
        assert "completion" in result.messages[0]
        assert len([entry for entry in gateway.calls if entry[1].endswith("/claim")]) == 1
    directory = tmp_path / "accepted"
    directory.mkdir(mode=0o700)
    assert operate_run(directory, monkeypatch).code == 0


def test_heartbeat_interval_and_omitted_reason(tmp_path, monkeypatch):
    from pcc_node.operating.gate import CircuitBreaker
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    now = [0.0]
    bodies = []

    def post(self, path, body):
        bodies.append(body)
        return 200, {}

    monkeypatch.setattr(PCCGatewayClient, "_post", post)
    client = PCCGatewayClient("https://gateway.example", "key-1", "kernel-1")
    heartbeats = operate._Heartbeats(client, CircuitBreaker("serial-1"), lambda: now[0])
    heartbeats.send(force=True)
    now[0] = 59.0
    heartbeats.send()
    assert len(bodies) == 1
    now[0] = 60.0
    heartbeats.send()
    assert len(bodies) == 2 and all(body["acceptingJobs"] is False for body in bodies)
    client.send_heartbeat()
    assert "acceptingJobs" not in bodies[-1] and "reason" not in bodies[-1]


def test_cli_uses_config_environment_and_flag_values(tmp_path, monkeypatch):
    import signal
    monkeypatch.setattr(cli, "_setup_logging", lambda verbose: None)
    key_pair = keys()
    monkeypatch.setattr(cli, "_load_node_keys", lambda: key_pair)
    installed = {}
    original_signal = signal.signal

    def install(sig, handler):
        if callable(handler):
            installed[sig] = handler
        return original_signal(sig, handler)

    monkeypatch.setattr(signal, "signal", install)
    device_log = []

    def device_request(method, url, body=None, **kwargs):
        device_log.append((method, url, body))
        if url.endswith("/status"):
            return runtime._Answer(200, {"state": "idle"}, True)
        if method == "POST":
            return runtime._Answer(201, {"id": "run-1"}, True)
        return runtime._Answer(200, {"status": "done"}, True)

    monkeypatch.setattr(runtime, "_request", device_request)
    monkeypatch.setattr(devicelock, "read_device_identity", lambda *args, **kwargs: "serial-1")
    monkeypatch.setattr(PCCGatewayClient, "_post", lambda *args: (200, {}))
    cases = [
        ([], {"PCC_BASE": None, "PCC_API_KEY": None, "KERNEL_ID": None},
         ("https://config.example", "key-config", "kernel-config")),
        ([], {"PCC_BASE": "https://env.example", "PCC_API_KEY": "key-env", "KERNEL_ID": "kernel-env"},
         ("https://env.example", "key-env", "kernel-env")),
        (["--pcc-base", "https://flag.example", "--api-key", "key-flag", "--kernel-id", "kernel-flag"],
         {"PCC_BASE": "https://env.example", "PCC_API_KEY": "key-env", "KERNEL_ID": "kernel-env"},
         ("https://flag.example", "key-flag", "kernel-flag")),
    ]
    for index, (options, variables, expected) in enumerate(cases):
        directory = tmp_path / str(index)
        directory.mkdir(mode=0o700)
        monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(directory))
        config = directory / "config.json"
        config.write_text(json.dumps({"pcc_base": "https://config.example", "pcc_api_key": "key-config",
                                      "kernel_id": "kernel-config"}))
        config.chmod(0o600)
        file = directory / "binding.json"
        file.write_text(json.dumps(binding()))
        gateway = Gateway()
        received = []

        def gateway_request(method, path, body=None, **kwargs):
            received.append((kwargs["base_url"], kwargs["api_key"]))
            answer = gateway(method, path, body, **kwargs)
            if path == "/api/operator/job-status":
                assert body["kernelId"] == expected[2] and body["status"] == "completed"
                installed[signal.SIGTERM](signal.SIGTERM, None)
            return answer

        monkeypatch.setattr(operate, "pcc_request", gateway_request)
        result = CliRunner().invoke(cli.main, ["operate", "--binding", str(file), "-c", str(config)] + options,
                                    env=variables)
        assert result.exit_code == 0, (result.output, result.exception)
        assert received and all(item == expected[:2] for item in received)
        assert signal.SIGINT in installed and signal.SIGTERM in installed
    assert len([entry for entry in device_log if entry[0] == "POST"]) == 3
