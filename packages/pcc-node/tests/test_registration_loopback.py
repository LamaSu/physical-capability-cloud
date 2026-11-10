"""The gateway's registration challenge over loopback HTTP."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

import pytest

from pcc_node.cli import main
from tests.test_register_challenge import FakeGateway, PAIR, CHALLENGES, KERNELS, separate_runner


@pytest.mark.parametrize("issues_challenges", [False, True], ids=["older", "challenge"])
def test_start_proves_its_key_over_loopback_http(tmp_path, monkeypatch, issues_challenges):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    directory = tmp_path / "keys"
    directory.mkdir(mode=0o700)
    monkeypatch.setenv("PCC_NODE_KEY_PATH", str(directory / "keys.json"))
    gateway = FakeGateway(issues_challenges)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            code, answer = gateway("POST", self.path, body, base_url=base,
                                   api_key=self.headers.get("Authorization", "").removeprefix("Bearer "))
            raw = json.dumps(answer).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    base = f"http://127.0.0.1:{server.server_port}"
    gateway.domain = f"127.0.0.1:{server.server_port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
             mock.patch("pcc_node.cli.detect_all", return_value=[]), \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=PAIR), \
             mock.patch("pcc_node.cli.register_devices"), \
             mock.patch("pcc_node.cli._interactive", return_value=False), \
             mock.patch("pcc_node.cli.run_daemon") as daemon:
            result = separate_runner().invoke(main, ["start", "--yes", "-c", str(tmp_path / "node-config.json"),
                                                    "--api-key", "k", "--pcc-base", base])
        assert result.exit_code == 0, result.output + result.stderr
        daemon.assert_called_once()
        assert gateway.paths() == [CHALLENGES, KERNELS]
        body = gateway.posts()[0]
        assert gateway.bound[body["id"]] == "0x" + PAIR[0]
        assert ("registrationProof" in body) is issues_challenges
        assert ("signingProof" in body) is not issues_challenges
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
