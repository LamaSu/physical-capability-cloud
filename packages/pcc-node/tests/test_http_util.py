"""Tests for the HTTP utility module."""

import json
from http.client import HTTPException
from unittest import mock
from urllib.error import HTTPError, URLError
from io import BytesIO

import pytest

from pcc_node.http_util import http, http_bytes, pcc_request, USER_AGENT


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


class TestHttpBytes:
    """http_bytes carries binary protocols (IPP): body out verbatim, raw
    bytes back, and the same status-0 transport sentinel as http()."""

    BINARY = b"\x02\x00\x00\x09\x00\x00\x00\x01\x01\x03\xff\xfe"

    def _resp(self, status, raw):
        mock_resp = mock.Mock()
        mock_resp.read.return_value = raw
        mock_resp.status = status
        mock_resp.__enter__ = mock.Mock(return_value=mock_resp)
        mock_resp.__exit__ = mock.Mock(return_value=False)
        return mock_resp

    def test_sends_the_body_verbatim_and_returns_raw_bytes(self):
        with mock.patch("pcc_node.http_util.urlopen",
                        return_value=self._resp(200, self.BINARY)) as mock_open:
            status, body = http_bytes(
                "POST", "http://printer:631/printers/q", data=self.BINARY,
                headers={"Content-Type": "application/ipp"}, timeout=7,
            )

        assert (status, body) == (200, self.BINARY)   # not decoded, not JSON-parsed
        req = mock_open.call_args[0][0]
        assert req.data == self.BINARY
        assert req.get_method() == "POST"
        assert req.get_header("Content-type") == "application/ipp"
        assert req.get_header("User-agent") == USER_AGENT
        assert mock_open.call_args.kwargs["timeout"] == 7

    def test_http_error_returns_its_code_and_raw_body(self):
        err = HTTPError("http://printer:631/", 500, "err", {}, BytesIO(b"\x00\xffoops"))
        with mock.patch("pcc_node.http_util.urlopen", side_effect=err):
            assert http_bytes("POST", "http://printer:631/", data=b"x") == (500, b"\x00\xffoops")

    @pytest.mark.parametrize("exc", [
        URLError("[Errno 111] Connection refused"),
        TimeoutError("timed out"),
        ConnectionResetError("reset"),
        HTTPException("malformed status line"),
    ])
    def test_transport_failure_is_the_status_zero_sentinel(self, exc):
        with mock.patch("pcc_node.http_util.urlopen", side_effect=exc):
            assert http_bytes("POST", "http://printer:631/", data=b"x") == (0, b"")


class TestPccRequest:
    def test_adds_auth_header(self):
        with mock.patch("pcc_node.http_util.http") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", api_key="mykey")

        call_args = mock_http.call_args
        headers = call_args[0][3]
        assert headers["Authorization"] == "Bearer mykey"

    def test_builds_full_url(self):
        with mock.patch("pcc_node.http_util.http") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc:3000")

        call_args = mock_http.call_args
        assert call_args[0][1] == "http://pcc:3000/api/test"

    def test_strips_trailing_slash(self):
        with mock.patch("pcc_node.http_util.http") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc/")

        call_args = mock_http.call_args
        assert call_args[0][1] == "http://pcc/api/test"
