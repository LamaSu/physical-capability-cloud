"""pcc-node's JobPort for the operating agent (ADK item 12).

The operating loop takes work from, and reports work to, the PCC gateway through
this port. It uses only the node's own routes, with the operator's API key:

- ``claim_next``: ``GET /api/operator/jobs?kernelId=…&status=queued``, then
  ``POST /api/operator/job-status`` ``in_progress``, so no other poll takes the job.
- ``resolve_params``: on the current gateway a polled job carries no parameters
  (board G6). The buyer's selections live in the job's negotiation session:
  ``GET /api/jobs/:id/settlement`` gives ``session.id``, then
  ``GET /api/negotiate/session/:id`` gives ``session.selections``.
- ``report``: a bundle that binds the job, the kernel, the operation and the
  runtime's signed log chain. ``bundleHash`` is sha256 over its canonical JSON
  (the same canonical form as ``@pcc/spec``), and ``kernelSignature`` is the node
  key's Ed25519 signature over that hash: the pair the gateway stores as
  device-signed and #428 verifies against the kernel's registered key. Posted to
  ``POST /api/operator/evidence``.
- ``complete``: ``POST /api/operator/job-status`` ``completed`` or ``failed``,
  with the reason. A job whose evidence was not stored is never marked
  ``completed``: it fails with ``evidence_not_stored``.

The port signs only bundles; only it knows the job id the bundle must bind.
"""

import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Set, Tuple
from urllib.parse import quote

from pcc_node.http_util import pcc_request
from pcc_node.log_capture import assert_ed25519_available, canonicalize, sha256_hex, sign_ed25519_utf8

log = logging.getLogger("pcc-node.operating.jobport")

Request = Callable[..., Tuple[int, Any]]


@dataclass(frozen=True)
class ClaimedJob:
    """A job this node has claimed. ``job_id`` and ``operation`` are what the loop reads."""

    job_id: str
    operation: str
    capability_type: str


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
        self._public_hex = public_hex[2:] if public_hex.lower().startswith("0x") else public_hex
        self._secret_hex = secret_hex
        self._status = status
        self._request = request
        self._seen: Set[str] = set()
        self._stored: Dict[str, bool] = {}

    def _call(self, method: str, path: str, body: Optional[dict] = None) -> Tuple[int, Any]:
        return self._request(method, path, body, base_url=self._base, api_key=self._api_key)

    def claim_next(self, kernel_id: str) -> Optional[ClaimedJob]:
        """Claim the next queued job this node can run, or return None."""
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
            if not isinstance(job_id, str) or job_id in self._seen:
                continue
            self._seen.add(job_id)
            if job.get("kernelId") not in (None, self._kernel_id):
                continue
            operation = self._ops.get(cap_type) if isinstance(cap_type, str) else None
            if operation is None:
                log.info("job %s: no operation for capability type %r; leaving it", job_id, cap_type)
                continue
            status, claimed = self._call("POST", "/api/operator/job-status", {
                "jobId": job_id, "kernelId": self._kernel_id, "status": "in_progress",
            })
            if status == 200 and isinstance(claimed, dict) and claimed.get("updated") is True:
                return ClaimedJob(job_id=job_id, operation=operation, capability_type=cap_type)
            log.warning("job %s: claim not accepted (HTTP %s)", job_id, status)
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

    def report(self, job: ClaimedJob, evidence: Dict[str, Any]) -> None:
        """Sign a bundle binding this job to the runtime's evidence, and post it."""
        bundle = {
            "jobId": job.job_id,
            "kernelId": self._kernel_id,
            "operation": job.operation,
            "runId": evidence.get("runId"),
            "record": evidence.get("record"),
            "logChain": evidence.get("logChain") or [],
            "signerPublicKey": "0x" + self._public_hex.lower(),
        }
        bundle_hash = sha256_hex(canonicalize(bundle))
        bundle["bundleHash"] = bundle_hash
        bundle["kernelSignature"] = {
            "signer": "0x" + self._public_hex.lower(),
            "algorithm": "ed25519",
            "value": sign_ed25519_utf8(bundle_hash, self._public_hex, self._secret_hex),
        }
        status, stored = self._call("POST", "/api/operator/evidence", {
            "jobId": job.job_id, "kernelId": self._kernel_id, "evidence": {"bundle": bundle},
        })
        ok = status == 200 and isinstance(stored, dict) and stored.get("stored") is True
        self._stored[job.job_id] = ok
        if not ok:
            log.warning("job %s: evidence not stored (HTTP %s)", job.job_id, status)

    def complete(self, job: ClaimedJob, *, passed: bool, reason: Optional[str]) -> None:
        """Finish the job the node's way. Never ``completed`` without stored evidence."""
        if passed and not self._stored.get(job.job_id):
            passed, reason = False, "evidence_not_stored"
        body: Dict[str, Any] = {"jobId": job.job_id, "kernelId": self._kernel_id,
                                "status": "completed" if passed else "failed"}
        if reason:
            body["metadata"] = {"reason": reason}
        status, _ = self._call("POST", "/api/operator/job-status", body)
        if status != 200:
            log.warning("job %s: final status not accepted (HTTP %s)", job.job_id, status)
