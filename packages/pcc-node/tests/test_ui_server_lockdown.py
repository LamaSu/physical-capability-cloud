"""Adversarial tests: the local generated-UI server is a LOWER-TRUST surface.

Agent-generated HTML is served from this origin, so the origin must carry no
authority (product pack section 2, open-ended generated UI): no raw privileged
credentials, and no money or physical authority outside registered typed
operations. User input reaches PCC only through the agent, which reads
/api/submit, validates it, and calls PCC with its own key. These tests pin that:
there is no credentialed gateway proxy, other web origins cannot drive or read
the API (CORS, Sec-Fetch-Site, DNS-rebinding Host check), bodies are bounded,
the hub escapes agent-chosen filenames, and pages cannot be framed.
"""

import http.client
import http.server
import json
import socket
import threading
import time

import pytest

import pcc_node.ui_server as ui_server
from pcc_node.ui_server import start_ui_server, get_submissions, clear_submissions

SECRET = "pcc_live_test_operator_key_do_not_forward"
EVIL = "https://evil.example"


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def upstream():
    """A fake PCC gateway that records every request that reaches it."""
    seen = []

    class Recorder(http.server.BaseHTTPRequestHandler):
        def _record(self):
            n = int(self.headers.get("Content-Length") or 0)
            seen.append({
                "method": self.command,
                "path": self.path,
                "auth": self.headers.get("Authorization"),
                "body": self.rfile.read(n) if n else b"",
            })
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')

        do_GET = _record
        do_POST = _record

        def log_message(self, *args):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Recorder)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "seen": seen}
    srv.shutdown()
    srv.server_close()


@pytest.fixture()
def node(tmp_path, upstream):
    """The node UI server, configured the way `pcc-node start` configures it."""
    clear_submissions()
    ui_dir = tmp_path / "ui"
    ui_dir.mkdir()
    port = _free_port()
    srv = start_ui_server(
        port=port,
        ui_dir=str(ui_dir),
        background=True,
        pcc_base=upstream["base"],
        pcc_api_key=SECRET,
    )
    time.sleep(0.1)
    yield {"port": port, "ui_dir": ui_dir, "upstream": upstream}
    srv.shutdown()
    srv.server_close()
    clear_submissions()


def _req(port, method, path, body=None, headers=None, host=None):
    """Send one request with full control of Host and browser headers.

    Returns (status, lower-cased headers, text body).
    """
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    conn.putheader("Host", host or f"127.0.0.1:{port}")
    hdrs = dict(headers or {})
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
        hdrs.setdefault("Content-Length", str(len(data)))
    for k, v in hdrs.items():
        conn.putheader(k, v)
    conn.endheaders(data)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", "replace")
    out = (resp.status, {k.lower(): v for k, v in resp.getheaders()}, raw)
    conn.close()
    return out


def _own(port, host="localhost"):
    return f"http://{host}:{port}"


# ---------- No credentialed proxy: the origin holds no authority ----------


class TestNoCredentialedProxy:
    @pytest.mark.parametrize("path", [
        "/api/pcc/escrow/0xabc/fund",
        "/api/pcc/kernels",
        "/api/pcc/",
    ])
    def test_proxy_is_gone_and_nothing_reaches_the_gateway(self, node, path):
        # Worst case: a generated page on the node's OWN origin tries it.
        status, _, body = _req(node["port"], "POST", path, {"amount": "1"},
                               {"Origin": _own(node["port"])})
        assert status == 410
        assert SECRET not in body
        assert node["upstream"]["seen"] == []

    def test_operator_key_is_not_retained_or_echoed(self, node):
        for name, value in vars(ui_server).items():
            assert value != SECRET, f"ui_server.{name} holds the operator key"
        for path in ("/api/health", "/"):
            _, _, body = _req(node["port"], "GET", path)
            assert SECRET not in body


# ---------- Other web origins cannot drive or read the API ----------


class TestCrossOriginLockdown:
    def test_foreign_origin_cannot_submit(self, node):
        status, hdrs, _ = _req(node["port"], "POST", "/api/submit",
                               {"approve": True}, {"Origin": EVIL})
        assert status == 403
        assert "access-control-allow-origin" not in hdrs
        assert get_submissions() == []

    def test_foreign_origin_cannot_generate_a_page(self, node):
        status, _, _ = _req(node["port"], "POST", "/api/generate",
                            {"filename": "x.html", "content": "<script>1</script>"},
                            {"Origin": EVIL})
        assert status == 403
        assert not (node["ui_dir"] / "x.html").exists()

    def test_foreign_preflight_gets_no_grant(self, node):
        status, hdrs, _ = _req(node["port"], "OPTIONS", "/api/submit", headers={
            "Origin": EVIL,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        assert status == 403
        assert "access-control-allow-origin" not in hdrs

    def test_foreign_origin_cannot_read_submissions(self, node):
        _req(node["port"], "POST", "/api/submit", {"note": "private-operator-input"})
        status, hdrs, body = _req(node["port"], "GET", "/api/submissions",
                                  headers={"Origin": EVIL})
        assert status == 403
        assert "private-operator-input" not in body
        assert "access-control-allow-origin" not in hdrs

    def test_null_origin_is_refused(self, node):
        # Sandboxed iframes and data: URLs send `Origin: null`.
        status, _, _ = _req(node["port"], "POST", "/api/submit", {"a": 1},
                            {"Origin": "null"})
        assert status == 403
        assert get_submissions() == []

    def test_cross_site_no_cors_get_cannot_pop(self, node):
        # e.g. <img src="http://localhost:3200/api/submissions/pop"> on any site:
        # no Origin header, but the browser marks it cross-site.
        _req(node["port"], "POST", "/api/submit", {"keep": "me"})
        status, _, _ = _req(node["port"], "GET", "/api/submissions/pop",
                            headers={"Sec-Fetch-Site": "cross-site",
                                     "Sec-Fetch-Mode": "no-cors"})
        assert status == 403
        assert len(get_submissions()) == 1

    @pytest.mark.parametrize("path", ["/api/health", "/", "/hello.html"])
    def test_dns_rebinding_host_is_refused(self, node, path):
        (node["ui_dir"] / "hello.html").write_text("<p>hi</p>")
        status, _, body = _req(node["port"], "GET", path,
                               host=f"rebind.evil.example:{node['port']}")
        assert status == 421
        assert "hi</p>" not in body

    @pytest.mark.parametrize("ctype", [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
    ])
    def test_simple_request_content_types_are_refused(self, node, ctype):
        # The content types a cross-site <form> or no-preflight fetch can send.
        status, _, _ = _req(node["port"], "POST", "/api/submit", b'{"a":1}',
                            {"Content-Type": ctype, "Origin": _own(node["port"])})
        assert status == 415
        assert get_submissions() == []


# ---------- The node's own UIs and the agent keep working ----------


class TestOwnUiStillWorks:
    @pytest.mark.parametrize("host", ["localhost", "127.0.0.1"])
    def test_own_origin_submit_gets_exact_acao(self, node, host):
        origin = _own(node["port"], host)
        status, hdrs, _ = _req(node["port"], "POST", "/api/submit", {"ok": 1},
                               {"Origin": origin, "X-UI-Source": "device-config"})
        assert status == 200
        assert hdrs.get("access-control-allow-origin") == origin
        assert "origin" in hdrs.get("vary", "").lower()
        assert get_submissions()[-1]["path"] == "device-config"

    def test_own_origin_preflight_is_granted(self, node):
        origin = _own(node["port"], "127.0.0.1")
        status, hdrs, _ = _req(node["port"], "OPTIONS", "/api/submit", headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-ui-source",
        })
        assert 200 <= status < 300
        assert hdrs.get("access-control-allow-origin") == origin
        assert "POST" in hdrs.get("access-control-allow-methods", "")
        allowed = hdrs.get("access-control-allow-headers", "").lower()
        assert "content-type" in allowed and "x-ui-source" in allowed

    def test_agent_client_without_browser_headers_works(self, node):
        status, _, _ = _req(node["port"], "POST", "/api/generate",
                            {"filename": "agent.html", "content": "<p>a</p>"})
        assert status == 201
        status, _, _ = _req(node["port"], "POST", "/api/submit", {"x": 1})
        assert status == 200
        status, _, body = _req(node["port"], "GET", "/api/submissions/pop")
        assert status == 200 and json.loads(body)["submission"]["data"] == {"x": 1}

    def test_same_origin_fetch_reads_health(self, node):
        status, _, _ = _req(node["port"], "GET", "/api/health",
                            headers={"Sec-Fetch-Site": "same-origin"})
        assert status == 200

    def test_cross_site_navigation_to_a_page_is_still_allowed(self, node):
        # Following a link to the hub is harmless; only the API is gated.
        status, _, _ = _req(node["port"], "GET", "/", headers={
            "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"})
        assert status == 200


# ---------- Bounds, escaping, framing ----------


class TestBoundsAndEscaping:
    def test_oversized_body_is_refused_without_reading_it(self, node):
        conn = http.client.HTTPConnection("127.0.0.1", node["port"], timeout=5)
        conn.putrequest("POST", "/api/generate")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(50 * 1024 * 1024))
        conn.endheaders()
        resp = conn.getresponse()
        assert resp.status == 413
        conn.close()

    @pytest.mark.parametrize("length", ["-1", "abc"])
    def test_invalid_content_length_is_refused(self, node, length):
        conn = http.client.HTTPConnection("127.0.0.1", node["port"], timeout=5)
        conn.putrequest("POST", "/api/submit")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", length)
        conn.endheaders()
        resp = conn.getresponse()
        assert resp.status == 400
        conn.close()
        assert get_submissions() == []

    def test_hub_escapes_filenames(self, node):
        (node["ui_dir"] / "a<img src=x onerror=alert(1)>.html").write_text("x")
        status, _, body = _req(node["port"], "GET", "/")
        assert status == 200
        assert "<img src=x onerror" not in body
        assert "&lt;img src=x onerror=alert(1)&gt;" in body

    @pytest.mark.parametrize("name", ["<b>.html", ".hidden.html", "a b.html", ""])
    def test_generate_rejects_unsafe_filenames(self, node, name):
        status, _, _ = _req(node["port"], "POST", "/api/generate",
                            {"filename": name, "content": "x"})
        assert status == 400

    def test_pages_cannot_be_framed_or_sniffed(self, node):
        (node["ui_dir"] / "hello.html").write_text("<p>hi</p>")
        for path in ("/hello.html", "/", "/api/health"):
            _, hdrs, _ = _req(node["port"], "GET", path)
            assert hdrs.get("x-frame-options") == "DENY", path
            assert "frame-ancestors 'none'" in hdrs.get("content-security-policy", ""), path
            assert hdrs.get("x-content-type-options") == "nosniff", path
