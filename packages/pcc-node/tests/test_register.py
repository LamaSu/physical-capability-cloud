"""Tests for PCC registration."""

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node.cli import main
from pcc_node.register import (
    provision_api_key,
    register_kernel,
    register_devices,
    announce_capabilities,
    send_heartbeat,
    register_signing_key,
    kernel_signing_proof_message,
    RegistrationError,
)
from pcc_node.log_capture import LogSigningRefused, _HAS_NACL
from pcc_node.config import NodeConfig


class TestProvisionApiKey:
    def test_provisions_then_uses_key_for_kernel_and_device_registration(self):
        cfg = NodeConfig(
            kernel_id="k1",
            kernel_name="test",
            devices=[{"id": "d1", "type": "camera", "model": "cam", "adapterType": "camera"}],
        )
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.side_effect = [
                (201, {"api_key": "test-key-123"}),
                (201, {"id": "k1"}),
                (201, {"id": "d1"}),
            ]
            key = provision_api_key("http://pcc")
            register_kernel("http://pcc", key, cfg)
            register_devices("http://pcc", key, cfg.kernel_id, cfg.devices)

        assert key == "test-key-123"
        calls = mock_pcc.call_args_list
        assert [call.args[1] for call in calls] == [
            "/api/auth/provision",
            "/api/kernels",
            "/api/devices/register",
        ]
        assert calls[0].kwargs["body"] == {"email": "", "name": "pcc-node"}
        assert calls[1].kwargs["api_key"] == "test-key-123"
        assert calls[1].kwargs["body"]["id"] == "k1"
        assert calls[2].kwargs["api_key"] == "test-key-123"

    def test_missing_api_key_field(self):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"apiKey": "obsolete-field"})
            key = provision_api_key("http://pcc")
        assert key == ""

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



class Gateway:
    """A loopback PCC gateway: every request gets one scripted answer, or, with ``hang_up``, the
    connection closes with no answer at all. Requests are recorded as (method, path, Authorization,
    JSON body)."""

    def __init__(self, status=200, body=None, headers=(), hang_up=False):
        self.requests = []
        gw = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                raw_in = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                gw.requests.append((self.command, self.path, self.headers.get("Authorization"),
                                    json.loads(raw_in) if raw_in else None))
                if hang_up:
                    self.close_connection = True
                    return
                raw = json.dumps({} if body is None else body).encode()
                self.send_response(status)
                for name, value in headers:
                    self.send_header(name, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _serve

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _refusing_url():
    """A loopback URL nothing listens on, so the connection is refused."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}"


REFUSAL = {"error": "Unauthorized", "message": "Invalid or missing API key"}


def _register(base):
    return register_kernel(base, "k-test", NodeConfig(kernel_id="k1", kernel_name="test"))


class TestRegisterKernelOverTheRealTransport:
    """ChatGPT r3 F2: register_kernel() fails closed on what a gateway actually sends.

    Only the gateway's answer is scripted (a loopback gateway); register_kernel(), pcc_request() and
    the gateway transport (no redirects followed) are the real ones. Item 133: anything but a 200 or
    201 must RAISE, so `start` and the daemon never claim the node is registered. At e7e6f821 the only
    direct failure test drove a 400, and the CLI and daemon tests injected a ready-made
    RegistrationError(401), so a register_kernel() that accepted a 401 survived the suite (pack M2).
    """

    @pytest.mark.parametrize("status", [401, 400, 403, 404, 409, 422, 429, 500, 502, 503])
    def test_an_error_status_raises_with_its_status_and_body(self, status):
        gateway = Gateway(status=status, body=REFUSAL)
        try:
            with pytest.raises(RegistrationError) as refused:
                _register(gateway.url)
        finally:
            gateway.close()
        assert refused.value.status == status
        assert refused.value.data == REFUSAL
        assert [(m, p, a) for m, p, a, _ in gateway.requests] == [("POST", "/api/kernels", "Bearer k-test")]

    @pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
    def test_a_redirect_raises_and_is_never_followed(self, status):
        catcher = Gateway(status=201, body={"id": "k1"})
        gateway = Gateway(status=status, headers=[("Location", catcher.url + "/api/kernels")])
        try:
            with pytest.raises(RegistrationError) as refused:
                _register(gateway.url)
        finally:
            gateway.close()
            catcher.close()
        assert refused.value.status == status
        assert catcher.requests == []  # neither the key nor the registration reached the new target

    def test_a_refused_connection_raises(self):
        with pytest.raises(RegistrationError) as refused:
            _register(_refusing_url())
        assert refused.value.status == 0

    def test_a_connection_closed_without_an_answer_raises(self):
        gateway = Gateway(hang_up=True)
        try:
            with pytest.raises(RegistrationError) as refused:
                _register(gateway.url)
        finally:
            gateway.close()
        assert refused.value.status == 0
        assert len(gateway.requests) == 1

    def test_a_gateway_the_transport_refuses_raises_without_connecting(self, monkeypatch):
        attempts = []

        def no_network(address, *args, **kwargs):
            attempts.append(address)
            raise OSError("network disabled in this test")

        monkeypatch.setattr(socket, "create_connection", no_network)
        with pytest.raises(RegistrationError) as refused:
            _register("http://gw.example.test")  # plain http to another host
        assert refused.value.status == 0
        assert refused.value.data["error"] == "insecure_gateway_url"
        assert attempts == []

    @pytest.mark.parametrize("status", [200, 201])
    def test_a_200_or_201_registers(self, status):
        gateway = Gateway(status=status, body={"id": "k1", "status": "registered"})
        try:
            result = _register(gateway.url)
        finally:
            gateway.close()
        assert result == {"id": "k1", "status": "registered"}
        (method, path, auth, body), = gateway.requests
        assert (method, path, auth) == ("POST", "/api/kernels", "Bearer k-test")
        assert body["id"] == "k1" and body["name"] == "test"


class TestStartKeepsTheRealRegistration:
    """ChatGPT r3 F2: `pcc-node start` with the real register_kernel(); only the gateway's answer is
    scripted. A registration that fails stops start before any later step: no device or signing-key
    registration, no saved config, no daemon, and no success output."""

    @pytest.mark.parametrize("answer", [401, 403, 302, 503, "connection-refused"])
    def test_a_failed_registration_stops_start_before_anything_else(self, answer, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        gateway = None
        if answer == "connection-refused":
            url, status = _refusing_url(), 0
        else:
            moved = [("Location", "http://127.0.0.1:9/elsewhere")] if 300 <= answer < 400 else ()
            gateway = Gateway(status=answer, body=REFUSAL, headers=moved)
            url, status = gateway.url, answer
        config_path = tmp_path / "node-config.json"
        try:
            with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
                 mock.patch("pcc_node.cli.detect_all", return_value=[{"id": "cam-1", "type": "camera"}]), \
                 mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 32, "cd" * 32)), \
                 mock.patch("pcc_node.cli.register_devices") as devices, \
                 mock.patch("pcc_node.cli.register_signing_key") as signing_key, \
                 mock.patch("pcc_node.cli.run_daemon") as daemon:
                result = CliRunner().invoke(main, ["start", "-c", str(config_path), "--api-key", "k-test",
                                                   "--pcc-base", url], env={"PCC_BASE": ""})
        finally:
            if gateway is not None:
                gateway.close()
        assert result.exit_code == 1, result.output
        assert f"Registration failed (HTTP {status})" in result.output, result.output
        for success in ("Node running", "Config saved"):
            assert success not in result.output, result.output
        devices.assert_not_called()
        signing_key.assert_not_called()
        daemon.assert_not_called()
        assert not config_path.exists()
        if gateway is not None:
            assert [(m, p) for m, p, _, _ in gateway.requests] == [("POST", "/api/kernels")]


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
        # Must equal kernelSigningProofMessage(kernelId), kernel-keychain.ts:53.
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
        # Upsert route -- the key-proof is verified on the kernel
        # registration path, keeping ONE proof route (no dedicated
        # /signing-key subroute).
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
