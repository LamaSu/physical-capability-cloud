#!/usr/bin/env python3
"""Tests for printer-executor.py -- mocks subprocess and HTTP calls."""

import json
import os
import sys
import base64
import unittest
from unittest.mock import patch, MagicMock

# Set required env before import
os.environ["PCC_API_KEY"] = "test-key-1234"
os.environ["PCC_BASE"] = "https://test.capability.network"
os.environ["KERNEL_ID"] = "kernel-hp-printer"
os.environ["PRINTER_NAME"] = "TestPrinter"
os.environ["POLL_INTERVAL"] = "1"

# Import the module under test
sys.path.insert(0, os.path.dirname(__file__))
import importlib
printer_executor = importlib.import_module("printer-executor")


class TestRunCmd(unittest.TestCase):
    @patch("subprocess.run")
    def test_success(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="OK\n", stderr="")
        rc, out, err = printer_executor.run_cmd(["echo", "hi"])
        self.assertEqual(rc, 0)
        self.assertEqual(out, "OK\n")

    @patch("subprocess.run", side_effect=FileNotFoundError("nope"))
    def test_command_not_found(self, mock_run):
        rc, out, err = printer_executor.run_cmd(["nonexistent"])
        self.assertEqual(rc, -1)
        self.assertIn("Command not found", err)

    @patch("subprocess.run", side_effect=__import__("subprocess").TimeoutExpired(["x"], 5))
    def test_timeout(self, mock_run):
        rc, out, err = printer_executor.run_cmd(["slow"], timeout=5)
        self.assertEqual(rc, -1)
        self.assertIn("timed out", err)


class TestExecuteTool(unittest.TestCase):
    @patch("subprocess.run")
    def test_printer_status(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="printer TestPrinter is idle.",
            stderr="",
        )
        result = json.loads(printer_executor.execute_tool("printer_status", {}))
        self.assertEqual(result["printer"], "TestPrinter")
        self.assertIn("idle", result["status"])
        self.assertEqual(result["exit_code"], 0)

    @patch("subprocess.run")
    def test_printer_queue(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="TestPrinter is ready\nno entries",
            stderr="",
        )
        result = json.loads(printer_executor.execute_tool("printer_queue", {}))
        self.assertIn("ready", result["queue"])

    @patch("subprocess.run")
    def test_printer_print_text(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="request id is TestPrinter-42 (1 file(s))",
            stderr="",
        )
        result = json.loads(printer_executor.execute_tool(
            "printer_print_text", {"text": "Hello World"}
        ))
        self.assertTrue(result["printed"])
        self.assertIn("TestPrinter-42", result["job_info"])

    def test_printer_print_text_empty(self):
        result = json.loads(printer_executor.execute_tool(
            "printer_print_text", {}
        ))
        self.assertIn("error", result)
        self.assertIn("No text", result["error"])

    @patch("subprocess.run")
    def test_printer_print_text_with_copies(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="request id is TestPrinter-99 (1 file(s))",
            stderr="",
        )
        result = json.loads(printer_executor.execute_tool(
            "printer_print_text", {"text": "copies test", "copies": 3}
        ))
        self.assertTrue(result["printed"])
        self.assertEqual(result["copies"], 3)
        # Verify -n 3 was in the command
        call_args = mock_run.call_args[0][0]
        idx = call_args.index("-n")
        self.assertEqual(call_args[idx + 1], "3")

    @patch("subprocess.run")
    def test_printer_print_url(self, mock_run):
        # First call: curl download succeeds
        # Second call: lp print succeeds
        mock_run.side_effect = [
            MagicMock(returncode=0, stdout="", stderr=""),  # curl
            MagicMock(returncode=0, stdout="request id is TestPrinter-55 (1 file(s))", stderr=""),  # lp
        ]
        # We need to also mock os.path.getsize so it doesn't check the temp file
        with patch("os.path.getsize", return_value=1024):
            result = json.loads(printer_executor.execute_tool(
                "printer_print_url", {"url": "https://example.com/doc.pdf"}
            ))
        self.assertTrue(result["printed"])

    def test_printer_print_url_empty(self):
        result = json.loads(printer_executor.execute_tool(
            "printer_print_url", {}
        ))
        self.assertIn("error", result)

    @patch("subprocess.run")
    def test_printer_print_file(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="request id is TestPrinter-77 (1 file(s))",
            stderr="",
        )
        content = base64.b64encode(b"fake pdf content").decode()
        result = json.loads(printer_executor.execute_tool(
            "printer_print_file", {"content": content, "filename": "test.pdf"}
        ))
        self.assertTrue(result["printed"])
        self.assertEqual(result["filename"], "test.pdf")

    def test_printer_print_file_empty(self):
        result = json.loads(printer_executor.execute_tool(
            "printer_print_file", {}
        ))
        self.assertIn("error", result)

    def test_printer_print_file_bad_base64(self):
        result = json.loads(printer_executor.execute_tool(
            "printer_print_file", {"content": "!!!not-base64!!!"}
        ))
        self.assertIn("error", result)

    @patch("subprocess.run")
    def test_printer_cancel(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
        result = json.loads(printer_executor.execute_tool(
            "printer_cancel", {"jobId": "TestPrinter-42"}
        ))
        self.assertTrue(result["cancelled"])
        self.assertEqual(result["job_id"], "TestPrinter-42")

    def test_printer_cancel_no_id(self):
        result = json.loads(printer_executor.execute_tool("printer_cancel", {}))
        self.assertIn("error", result)

    @patch("subprocess.run")
    def test_printer_options(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="PageSize/Page Size: Letter *A4 Legal\nDuplex/Double-Sided: None *DuplexNoTumble",
            stderr="",
        )
        result = json.loads(printer_executor.execute_tool("printer_options", {}))
        self.assertIn("PageSize", result["options"])

    def test_unknown_tool(self):
        result = json.loads(printer_executor.execute_tool("nonexistent_tool", {}))
        self.assertIn("error", result)
        self.assertIn("Unknown tool", result["error"])


class TestPollToolCalls(unittest.TestCase):
    @patch.object(printer_executor, "pcc")
    def test_generic_relay_success(self, mock_pcc):
        printer_executor._use_relay = True
        mock_pcc.return_value = (200, {
            "calls": [
                {"id": "tc_1", "toolName": "printer_status", "args": {}},
            ],
            "count": 1,
        })
        calls = printer_executor.poll_tool_calls()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["toolName"], "printer_status")
        # Should have called the generic relay endpoint
        mock_pcc.assert_called_with("GET", "/api/relay/kernel-hp-printer/tool-call/pending")

    @patch.object(printer_executor, "pcc")
    def test_fallback_to_ot2_on_404(self, mock_pcc):
        printer_executor._use_relay = True
        mock_pcc.side_effect = [
            (404, {"error": "Not found"}),  # generic relay 404
            (200, {"calls": [{"id": "tc_2", "toolName": "printer_queue", "args": {}}]}),  # ot2 relay
        ]
        calls = printer_executor.poll_tool_calls()
        self.assertEqual(len(calls), 1)
        self.assertFalse(printer_executor._use_relay)  # switched to ot2

    @patch.object(printer_executor, "pcc")
    def test_empty_poll(self, mock_pcc):
        printer_executor._use_relay = True
        mock_pcc.return_value = (200, {"calls": [], "count": 0})
        calls = printer_executor.poll_tool_calls()
        self.assertEqual(len(calls), 0)


class TestExecuteAndReport(unittest.TestCase):
    @patch.object(printer_executor, "post_result")
    @patch.object(printer_executor, "execute_tool")
    def test_execute_and_report(self, mock_exec, mock_post):
        mock_exec.return_value = '{"status": "idle"}'
        mock_post.return_value = (200, {"ok": True})

        call = {
            "id": "tc_test",
            "toolName": "printer_status",
            "args": {},
        }
        printer_executor.execute_and_report(call)
        mock_exec.assert_called_once_with("printer_status", {})
        mock_post.assert_called_once_with("tc_test", '{"status": "idle"}')

    @patch.object(printer_executor, "post_result")
    @patch.object(printer_executor, "execute_tool")
    def test_handles_toolArgs_field(self, mock_exec, mock_post):
        mock_exec.return_value = '{"ok": true}'
        mock_post.return_value = (200, {})

        call = {
            "id": "tc_alt",
            "toolName": "printer_queue",
            "toolArgs": {"extra": "data"},
        }
        printer_executor.execute_and_report(call)
        mock_exec.assert_called_once_with("printer_queue", {"extra": "data"})

    @patch.object(printer_executor, "post_result")
    @patch.object(printer_executor, "execute_tool")
    def test_handles_string_args(self, mock_exec, mock_post):
        mock_exec.return_value = '{"ok": true}'
        mock_post.return_value = (200, {})

        call = {
            "id": "tc_str",
            "toolName": "printer_status",
            "args": '{"key": "val"}',
        }
        printer_executor.execute_and_report(call)
        mock_exec.assert_called_once_with("printer_status", {"key": "val"})


class TestPostResult(unittest.TestCase):
    @patch.object(printer_executor, "pcc")
    def test_posts_to_relay(self, mock_pcc):
        printer_executor._use_relay = True
        mock_pcc.return_value = (200, {"ok": True})
        s, r = printer_executor.post_result("tc_1", '{"done": true}')
        self.assertEqual(s, 200)
        mock_pcc.assert_called_with(
            "POST",
            "/api/relay/kernel-hp-printer/tool-result",
            {"callId": "tc_1", "result": '{"done": true}'},
        )

    @patch.object(printer_executor, "pcc")
    def test_posts_with_error(self, mock_pcc):
        printer_executor._use_relay = True
        mock_pcc.return_value = (200, {"ok": True})
        s, r = printer_executor.post_result("tc_1", '{}', error="something broke")
        call_body = mock_pcc.call_args[0][2]
        self.assertEqual(call_body["error"], "something broke")


class TestConfig(unittest.TestCase):
    def test_config_values(self):
        self.assertEqual(printer_executor.KERNEL_ID, "kernel-hp-printer")
        self.assertEqual(printer_executor.PRINTER_NAME, "TestPrinter")
        self.assertEqual(printer_executor.PCC_BASE, "https://test.capability.network")
        self.assertEqual(printer_executor.POLL_INTERVAL, 1)


if __name__ == "__main__":
    unittest.main()
