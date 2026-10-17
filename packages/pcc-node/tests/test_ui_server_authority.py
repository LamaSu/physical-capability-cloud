"""Verdict 91 on #447: the generated-UI origin holds no authority, for real.

Each test failed at b12cf4c0, the reviewed SHA:
- H1: the agent API trusted a public header, so any page served from this
  origin (agent-generated, lower trust) or any local process could read and
  pop the submission queue, forge submissions, and overwrite other pages;
- M2: `pcc-node ui serve` still took --api-key/PCC_API_KEY and passed it in;
- M3: generation wrote through a symlink, and static serving followed one;
- M4: the queue, the generated files and the worker threads were unbounded.

The agent API (queue read and pop, page generation) now needs a random
per-process token that the server writes to a private file outside the
served directory. A generated page keeps only POST /api/submit.
"""

import http.client
import json
import os
import socket
import stat
import time

import pytest

import pcc_node.ui_server as ui_server
from pcc_node.ui_server import clear_submissions, start_ui_server


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def node(tmp_path, monkeypatch):
    clear_submissions()
    token_file = tmp_path / "state" / "ui-token"
    monkeypatch.setenv("PCC_NODE_UI_TOKEN_FILE", str(token_file))
    ui_dir = tmp_path / "ui"
    ui_dir.mkdir()
    port = _free_port()
    srv = start_ui_server(port=port, ui_dir=str(ui_dir), background=True)
    time.sleep(0.05)
    yield {"port": port, "ui_dir": ui_dir, "token_file": token_file, "tmp": tmp_path}
    srv.shutdown()
    srv.server_close()
    clear_submissions()


def _request(node, method, path, body=None, headers=None, own_origin=False, token=False):
    conn = http.client.HTTPConnection("127.0.0.1", node["port"], timeout=5)
    hdrs = {"Host": f"127.0.0.1:{node['port']}"}
    if own_origin:
        hdrs["Origin"] = f"http://127.0.0.1:{node['port']}"
    if token:
        hdrs["Authorization"] = "Bearer " + node["token_file"].read_text().strip()
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    conn.request(method, path, body=data, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw) if raw else None
    except ValueError:
        return resp.status, raw


def _submit(node, data):
    return _request(node, "POST", "/api/submit", body=data, own_origin=True)


class TestTheAgentApiNeedsTheToken:
    def test_a_same_origin_page_cannot_read_the_queue(self, node):
        _submit(node, {"secret": "operator answer"})
        status, _ = _request(node, "GET", "/api/submissions", own_origin=True, headers={"X-PCC-Node-Client": "1"})
        assert status == 401

    def test_a_same_origin_page_cannot_pop_the_queue(self, node):
        _submit(node, {"x": 1})
        status, _ = _request(node, "POST", "/api/submissions/pop", own_origin=True, headers={"X-PCC-Node-Client": "1"})
        assert status == 401
        assert len(ui_server.get_submissions()) == 1

    def test_a_same_origin_page_cannot_generate_or_overwrite_a_page(self, node):
        (node["ui_dir"] / "other-page.html").write_text("original")
        status, _ = _request(node, "POST", "/api/generate", own_origin=True,
                             body={"filename": "other-page.html", "content": "<script>replaced</script>"})
        assert status == 401
        assert (node["ui_dir"] / "other-page.html").read_text() == "original"

    def test_a_local_process_without_the_token_is_refused(self, node):
        status, _ = _request(node, "GET", "/api/submissions", headers={"X-PCC-Node-Client": "1"})
        assert status == 401

    def test_a_wrong_token_is_refused(self, node):
        status, _ = _request(node, "GET", "/api/submissions", headers={"Authorization": "Bearer " + "0" * 43})
        assert status == 401

    def test_the_state_changing_get_pop_is_gone(self, node):
        _submit(node, {"x": 1})
        status, _ = _request(node, "GET", "/api/submissions/pop", token=True)
        assert status == 405
        assert len(ui_server.get_submissions()) == 1

    def test_the_agent_with_the_token_reads_pops_and_generates(self, node):
        _submit(node, {"answer": 42})
        assert _request(node, "GET", "/api/submissions", token=True)[1]["submissions"][0]["data"] == {"answer": 42}
        status, body = _request(node, "POST", "/api/submissions/pop", token=True)
        assert status == 200 and body["submission"]["data"] == {"answer": 42}
        status, _ = _request(node, "POST", "/api/generate", token=True, body={"filename": "form.html", "content": "<p>ok</p>"})
        assert status == 201 and (node["ui_dir"] / "form.html").read_text() == "<p>ok</p>"

    def test_a_page_can_still_submit(self, node):
        status, body = _submit(node, {"x": 1})
        assert status == 200 and body == {"received": True}

    def test_the_token_file_is_private_and_never_served(self, node):
        mode = stat.S_IMODE(os.stat(node["token_file"]).st_mode)
        assert mode == 0o600
        assert node["ui_dir"] not in node["token_file"].parents
        token = node["token_file"].read_text().strip()
        assert len(token) >= 40
        for path in ("/", "/api/health", "/ui-token", "/../state/ui-token"):
            _, body = _request(node, "GET", path, token=False)
            text = body.decode("utf-8", "replace") if isinstance(body, bytes) else json.dumps(body)
            assert token not in text, path


class TestNoCredentialsAccepted:
    def test_ui_serve_takes_no_credential_options(self):
        from pcc_node.cli import ui_serve
        names = {p.name for p in ui_serve.params}
        assert "api_key" not in names and "pcc_base" not in names

    def test_start_ui_server_refuses_credentials(self, tmp_path):
        with pytest.raises(TypeError):
            start_ui_server(port=_free_port(), ui_dir=str(tmp_path), background=True, pcc_api_key="k")


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlinks")
class TestNoSymlinks:
    def test_generate_never_writes_through_a_symlink(self, node):
        target = node["tmp"] / "outside.txt"
        target.write_text("untouched")
        (node["ui_dir"] / "victim.html").symlink_to(target)
        status, _ = _request(node, "POST", "/api/generate", token=True, body={"filename": "victim.html", "content": "pwned"})
        assert status == 201
        assert target.read_text() == "untouched"
        assert not (node["ui_dir"] / "victim.html").is_symlink()

    def test_a_symlinked_file_is_not_served(self, node):
        secret = node["tmp"] / "secret.txt"
        secret.write_text("operator secret")
        (node["ui_dir"] / "leak.html").symlink_to(secret)
        status, body = _request(node, "GET", "/leak.html")
        assert status == 404 and b"operator secret" not in (body if isinstance(body, bytes) else json.dumps(body).encode())


class TestResourceBounds:
    def test_the_queue_is_bounded_in_entries(self, node, monkeypatch):
        monkeypatch.setattr(ui_server, "_MAX_QUEUE_ENTRIES", 2)
        assert [_submit(node, {"n": i})[0] for i in range(3)] == [200, 200, 429]

    def test_the_queue_is_bounded_in_bytes(self, node, monkeypatch):
        monkeypatch.setattr(ui_server, "_MAX_QUEUE_BYTES", 100)
        assert _submit(node, {"blob": "x" * 60})[0] == 200
        assert _submit(node, {"blob": "x" * 60})[0] == 429

    def test_generated_pages_are_bounded_in_count(self, node, monkeypatch):
        monkeypatch.setattr(ui_server, "_MAX_UI_FILES", 2)
        codes = [_request(node, "POST", "/api/generate", token=True, body={"filename": f"p{i}.html", "content": "x"})[0]
                 for i in range(3)]
        assert codes == [201, 201, 507]
        # Replacing an existing page is still allowed at the cap.
        assert _request(node, "POST", "/api/generate", token=True, body={"filename": "p0.html", "content": "y"})[0] == 201

    def test_generated_pages_are_bounded_in_bytes(self, node, monkeypatch):
        monkeypatch.setattr(ui_server, "_MAX_UI_BYTES", 100)
        assert _request(node, "POST", "/api/generate", token=True, body={"filename": "a.html", "content": "x" * 80})[0] == 201
        assert _request(node, "POST", "/api/generate", token=True, body={"filename": "b.html", "content": "x" * 80})[0] == 507

    def test_concurrent_connections_are_bounded(self, tmp_path, monkeypatch):
        monkeypatch.setenv("PCC_NODE_UI_TOKEN_FILE", str(tmp_path / "state" / "ui-token"))
        monkeypatch.setattr(ui_server, "_MAX_WORKERS", 1)
        port = _free_port()
        srv = start_ui_server(port=port, ui_dir=str(tmp_path / "ui"), background=True)
        try:
            stalled = socket.create_connection(("127.0.0.1", port), timeout=5)
            stalled.sendall(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n" % port)  # never finished
            time.sleep(0.2)
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/api/health", headers={"Host": f"127.0.0.1:{port}"})
            assert conn.getresponse().status == 503
            stalled.close()
        finally:
            srv.shutdown()
            srv.server_close()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlinks")
def test_the_hub_and_health_list_only_what_is_served(node):
    (node["ui_dir"] / "real.html").write_text("<p>ok</p>")
    (node["ui_dir"] / "link.html").symlink_to(node["tmp"] / "missing-target")  # dangling
    status, body = _request(node, "GET", "/")
    assert status == 200 and b"real" in body and b"link.html" not in body
    assert _request(node, "GET", "/api/health")[1]["files"] == ["real.html"]
