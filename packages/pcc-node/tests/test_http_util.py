"""Tests for the HTTP utility module."""

import json
from unittest import mock
from urllib.error import HTTPError, URLError
from io import BytesIO

import pytest

from pcc_node.http_util import http, pcc_request, USER_AGENT


class TestHttp:
    def test_get_json(self):
        response_body = json.dumps({"status": "ok"}).encode("utf-8")
        mock_resp = mock.Mock()
        mock_resp.read.return_value = response_body
        mock_resp.status = 200
        mock_resp.__enter__ = mock.Mock(return_value=mock_resp)
        mock_resp.__exit__ = mock.Mock(return_value=False)

        with mock.patch("pcc_node.http_util.urlopen", return_value=mock_resp):
            status, data = http("GET", "http://test/api")

        assert status == 200
        assert data["status"] == "ok"

    def test_post_with_body(self):
        response_body = json.dumps({"id": 1}).encode("utf-8")
        mock_resp = mock.Mock()
        mock_resp.read.return_value = response_body
        mock_resp.status = 201
        mock_resp.__enter__ = mock.Mock(return_value=mock_resp)
        mock_resp.__exit__ = mock.Mock(return_value=False)

        with mock.patch("pcc_node.http_util.urlopen", return_value=mock_resp) as mock_open:
            status, data = http("POST", "http://test/api", body={"name": "test"})

        assert status == 201
        # Verify the request had the right content type
        req = mock_open.call_args[0][0]
        assert req.get_header("Content-type") == "application/json"

    def test_http_error(self):
        error_body = json.dumps({"error": "not found"}).encode("utf-8")
        err = HTTPError(
            "http://test/api", 404, "Not Found",
            {}, BytesIO(error_body),
        )

        with mock.patch("pcc_node.http_util.urlopen", side_effect=err):
            status, data = http("GET", "http://test/api")

        assert status == 404
        assert data["error"] == "not found"

    def test_connection_error(self):
        with mock.patch("pcc_node.http_util.urlopen", side_effect=URLError("refused")):
            status, data = http("GET", "http://test/api")

        assert status == 0
        assert "error" in data

    def test_user_agent_header(self):
        mock_resp = mock.Mock()
        mock_resp.read.return_value = b'""'
        mock_resp.status = 200
        mock_resp.__enter__ = mock.Mock(return_value=mock_resp)
        mock_resp.__exit__ = mock.Mock(return_value=False)

        with mock.patch("pcc_node.http_util.urlopen", return_value=mock_resp) as mock_open:
            http("GET", "http://test/api")

        req = mock_open.call_args[0][0]
        assert req.get_header("User-agent") == USER_AGENT

    def test_non_json_response(self):
        mock_resp = mock.Mock()
        mock_resp.read.return_value = b"plain text"
        mock_resp.status = 200
        mock_resp.__enter__ = mock.Mock(return_value=mock_resp)
        mock_resp.__exit__ = mock.Mock(return_value=False)

        with mock.patch("pcc_node.http_util.urlopen", return_value=mock_resp):
            status, data = http("GET", "http://test/api")

        assert status == 200
        assert data == "plain text"


class TestPccRequest:
    def test_adds_auth_header(self):
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", api_key="mykey")

        call_args = mock_http.call_args
        headers = call_args[0][3]
        assert headers["Authorization"] == "Bearer mykey"

    def test_builds_full_url(self):
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc:3000")

        call_args = mock_http.call_args
        assert call_args[0][1] == "http://pcc:3000/api/test"

    def test_strips_trailing_slash(self):
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc/")

        call_args = mock_http.call_args
        assert call_args[0][1] == "http://pcc/api/test"


class TestPccRequestHeaders:
    """#400 F3: pcc_request takes an optional `headers` keyword (e.g. X-PCC-Lease: 1 on a
    relay poll). Authorization stays exclusively api_key's. Since #442 every gateway request
    goes through gateway_request (verified TLS, no redirects), so that is what these patch."""

    def test_headers_keyword_merges_into_request(self):
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", headers={"X-PCC-Lease": "1"})

        headers = mock_http.call_args[0][3]
        assert headers["X-PCC-Lease"] == "1"

    def test_headers_keyword_cannot_override_authorization(self):
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request(
                "GET", "/api/test", base_url="http://pcc", api_key="key1",
                headers={"Authorization": "Bearer evil", "X-Foo": "bar"},
            )

        headers = mock_http.call_args[0][3]
        assert headers["Authorization"] == "Bearer key1"
        assert headers["X-Foo"] == "bar"

    def test_headers_authorization_stripped_case_insensitively_without_api_key(self):
        """Even with no api_key, headers can never smuggle in an Authorization
        value -- it is exclusively derived from api_key, full stop."""
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", headers={"authorization": "Bearer evil"})

        headers = mock_http.call_args[0][3]
        assert "Authorization" not in headers
        assert "authorization" not in headers

    def test_existing_callers_without_headers_kwarg_still_work(self):
        with mock.patch("pcc_node.http_util.gateway_request") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", api_key="key1")

        headers = mock_http.call_args[0][3]
        assert headers == {"Authorization": "Bearer key1"}


class TestDeadlineAtTheFirstSocketWrite:
    """#400 F3 (r9-r11), moved here from tests/test_executor.py when #442 deleted the relay
    executor. A device command sent through http() inside actuation_deadline(deadline) is checked
    before any connection is made, and again after the connection is established and immediately
    before the request's first byte is written. These use a real server on 127.0.0.1."""

    @staticmethod
    def _device_server():
        """A device on 127.0.0.1 that records every request it receives. Returns (url, received, stop)."""
        import http.server
        import threading

        received = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                received.append((self.path, self.rfile.read(length)))
                payload = b'{"ok": true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()

        return "http://127.0.0.1:%d" % server.server_address[1], received, stop

    def test_a_deadline_already_past_never_opens_a_connection(self):
        import http.client
        import pcc_node.http_util as hu

        url, received, stop = self._device_server()
        connects = []
        real_connect = http.client.HTTPConnection.connect

        def counting_connect(conn):
            connects.append(conn.host)
            return real_connect(conn)

        try:
            with mock.patch("pcc_node.http_util.time.monotonic", return_value=1006.0), \
                    mock.patch.object(http.client.HTTPConnection, "connect", counting_connect):
                with hu.actuation_deadline(1005.0) as guard:
                    status, body = hu.http("POST", url + "/move", {})
        finally:
            stop()
        assert (status, body) == (0, {"error": "not_executed:lease_expired"})
        assert connects == [] and received == []
        assert guard["written"] == 0 and guard["refused"] == "not_executed:lease_expired"

    def test_a_slow_connection_setup_that_crosses_the_deadline_writes_nothing(self):
        """r10 F3, astra's regression: http() starts at t=1000 (deadline 1005), but establishing the
        connection takes until t=1006. The check before the first byte refuses: the device receives
        nothing. This distinguishes urlopen() entry from the underlying write."""
        import http.client
        import pcc_node.http_util as hu

        url, received, stop = self._device_server()
        clock = [1000.0]
        real_connect = http.client.HTTPConnection.connect

        def slow_connect(conn):
            real_connect(conn)
            clock[0] += 6.0  # the connection took until after the deadline

        try:
            with mock.patch("pcc_node.http_util.time.monotonic", side_effect=lambda: clock[0]), \
                    mock.patch.object(http.client.HTTPConnection, "connect", slow_connect):
                with hu.actuation_deadline(1005.0) as guard:
                    status, body = hu.http("POST", url + "/move", {})
        finally:
            stop()
        assert received == []
        assert (status, body) == (0, {"error": "not_executed:lease_expired"})
        assert guard["written"] == 0 and guard["refused"] == "not_executed:lease_expired"

    def test_a_request_checked_before_its_deadline_is_written_and_counted(self):
        import pcc_node.http_util as hu

        url, received, stop = self._device_server()
        try:
            with mock.patch("pcc_node.http_util.time.monotonic", return_value=1000.0):
                with hu.actuation_deadline(1005.0) as guard:
                    status, body = hu.http("POST", url + "/move", {"x": 1})
        finally:
            stop()
        assert status == 200 and body == {"ok": True}
        assert [path for path, _ in received] == ["/move"]
        assert guard["written"] == 1 and guard["refused"] is None

    def test_the_last_check_is_immediately_before_the_write_and_a_later_pause_is_the_residual(self):
        """The stated residual (operator item 127): the connection's check comes right before the
        socket write. A pause after it passes delays the write past the deadline, and the write
        still happens. Documented, not prevented."""
        import http.client
        import pcc_node.http_util as hu

        url, received, stop = self._device_server()
        clock = [1000.0]
        steps = []
        real_holds = hu._deadline_holds
        real_send = http.client.HTTPConnection.send

        def holds_then_maybe_pause(guard):
            result = real_holds(guard)
            steps.append(("check", clock[0], result))
            if len([s for s in steps if s[0] == "check"]) == 2:  # the connection's own check
                clock[0] += 6.0
            return result

        def recording_send(conn, data):
            steps.append(("write", clock[0], None))
            return real_send(conn, data)

        try:
            with mock.patch("pcc_node.http_util.time.monotonic", side_effect=lambda: clock[0]), \
                    mock.patch("pcc_node.http_util._deadline_holds", side_effect=holds_then_maybe_pause), \
                    mock.patch.object(http.client.HTTPConnection, "send", recording_send):
                with hu.actuation_deadline(1005.0):
                    hu.http("POST", url + "/move", {})
        finally:
            stop()
        kinds = [step[0] for step in steps]
        assert kinds[:3] == ["check", "check", "write"]  # start check, connection check, then the write
        assert steps[1][1] < 1005.0 and steps[1][2] is True  # the last check passed before the deadline
        assert steps[2][1] > 1005.0  # the residual: the pause made the write late
        assert [path for path, _ in received] == ["/move"]

    def test_a_deadline_that_passes_between_two_device_requests_writes_only_the_first(self):
        """The first request is written before the deadline. The second would start after it, so it
        is never written. (At 8a529d47 this ran through the relay executor's execute_and_report.)"""
        import pcc_node.http_util as hu

        url, received, stop = self._device_server()
        clock = [1000.0]
        try:
            with mock.patch("pcc_node.http_util.time.monotonic", side_effect=lambda: clock[0]):
                with hu.actuation_deadline(1005.0) as guard:
                    first = hu.http("POST", url + "/a", {})
                    clock[0] += 6.0  # the first move took long
                    second = hu.http("POST", url + "/b", {})
        finally:
            stop()
        assert first == (200, {"ok": True})
        assert second == (0, {"error": "not_executed:lease_expired"})
        assert [path for path, _ in received] == ["/a"]
        assert guard["written"] == 1 and guard["refused"] == "not_executed:lease_expired"

    def test_outside_a_deadline_block_nothing_is_guarded(self):
        """Health probes, detection and other calls outside any actuation_deadline block are
        unaffected, whatever the clock says."""
        import pcc_node.http_util as hu

        url, received, stop = self._device_server()
        try:
            with mock.patch("pcc_node.http_util.time.monotonic", return_value=10 ** 9):
                status, body = hu.http("POST", url + "/probe", {})
        finally:
            stop()
        assert (status, body) == (200, {"ok": True})
        assert [path for path, _ in received] == ["/probe"]
