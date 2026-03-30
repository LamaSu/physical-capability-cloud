"""Dynamic UI server -- agents generate HTML, serve locally, read back user input.

Architecture:
  Agent generates HTML -> writes to ui_dir -> pcc-node serves at localhost:3200
  User interacts with UI -> UI posts to localhost:3200/api/submit
  Agent reads submission -> validates -> translates -> submits to PCC

Endpoints:
  GET  /                     Hub page listing all active UIs
  GET  /api/health           Server health + file listing
  GET  /api/submissions      All pending form submissions
  GET  /api/submissions/pop  Pop oldest submission
  POST /api/submit           UI posts form data here
  POST /api/generate         Agent posts HTML to create a new UI
  POST /api/pcc/*            Proxy to PCC gateway (adds auth)
  GET  /<filename>           Serve static files from ui_dir
"""

import http.server
import json
import logging
import os
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

log = logging.getLogger("pcc-node.ui")

# Module-level defaults (overridden by start_ui_server)
_DEFAULT_UI_DIR = Path.home() / ".pcc-node" / "ui"
_DEFAULT_PORT = 3200

# Submission queue -- shared across handler instances
_submissions = []
_submissions_lock = threading.Lock()

# Active config -- set by start_ui_server
_active_port = _DEFAULT_PORT
_active_ui_dir = _DEFAULT_UI_DIR
_active_pcc_base = ""
_active_pcc_api_key = ""


def _read_body(handler):
    """Read and parse JSON body from a request handler."""
    length = int(handler.headers.get("Content-Length", 0))
    if length == 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def _send_json(handler, data, status=200):
    """Send a JSON response with CORS headers."""
    body = json.dumps(data).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _send_html(handler, html, status=200):
    """Send an HTML response."""
    body = html.encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class UIHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler for the dynamic UI server."""

    def __init__(self, *args, **kwargs):
        # SimpleHTTPRequestHandler needs 'directory' to serve static files
        super().__init__(*args, directory=str(_active_ui_dir), **kwargs)

    # ---- POST endpoints ----

    def do_POST(self):
        if self.path == "/api/submit":
            self._handle_submit()
        elif self.path == "/api/generate":
            self._handle_generate()
        elif self.path.startswith("/api/pcc/"):
            self._handle_pcc_proxy()
        else:
            _send_json(self, {"error": "Not found"}, 404)

    def _handle_submit(self):
        """Store a form submission from a UI."""
        try:
            body = _read_body(self)
        except (json.JSONDecodeError, ValueError) as e:
            _send_json(self, {"error": f"Invalid JSON: {e}"}, 400)
            return

        source = self.headers.get("X-UI-Source", "unknown")
        entry = {
            "path": source,
            "data": body,
            "timestamp": time.time(),
        }
        with _submissions_lock:
            _submissions.append(entry)
        log.info(f"Submission from {source}: {len(json.dumps(body))} bytes")
        _send_json(self, {"received": True})

    def _handle_generate(self):
        """Agent posts a UI spec -- server saves it to ui_dir."""
        try:
            body = _read_body(self)
        except (json.JSONDecodeError, ValueError) as e:
            _send_json(self, {"error": f"Invalid JSON: {e}"}, 400)
            return

        filename = body.get("filename", "generated.html")
        content = body.get("content", "")

        if not filename or ".." in filename or "/" in filename or "\\" in filename:
            _send_json(self, {"error": "Invalid filename"}, 400)
            return

        filepath = _active_ui_dir / filename
        filepath.write_text(content, encoding="utf-8")
        url = f"http://localhost:{_active_port}/{filename}"
        log.info(f"Generated UI: {url}")
        _send_json(self, {"url": url, "filename": filename}, 201)

    def _handle_pcc_proxy(self):
        """Proxy requests to the PCC gateway, adding auth headers."""
        if not _active_pcc_base:
            _send_json(self, {"error": "PCC gateway not configured"}, 503)
            return

        pcc_path = self.path[len("/api/pcc"):]  # e.g. /kernels
        url = f"{_active_pcc_base.rstrip('/')}{pcc_path}"

        try:
            body = _read_body(self)
        except (json.JSONDecodeError, ValueError):
            body = None

        headers = {
            "Content-Type": "application/json",
            "User-Agent": "PCC-Node-UI/1.0",
        }
        if _active_pcc_api_key:
            headers["Authorization"] = f"Bearer {_active_pcc_api_key}"

        data = json.dumps(body).encode("utf-8") if body else None
        req = Request(url, data=data, headers=headers, method="POST")

        try:
            with urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                try:
                    result = json.loads(raw)
                except (json.JSONDecodeError, ValueError):
                    result = {"raw": raw}
                _send_json(self, result, resp.status)
        except HTTPError as e:
            raw = e.read().decode("utf-8")
            try:
                result = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                result = {"error": raw}
            _send_json(self, result, e.code)
        except (URLError, OSError) as e:
            _send_json(self, {"error": f"PCC proxy error: {e}"}, 502)

    # ---- GET endpoints ----

    def do_GET(self):
        if self.path == "/api/health":
            self._handle_health()
            return

        if self.path == "/api/submissions":
            self._handle_submissions()
            return

        if self.path == "/api/submissions/pop":
            self._handle_submissions_pop()
            return

        if self.path == "/" or self.path == "/index.html":
            self._handle_hub()
            return

        # Reject unknown /api/ paths before falling through to static files
        if self.path.startswith("/api/"):
            _send_json(self, {"error": "Not found"}, 404)
            return

        # Serve static files from ui_dir
        super().do_GET()

    def _handle_health(self):
        """Return server health info."""
        files = []
        if _active_ui_dir.exists():
            files = sorted(f.name for f in _active_ui_dir.iterdir() if f.is_file())
        _send_json(self, {
            "status": "ok",
            "port": _active_port,
            "ui_dir": str(_active_ui_dir),
            "files": files,
        })

    def _handle_submissions(self):
        """Return all pending submissions."""
        with _submissions_lock:
            subs = list(_submissions)
        _send_json(self, {"submissions": subs})

    def _handle_submissions_pop(self):
        """Pop the oldest submission."""
        with _submissions_lock:
            sub = _submissions.pop(0) if _submissions else None
        _send_json(self, {"submission": sub})

    def _handle_hub(self):
        """Generate the hub page listing all available UIs."""
        files = []
        if _active_ui_dir.exists():
            files = sorted(_active_ui_dir.glob("*.html"))

        links = ""
        for f in files:
            links += (
                f'<li><a href="/{f.name}">{f.stem}</a>'
                f'<span class="meta">{f.name} &middot; '
                f'{f.stat().st_size} bytes</span></li>\n'
            )

        if not links:
            links = (
                '<li class="empty">No interfaces generated yet. '
                'An agent will create them on demand.</li>\n'
            )

        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PCC Node &mdash; Dynamic UI</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: #0a0a0a; color: #e0e0e0; font-family: 'JetBrains Mono', 'Fira Code', monospace; padding: 2rem; }}
h1 {{ color: #fff; font-size: 1.5rem; margin-bottom: 0.5rem; }}
.subtitle {{ color: #666; font-size: 0.85rem; margin-bottom: 2rem; }}
ul {{ list-style: none; }}
li {{ padding: 0.75rem 0; border-bottom: 1px solid #1a1a1a; display: flex; justify-content: space-between; align-items: center; }}
li.empty {{ color: #666; font-style: italic; }}
a {{ color: #4ade80; text-decoration: none; font-weight: 600; }}
a:hover {{ text-decoration: underline; }}
.meta {{ color: #555; font-size: 0.75rem; }}
.api {{ margin-top: 2rem; padding: 1rem; background: #111; border: 1px solid #222; border-radius: 4px; }}
.api h2 {{ font-size: 1rem; color: #4ade80; margin-bottom: 0.5rem; }}
.api code {{ color: #aaa; font-size: 0.8rem; }}
</style>
</head>
<body>
<h1>PCC Node &mdash; Active Interfaces</h1>
<p class="subtitle">Port {_active_port} &middot; {str(_active_ui_dir)}</p>
<ul>
{links}
</ul>
<div class="api">
<h2>API</h2>
<code>
GET /api/health &mdash; server info<br>
GET /api/submissions &mdash; pending form data<br>
GET /api/submissions/pop &mdash; pop oldest submission<br>
POST /api/submit &mdash; UI posts form data<br>
POST /api/generate &mdash; create a new UI (filename + content)<br>
POST /api/pcc/* &mdash; proxy to PCC gateway
</code>
</div>
</body>
</html>"""
        _send_html(self, html)

    # ---- OPTIONS (CORS preflight) ----

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-UI-Source, Authorization",
        )
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- Logging ----

    def log_message(self, format, *args):
        """Suppress default stderr logging -- use our logger instead."""
        log.debug(format, *args)


# ---- Public API ----


def start_ui_server(port=3200, ui_dir=None, background=True,
                    pcc_base="", pcc_api_key=""):
    """Start the UI server.

    Parameters
    ----------
    port : int
        Port to bind on (default 3200).
    ui_dir : str | Path | None
        Directory for generated UIs (default ~/.pcc-node/ui/).
    background : bool
        If True, run in a daemon thread and return the server.
        If False, block forever (for CLI use).
    pcc_base : str
        PCC gateway base URL for proxy endpoint.
    pcc_api_key : str
        PCC API key for proxy auth.

    Returns
    -------
    http.server.HTTPServer
        The running server instance.
    """
    global _active_port, _active_ui_dir, _active_pcc_base, _active_pcc_api_key

    _active_port = port
    _active_ui_dir = Path(ui_dir) if ui_dir else _DEFAULT_UI_DIR
    _active_pcc_base = pcc_base
    _active_pcc_api_key = pcc_api_key

    _active_ui_dir.mkdir(parents=True, exist_ok=True)

    server = http.server.HTTPServer(("127.0.0.1", port), UIHandler)

    if background:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        log.info(f"UI server started on http://localhost:{port}")
    else:
        log.info(f"UI server starting on http://localhost:{port}")
        server.serve_forever()

    return server


def get_submissions():
    """Get all pending UI submissions (non-destructive)."""
    with _submissions_lock:
        return list(_submissions)


def pop_submission():
    """Pop the oldest UI submission. Returns None if empty."""
    with _submissions_lock:
        return _submissions.pop(0) if _submissions else None


def clear_submissions():
    """Clear all pending submissions. Useful for testing."""
    with _submissions_lock:
        _submissions.clear()
