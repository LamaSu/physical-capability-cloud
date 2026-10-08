"""pcc-node's DeviceRuntime for an IPP printer: a print counts as done only when the printer says so.

#377 settled an accepted print when the printer reported it finished: ``lp`` spooled the job, and
the daemon asked the printer about that CUPS job-id once per cycle. On master the daemon takes no
jobs and a device runs only through the operating agent's typed operations, so the same rule lives
here, beside :class:`~pcc_node.operating.runtime.AdapterRuntime` (the generic-HTTP runtime), with
the same contract: the operating loop resolves and checks a job's parameters, checks the device is
idle, then calls ``run(operation, params, claim=job)`` exactly once.

1. **A job never chooses the request.** The operating profile fixes the printer's address and
   path, and each operation's document format and job name. A job's parameters fill only the
   operation's one document slot, and that value must be text (sent as UTF-8, at most 1 MiB).
2. **One Print-Job, never resent.** IPP has no idempotency key, so a second Print-Job could print
   the document twice.
3. **A completion is read only through the job-id the printer created for THIS print**, taken from
   its own answer to the Print-Job (#377 round 3), and only from the printer's own job-state for
   that job (:func:`~pcc_node.operating.ipp.ipp_completion_verdict`): job-state 9 with clean
   reasons, in an answer that echoes our request-id and names our job-id. The Print-Job answer is
   acceptance, never a completion (#343, #558).
4. **The run belongs to its claim**, as in AdapterRuntime, whose ``run()``, ``cancel()``, wait and
   evidence signing this class inherits rather than copies: the run never starts without a live
   lease, it stops the moment it is cancelled or the lease is lost, and its evidence is the node's
   signed record of what the printer answered, committed to the claim, the job and the kernel. The
   printer's own number is ``ippJobId`` in that record, never ``jobId``, which LO-EV-9 keeps for the
   PCC job.
5. **Device I/O is bounded and interruptible** on runtime.py's watch: every answer is capped in
   size, every request stops at the run's deadline, a cancel or a lost lease, and each status
   request also stops after :data:`POLL_REQUEST_TIMEOUT_S`, so one stalled answer cannot spend the
   whole budget.
6. **The result says whether the printer may be printing.** Once any byte of the Print-Job has left
   the node, every failure is ``<reason>:device_state_unknown``. An answer that arrives after the
   run was cancelled, its lease was lost or its deadline passed is discarded, even a completion
   (#377 round-1 finding 5); if it was terminal the result is ``<reason>:run_finished``.
7. **A cancel stops following the job, not the print**: no IPP Cancel-Job is sent. The emergency
   stop's device half is held out of #454, as for AdapterRuntime, and like it this runtime must not
   be armed for physical work until that returns.
"""

import http.client
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

from pcc_node.http_util import USER_AGENT
from pcc_node.operating.ipp import (
    IPP_INT_MAX,
    IPP_STATUS_SUCCESS_MAX,
    POLL_COMPLETED,
    POLL_FAILED,
    POLL_UNOBSERVABLE,
    POLL_WAITING,
    encode_get_job_attributes,
    encode_get_printer_attributes,
    encode_print_job,
    ipp_completion_verdict,
    print_job_answer,
    printer_is_idle,
)
# runtime.py's private helpers are imported relatively: the form the no-shell guard allows for a
# package-private name (its SAFE corpus has "from .crypto import _refuse_legacy").
from .runtime import (
    _IDLE_CHECK_S,
    _MAX_RESPONSE_BYTES,
    _SLOT,
    _WATCH_S,
    AdapterRuntime,
    BindingError,
    RunResult,
    _Abort,
    _Answer,
    _check_path,
    _claim_ok,
    _connect,
    _label,
    _stop_reason,
    _Watch,
)

log = logging.getLogger("pcc-node.operating.ipp-runtime")

# #377's defaults: at most one status request per job every 5 s, and an hour from the Print-Job to
# the printer's own completion. A profile may set each per operation.
DEFAULT_POLL_INTERVAL_S = 5.0
DEFAULT_TIMEOUT_S = 3600.0
# Each status request stops after this long, and never after the run's deadline, so a printer that
# stalls one answer is asked again (#377's COMPLETION_POLL_REQUEST_TIMEOUT_S).
POLL_REQUEST_TIMEOUT_S = 10.0
# The document is the UTF-8 text of one parameter, so only a text format can carry it.
DOCUMENT_FORMATS = ("text/plain",)
MAX_DOCUMENT_BYTES = 1 << 20
DEFAULT_JOB_NAME = "pcc-node"

Post = Callable[..., _Answer]


def _seconds(value: Any, default: float, where: str) -> float:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BindingError(f"{where} must be a number of seconds")
    return float(value)


@dataclass(frozen=True)
class IppOperation:
    """One typed operation's fixed print request: the parameter that holds the document, and how long to follow it."""

    document_slot: str
    document_format: str = DOCUMENT_FORMATS[0]
    job_name: str = DEFAULT_JOB_NAME
    poll_interval_s: float = DEFAULT_POLL_INTERVAL_S
    timeout_s: float = DEFAULT_TIMEOUT_S

    @classmethod
    def from_dict(cls, name: str, d: Any) -> "IppOperation":
        where = f"operations.{name}"
        if not isinstance(d, dict):
            raise BindingError(f"{where} must be an object")
        slot = d.get("document")
        match = _SLOT.match(slot) if isinstance(slot, str) else None
        if match is None:
            raise BindingError(f'{where}.document must be one parameter slot, such as "{{text}}"')
        document_format = d.get("documentFormat", DOCUMENT_FORMATS[0])
        if not isinstance(document_format, str) or document_format not in DOCUMENT_FORMATS:
            raise BindingError(f"{where}.documentFormat must be one of {', '.join(DOCUMENT_FORMATS)}: "
                               "the document is the text of one parameter")
        job_name = d.get("jobName", DEFAULT_JOB_NAME)
        if (not isinstance(job_name, str) or not 1 <= len(job_name) <= 255
                or any(not 0x20 <= ord(ch) <= 0x7E for ch in job_name)):
            raise BindingError(f"{where}.jobName must be 1 to 255 printable ASCII characters")
        poll = d.get("poll") or {}
        if not isinstance(poll, dict):
            raise BindingError(f"{where}.poll must be an object")
        interval = _seconds(poll.get("intervalS"), DEFAULT_POLL_INTERVAL_S, f"{where}.poll.intervalS")
        timeout = _seconds(poll.get("timeoutS"), DEFAULT_TIMEOUT_S, f"{where}.poll.timeoutS")
        if not (0 < interval <= 60 and 0 < timeout <= 86400):
            raise BindingError(f"{where}.poll: intervalS must be in (0, 60] and timeoutS in (0, 86400]")
        return cls(document_slot=match.group(1), document_format=document_format, job_name=job_name,
                   poll_interval_s=interval, timeout_s=timeout)


def _read_bytes(resp: http.client.HTTPResponse, max_bytes: int, watch: _Watch) -> bytes:
    """runtime._read_bounded without its text decode: an IPP answer is binary."""
    chunks, total = [], 0
    while True:
        watch.check()
        chunk = resp.read1(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise _Abort("device_response_too_large")
        chunks.append(chunk)
    return b"".join(chunks)


def post_ipp(url: str, payload: bytes, *, deadline: float, clock: Callable[[], float],
             stop: Optional[Callable[[], Optional[str]]] = None, max_bytes: int = _MAX_RESPONSE_BYTES) -> _Answer:
    """One IPP request (RFC 8010 sec 4: POST application/ipp), bounded in size and time, and interruptible.

    runtime._request's twin for a binary body, on the same watch. Raises ``_Abort(reason, sent)`` when
    the deadline passes, stop() names a reason (cancelled, lease_lost) or the answer is too large.
    Otherwise returns an ``_Answer``: status 0 when no status line arrived, body None when the body did
    not arrive whole, and ``sent`` saying whether the printer may have received the request. This is
    the transport an :class:`IppPrintRuntime` uses unless it is given another (``post=``).
    """
    reason = _stop_reason(deadline, clock, stop)
    if reason:
        raise _Abort(reason)
    target = urlparse(url)
    headers = {"User-Agent": USER_AGENT, "Content-Type": "application/ipp", "Accept": "application/ipp",
               "Connection": "close", "Content-Length": str(len(payload))}
    watch = _Watch(deadline, clock, stop)
    conn: Optional[http.client.HTTPConnection] = None
    sent, status = False, 0
    try:
        try:
            sock = _connect(target.hostname, target.port, target.scheme == "https", watch)
        except OSError:
            return _Answer(0, None, False)
        sock.settimeout(max(_WATCH_S, deadline - clock()))  # a backstop: the watch acts first
        watch.arm(sock)
        conn = http.client.HTTPConnection(target.hostname, target.port)
        conn.sock = sock
        conn.putrequest("POST", target.path or "/", skip_accept_encoding=True)
        for name, value in headers.items():
            conn.putheader(name, value)
        watch.check()  # a stop that came during the connect: nothing has been sent yet
        sent = True  # from here on the printer may have received the request
        conn.endheaders(payload)
        resp = conn.getresponse()
        status = resp.status
        raw = _read_bytes(resp, max_bytes, watch)
    except _Abort as halt:
        raise _Abort(halt.reason, sent)
    except (OSError, http.client.HTTPException):
        reason = watch.reason()
        if reason:
            raise _Abort(reason, sent)
        return _Answer(status, None, sent)
    finally:
        watch.close()
        if conn is not None:
            conn.close()
    return _Answer(status, raw, sent)


class IppPrintRuntime(AdapterRuntime):
    """Prints one document per typed operation on an IPP printer, and follows it to the printer's own outcome.

    Build it from the operating profile's ``device`` section with :meth:`from_profile`. Construction
    raises :class:`~pcc_node.log_capture.LogSigningRefused` when the node key is not a genuine Ed25519
    key, and :class:`~pcc_node.operating.runtime.BindingError` when the profile is unsafe or malformed.
    ``post`` replaces the network transport (:func:`post_ipp`); tests use it to stand in for a printer.
    """

    def __init__(
        self,
        url: str,
        path: str,
        operations: Dict[str, IppOperation],
        public_hex: str,
        secret_hex: str,
        *,
        source: str = "device",
        clock: Callable[[], float] = time.monotonic,
        sleep: Optional[Callable[[float], None]] = None,
        post: Optional[Post] = None,
    ) -> None:
        # AdapterRuntime checks the url, refuses a key that is not Ed25519, and keeps the generation-
        # scoped cancel. Its generic-HTTP status check and bindings stay empty: this class overrides
        # the only methods that read them (is_idle and _run).
        super().__init__(url, None, {}, public_hex, secret_hex, source=source, clock=clock, sleep=sleep)
        if not isinstance(operations, dict) or not operations:
            raise BindingError("device.operations must bind at least one operation")
        self._path = _check_path(path, "device.path")
        self._operations = dict(operations)
        scheme = urlparse(self._base).scheme
        # RFC 8010 sec 5: HTTP carries the request; the printer-uri attribute names the ipp(s) form.
        self._http_url = self._base + self._path
        self._printer_uri = ("ipps" if scheme == "https" else "ipp") + self._base[len(scheme):] + self._path
        if not self._printer_uri.isascii() or len(self._printer_uri) > 1023:
            raise BindingError("the printer's URI must be ASCII and at most 1023 characters")
        self._post: Post = post or post_ipp
        self._ids = threading.Lock()
        self._last_request_id = 0

    @classmethod
    def from_profile(cls, device: Dict[str, Any], public_hex: str, secret_hex: str, **kwargs) -> "IppPrintRuntime":
        """``device``: ``{"url": "http://host:631", "path": "/printers/<queue>", "operations": {name: op}}``.

        Each ``op`` is ``{"document": "{slot}", "documentFormat": "text/plain", "jobName": "...",
        "poll": {"intervalS": 5, "timeoutS": 3600}}``; only ``document`` is required.
        """
        operations = device.get("operations")
        if not isinstance(operations, dict) or not operations:
            raise BindingError("device.operations must bind at least one operation")
        return cls(
            device.get("url"),
            device.get("path"),
            {name: IppOperation.from_dict(name, op) for name, op in operations.items()},
            public_hex,
            secret_hex,
            **kwargs,
        )

    @property
    def printer_uri(self) -> str:
        """The ``printer-uri`` every request names."""
        return self._printer_uri

    def _next_request_id(self) -> int:
        with self._ids:
            self._last_request_id = self._last_request_id % IPP_INT_MAX + 1
            return self._last_request_id

    def is_idle(self) -> bool:
        """True only if the printer answers and reports printer-state idle (3). Anything else is busy."""
        request_id = self._next_request_id()
        try:
            answer = self._post(self._http_url, encode_get_printer_attributes(self._printer_uri, request_id),
                                deadline=self._clock() + _IDLE_CHECK_S, clock=self._clock, stop=None)
        except _Abort:
            return False
        return printer_is_idle(answer.status, answer.body, request_id)

    def _run(self, operation: str, params: Dict[str, Any], claim: Any, generation: int) -> RunResult:
        if not _claim_ok(claim):
            return RunResult(False, error="no_claim")
        binding = self._operations.get(operation)
        if binding is None:
            return RunResult(False, error=f"unknown_operation:{operation}")
        if binding.document_slot not in params:
            return RunResult(False, error=f"param_missing:{binding.document_slot}")
        text = params[binding.document_slot]
        try:
            document = text.encode("utf-8") if isinstance(text, str) else None
        except UnicodeEncodeError:  # a lone surrogate is not text a printer can be sent
            document = None
        if document is None:
            return RunResult(False, error="param_not_text:not_started")
        if len(document) > MAX_DOCUMENT_BYTES:
            return RunResult(False, error="param_too_large:not_started")

        def stop() -> Optional[str]:  # AdapterRuntime._run's, for the same claim and generation
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
        request_id = self._next_request_id()
        payload = encode_print_job(self._printer_uri, request_id, document,
                                   document_format=binding.document_format, job_name=binding.job_name)
        try:
            started = self._post(self._http_url, payload, deadline=deadline, clock=self._clock, stop=stop)
        except _Abort as halt:
            return RunResult(False, error=_label(halt.reason, halt.sent))
        except Exception:  # whatever went wrong, the request may have left the node
            log.exception("print request failed unexpectedly")
            return RunResult(False, error="internal_error:device_state_unknown")
        if not started.sent:
            return RunResult(False, error="device_unreachable")
        if started.status != 200:
            what = "connection_lost" if started.status == 0 else f"device_error:{started.status}"
            return RunResult(False, error=f"{what}:device_state_unknown")
        ipp_job_id, submitted = print_job_answer(started.status, started.body, request_id)
        if ipp_job_id is None:
            # The printer took the request and named no job we can follow: it may still print it.
            log.warning("print not followed: %s", submitted.get("reason"))
            code = submitted.get("ippStatusCode")
            if isinstance(code, str) and int(code, 16) > IPP_STATUS_SUCCESS_MAX:
                return RunResult(False, error=f"ipp_error:{code}:device_state_unknown")
            return RunResult(False, error="no_run_id:device_state_unknown")
        try:
            return self._follow_print(operation, binding, ipp_job_id, submitted, claim, stop, deadline)
        except Exception:  # the print was submitted: a bug here must not hide that
            log.exception("following the print failed unexpectedly")
            return RunResult(False, error="internal_error:device_state_unknown")

    def _follow_print(self, operation: str, binding: IppOperation, ipp_job_id: int, submitted: Dict[str, Any],
                      claim: Any, stop: Callable[[], Optional[str]], deadline: float) -> RunResult:
        """Ask the printer about its job ``ipp_job_id`` until it reports an outcome, the run stops, or time runs out."""
        run_id = str(ipp_job_id)
        record: Dict[str, Any] = {"printerUri": self._printer_uri, "ippJobId": ipp_job_id, "verdict": POLL_WAITING,
                                  "submitted": submitted, "observation": None}
        while True:
            request_id = self._next_request_id()
            try:
                answer = self._post(
                    self._http_url, encode_get_job_attributes(self._printer_uri, ipp_job_id, request_id),
                    deadline=min(deadline, self._clock() + POLL_REQUEST_TIMEOUT_S), clock=self._clock, stop=stop,
                )
                verdict, observation = ipp_completion_verdict(answer.status, answer.body, request_id, ipp_job_id)
            except _Abort as halt:
                if halt.reason in ("cancelled", "lease_lost"):
                    return self._stopped(operation, run_id, record, claim, halt.reason, finished=False)
                # This one request ran out of its own time, or answered too much: not an answer.
                verdict, observation = POLL_WAITING, {"httpStatus": 0, "reason": f"status request stopped: {halt.reason}"}
            record = dict(record, verdict=verdict, observation=observation)
            reason = _stop_reason(deadline, self._clock, stop)
            if reason:
                # Control or time ran out while this answer was on its way: it is discarded, even a
                # completion (#377 round-1 finding 5).
                return self._stopped(operation, run_id, record, claim, reason,
                                     finished=verdict in (POLL_COMPLETED, POLL_FAILED))
            if verdict == POLL_COMPLETED:
                evidence = self._evidence(operation, run_id, record, None, claim)
                if evidence is None:
                    return RunResult(False, output=record, error="record_not_portable")
                return RunResult(True, output=record, evidence=evidence)
            if verdict == POLL_FAILED:
                return RunResult(False, output=record, evidence=self._evidence(operation, run_id, record, None, claim),
                                 error="run_failed")
            if verdict == POLL_UNOBSERVABLE:
                return RunResult(False, output=record, evidence=self._evidence(operation, run_id, record, None, claim),
                                 error="outcome_unobservable:device_state_unknown")
            try:
                self._wait(binding.poll_interval_s, deadline, stop)
            except _Abort as halt:
                return self._stopped(operation, run_id, record, claim, halt.reason, finished=False)

    def _stopped(self, operation: str, run_id: str, record: Dict[str, Any], claim: Any, reason: str, *,
                 finished: bool) -> RunResult:
        """The run stopped before an outcome could count: the record so far, signed, and why."""
        evidence = self._evidence(operation, run_id, record, None, claim)
        state = "run_finished" if finished else "device_state_unknown"
        return RunResult(False, output=record, evidence=evidence, error=f"{reason}:{state}")
