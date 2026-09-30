"""GatewayJobPort: claims only mappable jobs, signs bundles the gateway can verify, never completes without evidence."""

import hashlib

import pytest

nacl_signing = pytest.importorskip("nacl.signing")

from pcc_node import log_capture
from pcc_node.log_capture import LogSigningRefused, canonicalize, sha256_hex
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
    pub, sec = _keys()
    port = GatewayJobPort("http://gw.test:4310", "k-operator", KERNEL, {"lab.absorbance": "read_absorbance"},
                          pub, sec, request=gateway, **kwargs)
    return port, pub


JOBS = f"/api/operator/jobs?kernelId={KERNEL}&status=queued"
STATUS = "/api/operator/job-status"
UPDATED = (200, {"updated": True})


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
    def test_claims_the_first_mappable_job_and_marks_it_in_progress(self):
        gw = FakeGateway({
            ("GET", JOBS): (200, {"jobs": [
                {"id": "j-other-type", "kernelId": KERNEL, "capabilityType": "manufacturing.fdm"},
                {"id": "j-other-kernel", "kernelId": "kernel_someone_else", "capabilityType": "lab.absorbance"},
                {"id": "j-1", "kernelId": KERNEL, "capabilityType": "lab.absorbance"},
            ]}),
            ("POST", STATUS): UPDATED,
        })
        port, _ = _port(gw)
        job = port.claim_next(KERNEL)
        assert job == ClaimedJob("j-1", "read_absorbance", "lab.absorbance")
        assert gw.posted(STATUS) == [{"jobId": "j-1", "kernelId": KERNEL, "status": "in_progress"}]
        assert all(api_key == "k-operator" for *_, api_key in gw.calls)

    def test_never_claims_a_job_twice_and_never_fails_one_it_cannot_run(self):
        gw = FakeGateway({("GET", JOBS): (200, {"jobs": [
            {"id": "j-1", "kernelId": KERNEL, "capabilityType": "lab.absorbance"},
            {"id": "j-2", "kernelId": KERNEL, "capabilityType": "manufacturing.fdm"},
        ]}), ("POST", STATUS): UPDATED})
        port, _ = _port(gw)
        assert port.claim_next(KERNEL).job_id == "j-1"
        assert port.claim_next(KERNEL) is None
        assert [b["jobId"] for b in gw.posted(STATUS)] == ["j-1"]

    def test_a_refused_claim_is_not_a_claim(self):
        gw = FakeGateway({("GET", JOBS): (200, {"jobs": [{"id": "j-1", "kernelId": KERNEL, "capabilityType": "lab.absorbance"}]}),
                          ("POST", STATUS): (200, {"updated": False, "warning": "job_not_found"})})
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
    JOB = ClaimedJob("j-1", "read_absorbance", "lab.absorbance")
    EVIDENCE = {"operation": "read_absorbance", "runId": "run-1", "record": {"status": "succeeded"},
                "logChain": [{"type": "log_hash_chain_entry", "payload": {"entryHash": "sha256:" + "a" * 64}}]}

    def test_the_bundle_binds_the_job_and_its_signature_verifies(self):
        gw = FakeGateway({("POST", "/api/operator/evidence"): (200, {"stored": True, "deviceSigned": True})})
        port, pub = _port(gw)
        port.report(self.JOB, self.EVIDENCE)
        [posted] = gw.posted("/api/operator/evidence")
        assert (posted["jobId"], posted["kernelId"]) == ("j-1", KERNEL)
        bundle = dict(posted["evidence"]["bundle"])
        signature = bundle.pop("kernelSignature")
        bundle_hash = bundle.pop("bundleHash")
        assert bundle["jobId"] == "j-1" and bundle["kernelId"] == KERNEL and bundle["logChain"] == self.EVIDENCE["logChain"]
        assert bundle_hash == sha256_hex(canonicalize(bundle))
        assert signature["algorithm"] == "ed25519" and signature["signer"] == "0x" + pub
        nacl_signing.VerifyKey(bytes.fromhex(pub)).verify(bundle_hash.encode(), bytes.fromhex(signature["value"]))

    def test_the_same_evidence_for_another_job_hashes_differently(self):
        gw = FakeGateway({("POST", "/api/operator/evidence"): (200, {"stored": True})})
        port, _ = _port(gw)
        port.report(self.JOB, self.EVIDENCE)
        port.report(ClaimedJob("j-2", "read_absorbance", "lab.absorbance"), self.EVIDENCE)
        first, second = (b["evidence"]["bundle"]["bundleHash"] for b in gw.posted("/api/operator/evidence"))
        assert first != second

    def test_completed_only_with_stored_evidence(self):
        gw = FakeGateway({("POST", "/api/operator/evidence"): (200, {"stored": True}), ("POST", STATUS): UPDATED})
        port, _ = _port(gw)
        port.report(self.JOB, self.EVIDENCE)
        port.complete(self.JOB, passed=True, reason=None)
        assert gw.posted(STATUS)[-1] == {"jobId": "j-1", "kernelId": KERNEL, "status": "completed"}

    @pytest.mark.parametrize("stored", [(200, {"stored": False, "error": "storage_failed"}), (500, {"error": "x"}), None])
    def test_unstored_evidence_turns_a_pass_into_a_failure(self, stored):
        routes = {("POST", STATUS): UPDATED}
        if stored is not None:
            routes[("POST", "/api/operator/evidence")] = stored
        gw = FakeGateway(routes)
        port, _ = _port(gw)
        if stored is not None:
            port.report(self.JOB, self.EVIDENCE)
        port.complete(self.JOB, passed=True, reason=None)
        assert gw.posted(STATUS)[-1] == {"jobId": "j-1", "kernelId": KERNEL, "status": "failed",
                                         "metadata": {"reason": "evidence_not_stored"}}

    def test_a_refusal_fails_with_its_reason(self):
        gw = FakeGateway({("POST", STATUS): UPDATED})
        port, _ = _port(gw)
        port.complete(self.JOB, passed=False, reason="envelope_violation:wavelengthNm 500 outside [405, 600]")
        assert gw.posted(STATUS)[-1]["metadata"] == {"reason": "envelope_violation:wavelengthNm 500 outside [405, 600]"}
