"""The request pcc-node's camera push sends, pinned to the gateway's receiver (pcc-node 0.1.1 r4).

push_camera_frame() POSTs each frame to the relay's camera route. The receiver, identical at prod
3f7011b3, master 7d0c27ca and in this tree (packages/gateway/src/routes/device-relay.ts:1606-1673),
takes {frame: base64 JPEG, capturedAt?} from the kernel's operator, binds the frame to the :kernelId
in the path (it reads no kernelId from the body) and answers 201. Anything else is a refusal: 401
without a key, 403 for a caller who is not the kernel's operator (relay_access_denied) or a closed
relay (relay_disabled), 400 invalid_request over the 1 MiB body limit, 400 without a frame.
The relay administration gate runs before body parsing: a closed relay returns 403 relay_disabled
to an ordinary node even for an oversized upload. Once that gate admits the request, the global
1 MiB limit and error handler produce 400; the camera route's larger 5 MB check is unreachable.

Only the capture is stubbed here (no camera). push_camera_frame(), pcc_request() and the gateway
transport are the real ones, against a loopback gateway that records exactly what arrives.
"""

import base64
import json
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import pytest

from pcc_node import camera
from .test_start_daemon_refusal import WireGateway, _wire_answer

KEY = "k-" + "operator-bearer"
KERNEL = "kernel-0a1b2c3d4e5f"  # the shape generate_config() gives a kernel id
JPEG = b"\xff\xd8" + bytes(range(256)) * 2 + b"\xff\xd9"
RECEIVED = {"id": "frame_x", "kernelId": KERNEL, "capturedAt": "2026-10-09T19:00:00Z", "framesKept": 1}
OVERSIZE_RESPONSE = (400, {"error": "invalid_request",
                           "message": "Request body size did not match Content-Length header"})


class Gateway:
    """A loopback PCC gateway that answers every request with one status and JSON body, and records
    (method, raw path, headers, body bytes) for each request it receives."""

    def __init__(self, status=201, body=None):
        self.requests = []
        gw = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                gw.requests.append((self.command, self.path, dict(self.headers.items()), raw))
                answer = json.dumps(RECEIVED if body is None else body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _push(base, kernel_id=KERNEL, frame=JPEG):
    with mock.patch.object(camera, "capture_frame_jpeg", return_value=frame):
        return camera.push_camera_frame(base, KEY, kernel_id)


def test_a_frame_goes_to_the_kernels_relay_route_in_the_shape_the_receiver_reads():
    gateway = Gateway(status=201)
    try:
        assert _push(gateway.url) is True
    finally:
        gateway.close()
    (method, path, headers, raw), = gateway.requests
    assert (method, path) == ("POST", f"/api/relay/{KERNEL}/camera/frame")
    assert headers["Authorization"] == f"Bearer {KEY}"
    assert headers["Content-Type"] == "application/json"
    assert not any(name.lower() == "x-admin-key" for name in headers)  # an operator node holds no admin key
    body = json.loads(raw)
    assert set(body) == {"frame", "capturedAt"}  # the kernel is the path's, never the body's
    assert base64.b64decode(body["frame"], validate=True) == JPEG
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", body["capturedAt"]), body["capturedAt"]


@pytest.mark.parametrize("kernel_id, segment", [
    ("kernel_ab-c.d~e", "kernel_ab-c.d~e"),     # unreserved characters stay as they are
    ("k/1 ?x#y", "k%2F1%20%3Fx%23y"),            # anything else is escaped into one path segment
])
def test_the_kernel_id_is_one_path_segment(kernel_id, segment):
    gateway = Gateway(status=201)
    try:
        assert _push(gateway.url, kernel_id=kernel_id) is True
    finally:
        gateway.close()
    (_, path, _, _), = gateway.requests
    assert path == f"/api/relay/{segment}/camera/frame"


@pytest.mark.parametrize("status, body", [
    (400, {"error": "frame (base64 JPEG) is required"}),
    (401, {"error": "api_key_required"}),
    (403, {"error": "relay_access_denied", "required": "kernel_operator"}),
    (403, {"error": "forbidden", "reason": "relay_disabled"}),
    OVERSIZE_RESPONSE,
    (302, {}),
    (500, {"error": "internal"}),
    (503, {"error": "unavailable"}),
], ids=["400-no-frame", "401", "403-not-the-operator", "403-relay-closed", "400-too-large", "302", "500", "503"])
def test_a_refused_frame_is_reported_as_not_pushed(status, body):
    gateway = Gateway(status=status, body=body)
    try:
        assert _push(gateway.url) is False
    finally:
        gateway.close()
    assert len(gateway.requests) == 1


def test_a_gateway_that_cannot_be_reached_is_not_pushed():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    assert _push(f"http://127.0.0.1:{port}") is False


def test_no_frame_sends_nothing():
    gateway = Gateway(status=201)
    try:
        assert _push(gateway.url, frame=None) is False
    finally:
        gateway.close()
    assert gateway.requests == []


def test_oversize_gateway_response_is_a_nonfatal_http_400(monkeypatch, caplog):
    # Exercise the real HTTP parser/transport without a sandbox socket. The
    # scripted reply represents the body-limit decision after relay admission.
    status, body = OVERSIZE_RESPONSE
    gateway = WireGateway(monkeypatch, _wire_answer(status, json.dumps(body).encode()))
    original_request = camera.pcc_request
    body_sizes = []

    def observe_request(*args, **kwargs):
        body_sizes.append(len(json.dumps(kwargs["body"]).encode()))
        return original_request(*args, **kwargs)

    monkeypatch.setattr(camera, "pcc_request", observe_request)
    assert _push(gateway.url, frame=b"x" * 786_432) is False
    assert body_sizes[0] > 1_048_576
    assert gateway.paths() == [f"/api/relay/{KERNEL}/camera/frame"]
    assert "Camera frame push failed: HTTP 400" in caplog.text
