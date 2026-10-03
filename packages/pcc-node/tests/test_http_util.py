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


class TestPccRequestHeaders:
    """#400 F3: pcc_request gains an optional `headers` keyword (e.g. for
    X-PCC-Lease: 1 on the poll). Authorization stays exclusively api_key's."""

    def test_headers_keyword_merges_into_request(self):
        with mock.patch("pcc_node.http_util.http") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", headers={"X-PCC-Lease": "1"})

        headers = mock_http.call_args[0][3]
        assert headers["X-PCC-Lease"] == "1"

    def test_headers_keyword_cannot_override_authorization(self):
        with mock.patch("pcc_node.http_util.http") as mock_http:
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
        with mock.patch("pcc_node.http_util.http") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", headers={"authorization": "Bearer evil"})

        headers = mock_http.call_args[0][3]
        assert "Authorization" not in headers
        assert "authorization" not in headers

    def test_existing_callers_without_headers_kwarg_still_work(self):
        with mock.patch("pcc_node.http_util.http") as mock_http:
            mock_http.return_value = (200, {})
            pcc_request("GET", "/api/test", base_url="http://pcc", api_key="key1")

        headers = mock_http.call_args[0][3]
        assert headers == {"Authorization": "Bearer key1"}
