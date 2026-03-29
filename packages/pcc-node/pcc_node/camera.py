"""Camera capture and push to PCC.

Supports multiple capture methods (v4l2-ctl, ffmpeg, dd) with automatic
fallback.  Linux only -- returns None on other platforms.
"""

import base64
import logging
import os
import platform
import subprocess
import time

from .http_util import pcc_request

log = logging.getLogger("pcc-node.camera")

# Cached camera device path
_camera_device = None


def detect_camera_device():
    """Auto-detect a working V4L2 camera device.

    Scans /dev/video* and returns the first device that can produce frames.
    Caches the result for subsequent calls.  Returns None on non-Linux.
    """
    global _camera_device
    if _camera_device is not None:
        return _camera_device

    if platform.system() != "Linux":
        return None

    import glob as globmod

    # Candidate list: prefer known working devices
    candidates = []
    for preferred in ["/dev/video6", "/dev/video0"]:
        if os.path.exists(preferred):
            candidates.append(preferred)
    for dev in sorted(globmod.glob("/dev/video*")):
        if dev not in candidates:
            candidates.append(dev)

    if not candidates:
        log.warning("No /dev/video* devices found")
        return None

    for dev in candidates:
        log.debug(f"Probing camera device: {dev}")
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

        # Fallback: device exists and is readable
        if os.path.exists(dev):
            log.info(f"Using device (unverified): {dev}")
            _camera_device = dev
            return dev

    log.warning("No working camera device found")
    return None


def reset_camera_cache():
    """Reset the cached camera device (useful for testing)."""
    global _camera_device
    _camera_device = None


def capture_frame_jpeg():
    """Capture a single JPEG frame from the camera.

    Tries methods in order:
      1. v4l2-ctl --stream-mmap
      2. ffmpeg single-frame capture
      3. dd from device (last resort)

    Returns JPEG bytes or None on failure.
    """
    dev = detect_camera_device()
    if not dev:
        return None

    tmpfile = "/tmp/pcc_frame.jpg"

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
            # Embedded JPEG search
            start = data.find(b"\xff\xd8")
            end = data.find(b"\xff\xd9", max(start, 0))
            if start >= 0 and end > start:
                return data[start:end + 2]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass

    # Method 2: ffmpeg
    for fmt in ["mjpeg", "h264"]:
        try:
            if os.path.exists(tmpfile):
                os.remove(tmpfile)
            r = subprocess.run(
                ["ffmpeg", "-y", "-f", "v4l2", "-input_format", fmt,
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

    log.warning("All camera capture methods failed")
    return None


def push_camera_frame(pcc_base, api_key, kernel_id):
    """Capture and push a camera frame to PCC.

    Returns True on success, False on failure.
    """
    try:
        frame = capture_frame_jpeg()
        if frame is None:
            log.warning("Camera frame capture failed -- no frame data")
            return False

        frame_b64 = base64.b64encode(frame).decode("ascii")
        status, _data = pcc_request(
            "POST", "/api/ot2/camera/frame",
            body={
                "kernelId": kernel_id,
                "frame": frame_b64,
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            base_url=pcc_base,
            api_key=api_key,
        )
        if status in (200, 201):
            log.info(f"Camera frame pushed ({len(frame)} bytes JPEG)")
            return True
        else:
            log.warning(f"Camera frame push failed: HTTP {status}")
            return False
    except Exception as e:
        log.warning(f"Camera push error: {e}")
        return False
