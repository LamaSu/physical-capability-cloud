"""Tests for PCC registration."""

from unittest import mock

import pytest

from pcc_node.register import (
    provision_api_key,
    register_kernel,
    announce_capabilities,
    send_heartbeat,
)
from pcc_node.config import NodeConfig


class TestProvisionApiKey:
    def test_success(self):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {"apiKey": "test-key-123"})
            key = provision_api_key("http://pcc")
        assert key == "test-key-123"

    def test_alternate_key_field(self):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"api_key": "alt-key"})
            key = provision_api_key("http://pcc")
        assert key == "alt-key"

    def test_failure(self):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (500, {"error": "server down"})
            key = provision_api_key("http://pcc")
        assert key == ""


class TestRegisterKernel:
    def test_success(self):
        cfg = NodeConfig(kernel_id="k1", kernel_name="test")
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {"id": "k1", "status": "registered"})
            result = register_kernel("http://pcc", "key", cfg)
        assert result["status"] == "registered"

    def test_failure(self):
        cfg = NodeConfig(kernel_id="k1", kernel_name="test")
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (400, {"error": "bad request"})
            result = register_kernel("http://pcc", "key", cfg)
        assert "error" in result


class TestAnnounceCapabilities:
    def test_with_opentrons(self):
        devices = [{"type": "opentrons", "url": "http://localhost:31950"}]
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {})
            announce_capabilities("http://pcc", "key", "k1", devices)
        mock_pcc.assert_called_once()
        body = mock_pcc.call_args[1].get("body") or mock_pcc.call_args[0][2]
        assert "liquid-handler" in body["capabilities"]

    def test_empty_devices(self):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            announce_capabilities("http://pcc", "key", "k1", [])
        mock_pcc.assert_not_called()

    def test_with_signature(self):
        devices = [{"type": "camera", "path": "/dev/video0"}]
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc, \
             mock.patch("pcc_node.register.sign_announcement", return_value="deadbeef"):
            mock_pcc.return_value = (200, {})
            announce_capabilities("http://pcc", "key", "k1", devices, secret_key="ab" * 32)
        body = mock_pcc.call_args[1].get("body") or mock_pcc.call_args[0][2]
        assert body["signature"] == "deadbeef"


class TestSendHeartbeat:
    def test_sends_heartbeat(self):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {})
            send_heartbeat("http://pcc", "key", "k1", "online")
        mock_pcc.assert_called_once()
        args = mock_pcc.call_args
        assert args[0][1] == "/api/kernels/k1/heartbeat"
