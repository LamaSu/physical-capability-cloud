"""pcc-node's DeviceRuntime for the operating agent (ADK item 12).

The operating loop (refvertical's ``loop.py``) owns the job contract: resolve a
job's parameters, type-check and envelope-check them, check the device is idle,
then call ``run(operation, params, claim=job)`` exactly once. This module is the
only part that touches the device, and it keeps these promises:

1. **A job never chooses the request.** Each operation is bound, in the
   operating profile, to one fixed request: method, path and body template.
   Parameters fill only the template's declared slots, and any other key is
   ignored. No method, path, host or URL is ever read from a job (board N87).
   Paths are checked when the profile is loaded, the device URL must name its
   port, and redirects are never followed.
2. **Evidence is signed or absent.** The runtime refuses to start without a
   genuine Ed25519 key (pynacl), and every record it returns is a signed
   ``log_hash_chain_entry`` from :class:`~pcc_node.log_capture.LogCapture`.
3. **A run belongs to its claim** (verdict 117b). The first entry of its log
   chain commits to the claim, the job and the kernel, so its evidence can be
   signed for no other job. The start request carries an ``Idempotency-Key``
   derived from the claim. The run never starts without a live lease, and it
   stops the moment the lease is lost.
4. **Device I/O is bounded and interruptible** (verdicts 117 and 117b). Every
   answer is capped in size. A watchdog shuts the request's socket the moment
   the run is cancelled, its lease is lost, or the operation's total deadline
   passes: a header wait, a stalled read or a slow connect never outlives
   them. A run id of "." or ".." is refused before it can change a path.
5. **The result says whether the device may be running.** Once any byte of the
   start request has left the node, every failure is labelled
   ``<reason>:device_state_unknown``: a lost connection, any answer that is not
   2xx (a 303 can follow a processed POST, a 409 can name a run that exists), a
   timeout, a cancel, a lost lease, an unusable run id, or any error while
   following the run (verdict 117c). A clean refusal (``device_refused:<status>``)
   is only a 4xx the operation's binding declares in ``request.refusals``: the
   device's own promise that it sends that answer before any side effect. A stop
   before anything was sent is ``<reason>:not_started``, and a device that could
   not be reached is ``device_unreachable``. A cancel or a lost lease that
   interrupts the log fetch, after the run finished, is ``<reason>:run_finished``.
6. **Each job is its own log chain**, starting at GENESIS, so every job's
   evidence verifies on its own.

:meth:`AdapterRuntime.cancel` cancels the run in progress, or the next run if
none is: a cancel is never erased by the run that follows it.

This first cut drives generic-HTTP devices, the kind with their own run API
(``POST /runs``, poll ``GET /runs/{runId}``). OctoPrint and Opentrons bindings
come next. It must not be armed for physical work until the emergency stop's
device half returns (held out of #454), since nothing here can stop a device
whose run outlived its deadline.
"""

import errno
import http.client
import json
import logging
import os
import re
import select
import socket
import ssl
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import quote, urlparse

from pcc_node.http_util import USER_AGENT
from pcc_node.log_capture import LogCapture, canonicalize
from pcc_node.operating.commitment import idempotency_key, portable, record_commitment

log = logging.getLogger("pcc-node.operating.runtime")

_SLOT = re.compile(r"^\{([A-Za-z_][A-Za-z0-9_]*)\}$")
_RUN_ID = "{runId}"
_METHODS = ("POST", "PUT")
# Bounds on what a device may send back (verdict 117).
_MAX_RESPONSE_BYTES = 1 << 20
_MAX_LOG_BYTES = 4 << 20
_IDLE_CHECK_S = 10.0
# How often a request, a connect or a wait between polls checks whether it must stop.
_WATCH_S = 0.02
_CONNECTING = {errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, getattr(errno, "WSAEWOULDBLOCK", errno.EWOULDBLOCK)}

Stop = Callable[[], Optional[str]]


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
    refusals: Tuple[int, ...] = ()

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
        refusals = request.get("refusals", [])
        if (not isinstance(refusals, list) or len(set(refusals)) != len(refusals)
                or not all(isinstance(c, int) and not isinstance(c, bool) and 400 <= c <= 499 for c in refusals)):
            raise BindingError(f"{where}.request.refusals must list distinct 4xx statuses the device sends "
                               "before any side effect")
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
            refusals=tuple(refusals),
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


class _Abort(Exception):
    """A device request stopped before its answer was complete: why, and whether any of it was sent."""

    def __init__(self, reason: str, sent: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.sent = sent


@dataclass(frozen=True)
class _Answer:
    """What a device request got back. status is 0 when no status line arrived; body is None when the
    body did not arrive whole; sent says whether any byte of the request left the node."""

    status: int
    body: Any
    sent: bool


def _stop_reason(deadline: float, clock: Callable[[], float], stop: Optional[Stop]) -> Optional[str]:
    reason = stop() if stop is not None else None
    if reason:
        return reason
    return "timeout" if clock() >= deadline else None


class _Watch:
    """Shuts a request's socket the moment it must stop: a cancel, a lost lease, or the deadline.

    A blocked connect, header wait or read then returns at once, instead of when the device
    next sends a byte (verdict 117b).
    """

    def __init__(self, deadline: float, clock: Callable[[], float], stop: Optional[Stop]) -> None:
        self._deadline, self._clock, self._stop = deadline, clock, stop
        self._sock: Optional[socket.socket] = None
        self._reason: Optional[str] = None
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._watch, name="pcc-device-io-watch", daemon=True)
        self._thread.start()

    def reason(self) -> Optional[str]:
        """Why the request must stop, if it must."""
        return self._reason or _stop_reason(self._deadline, self._clock, self._stop)

    def check(self) -> None:
        reason = self.reason()
        if reason:
            raise _Abort(reason)

    def arm(self, sock: socket.socket) -> None:
        with self._lock:
            self._sock = sock
            if self._reason:
                self._shut()

    def close(self) -> None:
        self._done.set()

    def _watch(self) -> None:
        while not self._done.wait(_WATCH_S):
            reason = _stop_reason(self._deadline, self._clock, self._stop)
            if reason:
                with self._lock:
                    self._reason = reason
                    self._shut()
                return

    def _shut(self) -> None:
        if self._sock is not None:
            try:
                self._sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _resolve(host: str, port: int, watch: _Watch) -> list:
    """getaddrinfo, abandoned (not waited for) if the request must stop first."""
    found: Dict[str, Any] = {}

    def lookup() -> None:
        try:
            found["infos"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as e:
            found["error"] = e

    worker = threading.Thread(target=lookup, name="pcc-device-resolve", daemon=True)
    worker.start()
    while worker.is_alive():
        watch.check()
        worker.join(_WATCH_S)
    if "error" in found:
        raise found["error"]
    return found["infos"]


def _connect(host: str, port: int, tls: bool, watch: _Watch) -> socket.socket:
    """A connected (and, for https, TLS-wrapped) socket. Every wait checks the watch, so a cancel,
    a lost lease or the deadline stops a slow connect too. Nothing has been sent when it raises."""
    last: Optional[OSError] = None
    for family, kind, proto, _, address in _resolve(host, port, watch):
        sock = socket.socket(family, kind, proto)
        try:
            sock.setblocking(False)
            err = sock.connect_ex(address)
            if err not in (0, *_CONNECTING):
                raise OSError(err, os.strerror(err))
            while err != 0:
                watch.check()
                _, writable, _ = select.select([], [sock], [], _WATCH_S)
                if writable:
                    err = sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                    if err:
                        raise OSError(err, os.strerror(err))
                    break
            if tls:
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host,
                                                                do_handshake_on_connect=False)
                while True:
                    watch.check()
                    try:
                        sock.do_handshake()
                        break
                    except ssl.SSLWantReadError:
                        select.select([sock], [], [], _WATCH_S)
                    except ssl.SSLWantWriteError:
                        select.select([], [sock], [], _WATCH_S)
            sock.setblocking(True)
            return sock
        except _Abort:
            sock.close()
            raise
        except OSError as e:
            sock.close()
            last = e
    raise last or OSError("the device's address did not resolve")


def _read_bounded(resp: http.client.HTTPResponse, max_bytes: int, watch: _Watch) -> str:
    """Read an answer in pieces, never more than max_bytes, never past the watch."""
    read1 = getattr(resp, "read1", None)
    chunks, total = [], 0
    while True:
        watch.check()
        chunk = read1(65536) if read1 is not None else resp.read(min(65536, max_bytes + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise _Abort("device_response_too_large")
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


def _request(method: str, url: str, body: Any = None, *, deadline: float, clock: Callable[[], float],
             stop: Optional[Stop] = None, max_bytes: int = _MAX_RESPONSE_BYTES,
             headers: Optional[Dict[str, str]] = None) -> _Answer:
    """One device request, bounded in size and time, and interruptible.

    Raises _Abort(reason, sent) when the deadline passes, stop() names a reason
    (cancelled, lease_lost), or the answer is too large. A transport failure is an
    _Answer with status 0 (none arrived) or with body None (the body did not arrive
    whole); its ``sent`` says whether the device may have received the request.
    """
    reason = _stop_reason(deadline, clock, stop)
    if reason:
        raise _Abort(reason)
    target = urlparse(url)
    path = target.path or "/"
    send_headers = {"User-Agent": USER_AGENT, "Accept": "application/json", "Connection": "close"}
    send_headers.update(headers or {})
    payload = None
    if body is not None:
        payload = json.dumps(body).encode("utf-8")
        send_headers["Content-Type"] = "application/json"
    if payload is not None or method in _METHODS:
        send_headers["Content-Length"] = str(len(payload or b""))  # putrequest does not add it
    watch = _Watch(deadline, clock, stop)
    conn: Optional[http.client.HTTPConnection] = None
    sent, status = False, 0
    try:
        try:
            sock = _connect(target.hostname, target.port, target.scheme == "https", watch)
        except OSError as e:
            return _Answer(0, {"error": str(e)}, False)
        sock.settimeout(max(_WATCH_S, deadline - clock()))  # a backstop: the watch acts first
        watch.arm(sock)
        conn = http.client.HTTPConnection(target.hostname, target.port)
        conn.sock = sock
        conn.putrequest(method, path, skip_accept_encoding=True)
        for name, value in send_headers.items():
            conn.putheader(name, value)
        watch.check()  # a stop that came during the connect: nothing has been sent yet
        sent = True  # from here on the device may have received the request
        conn.endheaders(payload)
        resp = conn.getresponse()
        status = resp.status
        raw = _read_bounded(resp, max_bytes, watch)
    except _Abort as halt:
        raise _Abort(halt.reason, sent)
    except (OSError, http.client.HTTPException) as e:
        reason = watch.reason()
        if reason:
            raise _Abort(reason, sent)
        return _Answer(status, None, sent) if status else _Answer(0, {"error": str(e)}, sent)
    finally:
        watch.close()
        if conn is not None:
            conn.close()
    try:
        return _Answer(status, json.loads(raw), sent)
    except ValueError:
        return _Answer(status, raw, sent)


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _claim_ok(claim: Any) -> bool:
    # Attributes by name only: the no-shell guard refuses a computed getattr (its rule 7).
    try:
        fields = (claim.job_id, claim.kernel_id, claim.claim_token)
        lease_alive = claim.lease_alive
    except AttributeError:
        return False
    return all(isinstance(f, str) and f for f in fields) and callable(lease_alive)


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
        self._sleep = sleep
        # Generation-scoped cancel (verdict 117b): a cancel names the run in progress, or the
        # next run if none is, and no run can erase it.
        self._gen_lock = threading.Lock()
        self._generation = 0
        self._cancel_upto = -1
        self._running = threading.Lock()

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
        """Stop the run in progress, or the next run if none is in progress.

        A run started after a cancel refuses without touching the device. A run stopped
        mid-way leaves the device's state unknown, and its result says so.
        """
        with self._gen_lock:
            self._cancel_upto = self._generation

    def is_idle(self) -> bool:
        """True only if the device answers and reports an idle state. Anything else is busy."""
        try:
            answer = _request("GET", self._base + self._status.path,
                              deadline=self._clock() + _IDLE_CHECK_S, clock=self._clock)
        except _Abort:
            return False
        if answer.status != 200 or not isinstance(answer.body, dict):
            return False
        return answer.body.get(self._status.field) in self._status.idle

    def run(self, operation: str, params: Dict[str, Any], *, claim: Any) -> RunResult:
        """Run one bound operation for a claimed job, with already-checked params, and sign what the device reports.

        ``claim`` is the job's claim (a :class:`~pcc_node.operating.jobport.ClaimedJob`): its
        ``job_id``, ``kernel_id`` and ``claim_token`` bind the request and the evidence to it,
        and the run stops, its device state unknown, the moment ``claim.lease_alive()`` is false.
        """
        if not self._running.acquire(blocking=False):
            return RunResult(False, error="busy")
        with self._gen_lock:
            generation = self._generation
        result = RunResult(False, error="runtime_error")
        try:
            result = self._run(operation, params, claim, generation)
            return result
        finally:
            with self._gen_lock:
                self._generation = generation + 1
                if self._cancel_upto >= generation and not (result.error or "").startswith("cancelled"):
                    # A cancel this run's result does not report (it came as the run finished)
                    # stops the next run instead: a cancel is never lost.
                    self._cancel_upto = generation + 1
            self._running.release()

    def _run(self, operation: str, params: Dict[str, Any], claim: Any, generation: int) -> RunResult:
        if not _claim_ok(claim):
            return RunResult(False, error="no_claim")
        binding = self._bindings.get(operation)
        if binding is None:
            return RunResult(False, error=f"unknown_operation:{operation}")
        try:
            body = _fill(binding.body, params)
        except KeyError as missing:
            return RunResult(False, error=f"param_missing:{missing.args[0]}")

        def stop() -> Optional[str]:
            if self._cancel_upto >= generation:
                return "cancelled"
            try:
                alive = claim.lease_alive()
            except Exception:  # a lease that cannot answer is not alive
                alive = False
            return None if alive is True else "lease_lost"

        reason = stop()
        if reason:
            return RunResult(False, error=f"{reason}:not_started")
        deadline = self._clock() + binding.timeout_s

        def call(method: str, path: str, payload: Any = None, *, max_bytes: int = _MAX_RESPONSE_BYTES,
                 headers: Optional[Dict[str, str]] = None) -> _Answer:
            return _request(method, self._base + path, payload, deadline=deadline, clock=self._clock,
                            stop=stop, max_bytes=max_bytes, headers=headers)

        try:
            json.dumps(body)
        except (TypeError, ValueError):
            return RunResult(False, error="param_not_json:not_started")
        key = idempotency_key(claim.job_id, claim.kernel_id, claim.claim_token)
        try:
            started = call(binding.method, binding.path, body, headers={"Idempotency-Key": key})
        except _Abort as halt:
            return RunResult(False, error=_label(halt.reason, halt.sent))
        except Exception:  # whatever went wrong, the request may have left the node
            log.exception("start request failed unexpectedly")
            return RunResult(False, error="internal_error:device_state_unknown")
        if not started.sent:
            return RunResult(False, error="device_unreachable")
        if started.status in binding.refusals:
            return RunResult(False, error=f"device_refused:{started.status}")  # declared: sent before any side effect
        if not 200 <= started.status < 300:
            what = "connection_lost" if started.status == 0 else f"device_error:{started.status}"
            return RunResult(False, error=f"{what}:device_state_unknown")
        try:
            return self._follow(binding, operation, started, claim, call, stop, deadline)
        except Exception:  # the device was started: a bug here must not hide that
            log.exception("following the run failed unexpectedly")
            output = started.body if isinstance(started.body, dict) else None
            return RunResult(False, output=output, error="internal_error:device_state_unknown")

    def _follow(self, binding: OperationBinding, operation: str, started: _Answer, claim: Any,
                call: Callable[..., _Answer], stop: Stop, deadline: float) -> RunResult:
        """Everything after a start the device accepted: its run id, the polls, the log, the evidence."""
        run_id = started.body.get(binding.run_id_field) if isinstance(started.body, dict) else None
        if not isinstance(run_id, (str, int)) or isinstance(run_id, bool) or str(run_id) == "":
            return RunResult(False, error="no_run_id:device_state_unknown")  # it started, and cannot be followed
        run_id = str(run_id)
        if run_id in (".", "..") or len(run_id) > 256 or not portable(run_id):
            # "." and ".." would change the path; an id that is not valid Unicode cannot be quoted
            return RunResult(False, error="bad_run_id:device_state_unknown")
        segment = quote(run_id, safe="")  # the device's id stays one path segment

        record: Any = started.body
        state = None
        try:
            while True:
                polled = call("GET", _run_path(binding.poll_path, segment))
                if polled.status == 200 and isinstance(polled.body, dict):
                    record, state = polled.body, polled.body.get(binding.state_field)
                    if state in binding.done or state in binding.failed:
                        break
                reason = _stop_reason(deadline, self._clock, stop)
                if reason:
                    raise _Abort(reason, True)
                self._wait(binding.poll_interval_s, deadline, stop)
        except _Abort as halt:
            # The device was started: whatever stopped the run, its state is unknown.
            evidence = self._evidence(operation, run_id, record, None, claim)
            return RunResult(False, output=record, evidence=evidence, error=f"{halt.reason}:device_state_unknown")

        log_text = None
        if binding.log_path is not None:
            try:
                fetched = call("GET", _run_path(binding.log_path, segment), max_bytes=_MAX_LOG_BYTES)
                if fetched.status == 200 and fetched.body is not None:
                    log_text = fetched.body if isinstance(fetched.body, str) else canonicalize(fetched.body)
            except _Abort as halt:
                if halt.reason in ("cancelled", "lease_lost"):
                    # Control was lost after the run finished: say so, never report success (verdict 117c).
                    return RunResult(False, output=record, evidence=self._evidence(operation, run_id, record, None, claim),
                                     error=f"{halt.reason}:run_finished")
                log.warning("run %s: log not fetched (%s)", run_id, halt.reason)  # the log is optional
        if not portable(record):
            return RunResult(False, output=record, error="record_not_portable")
        evidence = self._evidence(operation, run_id, record, log_text, claim)
        if state in binding.done:
            return RunResult(True, output=record, evidence=evidence)
        return RunResult(False, output=record, evidence=evidence, error=f"run_{state}")

    def _wait(self, seconds: float, deadline: float, stop: Stop) -> None:
        """The pause between polls, in slices, cut short by a cancel, a lost lease or the deadline.

        An injected ``sleep`` is called for one slice at a time too, so it cannot carry a run past
        any of them (verdict 117c).
        """
        nap = self._sleep or time.sleep
        end = self._clock() + seconds
        while True:
            reason = _stop_reason(deadline, self._clock, stop)
            if reason:
                raise _Abort(reason, True)
            left = min(end, deadline) - self._clock()
            if left <= 0:
                if self._clock() >= deadline:
                    raise _Abort("timeout", True)
                return
            nap(min(_WATCH_S, left))

    def _evidence(self, operation: str, run_id: str, record: Any, log_text: Optional[str], claim: Any) -> Optional[dict]:
        """The device's own account of the run, as signed log-chain entries bound to the claim.

        Each job gets a fresh chain from GENESIS, so its evidence verifies on its own. A record
        that is not portable JSON gets no evidence, and a log that is not valid Unicode is left out.
        """
        if not portable(record):
            return None
        capture = LogCapture(*self._keys)
        captured_at = _now()
        chain = [capture.capture(
            record_commitment(claim.claim_token, claim.job_id, claim.kernel_id, operation, record, run_id),
            f"{self._source}:run", captured_at, entry_id=f"{run_id}:record",
        )]
        if log_text is not None:
            if portable(log_text):
                chain.append(capture.capture(log_text, f"{self._source}:log", captured_at, entry_id=f"{run_id}:log"))
            else:
                log.warning("run %s: log left out (not valid Unicode)", run_id)
        return {"operation": operation, "runId": run_id, "record": record, "logChain": chain, "signer": self.signer}


def _run_path(template: str, segment: str) -> str:
    """The device path for one run. The run id is one quoted segment, never "." or ".."."""
    path = template.replace(_RUN_ID, segment)
    if any(part in (".", "..") for part in path.split("/")):
        raise _Abort("bad_run_id")
    return path


def _label(reason: str, sent: bool) -> str:
    """A start request's stop: the device may be running once any of the request was sent."""
    return f"{reason}:device_state_unknown" if sent else f"{reason}:not_started"
