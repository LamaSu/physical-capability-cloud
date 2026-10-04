"""pcc-node's JobPort for the operating agent (ADK item 12).

The operating loop takes work from, and reports work to, the PCC gateway through
this port. It uses only the node's own routes, with the operator's API key:

- ``claim_next``: ``GET /api/operator/jobs?kernelId=…&status=queued``, then the
  gateway's atomic claim, ``POST /api/operator/jobs/:id/claim``. That is a
  compare-and-set from ``queued`` which answers 200 with a ``claimToken`` and the
  lease (``leaseSeconds``) exactly once, and 409 to everyone else, so two nodes can
  never both run one job (verdict 117). Until the gateway serves that route,
  nothing is claimed.
- **The lease** (verdicts 117b and 117c): the gateway's lease ends a claim, and
  at its expiry the job fails (``lease_expired``) rather than going back to the
  queue, since a node that lost its lease may still be driving the device. A
  claimed job carries a :class:`Lease` that renews itself in the background
  (``POST /api/operator/jobs/:id/claim/renew``) at half its remaining time.
  The node reads the lease's length, ``leaseSeconds``, from the claim and each
  renewal, and counts it on its own monotonic clock from when it *sent* that
  request. That is never later than the gateway's own start, so no clock skew
  can stretch it, and ``leaseExpiresAt`` is not used. It treats the lease as
  over a margin early (a quarter of it, at most 5 s), and at once when a
  renewal is refused. A renewal that answers after the lease lapsed is
  discarded: a lapsed lease stays lapsed. ``ClaimedJob.lease_alive()`` is what
  the runtime checks before and throughout a run. A claim with no usable lease
  (no ``leaseSeconds``, or too short to run in) is never run. It is failed
  (``claim_lease_unusable``), and until the gateway applies that, the port owes
  it and retries on each ``claim_next`` (``owed_failures()``).
- ``resolve_params``: on the current gateway a polled job carries no parameters
  (board G6). The buyer's selections live in the job's negotiation session:
  ``GET /api/jobs/:id/settlement`` gives ``session.id``, then
  ``GET /api/negotiate/session/:id`` gives ``session.selections``.
- ``report``: first checks the runtime's evidence, exactly. It must have the
  runtime's shape and nothing else, at every level, so no unsigned field can
  ride inside the bundle the node signs (verdict 117b). Its operation, run id
  and record must match, its record must be portable JSON, and its log chain
  must come from this node's key, unbroken. Its first entry must commit to this
  claim, job and kernel as well as the operation, run and record, so evidence
  made for another claim is refused. Evidence that fails a check is never
  signed. Then it signs a bundle binding the job, the kernel, the claim's digest
  and that evidence: ``bundleHash`` is sha256 over its canonical JSON (the same
  canonical form as ``@pcc/spec``), and ``kernelSignature`` is the node key's
  Ed25519 signature over that hash. The device record travels as canonical
  text (``recordCanonical``, schema ``pcc-node.job-evidence/1``): hash it as a
  string; it parses back exactly with any JSON parser. Posted to
  ``POST /api/operator/evidence`` with the claim token.
- ``complete``: ``POST /api/operator/job-status`` ``completed`` or ``failed``,
  with the reason and the claim token, then ends the lease. A job whose evidence
  was not stored is never marked ``completed``.

``report`` and ``complete`` return what the gateway acknowledged
(:class:`ReportAck`, :class:`CompleteAck`), so the loop's outcome can follow
the gateway rather than the request. The port signs only bundles; only it knows
the job id the bundle must bind.
"""

import logging
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Set, Tuple
from urllib.parse import quote

from pcc_node.http_util import pcc_request
from pcc_node.log_capture import (
    GENESIS, assert_ed25519_available, canonicalize, compute_entry_hash, sha256_hex, sign_ed25519_utf8,
)
from pcc_node.operating.commitment import EVIDENCE_SCHEMA, claim_digest, portable, record_commitment

log = logging.getLogger("pcc-node.operating.jobport")

Request = Callable[..., Tuple[int, Any]]

# The node's lease ends this long before the gateway's: a quarter of the time left, at most 5 s.
_LEASE_MARGIN_FRACTION = 0.25
_LEASE_MARGIN_MAX_S = 5.0
_LEASE_MIN_WINDOW_S = 0.5
_RENEW_MIN_WAIT_S = 0.1
# A claim is renewed for at most the longest operation (24 h) plus an hour, even if never completed.
_MAX_HOLD_S = 86400.0 + 3600.0

# The runtime's evidence, exactly: anything else is refused before it can be signed (verdict 117b).
_EVIDENCE_KEYS = frozenset({"operation", "runId", "record", "logChain", "signer"})
_EVENT_KEYS = frozenset({"type", "timestamp", "payload"})
_PAYLOAD_KEYS = frozenset({"entryId", "entryHash", "previousHash", "source", "capturedAt", "kernelSignature",
                           "rawContent"})
_SIGNATURE_KEYS = frozenset({"signer", "algorithm", "value"})


def _parse_lease_seconds(value: Any) -> Optional[float]:
    """leaseSeconds, the lease length the gateway applied, or None: a finite number in (0, 86400]."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    seconds = float(value)
    return seconds if math.isfinite(seconds) and 0 < seconds <= 86400 else None


Renewal = Tuple[str, Optional[float], Optional[float]]


class Lease:
    """A claim's lease: alive until a margin before it ends on the node's monotonic clock, renewed in the background.

    The lease runs ``lease_seconds`` from ``sent_at``, the monotonic time the claim (or renewal)
    request was sent. ``renew()`` returns ``("ok", lease_seconds, sent_at)``, ``("refused", None,
    None)`` when the gateway says the lease is gone, or ``("error", None, None)`` for anything
    transient, which is retried until the lease runs out. A lease that lapsed or was refused
    stays over, even if a renewal sent before the lapse answers after it.
    """

    def __init__(self, job_id: str, lease_seconds: Optional[float], sent_at: float, renew: Callable[[], Renewal], *,
                 clock: Callable[[], float] = time.monotonic, max_hold_s: float = _MAX_HOLD_S) -> None:
        self._renew = renew
        self._clock = clock
        self._lock = threading.Lock()
        self._release = threading.Event()
        self._hold_until = clock() + max_hold_s
        deadline = self._local_deadline(lease_seconds, sent_at)
        self._dead = deadline is None
        self._deadline = deadline if deadline is not None else clock()
        if not self._dead:
            threading.Thread(target=self._keep, name=f"pcc-lease-{job_id}", daemon=True).start()

    def usable(self) -> bool:
        """Whether the gateway's lease left the node any time to run in."""
        return not self._dead

    def _local_deadline(self, lease_seconds: Optional[float], sent_at: Optional[float]) -> Optional[float]:
        if lease_seconds is None or sent_at is None:
            return None
        deadline = sent_at + lease_seconds - min(_LEASE_MARGIN_MAX_S, lease_seconds * _LEASE_MARGIN_FRACTION)
        if deadline - self._clock() <= _LEASE_MIN_WINDOW_S:
            return None
        return deadline

    def alive(self) -> bool:
        with self._lock:
            if not self._dead and self._clock() >= self._deadline:
                self._dead = True  # a lease that lapsed stays lapsed, even if a late renewal succeeds
            return not self._dead

    def release(self) -> None:
        """End the lease: the job is finished, or abandoned."""
        with self._lock:
            self._dead = True
        self._release.set()

    def _keep(self) -> None:
        while True:
            with self._lock:
                now = self._clock()
                if self._dead or now >= self._deadline:
                    self._dead = True
                    return
                if now >= self._hold_until:
                    return  # stop renewing; the lease runs out on its own
                wait = max(_RENEW_MIN_WAIT_S, (self._deadline - now) / 2)
            if self._release.wait(wait):
                return
            try:
                outcome, lease_seconds, sent_at = self._renew()
            except Exception:  # a renewal that cannot run is a transient failure
                outcome, lease_seconds, sent_at = "error", None, None
            with self._lock:
                if self._dead or self._clock() >= self._deadline:
                    self._dead = True  # the lease lapsed while the renewal was out: it stays lapsed
                    return
                if outcome == "refused":
                    self._dead = True
                    return
                if outcome == "ok":
                    deadline = self._local_deadline(lease_seconds, sent_at)
                    if deadline is None:
                        self._dead = True
                        return
                    self._deadline = deadline


@dataclass(frozen=True)
class ClaimedJob:
    """A job this node has claimed. ``job_id`` and ``operation`` are what the loop reads.

    The runtime reads ``job_id``, ``kernel_id`` and ``claim_token`` to bind its run to this
    claim, and ``lease_alive()`` before and throughout the run.
    """

    job_id: str
    operation: str
    capability_type: str
    claim_token: str = field(default="", repr=False)
    kernel_id: str = ""
    lease: Optional[Lease] = field(default=None, repr=False, compare=False)

    def lease_alive(self) -> bool:
        return self.lease is not None and self.lease.alive()


@dataclass(frozen=True)
class ReportAck:
    """Whether the gateway stored this job's evidence, and if not, why."""

    stored: bool
    reason: Optional[str] = None


@dataclass(frozen=True)
class CompleteAck:
    """The final status the port asked for, and whether the gateway applied it."""

    status: str
    accepted: bool
    reason: Optional[str] = None


class EvidenceInvalid(ValueError):
    """The runtime's evidence cannot be checked, so the port will not sign it."""


def _signature_ok(message: str, signature_hex: Any, public_hex: str) -> bool:
    import nacl.exceptions
    import nacl.signing

    try:
        nacl.signing.VerifyKey(bytes.fromhex(public_hex)).verify(message.encode("utf-8"), bytes.fromhex(signature_hex))
        return True
    except (TypeError, ValueError, nacl.exceptions.BadSignatureError):
        return False


class GatewayJobPort:
    """The loop's work source and sink, over a PCC gateway.

    ``operations_by_type`` maps a job's ``capabilityType`` to the profile's
    operation name. Jobs of any other type are left alone, never failed.
    Construction raises :class:`~pcc_node.log_capture.LogSigningRefused` without
    a genuine Ed25519 node key, so the port can never post unsigned evidence.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        kernel_id: str,
        operations_by_type: Dict[str, str],
        public_hex: str,
        secret_hex: str,
        *,
        status: str = "queued",
        request: Request = pcc_request,
    ) -> None:
        assert_ed25519_available(public_hex, secret_hex)
        self._base = base_url
        self._api_key = api_key
        self._kernel_id = kernel_id
        self._ops = dict(operations_by_type)
        self._public_hex = (public_hex[2:] if public_hex.lower().startswith("0x") else public_hex).lower()
        self._signer = "0x" + self._public_hex
        self._secret_hex = secret_hex
        self._status = status
        self._request = request
        self._seen: Set[str] = set()
        self._stored: Dict[str, bool] = {}
        self._failure: Dict[str, str] = {}
        # Claims this node failed (claim_lease_unusable) that the gateway has not applied yet: job -> token.
        self._owed: Dict[str, str] = {}

    def owed_failures(self) -> Tuple[str, ...]:
        """Jobs this node must fail but the gateway has not yet applied: retried on each claim_next."""
        return tuple(self._owed)

    def _settle_owed(self) -> None:
        for job_id, token in list(self._owed.items()):
            accepted, status = self._post_status(job_id, token, "failed", "claim_lease_unusable")
            if accepted or status == 409:  # applied, or the claim is gone (the gateway ended it)
                del self._owed[job_id]

    def _call(self, method: str, path: str, body: Optional[dict] = None) -> Tuple[int, Any]:
        return self._request(method, path, body, base_url=self._base, api_key=self._api_key)

    def claim_next(self, kernel_id: str) -> Optional[ClaimedJob]:
        """Atomically claim the next queued job this node can run, with a live lease, or return None."""
        if kernel_id != self._kernel_id:
            log.warning("asked to claim for kernel %s, but this port serves %s", kernel_id, self._kernel_id)
            return None
        self._settle_owed()
        status, body = self._call("GET", f"/api/operator/jobs?kernelId={quote(kernel_id, safe='')}&status={quote(self._status, safe='')}")
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("jobs"), list):
            return None
        for job in body["jobs"]:
            if not isinstance(job, dict):
                continue
            job_id, cap_type = job.get("id"), job.get("capabilityType")
            if not isinstance(job_id, str) or not job_id or job_id in self._seen:
                continue
            if job.get("kernelId") not in (None, self._kernel_id):
                continue
            operation = self._ops.get(cap_type) if isinstance(cap_type, str) else None
            if operation is None:
                log.info("job %s: no operation for capability type %r; leaving it", job_id, cap_type)
                continue
            sent_at = time.monotonic()  # the lease is counted from here, never from the gateway's clock
            status, claimed = self._call("POST", f"/api/operator/jobs/{quote(job_id, safe='')}/claim",
                                         {"kernelId": self._kernel_id})
            if not isinstance(claimed, dict):
                log.warning("job %s: not claimed (HTTP %s, malformed answer)", job_id, status)
                continue
            token = claimed.get("claimToken")
            if not (status == 200 and claimed.get("claimed") is True and claimed.get("jobId") == job_id
                    and isinstance(token, str) and token):
                log.warning("job %s: not claimed (HTTP %s)", job_id, status)
                continue
            # Seen only once claimed: a refused or failed claim is tried again next time.
            self._seen.add(job_id)
            lease = Lease(job_id, _parse_lease_seconds(claimed.get("leaseSeconds")), sent_at,
                          lambda job_id=job_id, token=token: self._renew(job_id, token))
            if not lease.usable():
                # The gateway gave this node the job, but no lease it can keep: never run it, and
                # fail it rather than strand it in_progress. Until that is applied, it is owed.
                log.warning("job %s: claimed without a usable lease; failing it", job_id)
                accepted, failed_status = self._post_status(job_id, token, "failed", "claim_lease_unusable")
                if not accepted and failed_status != 409:
                    self._owed[job_id] = token
                continue
            return ClaimedJob(job_id=job_id, operation=operation, capability_type=cap_type, claim_token=token,
                              kernel_id=self._kernel_id, lease=lease)
        return None

    def _renew(self, job_id: str, token: str) -> Renewal:
        sent_at = time.monotonic()
        status, answer = self._call("POST", f"/api/operator/jobs/{quote(job_id, safe='')}/claim/renew",
                                    {"claimToken": token})
        if status == 409 or (status == 200 and isinstance(answer, dict) and answer.get("renewed") is False):
            return "refused", None, None
        if status == 200 and isinstance(answer, dict):
            lease_seconds = _parse_lease_seconds(answer.get("leaseSeconds"))
            if lease_seconds is not None:
                return "ok", lease_seconds, sent_at
        return "error", None, None

    def resolve_params(self, job: ClaimedJob) -> Optional[Dict[str, Any]]:
        """The buyer's selections from the job's negotiation session, or None."""
        status, settlement = self._call("GET", f"/api/jobs/{quote(job.job_id, safe='')}/settlement")
        session = settlement.get("session") if status == 200 and isinstance(settlement, dict) else None
        session_id = session.get("id") if isinstance(session, dict) else None
        if not isinstance(session_id, str) or not session_id:
            return None
        status, found = self._call("GET", f"/api/negotiate/session/{quote(session_id, safe='')}")
        row = found.get("session") if status == 200 and isinstance(found, dict) else None
        selections = row.get("selections") if isinstance(row, dict) else None
        return dict(selections) if isinstance(selections, dict) else None

    def _check_evidence(self, job: ClaimedJob, evidence: Any) -> None:
        """Raise EvidenceInvalid unless the evidence is exactly this node's signed account of a run under this claim."""
        try:
            self._check_evidence_exactly(job, evidence)
        except EvidenceInvalid:
            raise
        except (TypeError, ValueError, UnicodeError, RecursionError) as why:
            raise EvidenceInvalid("unreadable") from why

    def _check_evidence_exactly(self, job: ClaimedJob, evidence: Any) -> None:
        if not isinstance(evidence, dict) or set(evidence) != _EVIDENCE_KEYS:
            raise EvidenceInvalid("not_runtime_evidence")
        if evidence["operation"] != job.operation:
            raise EvidenceInvalid("operation_mismatch")
        run_id = evidence["runId"]
        if not isinstance(run_id, str) or not run_id or len(run_id) > 256:
            raise EvidenceInvalid("no_run_id")
        record = evidence["record"]
        if record is None:
            raise EvidenceInvalid("no_record")
        if not portable(record):
            raise EvidenceInvalid("record_not_portable")
        if evidence["signer"] != self._signer:
            raise EvidenceInvalid("foreign_signer")
        if not isinstance(job.claim_token, str) or not job.claim_token:
            raise EvidenceInvalid("no_claim")
        chain = evidence["logChain"]
        if not isinstance(chain, list) or not chain:
            raise EvidenceInvalid("empty_chain")
        if len(chain) > 2:
            raise EvidenceInvalid("chain_too_long")  # the runtime writes the record, then at most a log
        previous = GENESIS
        for i, event in enumerate(chain):
            if not isinstance(event, dict) or set(event) != _EVENT_KEYS or event["type"] != "log_hash_chain_entry":
                raise EvidenceInvalid(f"entry_{i}_malformed")
            payload = event["payload"]
            if not isinstance(payload, dict) or set(payload) != _PAYLOAD_KEYS:
                raise EvidenceInvalid(f"entry_{i}_malformed")
            raw, source, captured_at = payload["rawContent"], payload["source"], payload["capturedAt"]
            if not all(isinstance(v, str) for v in (raw, source, captured_at)):
                raise EvidenceInvalid(f"entry_{i}_malformed")
            # The fields no signature covers must be the ones the runtime derives.
            if event["timestamp"] != captured_at or payload["entryId"] != f"{run_id}:{'record' if i == 0 else 'log'}":
                raise EvidenceInvalid(f"entry_{i}_malformed")
            if payload["previousHash"] != previous:
                raise EvidenceInvalid(f"entry_{i}_broken_link")
            entry_hash = compute_entry_hash(raw, source, captured_at)
            if payload["entryHash"] != entry_hash:
                raise EvidenceInvalid(f"entry_{i}_hash_mismatch")
            signature = payload["kernelSignature"]
            if (not isinstance(signature, dict) or set(signature) != _SIGNATURE_KEYS
                    or signature["signer"] != self._signer or signature["algorithm"] != "ed25519"
                    or not _signature_ok(entry_hash, signature["value"], self._public_hex)):
                raise EvidenceInvalid(f"entry_{i}_bad_signature")
            previous = entry_hash
        committed = record_commitment(job.claim_token, job.job_id, self._kernel_id, job.operation, record, run_id)
        if chain[0]["payload"]["rawContent"] != committed:
            raise EvidenceInvalid("record_not_committed")

    def report(self, job: ClaimedJob, evidence: Dict[str, Any]) -> ReportAck:
        """Check the runtime's evidence, sign a bundle binding it to this job and claim, and post it."""
        self._stored[job.job_id] = False
        try:
            self._check_evidence(job, evidence)
        except EvidenceInvalid as why:
            reason = f"evidence_invalid:{why}"
            self._failure[job.job_id] = reason
            log.warning("job %s: evidence not signed (%s)", job.job_id, why)
            return ReportAck(stored=False, reason=reason)
        bundle = {
            "schema": EVIDENCE_SCHEMA,
            "jobId": job.job_id,
            "kernelId": self._kernel_id,
            "claim": claim_digest(job.claim_token),
            "operation": job.operation,
            "runId": evidence["runId"],
            "recordCanonical": canonicalize(evidence["record"]),
            "logChain": evidence["logChain"],
            "signerPublicKey": self._signer,
        }
        bundle_hash = sha256_hex(canonicalize(bundle))
        bundle["bundleHash"] = bundle_hash
        bundle["kernelSignature"] = {
            "signer": self._signer,
            "algorithm": "ed25519",
            "value": sign_ed25519_utf8(bundle_hash, self._public_hex, self._secret_hex),
        }
        status, stored = self._call("POST", "/api/operator/evidence", {
            "jobId": job.job_id, "kernelId": self._kernel_id, "claimToken": job.claim_token,
            "evidence": {"bundle": bundle},
        })
        ok = (status == 200 and isinstance(stored, dict) and stored.get("stored") is True
              and stored.get("jobId") == job.job_id)
        self._stored[job.job_id] = ok
        if not ok:
            self._failure[job.job_id] = "evidence_not_stored"
            log.warning("job %s: evidence not stored (HTTP %s)", job.job_id, status)
            return ReportAck(stored=False, reason="evidence_not_stored")
        return ReportAck(stored=True)

    def _post_status(self, job_id: str, token: str, final: str, reason: Optional[str]) -> Tuple[bool, int]:
        body: Dict[str, Any] = {"jobId": job_id, "kernelId": self._kernel_id, "status": final, "claimToken": token}
        if reason:
            body["metadata"] = {"reason": reason}
        status, answer = self._call("POST", "/api/operator/job-status", body)
        accepted = status == 200 and isinstance(answer, dict) and answer.get("updated") is True
        if not accepted:
            log.warning("job %s: final status %s not applied (HTTP %s)", job_id, final, status)
        return accepted, status

    def complete(self, job: ClaimedJob, *, passed: bool, reason: Optional[str]) -> CompleteAck:
        """Finish the job the node's way, say whether the gateway applied it, and end the lease.

        Never ``completed`` without stored evidence.
        """
        if passed and not self._stored.get(job.job_id):
            passed, reason = False, self._failure.get(job.job_id, "evidence_not_stored")
        final = "completed" if passed else "failed"
        try:
            accepted, _ = self._post_status(job.job_id, job.claim_token, final, reason)
        finally:
            if job.lease is not None:
                job.lease.release()
        return CompleteAck(status=final, accepted=accepted, reason=reason)
