"""Verdict 68c on #442: the gateway transport never leaks the operator's key,
and an evidence receipt counts only when the gateway says it stored the bundle.

Each test failed at 5545fa7a, the reviewed SHA:
- finding 1 (CRITICAL): a plain-http gateway URL on another host got the
  bearer key, and a redirect was followed with the key still attached, by
  both the gateway client and pcc_request;
- 102f's finding 1 (HIGH, node side): push_evidence() treated HTTP 200 with
  {"stored": false} as success.

Plain http stays allowed for a loopback gateway (a rehearsal gateway on this
machine), where the key never leaves the host.
"""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from pcc_node import http_util, ws_client
from pcc_node.http_util import pcc_request
from pcc_node.ws_client import PCCGatewayClient

KEY = "k-" + "operator-bearer"


class Recorder:
    """A loopback HTTP server that records requests and answers from a script."""

    def __init__(self, answer=(200, {"jobs": []}), headers=()):
        self.requests = []
        rec = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length", "0"))
                rec.requests.append((self.command, self.path, self.headers.get("Authorization"), self.rfile.read(length)))
                code, body = answer
                raw = json.dumps(body).encode()
                self.send_response(code)
                for k, v in headers:
                    self.send_header(k, v)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PATCH = _serve

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def no_network(monkeypatch):
    """Record every outbound connection attempt instead of making it."""
    attempts = []

    def refuse(address, *args, **kwargs):
        attempts.append(address)
        raise OSError("network disabled in this test")

    monkeypatch.setattr(socket, "create_connection", refuse)
    return attempts


class TestPlainHttpToAnotherHost:
    def test_the_gateway_client_never_connects(self, no_network):
        PCCGatewayClient("http://gw.example.test", api_key=KEY, kernel_id="k1").poll_for_jobs()
        assert no_network == []

    def test_pcc_request_never_connects(self, no_network):
        status, _ = pcc_request("GET", "/api/auth/validate", base_url="http://gw.example.test", api_key=KEY)
        assert status == 0 and no_network == []

    def test_provisioning_is_refused_too_because_the_answer_carries_a_key(self, no_network):
        status, _ = pcc_request("POST", "/api/auth/provision", body={"email": "x@example.org"},
                                base_url="http://gw.example.test")
        assert status == 0 and no_network == []

    @pytest.mark.parametrize("base", ["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9", "https://gw.example.test"])
    def test_https_and_loopback_http_are_allowed(self, base, no_network):
        pcc_request("GET", "/api/health", base_url=base)
        assert len(no_network) == 1


class TestRedirects:
    def test_the_gateway_client_never_follows_one(self):
        catcher = Recorder()
        gateway = Recorder(answer=(302, {}), headers=[("Location", catcher.url + "/capture")])
        try:
            assert PCCGatewayClient(gateway.url, api_key=KEY, kernel_id="k1").poll_for_jobs() == []
            assert catcher.requests == []
        finally:
            gateway.close()
            catcher.close()

    def test_pcc_request_never_follows_one(self):
        catcher = Recorder()
        gateway = Recorder(answer=(302, {}), headers=[("Location", catcher.url + "/capture")])
        try:
            status, _ = pcc_request("GET", "/api/auth/validate", base_url=gateway.url, api_key=KEY)
            assert status == 302
            assert catcher.requests == []
        finally:
            gateway.close()
            catcher.close()


class TestEvidenceReceipt:
    @pytest.mark.parametrize("answer", [
        (200, {"stored": False, "error": "storage_failed"}),
        (200, {"stored": False, "warning": "job_not_found"}),
        (200, {"jobId": "j1"}),
        (200, {"stored": True, "jobId": "someone-else"}),
        (201, "not json"),
    ])
    def test_only_a_stored_receipt_for_this_job_counts(self, answer):
        gateway = Recorder(answer=answer)
        try:
            assert PCCGatewayClient(gateway.url, api_key=KEY, kernel_id="k1").push_evidence("j1", {"x": 1}) is False
        finally:
            gateway.close()

    def test_a_stored_receipt_counts(self):
        gateway = Recorder(answer=(200, {"stored": True, "jobId": "j1", "bundleId": "ev-1"}))
        try:
            assert PCCGatewayClient(gateway.url, api_key=KEY, kernel_id="k1").push_evidence("j1", {"x": 1}) is True
        finally:
            gateway.close()
