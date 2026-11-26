"""Stop readings, per-device failure counts, and single-attempt run grants."""

import json
import math
import re
import secrets
import threading
import time
from dataclasses import dataclass

from ..log_capture import canonicalize, sha256_hex
from .devicelock import breaker_open, read_stop_state, reset_breaker, write_breaker
from .runtime import RunResult

OPERATE_POLL_S = 5.0
RUN_GRANT_TTL_MS = 3600000
BREAKER_FAILURE_THRESHOLD = 3


class StopReader:
    def __init__(self, process_stop, *, clock=time.monotonic, unix_clock=time.time):
        self._process_stop = process_stop
        self._clock = clock
        self._unix_clock = unix_clock
        self._mutex = threading.Lock()
        self._gateway = "unavailable"
        self._sent_at = None
        self.refresh_poll = None

    def observe(self, status, body, sent_at):
        state = body.get("emergencyStop") if status == 200 and isinstance(body, dict) else None
        if state not in ("clear", "stopped"):
            state = "unavailable"
        with self._mutex:
            self._gateway, self._sent_at = state, sent_at

    def fresh(self):
        with self._mutex:
            return self._sent_at is not None and 0 <= self._clock() - self._sent_at < OPERATE_POLL_S

    def refresh(self):
        try:
            if self.refresh_poll is None:
                raise ValueError("no stop poll")
            self.refresh_poll()
        except Exception:
            self.observe(0, None, self._clock())
        return self.check(poll=False)

    def check(self, *, poll=True):
        if poll and not self.fresh():
            return self.refresh()
        try:
            local = read_stop_state()
        except Exception:
            local = "unavailable"
        with self._mutex:
            gateway = self._gateway
        if self._process_stop.is_set() or local == "stopped" or gateway == "stopped":
            return "stopped"
        if local != "clear" or gateway != "clear" or not self.fresh():
            return "unavailable"
        return "clear"


class CircuitBreaker:
    def __init__(self, serial, *, clock=time.monotonic, unix_clock=time.time):
        self.serial = serial
        self.count = 0
        self._clock = clock
        self._unix_clock = unix_clock
        self._opened = False
        self._persisted = False

    def is_open(self):
        present = breaker_open(self.serial)
        if self._opened and self._persisted and not present:
            self._opened = False
            self._persisted = False
            self.count = 0
        return self._opened or present

    def learn(self, result, failed_states):
        if result.ok is True:
            self.count = 0
        elif result.error in tuple("run_" + state for state in failed_states):
            self.count += 1
            if self.count >= BREAKER_FAILURE_THRESHOLD:
                self._opened = True
                write_breaker(self.serial)
                self._persisted = True

    def reset(self):
        reset_breaker(self.serial)
        self.count = 0
        self._opened = False
        self._persisted = False


@dataclass
class RunGrant:
    job_id: str
    device_id: str
    input_hash: str
    expires_at: float
    started: bool = False


class GatedRuntime:
    def __init__(self, profile, inner, reader, breaker, *, clock=time.monotonic, unix_clock=time.time,
                 result_observer=None):
        self.profile = profile
        self.inner = inner
        self.reader = reader
        self.breaker = breaker
        self._clock = clock
        self._unix_clock = unix_clock
        self._result_observer = result_observer
        self._grants = {}
        self._active = threading.Event()

    @property
    def running(self):
        return self._active.is_set()

    def allows_jobs(self):
        try:
            return self.reader.check(poll=True) == "clear" and not self.breaker.is_open()
        except Exception:
            return False

    def is_idle(self):
        return self.inner.is_idle()

    def cancel(self):
        self.inner.cancel()

    def _stop_refusal(self, *, poll):
        state = self.reader.check(poll=poll)
        if state == "stopped":
            return "stopped"
        return None if state == "clear" else "stop_unavailable"

    def _plan(self, operation, input_hash, claim):
        if not isinstance(input_hash, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", input_hash) is None:
            return "bad_hash"
        if operation not in self.profile.operations:
            return "not_certified"
        refusal = self._stop_refusal(poll=True)
        if refusal:
            return refusal
        if self.breaker.is_open():
            return "circuit_open"
        deadline = self.inner.timeout_s(operation)
        try:
            remaining = claim.lease_remaining_s()
        except Exception:
            remaining = 0.0
        if not isinstance(remaining, (int, float)) or not math.isfinite(remaining) or remaining < deadline:
            return "lease_too_short"
        reclaim_at = getattr(claim, "reclaim_at", None)
        if reclaim_at is not None and not self._unix_clock() + deadline < reclaim_at:
            return "reclaim_too_soon"
        return None

    def _mint(self, claim, input_hash):
        grant_id = secrets.token_hex(32)
        ttl = min(claim.lease_remaining_s(), RUN_GRANT_TTL_MS / 1000.0)
        self._grants[grant_id] = RunGrant(claim.job_id, self.profile.device_id, input_hash, self._clock() + ttl)
        return grant_id

    def last_check(self, grant_id, *, job_id, device_id, input_hash, params):
        if grant_id is None:
            return "no_grant"
        grant = self._grants.get(grant_id)
        if grant is None:
            return "grant_not_minted"
        if (grant.job_id, grant.device_id, grant.input_hash) != (job_id, device_id, input_hash):
            return "grant_mismatch"
        if self._clock() >= grant.expires_at:
            return "grant_expired"
        if grant.started:
            return "grant_used"
        refusal = self._stop_refusal(poll=False)
        if refusal:
            return refusal
        if self.breaker.is_open():
            return "circuit_open"
        try:
            current_hash = sha256_hex(canonicalize(params))
        except Exception:
            return "bytes_changed"
        if current_hash != grant.input_hash:
            return "bytes_changed"
        grant.started = True
        return None

    def run(self, operation, params, *, claim):
        result = self._run(operation, params, claim=claim)
        if self._result_observer is not None:
            self._result_observer(result)
        return result

    def _run(self, operation, params, *, claim):
        try:
            copied = json.loads(json.dumps(params, allow_nan=False))
            input_hash = sha256_hex(canonicalize(copied))
        except (TypeError, ValueError, OverflowError, RecursionError):
            return RunResult(False, error="bad_hash")
        refusal = self._plan(operation, input_hash, claim)
        if refusal:
            return RunResult(False, error=refusal)
        grant_id = self._mint(claim, input_hash)
        job_id, device_id = claim.job_id, self.profile.device_id

        def last_check():
            return self.last_check(grant_id, job_id=job_id, device_id=device_id, input_hash=input_hash, params=copied)

        self._active.set()
        try:
            result = self.inner.run(operation, copied, claim=claim, last_check=last_check)
            self.breaker.learn(result, self.inner.failed_states(operation))
            return result
        finally:
            if not self._grants[grant_id].started:
                del self._grants[grant_id]
            self._active.clear()
