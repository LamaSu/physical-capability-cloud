"""Tests for PCC registration."""

from unittest import mock

import pytest

from pcc_node.register import (
    provision_api_key,
    register_kernel,
    announce_capabilities,
    send_heartbeat,
    register_signing_key,
    kernel_signing_proof_message,
)
from pcc_node.log_capture import LogSigningRefused, _HAS_NACL
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


class TestRegisterSigningKey:
    def _real_ed25519(self):
        import nacl.signing
        import nacl.encoding

        sk = nacl.signing.SigningKey(bytes.fromhex("deadbeef" * 8))
        pub = sk.verify_key.encode(nacl.encoding.HexEncoder).decode("ascii")
        return pub, "deadbeef" * 8

    def test_challenge_string_matches_gateway(self):
        # Must equal kernelSigningProofMessage(kernelId), kernel-keychain.ts.
        assert (
            kernel_signing_proof_message("kernel_1")
            == "pcc-kernel-signing-key:kernel_1"
        )

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl required")
    def test_posts_tagged_ed25519_proof(self):
        pub, sec = self._real_ed25519()
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"ok": True})
            status, _ = register_signing_key("http://pcc", "key", "kernel_1", pub, sec)
        assert status == 200
        # Upsert route -- the key-proof is verified on the kernel registration
        # path, keeping ONE proof route (no dedicated /signing-key subroute).
        assert mock_pcc.call_args[0][1] == "/api/kernels"
        body = mock_pcc.call_args[1]["body"]
        assert body["id"] == "kernel_1"
        assert body["signingKeyAlgorithm"] == "ed25519"
        assert body["signingPublicKey"] == "0x" + pub.lower()
        assert len(body["signingProof"]) == 128  # 64-byte ed25519 sig, hex
        # The proof is a valid ed25519 signature over the EXACT challenge string.
        import nacl.signing

        vk = nacl.signing.VerifyKey(bytes.fromhex(pub))
        vk.verify(
            b"pcc-kernel-signing-key:kernel_1",
            bytes.fromhex(body["signingProof"]),
        )

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl required")
    def test_accepts_0x_prefixed_pubkey_without_double_prefix(self):
        pub, sec = self._real_ed25519()
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {})
            register_signing_key("http://pcc", "key", "k", "0x" + pub, sec)
        body = mock_pcc.call_args[1]["body"]
        assert body["signingPublicKey"] == "0x" + pub.lower()  # not 0x0x...

    def test_refuses_when_pynacl_absent(self, monkeypatch):
        import pcc_node.log_capture as lc

        monkeypatch.setattr(lc, "_HAS_NACL", False)
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            with pytest.raises(LogSigningRefused):
                register_signing_key(
                    "http://pcc", "key", "k1", "0x" + "ab" * 32, "cd" * 32
                )
        # Money-path invariant: never POST an HMAC value as ed25519.
        mock_pcc.assert_not_called()

    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl required")
    def test_refuses_real_hmac_fallback_key(self, monkeypatch):
        import pcc_node.crypto as crypto_mod

        monkeypatch.setattr(crypto_mod, "_HAS_NACL", False)
        pub, sec = crypto_mod.generate_node_keys()  # public = sha256(secret)
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            with pytest.raises(LogSigningRefused):
                register_signing_key("http://pcc", "key", "k1", pub, sec)
        mock_pcc.assert_not_called()
