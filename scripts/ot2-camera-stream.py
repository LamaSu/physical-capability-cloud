#!/usr/bin/env python3
"""Simple MJPEG camera streamer for the OT-2's USB camera.

Auto-detects the camera device (prefers /dev/video6, the Innomaker USB camera).
Uses v4l2-ctl or ffmpeg for reliable capture, with dd as last resort.
"""
import http.server
import subprocess
import time
import os
import glob as globmod
import json
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ot2-cam")

PORT = int(os.environ.get("CAMERA_PORT", "8080"))

# ── Camera Utilities (shared logic with ot2-executor.py) ─────────────

_camera_device = None


def detect_camera_device():
    """Auto-detect a working V4L2 camera device."""
    global _camera_device
    if _camera_device is not None:
        return _camera_device

    candidates = []
    if os.path.exists("/dev/video6"):
        candidates.append("/dev/video6")
    if os.path.exists("/dev/video0"):
        candidates.append("/dev/video0")
    for dev in sorted(globmod.glob("/dev/video*")):
        if dev not in candidates:
            candidates.append(dev)

    if not candidates:
        log.warning("No /dev/video* devices found")
        return None

    for dev in candidates:
        log.info(f"Probing camera device: {dev}")
        try:
            r = subprocess.run(
                ["v4l2-ctl", "--device", dev, "--all"],
                capture_output=True, text=True, timeout=3,
            )
            if r.returncode == 0 and "Video Capture" in r.stdout:
                log.info(f"Found capture device: {dev}")
                _camera_device = dev
                return dev
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

        if os.path.exists(dev):
            log.info(f"Using device (unverified): {dev}")
            _camera_device = dev
            return dev

    return None


def capture_frame_jpeg():
    """Capture a single JPEG frame. Returns bytes or None."""
    dev = detect_camera_device()
    if not dev:
        return None

    tmpfile = "/tmp/pcc_cam_frame.jpg"

    # Method 1: v4l2-ctl
    try:
        subprocess.run(
            ["v4l2-ctl", "--device", dev,
             "--set-fmt-video=width=640,height=480,pixelformat=MJPG"],
            capture_output=True, timeout=3,
        )
        r = subprocess.run(
            ["v4l2-ctl", "--device", dev,
             "--stream-mmap", "--stream-count=1",
             f"--stream-to={tmpfile}"],
            capture_output=True, timeout=8,
        )
        if r.returncode == 0 and os.path.exists(tmpfile):
            with open(tmpfile, "rb") as f:
                data = f.read()
            if len(data) > 100 and data[:2] == b"\xff\xd8":
                return data
            start = data.find(b"\xff\xd8")
            end = data.find(b"\xff\xd9", max(start, 0))
            if start >= 0 and end > start:
                return data[start:end + 2]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 2: ffmpeg
    try:
        if os.path.exists(tmpfile):
            os.remove(tmpfile)
        r = subprocess.run(
            ["ffmpeg", "-y", "-f", "v4l2", "-input_format", "mjpeg",
             "-video_size", "640x480", "-i", dev,
             "-frames:v", "1", "-f", "mjpeg", tmpfile],
            capture_output=True, timeout=8,
        )
        if r.returncode == 0 and os.path.exists(tmpfile):
            with open(tmpfile, "rb") as f:
                data = f.read()
            if len(data) > 100:
                return data
        if os.path.exists(tmpfile):
            os.remove(tmpfile)
        r = subprocess.run(
            ["ffmpeg", "-y", "-f", "v4l2", "-input_format", "h264",
             "-video_size", "640x480", "-i", dev,
             "-frames:v", "1", "-f", "mjpeg", tmpfile],
            capture_output=True, timeout=8,
        )
        if r.returncode == 0 and os.path.exists(tmpfile):
            with open(tmpfile, "rb") as f:
                data = f.read()
            if len(data) > 100:
                return data
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 3: dd (last resort)
    try:
        r = subprocess.run(
            ["dd", f"if={dev}", "bs=512", "count=400"],
            capture_output=True, timeout=5,
        )
        data = r.stdout
        start = data.find(b"\xff\xd8")
        end = data.find(b"\xff\xd9", max(start, 0))
        if start >= 0 and end > start:
            return data[start:end + 2]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    return None


# ── HTTP Server ──────────────────────────────────────────────────────

class MJPEGHandler(http.server.BaseHTTPRequestHandler):
    def grab_frame(self):
        return capture_frame_jpeg()

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
            dev = detect_camera_device() or "none"
            body = json.dumps({"status": "ok", "camera": dev, "port": PORT})
            self.wfile.write(body.encode())

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
    dev = detect_camera_device()
    print(f"Camera device: {dev or 'NONE DETECTED'}")
    print(f"Camera stream on port {PORT}")
    print(f"  Snapshot: http://localhost:{PORT}/snapshot")
    print(f"  Stream:   http://localhost:{PORT}/stream")
    print(f"  Health:   http://localhost:{PORT}/health")
    with http.server.HTTPServer(("", PORT), MJPEGHandler) as httpd:
        httpd.serve_forever()
