"""Real stop readings and per-attempt grants at the device hand-off."""

import json
import threading
from dataclasses import replace
from types import SimpleNamespace

import pytest
from click.testing import CliRunner

from pcc_node import cli
from pcc_node.log_capture import canonicalize, sha256_hex
from pcc_node.operating import devicelock, gate, runtime
from pcc_node.operating.gate import CircuitBreaker, GatedRuntime, OPERATE_POLL_S, RUN_GRANT_TTL_MS, StopReader
from pcc_node.operating.jobport import ClaimedJob, Lease
from pcc_node.operating.loop import run_once
from pcc_node.operating.profile import build_r0_plate_reader_profile
from pcc_node.operating.runtime import AdapterRuntime, RunResult
from tests.test_operating_reconcile import PARAMS, Gateway, binding, keys, make_port


class LiveLease:
    def __init__(self, remaining=90000.0):
        self.remaining = remaining
        self.live = True

    def alive(self):
        return self.live

    def remaining_s(self):
        return self.remaining if self.live else 0.0

    def release(self):
        self.live = False


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "_setup_logging", lambda verbose: None)
    monkeypatch.setattr(devicelock, "DEFAULT_DIRECTORY", str(tmp_path))
    monkeypatch.setattr(devicelock, "read_device_identity", lambda *args, **kwargs: "serial-1")
    now, unix = [100.0], [1000.0]
    key_pair = keys()
    profile = build_r0_plate_reader_profile(kernel_id="kernel-1", device_id="reader-1")
    inner = AdapterRuntime.from_profile(binding()["device"], *key_pair, clock=lambda: now[0])
    gateway = Gateway()
    stopped = threading.Event()
    reader = StopReader(stopped, clock=lambda: now[0], unix_clock=lambda: unix[0])
    port = make_port(gateway, key_pair, observer=reader.observe, clock=lambda: now[0])
    reader.refresh_poll = port.refresh_stop
    breaker = CircuitBreaker("serial-1", clock=lambda: now[0], unix_clock=lambda: unix[0])
    gated = GatedRuntime(profile, inner, reader, breaker, clock=lambda: now[0], unix_clock=lambda: unix[0])
    state = SimpleNamespace(now=now, unix=unix, inner=inner, profile=profile, gateway=gateway,
                            reader=reader, breaker=breaker, gated=gated, port=port, stopped=stopped,
                            job=ClaimedJob("job-1", "runPlate", "lab.absorbance", "token-1", "kernel-1", LiveLease()),
                            params=json.loads(json.dumps(PARAMS)), log=[], device_state="done", key_pair=key_pair)

    def request(method, url, body=None, **kwargs):
        state.log.append((method, url, body, kwargs))
        if url.endswith("/status"):
            return runtime._Answer(200, {"state": "idle"}, True)
        if url.endswith("/cancel"):
            return runtime._Answer(200, {}, True)
        if method == "POST":
            return runtime._Answer(201, {"id": "run-1"}, True)
        return runtime._Answer(200, {"status": state.device_state}, True)

    monkeypatch.setattr(runtime, "_request", request)
    return state


def passed(env):
    result = env.gated.run("runPlate", env.params, claim=env.job)
    assert result.ok and result.error is None
    assert any(method == "POST" and url.endswith("/runs") for method, url, *_ in env.log)
    return result


def fresh_clear(env):
    env.port.refresh_stop()
    assert env.reader.check(poll=False) == "clear"


def mint(env):
    digest = sha256_hex(canonicalize(env.params))
    assert env.gated._plan("runPlate", digest, env.job) is None
    return env.gated._mint(env.job, digest)


def last(env, grant_id, **changes):
    args = dict(job_id=env.job.job_id, device_id=env.profile.device_id,
                input_hash=sha256_hex(canonicalize(PARAMS)), params=env.params)
    args.update(changes)
    return env.gated.last_check(grant_id, **args)


def refused_poll(env, answer, reason):
    env.gateway.polls = [answer]
    result = env.gated.run("runPlate", env.params, claim=env.job)
    assert result.error == reason and not result.ok
    assert env.gated._grants == {} and env.log == []
    fresh_clear(env)
    passed(env)


def test_HG1a_stopped_poll_mints_no_grant(env):
    refused_poll(env, (200, {"emergencyStop": "stopped", "jobs": []}), "stopped")


def test_HG1a_unavailable_poll_mints_no_grant(env):
    refused_poll(env, (200, {"emergencyStop": "unavailable", "jobs": []}), "stop_unavailable")


def test_HG1a_absent_field_mints_no_grant(env):
    refused_poll(env, (200, {"jobs": []}), "stop_unavailable")


def refused_claim(env, claim, reason):
    result = env.gated.run("runPlate", env.params, claim=claim)
    assert not result.ok and result.error == reason
    assert env.gated._grants == {} and env.log == []
    passed(env)


def test_HG1b_passed_reclaim_at_mints_no_grant(env):
    refused_claim(env, replace(env.job, reclaim_at=999.0), "reclaim_too_soon")


def test_HG1b_reclaim_at_before_deadline_mints_no_grant(env):
    refused_claim(env, replace(env.job, reclaim_at=1029.0), "reclaim_too_soon")


def test_HG1b_short_lease_mints_no_grant(env):
    refused_claim(env, replace(env.job, lease=LiveLease(29.0)), "lease_too_short")


def test_HG1c_two_attempts_get_two_grants(env):
    passed(env)
    first = set(env.gated._grants)
    passed(env)
    assert len(env.gated._grants) == 2 and len(first) == 1
    assert all(grant.started for grant in env.gated._grants.values())


def test_HG1c_other_job_is_grant_mismatch(env):
    grant_id = mint(env)
    assert last(env, grant_id, job_id="job-2") == "grant_mismatch"
    assert last(env, grant_id) is None


def test_HG1c_other_device_is_grant_mismatch(env):
    grant_id = mint(env)
    assert last(env, grant_id, device_id="reader-2") == "grant_mismatch"
    assert last(env, grant_id) is None


def test_HG1c_other_input_hash_is_grant_mismatch(env):
    grant_id = mint(env)
    assert last(env, grant_id, input_hash="sha256:" + "0" * 64) == "grant_mismatch"
    assert last(env, grant_id) is None


def test_HG1c_used_grant_is_grant_used(env):
    grant_id = mint(env)
    assert last(env, grant_id) is None
    assert last(env, grant_id) == "grant_used"
    assert last(env, mint(env)) is None


def test_HG1c_expired_grant_is_grant_expired(env):
    grant_id = mint(env)
    env.now[0] += RUN_GRANT_TTL_MS / 1000.0 + 1.0
    assert last(env, grant_id) == "grant_expired"
    assert last(env, mint(env)) is None


def test_HG1c_unminted_grant_is_grant_not_minted(env):
    assert last(env, "unminted") == "grant_not_minted"
    assert last(env, mint(env)) is None


def late_stop(env, tmp_path, monkeypatch, unavailable=False, stale=False):
    lock = devicelock.HostDeviceLock(binding()["device"]["url"], serial="serial-1")
    job = env.port.claim_next("kernel-1")
    original = gate.read_stop_state
    reads = [0]

    def read():
        answer = original()
        reads[0] += 1
        if reads[0] == 2:
            if unavailable:
                (tmp_path / devicelock._STOP_FILE).symlink_to(tmp_path / "missing")
            else:
                devicelock.write_stop()
        return answer

    original_mint = env.gated._mint
    minted = []

    def track(claim, digest):
        grant_id = original_mint(claim, digest)
        minted.append(grant_id)
        if stale:
            env.now[0] += OPERATE_POLL_S + 0.1
        return grant_id

    monkeypatch.setattr(env.gated, "_mint", track)
    if not stale:
        monkeypatch.setattr(gate, "read_stop_state", read)
    before = sum(path.startswith("/api/operator/jobs?") for _, path, _ in env.gateway.calls)
    try:
        outcome = run_once(env.profile, env.gated, env.port, job, gate=env.gated, lock=lock)
        reason = "stop_unavailable" if unavailable or stale else "stopped"
        assert len(minted) == 1 and outcome.reason == reason
        assert not any(method == "POST" for method, *_ in env.log)
        assert lock.record_state("job:job-1") == "terminal"
        terminal = tmp_path / "jobs" / (devicelock._name("job:job-1") + ".terminal")
        assert terminal.read_text() == reason
        completions = [body for _, path, body in env.gateway.calls if path == "/api/operator/job-status"]
        assert len(completions) == 1
        assert completions[0]["status"] == "failed" and completions[0]["metadata"]["reason"] == reason
        after = sum(path.startswith("/api/operator/jobs?") for _, path, _ in env.gateway.calls)
        assert after == before
        monkeypatch.setattr(gate, "read_stop_state", original)
        monkeypatch.setattr(env.gated, "_mint", original_mint)
        devicelock.clear_stop()
        fresh_clear(env)
        passed(env)
    finally:
        job.lease.release()
        lock.close()


def test_HG4_stop_before_start_request_sends_no_start(env, tmp_path, monkeypatch):
    late_stop(env, tmp_path, monkeypatch)


def test_HG4_unreadable_stop_before_start_is_stop_unavailable(env, tmp_path, monkeypatch):
    late_stop(env, tmp_path, monkeypatch, unavailable=True)


def test_HG4_stale_gateway_half_at_last_check_is_stop_unavailable(env, tmp_path, monkeypatch):
    late_stop(env, tmp_path, monkeypatch, stale=True)


def test_GT1_bad_hash(env):
    for value in (float("nan"), float("inf"), float("-inf"), object()):
        assert env.gated.run("runPlate", {"value": value}, claim=env.job).error == "bad_hash"
    for digest in (None, "sha256:abc", "sha256:" + "A" * 64, "sha256:" + "a" * 64 + "\n"):
        assert env.gated._plan("runPlate", digest, env.job) == "bad_hash"
    assert not env.gated._grants and not env.log
    passed(env)


def test_GT1_not_certified(env):
    assert env.gated.run("other", env.params, claim=env.job).error == "not_certified"
    assert not env.gated._grants and not env.log
    passed(env)


def test_GT1_grant_names(env):
    assert last(env, None) == "no_grant"
    assert last(env, "absent") == "grant_not_minted"
    grant_id = mint(env)
    assert last(env, grant_id, job_id="other") == "grant_mismatch"
    assert last(env, grant_id) is None
    assert last(env, grant_id) == "grant_used"
    env.now[0] += RUN_GRANT_TTL_MS / 1000.0
    assert last(env, grant_id) == "grant_expired"
    assert last(env, mint(env)) is None


def test_GT1_stop_names(env):
    grant_id = mint(env)
    devicelock.write_stop()
    assert last(env, grant_id) == "stopped"
    assert not env.gated.allows_jobs()
    devicelock.clear_stop()
    env.gateway.polls = [(503, {})]
    env.port.refresh_stop()
    assert last(env, grant_id) == "stop_unavailable"
    fresh_clear(env)
    assert last(env, grant_id) is None


def test_GT1_circuit_open(env):
    grant_id = mint(env)
    devicelock.write_breaker("serial-1")
    assert not env.gated.allows_jobs()
    assert env.gated.run("runPlate", env.params, claim=env.job).error == "circuit_open"
    assert last(env, grant_id) == "circuit_open"
    assert not env.log
    env.breaker.reset()
    assert last(env, grant_id) is None
    passed(env)


def test_GT1_bytes_changed_rehashes_every_hand_off(env):
    """Every hand-off rehashes the parameters carried by the command."""
    grant_id = mint(env)
    env.params["wells"] = ["A1"]
    assert last(env, grant_id) == "bytes_changed"
    assert not env.gated._grants[grant_id].started and not env.log
    env.params["wells"] = "all"
    assert last(env, grant_id) is None
    other = mint(env)
    env.params["wavelengthNm"] = 405
    assert last(env, other) == "bytes_changed"
    env.params["wavelengthNm"] = 450
    assert last(env, other) is None


def test_GT1_last_check_marks_grant_started(env):
    grant_id = mint(env)
    assert not env.gated._grants[grant_id].started
    assert last(env, grant_id) is None
    assert env.gated._grants[grant_id].started
    assert last(env, grant_id) == "grant_used"


def test_GT1_breaker_counts_declared_failures(env, tmp_path):
    env.device_state = "failed"
    assert env.gated.run("runPlate", env.params, claim=env.job).error == "run_failed"
    assert env.breaker.count == 1
    env.breaker.learn(RunResult(False, error="timeout:device_state_unknown"), ("failed",))
    assert env.breaker.count == 1
    env.device_state = "done"
    passed(env)
    assert env.breaker.count == 0
    env.device_state = "failed"
    for _ in range(3):
        assert env.gated.run("runPlate", env.params, claim=env.job).error == "run_failed"
    assert env.breaker.count == 3 and env.breaker.is_open()
    other = CircuitBreaker("serial-1", clock=lambda: env.now[0], unix_clock=lambda: env.unix[0])
    restarted = GatedRuntime(env.profile, env.inner, env.reader, other, clock=lambda: env.now[0])
    assert not restarted.allows_jobs()
    assert restarted.run("runPlate", env.params, claim=env.job).error == "circuit_open"
    file = tmp_path / "binding.json"
    file.write_text(json.dumps(binding()))
    assert CliRunner().invoke(cli.main, ["operate", "--binding", str(file), "--reset-breaker"]).exit_code == 0
    assert not other.is_open() and other.count == 0
    env.device_state = "done"
    assert restarted.run("runPlate", env.params, claim=env.job).ok


def test_GT1_device_stop_and_idle_probe_need_no_grant(env, monkeypatch):
    assert env.gated.is_idle() and not env.gated._grants
    env.gated.cancel()
    assert env.inner.run("runPlate", env.params, claim=env.job).error == "cancelled:not_started"
    original = runtime._request

    def request(method, url, body=None, **kwargs):
        if method == "GET" and url.endswith("/runs/run-1"):
            env.gated.cancel()
            return runtime._Answer(200, {"status": "running"}, True)
        return original(method, url, body, **kwargs)

    monkeypatch.setattr(runtime, "_request", request)
    result = env.inner.run("runPlate", env.params, claim=env.job)
    assert result.error == "cancelled:device_state_unknown"
    assert len([entry for entry in env.log if entry[1].endswith("/cancel")]) == 1
    assert not env.gated._grants
    monkeypatch.setattr(runtime, "_request", original)
    passed(env)


def test_ST1_anything_but_clear_stops(env):
    for value in ("stopped", "unavailable", "", "CLEAR", 1, None, []):
        env.gateway.polls = [(200, {"emergencyStop": value, "jobs": []})]
        state = env.reader.refresh()
        assert state == ("stopped" if value == "stopped" else "unavailable")
        assert not env.gated.allows_jobs()
        fresh_clear(env)
        assert env.gated.allows_jobs()
    for answer in ((200, {}), (200, []), (503, {"emergencyStop": "clear"}), OSError("offline")):
        env.gateway.polls = [answer]
        assert env.reader.refresh() == "unavailable"
        assert not env.gated.allows_jobs()
        fresh_clear(env)
        assert env.gated.allows_jobs()
    passed(env)


def test_ST1_stale_clear_stops_until_a_fresh_clear(env):
    fresh_clear(env)
    env.now[0] += OPERATE_POLL_S
    calls = len(env.gateway.calls)
    assert env.reader.check(poll=False) == "unavailable"
    assert len(env.gateway.calls) == calls
    assert env.reader.check(poll=True) == "clear"
    assert len(env.gateway.calls) == calls + 1
    passed(env)


def test_ST1_local_stop_holds_through_clear_poll_and_restart(env, tmp_path, monkeypatch):
    from tests.test_operating_operate import operate_run
    assert CliRunner().invoke(cli.main, ["operate", "--stop"]).exit_code == 0
    env.port.refresh_stop()
    assert env.reader.check(poll=False) == "stopped"
    result = operate_run(tmp_path, monkeypatch)
    assert result.code == 0 and not result.claims() and result.device_log == []
    again = operate_run(tmp_path, monkeypatch)
    assert again.code == 0 and not again.claims() and again.device_log == []
    assert devicelock.read_stop_state() == "stopped"
    assert CliRunner().invoke(cli.main, ["operate", "--clear-stop"]).exit_code == 0
    resumed = operate_run(tmp_path, monkeypatch)
    assert resumed.code == 0 and len(resumed.claims()) == 1


def test_ST1_only_clear_stop_clears_the_local_stop(env):
    runner = CliRunner()
    assert runner.invoke(cli.main, ["operate", "--stop"]).exit_code == 0
    assert runner.invoke(cli.main, ["operate", "--stop"]).exit_code == 0
    fresh = env.reader.refresh()
    assert fresh == "stopped" and devicelock.read_stop_state() == "stopped"
    assert runner.invoke(cli.main, ["operate", "--clear-stop"]).exit_code == 0
    assert runner.invoke(cli.main, ["operate", "--clear-stop"]).exit_code == 0
    assert env.reader.check(poll=False) == "clear"
    passed(env)


def test_ST1_unreadable_stop_file_is_unavailable(env, tmp_path):
    file = tmp_path / devicelock._STOP_FILE
    file.symlink_to(tmp_path / "missing")
    assert devicelock.read_stop_state() == "unavailable"
    assert env.gated.run("runPlate", env.params, claim=env.job).error == "stop_unavailable"
    assert not env.log and not env.gated._grants
    file.unlink()
    tmp_path.chmod(0o755)
    assert devicelock.read_stop_state() == "unavailable"
    tmp_path.chmod(0o700)
    passed(env)


def test_parameter_copy_precedes_stop_reads_and_device_body(env, monkeypatch):
    env.params["wells"] = ["A1"]
    original = gate.read_stop_state

    def read():
        env.params["wells"].append("A2")
        return original()

    monkeypatch.setattr(gate, "read_stop_state", read)
    result = env.gated.run("runPlate", env.params, claim=env.job)
    assert result.ok
    body = next(body for method, url, body, _ in env.log if method == "POST" and url.endswith("/runs"))
    assert body == {"params": ["A1"]}
    grant = next(iter(env.gated._grants.values()))
    assert grant.input_hash == sha256_hex(canonicalize(dict(PARAMS, wells=["A1"])))
    assert env.params["wells"] != ["A1"]


def test_last_check_exception_returns_known_gate_error(env):
    def failing_check():
        raise ValueError("unreadable")

    result = env.inner.run("runPlate", env.params, claim=env.job, last_check=failing_check)
    assert result.error == "gate_error" and not result.ok and env.log == []
    grant_id = mint(env)
    result = env.inner.run("runPlate", env.params, claim=env.job, last_check=lambda: last(env, grant_id))
    assert result.ok and env.gated._grants[grant_id].started


def test_remaining_time_uses_hold_limit_or_current_deadline(env):
    long = Lease("job-long", 60.0, env.now[0], lambda: ("error", None, None),
                 clock=lambda: env.now[0], max_hold_s=90000.0)
    short = Lease("job-short", 60.0, env.now[0], lambda: ("error", None, None),
                  clock=lambda: env.now[0], max_hold_s=10.0)
    try:
        assert long.remaining_s() == 90000.0
        assert short.remaining_s() == 55.0
        assert replace(env.job, lease=None).lease_remaining_s() == 0.0
        long.release()
        assert long.remaining_s() == 0.0
        env.now[0] += 56.0
        assert short.remaining_s() == 0.0
    finally:
        long.release()
        short.release()


def test_claim_reclaim_time_parsing_and_refresh_observation(env):
    original = env.gateway.__call__
    for value, expected in ((None, 0.0), (True, 0.0), ("later", 0.0), (0, 0.0),
                            (-1, 0.0), (float("nan"), 0.0), (float("inf"), 0.0), (2000.0, 2000.0)):
        def request(method, path, body=None, **kwargs):
            status, answer = original(method, path, body, **kwargs)
            if path.endswith("/claim"):
                answer["reclaimAt"] = value
            return status, answer
        port = make_port(request, env.key_pair, observer=env.reader.observe, clock=lambda: env.now[0])
        job = port.claim_next("kernel-1")
        try:
            assert job.reclaim_at == expected
            assert job.lease_remaining_s() >= env.inner.timeout_s("runPlate")
        finally:
            job.lease.release()
    job = make_port(env.gateway, env.key_pair).claim_next("kernel-1")
    assert job.reclaim_at is None
    job.lease.release()
    env.now[0] += OPERATE_POLL_S
    calls = len(env.gateway.calls)
    env.port.refresh_stop()
    assert env.reader.check(poll=False) == "clear" and len(env.gateway.calls) == calls + 1
    assert not env.gated._grants


def test_process_stop_is_retained_and_never_needs_a_poll(env):
    passed(env)
    env.stopped.set()
    calls = len(env.gateway.calls)
    assert env.reader.check(poll=False) == "stopped"
    assert len(env.gateway.calls) == calls
    assert env.gated.run("runPlate", env.params, claim=env.job).error == "stopped"
    env.port.refresh_stop()
    assert env.reader.check(poll=False) == "stopped" and env.stopped.is_set()


def test_unreadable_breaker_marker_is_open(env, tmp_path):
    marker = tmp_path / devicelock._breaker_name("serial-1")
    marker.symlink_to(tmp_path / "missing")
    assert env.breaker.is_open() and not env.gated.allows_jobs()
    assert env.gated.run("runPlate", env.params, claim=env.job).error == "circuit_open"
    assert not env.gated._grants and not env.log
    env.breaker.reset()
    assert not env.breaker.is_open()
    passed(env)



def test_refused_attempt_retires_its_unstarted_grant(env, monkeypatch):
    minted = []
    original = env.gated._mint

    def track(claim, digest):
        grant_id = original(claim, digest)
        minted.append(grant_id)
        return grant_id

    monkeypatch.setattr(env.gated, "_mint", track)
    env.inner.cancel()
    result = env.gated.run("runPlate", env.params, claim=env.job)
    assert result.error == "cancelled:not_started"
    assert len(minted) == 1 and not env.log
    assert last(env, minted[0]) == "grant_not_minted"
    passed(env)
