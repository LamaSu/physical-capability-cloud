"""pcc-node's DeviceRuntime for the operating agent (ADK item 12).

The operating loop (refvertical's ``loop.py``) owns the job contract: resolve a
job's parameters, type-check and envelope-check them, check the device is idle,
then call ``run(operation, params)`` exactly once. This module is the only part
that touches the device, and it keeps two promises:

1. **A job never chooses the request.** Each operation is bound, in the
   operating profile, to one fixed request: method, path and body template.
   Parameters fill only the template's declared slots, and any other key is
   ignored. No method, path, host or URL is ever read from a job (board N87).
   Paths are checked when the profile is loaded, the device URL must name its
   port, and redirects are never followed.
2. **Evidence is signed or absent.** The runtime refuses to start without a
   genuine Ed25519 key (pynacl), and every record it returns is a signed
   ``log_hash_chain_entry`` from :class:`~pcc_node.log_capture.LogCapture`.

3. **Device I/O is bounded** (verdict 117). Every device answer is capped in
   size, every request runs against the operation's total deadline, a run id
   of "." or ".." is refused before it can change a path, and :meth:`cancel`
   stops a run between reads. A timeout or a cancel leaves the device's state
   unknown, and the result says so.
4. **Each job is its own log chain**, starting at GENESIS, so every job's
   evidence verifies on its own.

This first cut drives generic-HTTP devices, the kind with their own run API
(``POST /runs``, poll ``GET /runs/{runId}``). OctoPrint and Opentrons bindings
come next. It must not be armed for physical work until the emergency stop's
device half returns (held out of #454), since nothing here can stop a device
whose run outlived its deadline.
"""

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pcc_node.http_util import USER_AGENT
from pcc_node.log_capture import LogCapture, canonicalize

log = logging.getLogger("pcc-node.operating.runtime")

_SLOT = re.compile(r"^\{([A-Za-z_][A-Za-z0-9_]*)\}$")
_RUN_ID = "{runId}"
_METHODS = ("POST", "PUT")
# Bounds on what a device may send back (verdict 117).
_MAX_RESPONSE_BYTES = 1 << 20
_MAX_LOG_BYTES = 4 << 20
_REQUEST_TIMEOUT_S = 30.0
_IDLE_CHECK_S = 10.0


class BindingError(ValueError):
    """An operating profile's device binding is unsafe or malformed."""


@dataclass(frozen=True)
class RunResult:
    """What :meth:`AdapterRuntime.run` returns.

    Field-for-field the loop's ``RuntimeResult``: ``ok``, ``output``,
    ``evidence`` and ``error``.
    """

    ok: bool
    output: Any = None
    evidence: Optional[dict] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class DeviceStatus:
    """How to ask the device whether it is idle: ``GET path``, then ``field`` in ``idle``."""

    path: str
    field: str
    idle: Tuple[str, ...]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DeviceStatus":
        idle = d.get("idle")
        if not isinstance(idle, (list, tuple)) or not idle or not all(isinstance(v, str) for v in idle):
            raise BindingError("status.idle must be a non-empty list of strings")
        if not isinstance(d.get("field"), str) or not d["field"]:
            raise BindingError("status.field must name the response field that holds the state")
        return cls(path=_check_path(d.get("path"), "status.path"), field=d["field"], idle=tuple(idle))


@dataclass(frozen=True)
class OperationBinding:
    """One typed operation's fixed device request, and how to follow the run it starts."""

    method: str
    path: str
    body: Any
    run_id_field: str
    poll_path: str
    state_field: str
    done: Tuple[str, ...]
    failed: Tuple[str, ...]
    log_path: Optional[str] = None
    poll_interval_s: float = 1.0
    timeout_s: float = 600.0

    @classmethod
    def from_dict(cls, name: str, d: Dict[str, Any]) -> "OperationBinding":
        where = f"operations.{name}"
        request = d.get("request") or {}
        method = str(request.get("method", "POST")).upper()
        if method not in _METHODS:
            raise BindingError(f"{where}.request.method must be one of {', '.join(_METHODS)}")
        body = request.get("body", {})
        _check_template(body, f"{where}.request.body")
        poll = d.get("poll") or {}
        done, failed = poll.get("done"), poll.get("failed", [])
        for label, states in (("done", done), ("failed", failed)):
            if not isinstance(states, (list, tuple)) or not all(isinstance(v, str) for v in states):
                raise BindingError(f"{where}.poll.{label} must be a list of strings")
        if not done:
            raise BindingError(f"{where}.poll.done must name at least one terminal state")
        interval = float(poll.get("intervalS", 1.0))
        timeout = float(poll.get("timeoutS", 600.0))
        if not (0 < interval <= 60 and 0 < timeout <= 86400):
            raise BindingError(f"{where}.poll: intervalS must be in (0, 60] and timeoutS in (0, 86400]")
        run_id_field = d.get("runId", "id")
        state_field = poll.get("field", "status")
        if not isinstance(run_id_field, str) or not isinstance(state_field, str):
            raise BindingError(f"{where}: runId and poll.field must be strings")
        log_path = (d.get("log") or {}).get("path")
        return cls(
            method=method,
            path=_check_path(request.get("path"), f"{where}.request.path"),
            body=body,
            run_id_field=run_id_field,
            poll_path=_check_path(poll.get("path"), f"{where}.poll.path", run_id=True),
            state_field=state_field,
            done=tuple(done),
            failed=tuple(failed),
            log_path=None if log_path is None else _check_path(log_path, f"{where}.log.path", run_id=True),
            poll_interval_s=interval,
            timeout_s=timeout,
        )


def _check_path(path: Any, where: str, *, run_id: bool = False) -> str:
    """A device path the profile fixes: absolute, one host, no traversal, no query."""
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
        raise BindingError(f"{where} must be an absolute path such as /runs")
    if run_id and path.count(_RUN_ID) != 1:
        raise BindingError(f"{where} must hold exactly one {{runId}}")
    bare = path.replace(_RUN_ID, "x") if run_id else path
    if re.search(r"[\s\\@?#%]|\.\.|://|[{}]", bare):
        raise BindingError(f"{where} may hold only a plain path" + (" and {runId}" if run_id else ""))
    return path


def _check_template(value: Any, where: str) -> None:
    """A body template: JSON values, where a string exactly "{name}" is a parameter slot."""
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise BindingError(f"{where}: keys must be strings")
            _check_template(v, f"{where}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _check_template(v, f"{where}[{i}]")
    elif isinstance(value, str) and "{" in value and not _SLOT.match(value):
        raise BindingError(f"{where}: a slot is a whole string such as \"{{wavelengthNm}}\"")
    elif value is not None and not isinstance(value, (str, bool, int, float)):
        raise BindingError(f"{where}: only JSON values are allowed")


def _check_base_url(url: Any) -> str:
    """The device's address: http(s), a host, an explicit port, and nothing else."""
    if not isinstance(url, str):
        raise BindingError("device url must be a string")
    parsed = urlparse(url)
    try:
        port = parsed.port
    except ValueError:
        port = None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise BindingError("device url must be http(s)://host:port")
    if port is None:
        raise BindingError("device url must name its port, such as http://192.168.1.50:8080")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise BindingError("device url must be only scheme, host and port")
    return f"{parsed.scheme}://{parsed.netloc}"


def _fill(template: Any, params: Dict[str, Any]) -> Any:
    """Copy the template, putting params[name] where a string is exactly "{name}".

    Only the template's slots are read, so a key the template does not name
    (``method``, ``path``, ``url``…) can never reach the device.
    """
    if isinstance(template, dict):
        return {k: _fill(v, params) for k, v in template.items()}
    if isinstance(template, list):
        return [_fill(v, params) for v in template]
    if isinstance(template, str):
        m = _SLOT.match(template)
        if m:
            if m.group(1) not in params:
                raise KeyError(m.group(1))
            return params[m.group(1)]
    return template


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # a 3xx is an answer, never a new target


_OPENER = build_opener(_NoRedirect)


class _Abort(Exception):
    """A device request stopped before its answer was complete: why, as a result error."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _read_bounded(source: Any, max_bytes: int, deadline: float, clock: Callable[[], float],
                  cancelled: Callable[[], bool]) -> str:
    """Read an answer in pieces, never more than max_bytes, never past the deadline."""
    read1 = getattr(source, "read1", None)
    chunks, total = [], 0
    while True:
        if cancelled():
            raise _Abort("cancelled")
        if clock() >= deadline:
            raise _Abort("timeout")
        chunk = read1(65536) if read1 is not None else source.read(max_bytes + 1 - total)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise _Abort("device_response_too_large")
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


def _request(method: str, url: str, body: Any = None, *, deadline: float, clock: Callable[[], float],
             cancelled: Callable[[], bool] = lambda: False, max_bytes: int = _MAX_RESPONSE_BYTES) -> Tuple[int, Any]:
    """One device request, bounded in size and by the deadline.

    Returns (status, parsed body), with status 0 on a connection error, or
    raises _Abort when the deadline passes, the run is cancelled, or the
    answer is too large.
    """
    remaining = deadline - clock()
    if remaining <= 0:
        raise _Abort("timeout")
    headers = {"User-Agent": USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    timeout = min(_REQUEST_TIMEOUT_S, remaining)
    try:
        with _OPENER.open(Request(url, data=data, headers=headers, method=method), timeout=timeout) as resp:
            status, raw = resp.status, _read_bounded(resp, max_bytes, deadline, clock, cancelled)
    except HTTPError as e:
        status, raw = e.code, _read_bounded(e, max_bytes, deadline, clock, cancelled)
    except (URLError, OSError) as e:
        if clock() >= deadline:
            raise _Abort("timeout")
        return 0, {"error": str(e)}
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


class AdapterRuntime:
    """Runs one typed operation at a time on a generic-HTTP device, with signed evidence.

    Build it from the operating profile's ``device`` section with
    :meth:`from_profile`. Construction raises
    :class:`~pcc_node.log_capture.LogSigningRefused` when the node key is not a
    genuine Ed25519 key, and :class:`BindingError` when a binding is unsafe.
    """

    def __init__(
        self,
        url: str,
        status: DeviceStatus,
        bindings: Dict[str, OperationBinding],
        public_hex: str,
        secret_hex: str,
        *,
        source: str = "device",
        clock: Callable[[], float] = time.monotonic,
        sleep: Optional[Callable[[float], None]] = None,
    ) -> None:
        self._base = _check_base_url(url)
        self._signer = LogCapture(public_hex, secret_hex).signer  # fails closed without Ed25519
        self._keys = (public_hex, secret_hex)
        self._status = status
        self._bindings = dict(bindings)
        self._source = source
        self._clock = clock
        self._cancelled = threading.Event()
        self._sleep = sleep or self._cancelled.wait

    @classmethod
    def from_profile(cls, device: Dict[str, Any], public_hex: str, secret_hex: str, **kwargs) -> "AdapterRuntime":
        """``device``: ``{"url", "status": {...}, "operations": {name: binding}}``."""
        operations = device.get("operations")
        if not isinstance(operations, dict) or not operations:
            raise BindingError("device.operations must bind at least one operation")
        return cls(
            device.get("url"),
            DeviceStatus.from_dict(device.get("status") or {}),
            {name: OperationBinding.from_dict(name, b) for name, b in operations.items()},
            public_hex,
            secret_hex,
            **kwargs,
        )

    @property
    def signer(self) -> str:
        """The ``0x``-prefixed Ed25519 public key that signs this runtime's evidence."""
        return self._signer

    def cancel(self) -> None:
        """Stop the run in progress at its next read or poll. The device's state is then unknown."""
        self._cancelled.set()

    def is_idle(self) -> bool:
        """True only if the device answers and reports an idle state. Anything else is busy."""
        try:
            status, body = _request("GET", self._base + self._status.path,
                                    deadline=self._clock() + _IDLE_CHECK_S, clock=self._clock)
        except _Abort:
            return False
        if status != 200 or not isinstance(body, dict):
            return False
        return body.get(self._status.field) in self._status.idle

    def run(self, operation: str, params: Dict[str, Any]) -> RunResult:
        """Run one bound operation with already-checked params, and sign what the device reports."""
        binding = self._bindings.get(operation)
        if binding is None:
            return RunResult(False, error=f"unknown_operation:{operation}")
        try:
            body = _fill(binding.body, params)
        except KeyError as missing:
            return RunResult(False, error=f"param_missing:{missing.args[0]}")

        self._cancelled.clear()
        deadline = self._clock() + binding.timeout_s

        def call(method: str, path: str, payload: Any = None, max_bytes: int = _MAX_RESPONSE_BYTES):
            return _request(method, self._base + path, payload, deadline=deadline, clock=self._clock,
                            cancelled=self._cancelled.is_set, max_bytes=max_bytes)

        try:
            status, started = call(binding.method, binding.path, body)
        except _Abort as stop:
            # The device may or may not have started: its state is unknown.
            return RunResult(False, error=_stopped(stop.reason))
        if not 200 <= status < 300:
            return RunResult(False, error=f"device_refused:{status}")
        run_id = started.get(binding.run_id_field) if isinstance(started, dict) else None
        if not isinstance(run_id, (str, int)) or isinstance(run_id, bool) or str(run_id) == "":
            return RunResult(False, error="no_run_id")
        run_id = str(run_id)
        if run_id in (".", "..") or len(run_id) > 256:
            return RunResult(False, error="bad_run_id")  # "." and ".." would change the polled path
        segment = quote(run_id, safe="")  # the device's id stays one path segment

        record: Any = started
        state = None
        try:
            while True:
                status, polled = call("GET", _run_path(binding.poll_path, segment))
                if status == 200 and isinstance(polled, dict):
                    record, state = polled, polled.get(binding.state_field)
                    if state in binding.done or state in binding.failed:
                        break
                if self._cancelled.is_set():
                    raise _Abort("cancelled")
                if self._clock() >= deadline:
                    raise _Abort("timeout")
                self._sleep(binding.poll_interval_s)
                if self._cancelled.is_set():
                    raise _Abort("cancelled")
        except _Abort as stop:
            evidence = self._evidence(operation, run_id, record, None)
            return RunResult(False, output=record, evidence=evidence, error=_stopped(stop.reason))

        log_text = None
        if binding.log_path is not None:
            try:
                status, fetched = call("GET", _run_path(binding.log_path, segment), max_bytes=_MAX_LOG_BYTES)
            except _Abort as stop:
                log.warning("run %s: log not fetched (%s)", run_id, stop.reason)
                status, fetched = 0, None
            if status == 200:
                log_text = fetched if isinstance(fetched, str) else canonicalize(fetched)
        evidence = self._evidence(operation, run_id, record, log_text)
        if state in binding.done:
            return RunResult(True, output=record, evidence=evidence)
        return RunResult(False, output=record, evidence=evidence, error=f"run_{state}")

    def _evidence(self, operation: str, run_id: str, record: Any, log_text: Optional[str]) -> dict:
        """The device's own account of the run, as signed log-chain entries.

        Each job gets a fresh chain from GENESIS, so its evidence verifies on its own.
        """
        capture = LogCapture(*self._keys)
        captured_at = _now()
        chain = [capture.capture(
            canonicalize({"operation": operation, "record": record, "runId": run_id}),
            f"{self._source}:run", captured_at, entry_id=f"{run_id}:record",
        )]
        if log_text is not None:
            chain.append(capture.capture(log_text, f"{self._source}:log", captured_at, entry_id=f"{run_id}:log"))
        return {"operation": operation, "runId": run_id, "record": record, "logChain": chain, "signer": self.signer}


def _run_path(template: str, segment: str) -> str:
    """The device path for one run. The run id is one quoted segment, never "." or ".."."""
    path = template.replace(_RUN_ID, segment)
    if any(part in (".", "..") for part in path.split("/")):
        raise _Abort("bad_run_id")
    return path


def _stopped(reason: str) -> str:
    """A result error for a stopped request. After a timeout or cancel the device's state is unknown."""
    return f"{reason}:device_state_unknown" if reason in ("timeout", "cancelled") else reason
