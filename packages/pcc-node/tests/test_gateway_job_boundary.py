"""Verdict 68b on #442: a gateway job never becomes a device command, and the
gateway's TLS identity is verified.

Each test here failed at b9db8bb6, the reviewed SHA:
- finding 1: a job's pythonCode was uploaded to an Opentrons robot and played,
  and a job's protocolId started a run, with approval_mode never consulted;
- finding 3: a job's method, path and body went to a generic device unchanged,
  a job's filename was selected and printed on OctoPrint, and a job's content
  went to the system printer;
- finding 2: the gateway client accepted a self-signed certificate, so anyone
  on the path could serve it jobs and read its bearer key.

Parameters reach a device only through the operating agent's typed operations
(pcc_node.operating, ADK item 12), never through a polled job.
"""

import json
import shutil
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import pytest

from pcc_node import job_executor
from pcc_node.job_executor import JobExecutor
from pcc_node.ws_client import PCCGatewayClient


class RecordingDevice:
    """An HTTP device that records every request and answers like a willing robot."""

    def __init__(self):
        self.requests = []
        device = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self):
                length = int(self.headers.get("Content-Length", "0"))
                device.requests.append((self.command, self.path, self.rfile.read(length)))
                raw = json.dumps({"data": {"id": "x-1"}}).encode()
                self.send_response(201)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _answer

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def device():
    d = RecordingDevice()
    yield d
    d.close()


def _run(devices, job):
    gateway = mock.MagicMock()
    result = JobExecutor(devices, gateway_client=gateway).execute(job)
    return result, gateway


class TestAJobNeverDrivesADevice:
    def test_python_code_is_never_uploaded_or_played(self, device):
        result, _ = _run([{"id": "ot-1", "protocol": "opentrons", "url": device.url}], {
            "id": "repro", "capabilityType": "liquid-handler",
            "parameters": {"filename": "repro.py", "pythonCode": "from opentrons import protocol_api\n# arbitrary"},
        })
        assert device.requests == []
        assert result["status"] == "refused"

    def test_a_protocol_id_never_starts_a_run(self, device):
        _run([{"id": "ot-1", "protocol": "opentrons", "url": device.url}],
             {"id": "repro", "capabilityType": "liquid-handler", "parameters": {"protocolId": "p-existing"}})
        assert device.requests == []

    def test_a_method_and_path_never_reach_a_generic_device(self, device):
        _run([{"id": "gen-1", "protocol": "generic", "url": device.url}], {
            "id": "repro", "capabilityType": "network-instrument",
            "parameters": {"method": "DELETE", "path": "/safety/disable", "body": {"all": True}},
        })
        assert device.requests == []

    def test_a_filename_is_never_selected_and_printed(self, device):
        _run([{"id": "op-1", "protocol": "octoprint", "url": device.url}],
             {"id": "repro", "capabilityType": "3d-print", "parameters": {"filename": "anything.gcode"}})
        assert device.requests == []

    def test_content_never_reaches_the_system_printer(self, monkeypatch):
        calls = []
        monkeypatch.setattr(subprocess, "run", lambda *a, **k: calls.append(a) or mock.MagicMock(returncode=0))
        _run([{"id": "pr-1", "protocol": "ipp", "host": "10.0.0.9"}],
             {"id": "repro", "capabilityType": "document-printing", "parameters": {"content": "%!PS\n", "filename": "x.ps"}})
        assert calls == []

    def test_a_refused_job_is_left_queued_and_unreported(self, device):
        result, gateway = _run([{"id": "gen-1", "protocol": "generic", "url": device.url}],
                               {"id": "repro", "parameters": {"path": "/x"}})
        assert result["status"] == "refused" and "typed operations" in result["note"]
        gateway.update_job_status.assert_not_called()
        gateway.push_evidence.assert_not_called()

    def test_the_parameter_driven_device_paths_are_gone(self):
        for name in ("execute_ipp_print",):
            assert not hasattr(job_executor, name), name
        for name in ("_execute_opentrons", "_execute_octoprint", "_execute_generic_http", "_execute_on_device"):
            assert not hasattr(JobExecutor, name), name


@pytest.fixture
def self_signed_gateway():
    """An HTTPS gateway with a self-signed certificate that serves a forged job."""
    if not shutil.which("openssl"):
        pytest.skip("openssl is needed to make a throwaway certificate")
    tmp = Path(tempfile.mkdtemp())
    cert, key = tmp / "cert.pem", tmp / "key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
                    "-out", str(cert), "-days", "1", "-subj", "/CN=127.0.0.1"],
                   check=True, capture_output=True)
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append((self.path, self.headers.get("Authorization")))
            raw = json.dumps({"jobs": [{"id": "forged", "parameters": {"pythonCode": "x"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert), str(key))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"https://127.0.0.1:{server.server_port}", seen
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(tmp, ignore_errors=True)


def test_the_gateway_client_refuses_an_unverified_certificate(self_signed_gateway):
    url, seen = self_signed_gateway
    client = PCCGatewayClient(url, api_key="k-" + "operator-bearer", kernel_id="kernel_x")
    assert client.poll_for_jobs() == []
    assert seen == []  # no request, so no bearer key, ever reached the impostor
