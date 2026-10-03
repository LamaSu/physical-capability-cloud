"""A device's identity endpoint for the operating tests: GET /identity -> {"serial": ...} on 127.0.0.1.

The test can change what it answers: another serial, a raw body, a status, or a redirect.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class IdentityServer:
    def __init__(self, serial="PR-0001", *, path="/identity"):
        self.serial = serial
        self.path = path
        self.raw = None  # bytes to answer instead of {"serial": ...}
        self.status = 200
        self.redirect_to = None
        self.requests = 0
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):  # noqa: N802
                owner.requests += 1
                if self.path != owner.path:
                    body, status = b'{"error": "not_found"}', 404
                elif owner.redirect_to is not None:
                    self.send_response(302)
                    self.send_header("Location", owner.redirect_to)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                else:
                    body = owner.raw if owner.raw is not None else json.dumps({"serial": owner.serial}).encode("utf-8")
                    status = owner.status
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self.url = "http://127.0.0.1:%d" % self.port
        threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self._server.shutdown()
        self._server.server_close()
