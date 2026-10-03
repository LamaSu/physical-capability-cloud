"""Tests for the executor and device adapters."""

import json
import time
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


@pytest.fixture(autouse=True)
def _isolated_fence_dir(tmp_path, monkeypatch):
    """#400 F3: every test gets its own PCC_NODE_FENCE_DIR, never the real
    ~/.pcc-node/relay-fence. Also clears PCC_NODE_LEASE_FRESHNESS_S so a
    developer's/CI's shell env can't make freshness tests flaky."""
    monkeypatch.setenv("PCC_NODE_FENCE_DIR", str(tmp_path / "relay-fence"))
    monkeypatch.delenv("PCC_NODE_LEASE_FRESHNESS_S", raising=False)
    return tmp_path / "relay-fence"


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

        call = {
            "id": "c1", "kernelId": "k1", "toolName": "test_tool", "args": {"x": 1},
            "claimToken": "tok-1", "_receivedAt": time.monotonic(),
        }

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"started": True})
            assert execute_and_report(call, [adapter], "http://pcc", "key", "k1") is True

        adapter.execute.assert_called_once_with("test_tool", {"x": 1})
        # Lease start, then the result post -- the lease guard runs first.
        assert mock_pcc.call_count == 2
        post_body = mock_pcc.call_args[1].get("body") or mock_pcc.call_args[0][2]
        assert post_body["callId"] == "c1"
        assert post_body["result"] == json.dumps({"ok": True})
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
        call = {
            "id": "c7", "toolName": "t", "args": {},
            "claimToken": "tok-7", "_receivedAt": time.monotonic(),
        }

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"started": True})
            execute_and_report(call, [adapter], "http://pcc", "key", kernel_id="a/b?c#d")

        adapter.execute.assert_called_once_with("t", {})
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

        call = {
            "id": "c2", "kernelId": "k1", "toolName": "x", "toolArgs": {},
            "claimToken": "tok-2", "_receivedAt": time.monotonic(),
        }

        with mock.patch("pcc_node.executor.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"started": True})
            execute_and_report(call, [adapter1, adapter2], "http://pcc", "key", "k1")

        adapter1.execute.assert_called_once()
        adapter2.execute.assert_called_once()


class TestRunPendingOnce:
    """The path from polling to execution binds every call to the polled kernel."""

    def _gateway(self, calls):
        """A fake PCC: GET pending answers `calls`; POST .../start grants the
        lease; POST tool-result is recorded."""
        posted = []

        def pcc_request(method, path, body=None, **_kwargs):
            if method == "GET":
                return 200, {"calls": calls}
            if path.endswith("/start"):
                return 200, {"started": True}
            posted.append((path, body))
            return 200, {}

        return pcc_request, posted

    def test_a_foreign_call_in_the_polled_list_never_touches_the_device(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})
        calls = [
            {"id": "mine", "kernelId": "k1", "toolName": "t", "args": {"n": 1}, "claimToken": "tok-mine"},
            {"id": "foreign", "kernelId": "k2", "toolName": "t", "args": {"n": 2}},
            {"id": "unstated", "toolName": "t", "args": {"n": 3}, "claimToken": "tok-unstated"},
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


class TestExecutionLeaseGuard:
    """#400 F3: a self-contained fail-closed re-check right before adapter.execute().

    Cross-family review finding (r5, F3, HIGH): the exact-SHA pcc-node checked only
    that kernelId matched, then called adapter.execute() unconditionally -- never
    rechecking e-stop/scope/budget/breaker/freshness, and with no execution fencing.
    adk (#5510) ruled the node-side fix is this guard, reusing #471's claim-token
    wire shape (claim, then start with the token).
    """

    def test_reproduction_409_lease_refused_must_block_execution(self):
        """THE BUG (#400 F3). A claimed call whose lease the gateway refuses (409
        lease_refused, emergency_stopped) must never reach adapter.execute, and
        nothing may be reported for it (the gateway already closed the call).

        At HEAD 30e41a3f this FAILS: the unchanged execute_and_report never asks
        for a lease at all -- it runs the adapter and posts the result regardless.
        """
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})

        call = {
            "id": "c-repro",
            "kernelId": "k1",
            "toolName": "t",
            "args": {},
            "claimToken": "tok-repro",
            "_receivedAt": time.monotonic(),
        }

        posted = []

        def fake_pcc_request(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                return 409, {"error": "lease_refused", "reason": "emergency_stopped"}
            posted.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake_pcc_request):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posted == []

    def _late_grant(self, advance_s, lease_ms=5000, adapters=None, call_id="c-late"):
        """r7 F3 (CRITICAL): the gateway grants the lease, but the grant reaches the node
        `advance_s` seconds after the node asked for it. Returns (result, adapters, posts).
        Each call in one test needs its own call_id: the fence refuses a repeated id."""
        clock = [1000.0]
        if adapters is None:
            adapter = mock.Mock()
            adapter.device_type = "test"
            adapter.execute.return_value = json.dumps({"ok": True})
            adapters = [adapter]
        call = {
            "id": call_id, "kernelId": "k1", "toolName": "t", "args": {},
            "claimToken": "tok-late", "_receivedAt": 1000.0,
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                clock[0] += advance_s
                answer = {"started": True, "callId": call_id}
                if lease_ms is not None:
                    answer["leaseMs"] = lease_ms
                return 200, answer
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.time.monotonic", side_effect=lambda: clock[0]), \
                mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, adapters, "http://pcc", "key", "k1")
        return result, adapters, posts

    @pytest.mark.parametrize("advance_s", [31.0, 6.0])
    def test_a_grant_that_arrives_after_the_lease_window_never_reaches_the_adapter(self, advance_s):
        """r7 F3 (CRITICAL) reproduction: a valid 200 started:true that reaches the node after
        the freshness bound (31 s) or after the lease window (6 s) must not run."""
        result, adapters, posts = self._late_grant(advance_s)
        assert result is False
        adapters[0].execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-late", "error": "not_executed:lease_expired"}),
        ]

    def test_a_grant_inside_the_lease_window_runs(self):
        result, adapters, posts = self._late_grant(1.0)
        assert result is True
        adapters[0].execute.assert_called_once()

    def test_the_gateway_can_shorten_the_lease_window_but_never_lengthen_it(self):
        expired = {"callId": None, "error": "not_executed:lease_expired"}
        result, adapters, posts = self._late_grant(2.0, lease_ms=1000, call_id="c-short")
        assert result is False
        adapters[0].execute.assert_not_called()
        assert posts[-1][2] == dict(expired, callId="c-short")
        result, adapters, posts = self._late_grant(6.0, lease_ms=60000, call_id="c-long")
        assert result is False  # capped at the node's own window
        adapters[0].execute.assert_not_called()
        assert posts[-1][2] == dict(expired, callId="c-long")
        result, adapters, _posts = self._late_grant(1.0, lease_ms=None, call_id="c-none")
        assert result is True  # no leaseMs: the node's own window applies
        adapters[0].execute.assert_called_once()
        result, adapters, _posts = self._late_grant(0.5, lease_ms=1000, call_id="c-inside")
        assert result is True
        adapters[0].execute.assert_called_once()

    def test_the_lease_is_rechecked_before_every_adapter(self):
        clock_box = {}

        def first_execute(tool, args):
            clock_box["advance"]()
            return json.dumps({"error": "Unknown tool: t"})

        first = mock.Mock()
        first.device_type = "first"
        first.execute.side_effect = first_execute
        second = mock.Mock()
        second.device_type = "second"
        second.execute.return_value = json.dumps({"ok": True})
        clock = [1000.0]
        clock_box["advance"] = lambda: clock.__setitem__(0, clock[0] + 6.0)
        call = {"id": "c-two", "kernelId": "k1", "toolName": "t", "args": {}, "claimToken": "tok-two", "_receivedAt": 1000.0}
        posts = []

        def fake(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                return 200, {"started": True, "leaseMs": 5000}
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.time.monotonic", side_effect=lambda: clock[0]), \
                mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, [first, second], "http://pcc", "key", "k1")
        assert result is False
        first.execute.assert_called_once()
        second.execute.assert_not_called()
        assert posts[-1][2] == {"callId": "c-two", "error": "not_executed:lease_expired"}

    def _paused_after_final_check(self, adapter, tool_name, args, advance_s=6.0, extra_patches=()):
        """r8 F3 (CRITICAL): the real final check passes, then the process is suspended for
        `advance_s` before the adapter emits its device command. Returns (result, posts, sent)
        where `sent` is the mocked urlopen (the device boundary)."""
        import pcc_node.executor as ex

        clock = [1000.0]
        real_check = ex.lease_refusal_at_entry

        def check_then_pause(call, deadline):
            refusal = real_check(call, deadline)
            clock[0] += advance_s
            return refusal

        call = {
            "id": "c-pause-" + tool_name, "kernelId": "k1", "toolName": tool_name, "args": args,
            "claimToken": "tok-pause", "_receivedAt": 1000.0,
        }
        posts = []

        def fake_pcc(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                return 200, {"started": True, "leaseMs": 5000}
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.time.monotonic", side_effect=lambda: clock[0]), \
                mock.patch("pcc_node.executor.lease_refusal_at_entry", side_effect=check_then_pause), \
                mock.patch("pcc_node.executor.pcc_request", side_effect=fake_pcc), \
                mock.patch("pcc_node.http_util.urlopen") as sent:
            sent.return_value.__enter__.return_value.read.return_value = b'{"ok": true}'
            sent.return_value.__enter__.return_value.status = 200
            for patcher in extra_patches:
                patcher.start()
            try:
                result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")
            finally:
                for patcher in extra_patches:
                    patcher.stop()
        return result, posts, sent

    def test_a_pause_after_the_final_check_still_sends_no_device_command(self):
        """r8 F3 (CRITICAL) reproduction, astra's cheapest: the check passes, the process
        pauses six seconds, and the adapter's device request must not leave the node."""
        from pcc_node.executor import GenericHTTPAdapter

        result, posts, sent = self._paused_after_final_check(
            GenericHTTPAdapter(base_url="http://device.invalid"), "move", {"method": "POST", "path": "/move"},
        )
        sent.assert_not_called()
        assert result is False
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-pause-move", "error": "not_executed:lease_expired"}),
        ]

    # ── r11: the deadline holds at the socket write (a real server on 127.0.0.1) ──

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
        """The first request is written before the deadline. The second would start after it, so
        it is never written. The report is a device outcome: the first may have moved the device."""
        import pcc_node.executor as ex
        from pcc_node.http_util import http

        url, received, stop = self._device_server()
        clock = [1000.0]

        class TwoStep(object):
            device_type = "two-step"

            def execute(self, tool_name, tool_args):
                first = http("POST", url + "/a", {})
                clock[0] += 6.0  # the first move took long
                second = http("POST", url + "/b", {})
                return json.dumps({"first": first[0], "second": second[0]})

        call = {"id": "c-two-step", "kernelId": "k1", "toolName": "t", "args": {},
                "claimToken": "tok-ts", "_receivedAt": 1000.0}
        posts = []

        def fake_pcc(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                return 200, {"started": True, "leaseMs": 5000}
            posts.append((method, path, body))
            return 200, {}

        try:
            with mock.patch("pcc_node.executor.time.monotonic", side_effect=lambda: clock[0]), \
                    mock.patch("pcc_node.executor.pcc_request", side_effect=fake_pcc):
                result = ex.execute_and_report(call, [TwoStep()], "http://pcc", "key", "k1")
        finally:
            stop()
        assert [path for path, _ in received] == ["/a"]
        assert result is False
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-two-step", "error": "lease_lapsed_mid_command"}),
        ]

    def test_under_a_lease_the_shell_path_is_refused_outright(self):
        """A started shell process can act at any later time, so no deadline bounds it: under a lease
        it never runs, whatever the clock says."""
        import pcc_node.http_util as hu
        from pcc_node.executor import OpentronAdapter

        with mock.patch("pcc_node.executor.subprocess.run") as ran:
            with hu.actuation_deadline(10 ** 9) as guard:
                shell = OpentronAdapter(base_url="http://ot2.invalid")._shell({"command": "true"})
            outside = OpentronAdapter(base_url="http://ot2.invalid")._shell({"command": "true"})
        assert json.loads(shell) == {"error": "not_executed:shell_not_lease_bound"}
        assert guard["refused"] == "not_executed:shell_not_lease_bound" and guard["written"] == 0
        assert ran.call_count == 1  # only the call outside any lease ran
        assert "error" not in json.loads(outside) or "not_executed" not in json.loads(outside)["error"]

    def test_a_relayed_shell_call_is_reported_not_executed(self):
        from pcc_node.executor import OpentronAdapter

        with mock.patch("pcc_node.executor.subprocess.run") as run:
            result, posts, sent = self._paused_after_final_check(
                OpentronAdapter(base_url="http://ot2.invalid"), "ot2_shell", {"command": "true"}, advance_s=0.0,
            )
        run.assert_not_called()
        assert result is False
        assert posts[-1][2] == {"callId": "c-pause-ot2_shell", "error": "not_executed:shell_not_lease_bound"}

    def test_200_started_true_runs_adapter_once_and_reports_result(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})

        call = {
            "id": "c-ok", "kernelId": "k1", "toolName": "t", "args": {"a": 1},
            "claimToken": "tok-ok", "_receivedAt": time.monotonic(),
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                assert body == {"claimToken": "tok-ok"}
                return 200, {"started": True, "callId": "c-ok", "startedAt": "2026-01-01T00:00:00Z"}
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is True
        adapter.execute.assert_called_once_with("t", {"a": 1})
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-ok", "result": json.dumps({"ok": True})}),
        ]

    @pytest.mark.parametrize("bad_call", [
        {"id": "c-missing", "kernelId": "k1", "toolName": "t", "args": {}},
        {"id": "c-empty", "kernelId": "k1", "toolName": "t", "args": {}, "claimToken": ""},
        {"id": "c-wrongtype", "kernelId": "k1", "toolName": "t", "args": {}, "claimToken": 12345},
    ])
    def test_no_claim_token_refuses_and_reports_no_lease(self, bad_call):
        adapter = mock.Mock()
        adapter.device_type = "test"
        bad_call = dict(bad_call, _receivedAt=time.monotonic())
        posts = []

        def fake(method, path, body=None, **_kwargs):
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(bad_call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": bad_call["id"], "error": "not_executed:no_lease"}),
        ]

    def test_stale_call_refuses_and_reports_stale(self):
        """More than LEASE_FRESHNESS_S (default 30s) has passed since receipt;
        fake the monotonic clock rather than actually sleeping."""
        adapter = mock.Mock()
        adapter.device_type = "test"

        call = {
            "id": "c-stale", "kernelId": "k1", "toolName": "t", "args": {},
            "claimToken": "tok-stale", "_receivedAt": 1000.0,
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake), \
                mock.patch("pcc_node.executor.time.monotonic", return_value=1000.0 + 30.000001):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-stale", "error": "not_executed:stale"}),
        ]

    @pytest.mark.parametrize("missing_receipt", [
        {"id": "c-noreceipt-1", "kernelId": "k1", "toolName": "t", "args": {}, "claimToken": "t1"},
        {"id": "c-noreceipt-2", "kernelId": "k1", "toolName": "t", "args": {}, "claimToken": "t1", "_receivedAt": None},
        {"id": "c-noreceipt-3", "kernelId": "k1", "toolName": "t", "args": {}, "claimToken": "t1", "_receivedAt": "oops"},
    ])
    def test_no_receipt_time_is_stale(self, missing_receipt):
        """'A call with no receipt time is stale.'"""
        adapter = mock.Mock()
        adapter.device_type = "test"
        posts = []

        def fake(method, path, body=None, **_kwargs):
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(missing_receipt, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": missing_receipt["id"], "error": "not_executed:stale"}),
        ]

    def test_same_call_id_twice_fences_the_second_attempt(self):
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})

        def make_call():
            return {
                "id": "c-dupe", "kernelId": "k1", "toolName": "t", "args": {},
                "claimToken": "tok-dupe", "_receivedAt": time.monotonic(),
            }

        posts = []

        def fake(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                return 200, {"started": True}
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            first = execute_and_report(make_call(), [adapter], "http://pcc", "key", "k1")
            second = execute_and_report(make_call(), [adapter], "http://pcc", "key", "k1")

        assert first is True
        assert second is False
        adapter.execute.assert_called_once()
        # Only the first attempt is reported; the fenced second attempt is silent.
        assert len(posts) == 1
        assert posts[0][2]["callId"] == "c-dupe"
        assert posts[0][2]["result"] == json.dumps({"ok": True})

    @pytest.mark.parametrize("start_behavior", ["raises", "503_policy_unavailable", "transport_zero"])
    def test_transport_error_timeout_or_503_reports_lease_unavailable(self, start_behavior):
        adapter = mock.Mock()
        adapter.device_type = "test"

        call = {
            "id": "c-unavail", "kernelId": "k1", "toolName": "t", "args": {},
            "claimToken": "tok-unavail", "_receivedAt": time.monotonic(),
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                if start_behavior == "raises":
                    raise TimeoutError("timed out")
                if start_behavior == "503_policy_unavailable":
                    return 503, {"error": "policy_unavailable"}
                return 0, {"error": "Connection refused"}  # transport_zero
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-unavail", "error": "not_executed:lease_unavailable"}),
        ]

    @pytest.mark.parametrize("start_body", [{"started": False}, {}, {"started": "true"}, {"started": 1}])
    def test_200_without_started_true_does_not_run(self, start_body):
        """Spec gap (documented in the report): the wire contract only names
        200/409/404/503-or-other as report buckets; a malformed 200 isn't
        listed. We fail closed (never run) AND report "lease_unavailable",
        bucketing it with "any other status" so the gateway isn't left
        believing the call may still be open."""
        adapter = mock.Mock()
        adapter.device_type = "test"

        call = {
            "id": "c-notstarted", "kernelId": "k1", "toolName": "t", "args": {},
            "claimToken": "tok-ns", "_receivedAt": time.monotonic(),
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            if path.endswith("/start"):
                return 200, start_body
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-notstarted", "error": "not_executed:lease_unavailable"}),
        ]

    def test_poll_sends_lease_header(self):
        sent_headers = {}

        def fake(method, path, body=None, **kwargs):
            sent_headers.update(kwargs.get("headers") or {})
            return 200, {"calls": [{"id": "c1", "toolName": "t", "args": {}}]}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            calls = poll_pending_jobs("http://pcc", "key", "k1")

        assert sent_headers == {"X-PCC-Lease": "1"}
        assert isinstance(calls[0]["_receivedAt"], float)

    def test_receipt_time_never_reaches_any_outgoing_body(self):
        """The full poll -> execute cycle: _receivedAt must never appear in
        any body sent to the gateway (poll, lease-start, or tool-result)."""
        adapter = mock.Mock()
        adapter.device_type = "test"
        adapter.execute.return_value = json.dumps({"ok": True})

        bodies = []

        def fake(method, path, body=None, **_kwargs):
            bodies.append(body)
            if method == "GET":
                return 200, {"calls": [
                    {"id": "c1", "toolName": "t", "args": {}, "claimToken": "tok-1"},
                ]}
            if path.endswith("/start"):
                return 200, {"started": True}
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            executed, refused = run_pending_once([adapter], "http://pcc", "key", "k1")

        assert (executed, refused) == (1, 0)
        assert len(bodies) == 3  # poll (None), lease-start, tool-result
        for body in bodies:
            if isinstance(body, dict):
                assert "_receivedAt" not in body

    def test_fence_dir_that_cannot_be_created_reports_fence_unavailable(self, tmp_path, monkeypatch):
        """A plain file sitting where the fence dir needs to be: os.makedirs
        can never succeed there, portably (no permission-bit tricks needed)."""
        adapter = mock.Mock()
        adapter.device_type = "test"

        blocked = tmp_path / "blocked-fence-dir"
        blocked.write_text("a file, not a directory")
        monkeypatch.setenv("PCC_NODE_FENCE_DIR", str(blocked))

        call = {
            "id": "c-fence", "kernelId": "k1", "toolName": "t", "args": {},
            "claimToken": "tok-fence", "_receivedAt": time.monotonic(),
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-fence", "error": "not_executed:fence_unavailable"}),
        ]

    @pytest.mark.parametrize("bad_value", ["not-a-number", "0", "-5", "nan", "inf"])
    def test_invalid_lease_freshness_env_var_fails_closed(self, bad_value, monkeypatch):
        """Spec gap (documented in the report): PCC_NODE_LEASE_FRESHNESS_S 'must
        parse as a positive number, else refuse to start the guard: fail
        closed.' No report string is named for this case; we collapse it into
        "stale" (the closest existing reason -- an untrustworthy bound means
        we cannot prove freshness either way, the same as a missing receipt
        time). inf is treated as invalid too: it would disable the staleness
        check entirely, which is not fail-closed."""
        monkeypatch.setenv("PCC_NODE_LEASE_FRESHNESS_S", bad_value)
        adapter = mock.Mock()
        adapter.device_type = "test"

        call = {
            "id": "c-badenv", "kernelId": "k1", "toolName": "t", "args": {},
            "claimToken": "tok-badenv", "_receivedAt": time.monotonic(),
        }
        posts = []

        def fake(method, path, body=None, **_kwargs):
            posts.append((method, path, body))
            return 200, {}

        with mock.patch("pcc_node.executor.pcc_request", side_effect=fake):
            result = execute_and_report(call, [adapter], "http://pcc", "key", "k1")

        assert result is False
        adapter.execute.assert_not_called()
        assert posts == [
            ("POST", "/api/relay/k1/tool-result", {"callId": "c-badenv", "error": "not_executed:stale"}),
        ]
