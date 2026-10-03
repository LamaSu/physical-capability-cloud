"""GatewayJobPort: claims only mappable jobs, signs bundles the gateway can verify, never completes without evidence."""

import hashlib

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node import log_capture
from pcc_node.log_capture import LogCapture, LogSigningRefused, canonicalize, sha256_hex
from pcc_node.operating.jobport import ClaimedJob, GatewayJobPort

KERNEL = "kernel_bench"


def _keys():
    sk = nacl_signing.SigningKey.generate()
    return sk.verify_key.encode().hex(), sk.encode().hex()


class FakeGateway:
    """Scripted answers keyed by (method, path); records every call."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []

    def __call__(self, method, path, body=None, *, base_url, api_key, **kwargs):
        self.calls.append((method, path, body, api_key))
        answer = self.routes.get((method, path), (404, {"error": "not found"}))
        return answer(body) if callable(answer) else answer

    def posted(self, path):
        return [body for method, p, body, _ in self.calls if method == "POST" and p == path]


def _port(gateway, **kwargs):
    port, pub, _ = _port_and_keys(gateway, **kwargs)
    return port, pub


def _port_and_keys(gateway, **kwargs):
    pub, sec = _keys()
    port = GatewayJobPort("http://gw.test:4310", "k-operator", KERNEL, {"lab.absorbance": "read_absorbance"},
                          pub, sec, request=gateway, **kwargs)
    return port, pub, sec


def _evidence(pub, sec, run_id="run-1"):
    """Evidence as AdapterRuntime builds it: the node's own signed chain for one run."""
    record = {"status": "succeeded"}
    capture = LogCapture(pub, sec)
    entry = capture.capture(canonicalize({"operation": "read_absorbance", "record": record, "runId": run_id}),
                            "device:run", "2026-10-03T00:00:00Z", entry_id=f"{run_id}:record")
    return {"operation": "read_absorbance", "runId": run_id, "record": record, "logChain": [entry],
            "signer": capture.signer}


JOBS = f"/api/operator/jobs?kernelId={KERNEL}&status=queued"
STATUS = "/api/operator/job-status"
UPDATED = (200, {"updated": True})
CLAIM_J1 = "/api/operator/jobs/j-1/claim"
CLAIMED_J1 = (200, {"claimed": True, "jobId": "j-1", "claimToken": "tok-1", "leaseExpiresAt": "2026-10-03T00:10:00Z"})


class TestSigningIsMandatory:
    def test_no_pynacl_means_no_port(self, monkeypatch):
        pub, sec = _keys()
        monkeypatch.setattr(log_capture, "_HAS_NACL", False)
        with pytest.raises(LogSigningRefused):
            GatewayJobPort("http://gw.test:4310", "k", KERNEL, {}, pub, sec, request=FakeGateway())

    def test_a_placeholder_key_means_no_port(self):
        secret = bytes(range(32))
        with pytest.raises(LogSigningRefused):
            GatewayJobPort("http://gw.test:4310", "k", KERNEL, {}, hashlib.sha256(secret).hexdigest(), secret.hex(),
                           request=FakeGateway())


class TestClaim:
    def test_claims_the_first_mappable_job_through_the_atomic_claim(self):
        gw = FakeGateway({
            ("GET", JOBS): (200, {"jobs": [
                {"id": "j-other-type", "kernelId": KERNEL, "capabilityType": "manufacturing.fdm"},
                {"id": "j-other-kernel", "kernelId": "kernel_someone_else", "capabilityType": "lab.absorbance"},
                {"id": "j-1", "kernelId": KERNEL, "capabilityType": "lab.absorbance"},
            ]}),
            ("POST", CLAIM_J1): CLAIMED_J1,
        })
        port, _ = _port(gw)
        job = port.claim_next(KERNEL)
        assert job == ClaimedJob("j-1", "read_absorbance", "lab.absorbance", "tok-1")
        assert gw.posted(CLAIM_J1) == [{"kernelId": KERNEL}]
        assert gw.posted(STATUS) == []  # the claim itself moves the job to in_progress
        assert all(api_key == "k-operator" for *_, api_key in gw.calls)

    def test_never_claims_a_job_twice_and_never_fails_one_it_cannot_run(self):
        gw = FakeGateway({("GET", JOBS): (200, {"jobs": [
            {"id": "j-1", "kernelId": KERNEL, "capabilityType": "lab.absorbance"},
            {"id": "j-2", "kernelId": KERNEL, "capabilityType": "manufacturing.fdm"},
        ]}), ("POST", CLAIM_J1): CLAIMED_J1})
        port, _ = _port(gw)
        assert port.claim_next(KERNEL).job_id == "j-1"
        assert port.claim_next(KERNEL) is None
        assert [p for m, p, *_ in gw.calls if m == "POST"] == [CLAIM_J1]
        assert gw.posted(STATUS) == []

    @pytest.mark.parametrize("answer", [
        (409, {"error": "job_not_claimable", "status": "in_progress"}),
        (200, {"claimed": True, "jobId": "j-1"}),
        (200, {"claimed": True, "jobId": "j-2", "claimToken": "tok"}),
        (404, {"error": "not found"}),
    ])
    def test_a_refused_or_malformed_claim_is_not_a_claim(self, answer):
        gw = FakeGateway({("GET", JOBS): (200, {"jobs": [{"id": "j-1", "kernelId": KERNEL, "capabilityType": "lab.absorbance"}]}),
                          ("POST", CLAIM_J1): answer})
        port, _ = _port(gw)
        assert port.claim_next(KERNEL) is None

    def test_only_its_own_kernel(self):
        gw = FakeGateway()
        port, _ = _port(gw)
        assert port.claim_next("kernel_someone_else") is None
        assert gw.calls == []

    def test_an_unreadable_queue_claims_nothing(self):
        for answer in [(500, {"error": "x"}), (200, "not json"), (200, {"jobs": "nope"}), (0, {"error": "down"})]:
            port, _ = _port(FakeGateway({("GET", JOBS): answer}))
            assert port.claim_next(KERNEL) is None


class TestResolveParams:
    JOB = ClaimedJob("j-1", "read_absorbance", "lab.absorbance")

    def test_reads_the_buyers_selections_from_the_negotiation_session(self):
        gw = FakeGateway({
            ("GET", "/api/jobs/j-1/settlement"): (200, {"session": {"id": "s-9", "capabilityType": "lab.absorbance"}}),
            ("GET", "/api/negotiate/session/s-9"): (200, {"session": {"id": "s-9", "selections": {"wavelengthNm": 450, "wells": ["A1"]}}}),
        })
        port, _ = _port(gw)
        assert port.resolve_params(self.JOB) == {"wavelengthNm": 450, "wells": ["A1"]}

    @pytest.mark.parametrize("routes", [
        {},
        {("GET", "/api/jobs/j-1/settlement"): (200, {"session": None})},
        {("GET", "/api/jobs/j-1/settlement"): (200, {"session": {"id": "s-9"}}),
         ("GET", "/api/negotiate/session/s-9"): (410, {"error": "Session expired"})},
        {("GET", "/api/jobs/j-1/settlement"): (200, {"session": {"id": "s-9"}}),
         ("GET", "/api/negotiate/session/s-9"): (200, {"session": {"selections": "450nm please"}})},
    ])
    def test_anything_less_is_unresolved(self, routes):
        port, _ = _port(FakeGateway(routes))
        assert port.resolve_params(self.JOB) is None


class TestReportAndComplete:
    JOB = ClaimedJob("j-1", "read_absorbance", "lab.absorbance", "tok-1")

    def test_the_bundle_binds_the_job_and_its_signature_verifies(self):
        gw = FakeGateway({("POST", "/api/operator/evidence"): (200, {"stored": True, "jobId": "j-1", "deviceSigned": True})})
        port, pub, sec = _port_and_keys(gw)
        evidence = _evidence(pub, sec)
        assert port.report(self.JOB, evidence).stored is True
        [posted] = gw.posted("/api/operator/evidence")
        assert (posted["jobId"], posted["kernelId"], posted["claimToken"]) == ("j-1", KERNEL, "tok-1")
        bundle = dict(posted["evidence"]["bundle"])
        signature = bundle.pop("kernelSignature")
        bundle_hash = bundle.pop("bundleHash")
        assert bundle["jobId"] == "j-1" and bundle["kernelId"] == KERNEL and bundle["logChain"] == evidence["logChain"]
        assert bundle["recordCanonical"] == canonicalize(evidence["record"])
        assert bundle_hash == sha256_hex(canonicalize(bundle))
        assert signature["algorithm"] == "ed25519" and signature["signer"] == "0x" + pub
        nacl_signing.VerifyKey(bytes.fromhex(pub)).verify(bundle_hash.encode(), bytes.fromhex(signature["value"]))

    def test_the_same_evidence_for_another_job_hashes_differently(self):
        gw = FakeGateway({("POST", "/api/operator/evidence"): (200, {"stored": True, "jobId": "j-1"})})
        port, pub, sec = _port_and_keys(gw)
        evidence = _evidence(pub, sec)
        port.report(self.JOB, evidence)
        port.report(ClaimedJob("j-2", "read_absorbance", "lab.absorbance", "tok-2"), evidence)
        first, second = (b["evidence"]["bundle"]["bundleHash"] for b in gw.posted("/api/operator/evidence"))
        assert first != second

    def test_completed_only_with_stored_evidence(self):
        gw = FakeGateway({("POST", "/api/operator/evidence"): (200, {"stored": True, "jobId": "j-1"}), ("POST", STATUS): UPDATED})
        port, pub, sec = _port_and_keys(gw)
        port.report(self.JOB, _evidence(pub, sec))
        ack = port.complete(self.JOB, passed=True, reason=None)
        assert gw.posted(STATUS)[-1] == {"jobId": "j-1", "kernelId": KERNEL, "status": "completed", "claimToken": "tok-1"}
        assert ack.accepted is True and ack.status == "completed"

    @pytest.mark.parametrize("stored", [(200, {"stored": False, "error": "storage_failed"}), (500, {"error": "x"}),
                                        (200, {"stored": True, "jobId": "someone-else"}), None])
    def test_unstored_evidence_turns_a_pass_into_a_failure(self, stored):
        routes = {("POST", STATUS): UPDATED}
        if stored is not None:
            routes[("POST", "/api/operator/evidence")] = stored
        gw = FakeGateway(routes)
        port, pub, sec = _port_and_keys(gw)
        if stored is not None:
            assert port.report(self.JOB, _evidence(pub, sec)).stored is False
        port.complete(self.JOB, passed=True, reason=None)
        assert gw.posted(STATUS)[-1] == {"jobId": "j-1", "kernelId": KERNEL, "status": "failed", "claimToken": "tok-1",
                                         "metadata": {"reason": "evidence_not_stored"}}

    def test_a_refusal_fails_with_its_reason(self):
        gw = FakeGateway({("POST", STATUS): UPDATED})
        port, _ = _port(gw)
        port.complete(self.JOB, passed=False, reason="envelope_violation:wavelengthNm 500 outside [405, 600]")
        assert gw.posted(STATUS)[-1]["metadata"] == {"reason": "envelope_violation:wavelengthNm 500 outside [405, 600]"}
