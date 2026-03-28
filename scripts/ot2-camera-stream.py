#!/usr/bin/env python3
"""Simple MJPEG camera streamer for the OT-2's USB camera."""
import http.server
import subprocess
import time

PORT = 8080

class MJPEGHandler(http.server.BaseHTTPRequestHandler):
    def grab_frame(self):
        try:
            r = subprocess.run(
                ["dd", "if=/dev/video0", "bs=512", "count=200"],
                capture_output=True, timeout=3,
            )
            data = r.stdout
            start = data.find(b"\xff\xd8")
            end = data.find(b"\xff\xd9", start)
            if start >= 0 and end >= 0:
                return data[start : end + 2]
        except Exception:
            pass
        return None

    def do_GET(self):
        if self.path == "/snapshot":
            frame = self.grab_frame()
            if frame:
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(frame)))
                self.end_headers()
                self.wfile.write(frame)
            else:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"No frame captured")

        elif self.path == "/stream":
            self.send_response(200)
            boundary = "frame"
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={boundary}")
            self.end_headers()
            try:
                while True:
                    frame = self.grab_frame()
                    if frame:
                        self.wfile.write(f"--{boundary}\r\n".encode())
                        self.wfile.write(b"Content-Type: image/jpeg\r\n")
                        self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode())
                        self.wfile.write(frame)
                        self.wfile.write(b"\r\n")
                    time.sleep(0.3)
            except (BrokenPipeError, ConnectionResetError):
                pass

        elif self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","camera":"/dev/video0","port":8080}')

        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b'<html><body style="background:#000;margin:0">')
            self.wfile.write(b'<img src="/stream" style="width:100%;height:auto">')
            self.wfile.write(b"</body></html>")

    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    print(f"Camera stream on port {PORT}")
    with http.server.HTTPServer(("", PORT), MJPEGHandler) as httpd:
        httpd.serve_forever()
