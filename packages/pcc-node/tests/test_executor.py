"""Tests for the executor and device adapters."""

import json
from unittest import mock

import pytest

from pcc_node.executor import (
    OpentronAdapter,
    OctoPrintAdapter,
    GenericHTTPAdapter,
    create_adapter,
    poll_pending_jobs,
    execute_and_report,
    run_pending_once,
)


class TestOpentronAdapter:
    def test_health(self):
        adapter = OpentronAdapter(base_url="http://test:31950")
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (200, {"name": "ot2", "api_version": "8"})
            result = adapter.health()
        assert result["name"] == "ot2"

    def test_execute_health_tool(self):
        adapter = OpentronAdapter()
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (200, {"name": "ot2"})
            result = adapter.execute("ot2_health", {})
        parsed = json.loads(result)
        assert parsed["name"] == "ot2"

    def test_execute_unknown_tool(self):
        adapter = OpentronAdapter()
        result = adapter.execute("ot2_nonexistent", {})
        parsed = json.loads(result)
        assert "error" in parsed
        assert "Unknown tool" in parsed["error"]

    def test_execute_run_create(self):
        adapter = OpentronAdapter()
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (201, {"id": "run-1"})
            result = adapter.execute("ot2_run_create", {"protocolId": "proto-1"})
        parsed = json.loads(result)
        assert parsed["id"] == "run-1"


class TestOctoPrintAdapter:
    def test_health(self):
        adapter = OctoPrintAdapter(base_url="http://test:5000")
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (200, {"server": "1.10.0"})
            result = adapter.health()
        assert result["server"] == "1.10.0"

    def test_execute_version(self):
        adapter = OctoPrintAdapter()
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (200, {"server": "1.10.0"})
            result = adapter.execute("octoprint_version", {})
        parsed = json.loads(result)
        assert parsed["server"] == "1.10.0"

    def test_execute_unknown_tool(self):
        adapter = OctoPrintAdapter()
        result = adapter.execute("octoprint_nonexistent", {})
        parsed = json.loads(result)
        assert "error" in parsed


class TestGenericHTTPAdapter:
    def test_health_no_url(self):
        adapter = GenericHTTPAdapter()
        result = adapter.health()
        assert "error" in result

    def test_health_with_url(self):
        adapter = GenericHTTPAdapter(base_url="http://test:8080")
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (200, {})
            result = adapter.health()
        assert result["reachable"] is True

    def test_execute_passthrough(self):
        adapter = GenericHTTPAdapter(base_url="http://test:8080")
        with mock.patch("pcc_node.executor.http") as mock_http:
            mock_http.return_value = (200, {"data": "ok"})
            result = adapter.execute("anything", {"method": "GET", "path": "/status"})
        parsed = json.loads(result)
        assert parsed["status"] == 200


class TestCreateAdapter:
    def test_opentrons(self):
        dev = {"type": "opentrons", "url": "http://localhost:31950"}
        adapter = create_adapter(dev)
        assert isinstance(adapter, OpentronAdapter)

    def test_octoprint(self):
        dev = {"type": "octoprint", "url": "http://localhost:5000"}
        adapter = create_adapter(dev)
        assert isinstance(adapter, OctoPrintAdapter)

    def test_camera_returns_none(self):
        dev = {"type": "camera", "path": "/dev/video0"}
        adapter = create_adapter(dev)
        assert adapter is None

    def test_serial_without_url_returns_none(self):
        dev = {"type": "serial", "path": "/dev/ttyUSB0"}
        adapter = create_adapter(dev)
        assert adapter is None

    def test_serial_with_url(self):
        dev = {"type": "serial", "url": "http://192.168.1.100:8080"}
        adapter = create_adapter(dev)
        assert isinstance(adapter, GenericHTTPAdapter)


class TestPollPendingJobs:
    def test_returns_calls_list(self):
        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"calls": [
                {"id": "c1", "toolName": "ot2_health", "toolArgs": {}},
            ]})
            calls = poll_pending_jobs("http://pcc", "key", "k1")
        assert len(calls) == 1
        assert calls[0]["id"] == "c1"
        assert mock_pcc.call_args[0][:2] == ("GET", "/api/relay/k1/tool-call/pending")

    def test_returns_empty_on_error(self):
        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (500, "error")
            calls = poll_pending_jobs("http://pcc", "key", "k1")
        assert calls == []

    def test_handles_flat_list_response(self):
        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, [{"id": "c1", "toolName": "x", "toolArgs": {}}])
            calls = poll_pending_jobs("http://pcc", "key", "k1")
        assert len(calls) == 1


class TestExecuteAndReport:
    def test_executes_and_posts_result(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})

        call = {"id": "c1", "kernelId": "k1", "toolName": "test_tool", "args": {"x": 1}}

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {})
            assert execute_and_report(call, [adapter], "http://pcc", "key", "k1") is True

        adapter.execute.assert_called_once_with("test_tool", {"x": 1})
        mock_pcc.assert_called_once()
        post_body = mock_pcc.call_args[1].get("body") or mock_pcc.call_args[0][2]
        assert post_body["callId"] == "c1"
        assert mock_pcc.call_args[0][:2] == ("POST", "/api/relay/k1/tool-result")

    def test_the_polled_kernel_is_required(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})
        call = {"id": "c9", "kernelId": "k1", "toolName": "t", "args": {}}

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            with pytest.raises(TypeError):
                execute_and_report(call, [adapter], "http://pcc", "key")  # no kernel id at all
            for missing in (None, "", 7):
                with pytest.raises(ValueError):
                    execute_and_report(call, [adapter], "http://pcc", "key", missing)

        adapter.execute.assert_not_called()
        mock_pcc.assert_not_called()

    def test_refuses_a_call_that_names_another_kernel(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        call = {"id": "c8", "kernelId": "someone-elses", "toolName": "t", "args": {}}

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            assert execute_and_report(call, [adapter], "http://pcc", "key", kernel_id="k1") is False

        adapter.execute.assert_not_called()
        mock_pcc.assert_not_called()

    def test_the_polled_kernel_wins_and_is_url_encoded(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})
        call = {"id": "c7", "toolName": "t", "args": {}}

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {})
            execute_and_report(call, [adapter], "http://pcc", "key", kernel_id="a/b?c#d")

        assert mock_pcc.call_args[0][:2] == ("POST", "/api/relay/a%2Fb%3Fc%23d/tool-result")

    def test_poll_url_encodes_the_kernel_id(self):
        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"calls": []})
            poll_pending_jobs("http://pcc", "key", "../admin")
        assert mock_pcc.call_args[0][:2] == ("GET", "/api/relay/..%2Fadmin/tool-call/pending")

    def test_falls_through_adapters(self):
        """If first adapter returns 'Unknown tool', try the next."""
        adapter1 = mock.Mock()
        adapter1.device_type = "a1"
        adapter1.execute.return_value = json.dumps({"error": "Unknown tool: x"})

        adapter2 = mock.Mock()
        adapter2.device_type = "a2"
        adapter2.execute.return_value = json.dumps({"result": "handled"})

        call = {"id": "c2", "kernelId": "k1", "toolName": "x", "toolArgs": {}}

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {})
            execute_and_report(call, [adapter1, adapter2], "http://pcc", "key", "k1")

        adapter1.execute.assert_called_once()
        adapter2.execute.assert_called_once()


class TestRunPendingOnce:
    """The path from polling to execution binds every call to the polled kernel."""

    def _gateway(self, calls):
        """A fake PCC: GET pending answers `calls`; POST tool-result is recorded."""
        posted = []

        def pcc_request(method, path, body=None, base_url=None, api_key=None):
            if method == "GET":
                return 200, {"calls": calls}
            posted.append((path, body))
            return 200, {}

        return pcc_request, posted

    def test_a_foreign_call_in_the_polled_list_never_touches_the_device(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})
        calls = [
            {"id": "mine", "kernelId": "k1", "toolName": "t", "args": {"n": 1}},
            {"id": "foreign", "kernelId": "k2", "toolName": "t", "args": {"n": 2}},
            {"id": "unstated", "toolName": "t", "args": {"n": 3}},
            "not-a-call",
        ]
        fake, posted = self._gateway(calls)
        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake) as mock_pcc:
            assert run_pending_once([adapter], "http://pcc", "key", "k1") == (2, 2)

        assert mock_pcc.call_args_list[0][0][:2] == ("GET", "/api/relay/k1/tool-call/pending")
        assert [c.args for c in adapter.execute.call_args_list] == [("t", {"n": 1}), ("t", {"n": 3})]
        assert [(path, body["callId"]) for path, body in posted] == [
            ("/api/relay/k1/tool-result", "mine"),
            ("/api/relay/k1/tool-result", "unstated"),
        ]

    def test_it_needs_the_kernel_it_polls(self):
        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            with pytest.raises(ValueError):
                run_pending_once([], "http://pcc", "key", "")
        mock_pcc.assert_not_called()
