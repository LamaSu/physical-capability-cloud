"""Dynamic UI server -- agents generate HTML, serve locally, read back user input.

Architecture:
  Agent generates HTML -> writes to ui_dir -> pcc-node serves at localhost:3200
  User interacts with UI -> UI posts to localhost:3200/api/submit
  Agent reads submission -> validates -> translates -> submits to PCC

Trust boundary: pages served here are agent-generated, open-ended HTML, a
LOWER-TRUST surface. So this origin holds no authority: it never holds or
forwards the operator's PCC key, and only this server's own loopback origins
(plus non-browser callers such as the agent) may use the API. User input
reaches PCC only through the agent, which validates it and calls PCC itself.

For the agent: a submission and its X-UI-Source are CLAIMS, not evidence. Any
page served here (generated, so lower-trust) can read, pop or forge entries on
this origin. Money or physical actions must be re-confirmed through PCC's
registered typed operations, never taken on a submission's word.

Endpoints:
  GET  /                     Hub page listing all active UIs
  GET  /api/health           Server health + file listing
  GET  /api/submissions      All pending form submissions (needs X-PCC-Node-Client: 1)
  POST /api/submissions/pop  Pop oldest submission (needs X-PCC-Node-Client: 1)
  GET  /api/submissions/pop  Same, kept for existing agents (needs the header too)
  POST /api/submit           UI posts form data here
  POST /api/generate         Agent posts HTML to create a new UI
  POST /api/pcc/*            410 Gone: the credentialed gateway proxy was removed
  GET  /<filename>           Serve static files from ui_dir
"""

import http.server
import json
import logging
import os
import re
import sys
import threading
import time
from html import escape as _escape
from pathlib import Path
from urllib.parse import quote

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

# Request body limits (bytes). Generated pages may inline assets, so more room.
_MAX_SUBMIT_BYTES = 1024 * 1024
_MAX_GENERATE_BYTES = 5 * 1024 * 1024

# Generated page names: plain and visible, no markup or path characters.
_SAFE_FILENAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
# Windows reserved device names (any extension): writing "COM1.html" on a Windows node could
# open a device. Also refused: a trailing dot, which Windows silently strips.
_RESERVED_DEVICE = re.compile(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?", re.IGNORECASE)
# The agent's (non-browser) header for reading or popping the queue. A browser cannot attach a
# custom header cross-origin without a CORS preflight, which is refused, so this guards the
# destructive pop even in browsers that send no Fetch Metadata (reviewer-alpha F-2).
_CLIENT_HEADER = "X-PCC-Node-Client"
_UI_SOURCE = re.compile(r"[A-Za-z0-9._-]{1,64}")

_PROXY_GONE = (
    "The credentialed PCC proxy was removed: pages served here are "
    "agent-generated and never act with the operator's key. Post user input "
    "to /api/submit; the agent validates it and calls PCC itself."
)


class _Refused(Exception):
    """A request refused with an HTTP status and message."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _own_hosts():
    """Host header values this server answers to (the DNS-rebinding guard)."""
    hosts = {f"localhost:{_active_port}", f"127.0.0.1:{_active_port}",
             f"[::1]:{_active_port}"}
    if _active_port == 80:
        hosts |= {"localhost", "127.0.0.1", "[::1]"}
    return hosts


def _own_origins():
    """The only browser origins allowed to use the API: this server's own."""
    return {f"http://{h}" for h in _own_hosts()}


def _is_own_origin(origin):
    return origin is not None and origin.strip().lower() in _own_origins()


def _read_body(handler, limit):
    """Read and parse a JSON body: bounded, and JSON only.

    Cross-site forms and no-preflight fetches can only send text/plain,
    urlencoded or multipart bodies, so anything but JSON is refused.
    """
    if handler.headers.get("Transfer-Encoding") is not None:
        raise _Refused(411, "Send a Content-Length; chunked bodies are not accepted")
    raw_len = (handler.headers.get("Content-Length") or "0").strip()
    if not re.fullmatch(r"[0-9]{1,10}", raw_len):
        raise _Refused(400, "Invalid Content-Length")
    length = int(raw_len)
    if length > limit:
        raise _Refused(413, f"Body too large (limit {limit} bytes)")
    raw = handler.rfile.read(length) if length else b""
    ctype = handler.headers.get("Content-Type")
    if ctype is not None and ctype.split(";", 1)[0].strip().lower() != "application/json":
        raise _Refused(415, "Content-Type must be application/json")
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise _Refused(400, f"Invalid JSON: {type(e).__name__}")


def _drain(handler):
    """Consume a small unread body so refusing it cannot reset the connection."""
    raw_len = (handler.headers.get("Content-Length") or "0").strip()
    if not re.fullmatch(r"[0-9]{1,10}", raw_len):
        return
    length = int(raw_len)
    if 0 < length <= _MAX_GENERATE_BYTES:
        handler.rfile.read(length)


def _send_json(handler, data, status=200):
    """Send a JSON response. CORS is granted only to this server's own origins."""
    body = json.dumps(data).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    origin = handler.headers.get("Origin")
    if _is_own_origin(origin):
        handler.send_header("Access-Control-Allow-Origin", origin.strip())
    handler.send_header("Vary", "Origin")
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

    # A client that stops sending cannot hold a worker forever (reviewer-alpha F-4).
    timeout = 30

    def __init__(self, *args, **kwargs):
        # SimpleHTTPRequestHandler needs 'directory' to serve static files
        super().__init__(*args, directory=str(_active_ui_dir), **kwargs)

    # ---- Origin lock ----

    def _refusal(self, api):
        """Why this request must be refused, as (status, message), or None.

        Every request that names a Host must name one of this server's own loopback
        names, so a DNS-rebinding page can never become same-origin with it (a request
        with no Host at all can only come from a non-browser client). API
        requests also: a browser caller must be one of this server's own
        origins. Non-browser callers (the agent, the CLI) send neither Origin
        nor Sec-Fetch-Site, and are allowed.
        """
        host = (self.headers.get("Host") or "").strip().lower()
        if host and host not in _own_hosts():
            return 421, "Misdirected request: unknown Host"
        if not api:
            return None
        origin = self.headers.get("Origin")
        if origin is not None:
            return None if _is_own_origin(origin) else (403, "Cross-origin request refused")
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site in ("cross-site", "same-site"):
            return 403, "Cross-site request refused"
        return None

    def end_headers(self):
        # Pages here are lower-trust, agent-generated HTML: never frameable
        # (clickjacking) and never content-sniffed.
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # ---- POST endpoints ----

    def do_POST(self):
        refusal = self._refusal(api=True)
        if refusal:
            _drain(self)
            _send_json(self, {"error": refusal[1]}, refusal[0])
            return
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/submit":
                self._handle_submit()
            elif path == "/api/generate":
                self._handle_generate()
            elif path == "/api/submissions/pop":
                _drain(self)
                self._handle_submissions_pop()
            elif path == "/api/pcc" or path.startswith("/api/pcc/"):
                _drain(self)
                _send_json(self, {"error": _PROXY_GONE}, 410)
            else:
                _drain(self)
                _send_json(self, {"error": "Not found"}, 404)
        except _Refused as e:
            _send_json(self, {"error": e.message}, e.status)

    def _handle_submit(self):
        """Store a form submission from a UI."""
        body = _read_body(self, _MAX_SUBMIT_BYTES)

        raw_source = self.headers.get("X-UI-Source", "unknown")
        source = raw_source if _UI_SOURCE.fullmatch(raw_source) else "invalid" # a claim, sanitized
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
        body = _read_body(self, _MAX_GENERATE_BYTES)
        if not isinstance(body, dict):
            raise _Refused(400, "Body must be a JSON object")

        if "filename" not in body or "content" not in body:
            raise _Refused(400, "filename and content are required")
        filename = body["filename"]
        content = body["content"]

        if (not isinstance(filename, str) or not _SAFE_FILENAME.fullmatch(filename)
                or filename.endswith(".") or _RESERVED_DEVICE.fullmatch(filename)):
            raise _Refused(400, "Invalid filename")
        if not isinstance(content, str):
            raise _Refused(400, "content must be a string")

        filepath = _active_ui_dir / filename
        filepath.write_text(content, encoding="utf-8")
        url = f"http://localhost:{_active_port}/{filename}"
        log.info(f"Generated UI: {url}")
        _send_json(self, {"url": url, "filename": filename}, 201)

    # ---- GET endpoints ----

    def do_GET(self):
        refusal = self._refusal(api=self.path.startswith("/api/"))
        if refusal:
            _send_json(self, {"error": refusal[1]}, refusal[0])
            return

        if self.path == "/api/health":
            self._handle_health()
            return

        path = self.path.split("?", 1)[0]
        if path == "/api/submissions":
            self._handle_submissions()
            return

        if path == "/api/submissions/pop":
            self._handle_submissions_pop()
            return

        if path == "/" or path == "/index.html":
            self._handle_hub()
            return

        # Reject unknown /api/ paths before falling through to static files
        if self.path.startswith("/api/"):
            _send_json(self, {"error": "Not found"}, 404)
            return

        # Serve static files from ui_dir
        super().do_GET()

    def list_directory(self, path):
        # No raw directory listings: the hub at "/" is the only index.
        self.send_error(404, "Not found")
        return None

    def do_HEAD(self):
        refusal = self._refusal(api=self.path.startswith("/api/"))
        if refusal:
            self.send_error(refusal[0], refusal[1])
            return
        super().do_HEAD()

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

    def _client_ok(self):
        """The queue is for the agent: require its header (browsers cannot send it cross-origin)."""
        if self.headers.get(_CLIENT_HEADER) == "1":
            return True
        _send_json(self, {"error": f"Send {_CLIENT_HEADER}: 1 to read the submission queue"}, 403)
        return False

    def _handle_submissions(self):
        """Return all pending submissions."""
        if not self._client_ok():
            return
        with _submissions_lock:
            subs = list(_submissions)
        _send_json(self, {"submissions": subs})

    def _handle_submissions_pop(self):
        """Pop the oldest submission."""
        if not self._client_ok():
            return
        with _submissions_lock:
            sub = _submissions.pop(0) if _submissions else None
        _send_json(self, {"submission": sub})

    def _handle_hub(self):
        """Generate the hub page listing all available UIs."""
        files = []
        if _active_ui_dir.exists():
            files = sorted(_active_ui_dir.glob("*.html"))

        links = ""
        # Filenames are agent-chosen: escape them (and quote the href).
        for f in files:
            links += (
                f'<li><a href="/{quote(f.name)}">{_escape(f.stem)}</a>'
                f'<span class="meta">{_escape(f.name)} &middot; '
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
<p class="subtitle">Port {_active_port} &middot; {_escape(str(_active_ui_dir))}</p>
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
User input reaches PCC only through the agent, never from this page.
</code>
</div>
</body>
</html>"""
        _send_html(self, html)

    # ---- OPTIONS (CORS preflight) ----

    def do_OPTIONS(self):
        # Preflight is granted only to this server's own origins; no
        # credentials header is accepted, since nothing here uses one.
        refusal = self._refusal(api=True)
        if refusal:
            _send_json(self, {"error": refusal[1]}, refusal[0])
            return
        self.send_response(204)
        origin = self.headers.get("Origin")
        if _is_own_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin.strip())
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-UI-Source")  # never X-PCC-Node-Client
        self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- Logging ----

    def log_message(self, format, *args):
        """Suppress default stderr logging -- use our logger instead."""
        log.debug(format, *args)


# ---- Public API ----


class _UIServer(http.server.ThreadingHTTPServer):
    """Threaded, so one stalled client cannot block the others (reviewer-alpha F-4)."""

    daemon_threads = True

    def handle_error(self, request, client_address):
        # A client that went away mid-response is not a server error.
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


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
    pcc_base, pcc_api_key : str
        Accepted for backward compatibility and ignored. Pages served here are
        agent-generated, so this server never holds or forwards the operator's
        PCC key (the credentialed /api/pcc/* proxy was removed).

    Returns
    -------
    http.server.HTTPServer
        The running server instance.
    """
    global _active_port, _active_ui_dir

    _active_port = port
    _active_ui_dir = Path(ui_dir) if ui_dir else _DEFAULT_UI_DIR
    if pcc_api_key:
        log.info("UI server ignores pcc_api_key: generated pages never act "
                 "with the operator's key")

    _active_ui_dir.mkdir(parents=True, exist_ok=True)

    server = _UIServer(("127.0.0.1", port), UIHandler)

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
