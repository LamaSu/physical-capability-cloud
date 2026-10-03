"""pcc-node's JobPort for the operating agent (ADK item 12).

The operating loop takes work from, and reports work to, the PCC gateway through
this port. It uses only the node's own routes, with the operator's API key:

- ``claim_next``: ``GET /api/operator/jobs?kernelId=…&status=queued``, then the
  gateway's atomic claim, ``POST /api/operator/jobs/:id/claim``. That is a
  compare-and-set from ``queued`` which answers 200 with a ``claimToken`` exactly
  once and 409 to everyone else, so two nodes can never both run one job
  (verdict 117). Until the gateway serves that route, nothing is claimed.
- ``resolve_params``: on the current gateway a polled job carries no parameters
  (board G6). The buyer's selections live in the job's negotiation session:
  ``GET /api/jobs/:id/settlement`` gives ``session.id``, then
  ``GET /api/negotiate/session/:id`` gives ``session.selections``.
- ``report``: first checks the runtime's evidence. Its operation, run id,
  record and signed log chain must all be from this node's key, the chain
  unbroken, and its first entry must commit to that operation, run and record.
  Evidence that fails a check is never signed. Then it signs a bundle binding
  the job, the kernel and that evidence: ``bundleHash`` is sha256 over its
  canonical JSON (the same canonical form as ``@pcc/spec``), and
  ``kernelSignature`` is the node key's Ed25519 signature over that hash. The
  device record travels as canonical text (``recordCanonical``), so no device
  number has to render the same in Python and JavaScript. Posted to
  ``POST /api/operator/evidence`` with the claim token.
- ``complete``: ``POST /api/operator/job-status`` ``completed`` or ``failed``,
  with the reason and the claim token. A job whose evidence was not stored is
  never marked ``completed``.

``report`` and ``complete`` return what the gateway acknowledged
(:class:`ReportAck`, :class:`CompleteAck`), so the loop's outcome can follow
the gateway rather than the request. The port signs only bundles; only it knows
the job id the bundle must bind.
"""

import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set, Tuple
from urllib.parse import quote

from pcc_node.http_util import pcc_request
from pcc_node.log_capture import (
    GENESIS, assert_ed25519_available, canonicalize, compute_entry_hash, sha256_hex, sign_ed25519_utf8,
)

log = logging.getLogger("pcc-node.operating.jobport")

Request = Callable[..., Tuple[int, Any]]


@dataclass(frozen=True)
class ClaimedJob:
    """A job this node has claimed. ``job_id`` and ``operation`` are what the loop reads."""

    job_id: str
    operation: str
    capability_type: str
    claim_token: str = ""


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

    def _call(self, method: str, path: str, body: Optional[dict] = None) -> Tuple[int, Any]:
        return self._request(method, path, body, base_url=self._base, api_key=self._api_key)

    def claim_next(self, kernel_id: str) -> Optional[ClaimedJob]:
        """Atomically claim the next queued job this node can run, or return None."""
        if kernel_id != self._kernel_id:
            log.warning("asked to claim for kernel %s, but this port serves %s", kernel_id, self._kernel_id)
            return None
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
            status, claimed = self._call("POST", f"/api/operator/jobs/{quote(job_id, safe='')}/claim",
                                         {"kernelId": self._kernel_id})
            token = claimed.get("claimToken") if isinstance(claimed, dict) else None
            if (status == 200 and claimed.get("claimed") is True and claimed.get("jobId") == job_id
                    and isinstance(token, str) and token):
                # Seen only once claimed: a refused or failed claim is tried again next time.
                self._seen.add(job_id)
                return ClaimedJob(job_id=job_id, operation=operation, capability_type=cap_type, claim_token=token)
            log.warning("job %s: not claimed (HTTP %s)", job_id, status)
        return None

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
        """Raise EvidenceInvalid unless the evidence is this node's own signed account of this run."""
        if not isinstance(evidence, dict):
            raise EvidenceInvalid("not_an_object")
        if evidence.get("operation") != job.operation:
            raise EvidenceInvalid("operation_mismatch")
        run_id = evidence.get("runId")
        if not isinstance(run_id, str) or not run_id:
            raise EvidenceInvalid("no_run_id")
        if evidence.get("record") is None:
            raise EvidenceInvalid("no_record")
        if evidence.get("signer") != self._signer:
            raise EvidenceInvalid("foreign_signer")
        chain = evidence.get("logChain")
        if not isinstance(chain, list) or not chain:
            raise EvidenceInvalid("empty_chain")
        previous = GENESIS
        for i, event in enumerate(chain):
            if not isinstance(event, dict) or event.get("type") != "log_hash_chain_entry":
                raise EvidenceInvalid(f"entry_{i}_malformed")
            payload = event.get("payload")
            if not isinstance(payload, dict):
                raise EvidenceInvalid(f"entry_{i}_malformed")
            raw, source, captured_at = payload.get("rawContent"), payload.get("source"), payload.get("capturedAt")
            if not all(isinstance(v, str) for v in (raw, source, captured_at)):
                raise EvidenceInvalid(f"entry_{i}_malformed")
            if payload.get("previousHash") != previous:
                raise EvidenceInvalid(f"entry_{i}_broken_link")
            entry_hash = compute_entry_hash(raw, source, captured_at)
            if payload.get("entryHash") != entry_hash:
                raise EvidenceInvalid(f"entry_{i}_hash_mismatch")
            signature = payload.get("kernelSignature")
            if (not isinstance(signature, dict) or signature.get("signer") != self._signer
                    or signature.get("algorithm") != "ed25519"
                    or not _signature_ok(entry_hash, signature.get("value"), self._public_hex)):
                raise EvidenceInvalid(f"entry_{i}_bad_signature")
            previous = entry_hash
        committed = canonicalize({"operation": job.operation, "record": evidence["record"], "runId": run_id})
        if chain[0]["payload"]["rawContent"] != committed:
            raise EvidenceInvalid("record_not_committed")

    def report(self, job: ClaimedJob, evidence: Dict[str, Any]) -> ReportAck:
        """Check the runtime's evidence, sign a bundle binding it to this job, and post it."""
        self._stored[job.job_id] = False
        try:
            self._check_evidence(job, evidence)
        except EvidenceInvalid as why:
            reason = f"evidence_invalid:{why}"
            self._failure[job.job_id] = reason
            log.warning("job %s: evidence not signed (%s)", job.job_id, why)
            return ReportAck(stored=False, reason=reason)
        bundle = {
            "jobId": job.job_id,
            "kernelId": self._kernel_id,
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

    def complete(self, job: ClaimedJob, *, passed: bool, reason: Optional[str]) -> CompleteAck:
        """Finish the job the node's way, and say whether the gateway applied it.

        Never ``completed`` without stored evidence.
        """
        if passed and not self._stored.get(job.job_id):
            passed, reason = False, self._failure.get(job.job_id, "evidence_not_stored")
        final = "completed" if passed else "failed"
        body: Dict[str, Any] = {"jobId": job.job_id, "kernelId": self._kernel_id,
                                "status": final, "claimToken": job.claim_token}
        if reason:
            body["metadata"] = {"reason": reason}
        status, answer = self._call("POST", "/api/operator/job-status", body)
        accepted = status == 200 and isinstance(answer, dict) and answer.get("updated") is True
        if not accepted:
            log.warning("job %s: final status %s not applied (HTTP %s)", job.job_id, final, status)
        return CompleteAck(status=final, accepted=accepted, reason=reason)
