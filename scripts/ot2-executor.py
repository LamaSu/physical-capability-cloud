#!/usr/bin/env python3
"""
OT-2 Thin Executor — runs on the Opentrons OT-2.

No LLM. No decision-making. Just executes tool calls relayed through PCC
and pushes camera frames. The "brain" runs on Spark.

Architecture:
  Spark (brain + Claude) → PCC (relay) ← this script (executor) ← OT-2 API
"""

import json
import time
import sys
import os
import ssl
import subprocess
import logging
import glob as globmod
import base64
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ── Config ──────────────────────────────────────────────────────────────

PCC_API_KEY = os.environ.get("PCC_API_KEY", "")
PCC_BASE = os.environ.get("PCC_BASE", "https://capability.network")
OT2_BASE = os.environ.get("OT2_BASE", "http://localhost:31950")
OT2_API_VERSION = "2"
KERNEL_ID = os.environ.get("KERNEL_ID", "kernel-nanoclaw")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ot2-exec")

# ── HTTP helpers ────────────────────────────────────────────────────────

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def http(method, url, body=None, headers=None, timeout=30):
    hdrs = headers or {}
    hdrs.setdefault("User-Agent", "PCC-OT2-Executor/2.0 (falling-bush)")
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = Request(url, data=data, headers=hdrs, method=method)
    try:
        with urlopen(req, timeout=timeout, context=_ctx) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except (URLError, Exception) as e:
        return 0, {"error": str(e)}


def ot2(method, path, body=None):
    url = f"{OT2_BASE}{path}"
    headers = {"opentrons-version": OT2_API_VERSION}
    return http(method, url, body, headers)


def pcc(method, path, body=None):
    url = f"{PCC_BASE}{path}"
    headers = {"Authorization": f"Bearer {PCC_API_KEY}"}
    return http(method, url, body, headers)


# ── Camera Utilities ──────────────────────────────────────────────────

# Cached camera device path (detected once, reused)
_camera_device = None


def detect_camera_device():
    """Auto-detect a working V4L2 camera device.

    Scans /dev/video* and returns the first device that can produce frames.
    Prefers /dev/video6 (known Innomaker USB camera on the OT-2).
    Caches the result for subsequent calls.
    """
    global _camera_device
    if _camera_device is not None:
        return _camera_device

    # Candidate list: prefer /dev/video6, then scan all
    candidates = []
    # Add /dev/video6 first (known working device)
    if os.path.exists("/dev/video6"):
        candidates.append("/dev/video6")
    # Add /dev/video0 as second preference
    if os.path.exists("/dev/video0"):
        candidates.append("/dev/video0")
    # Scan for any other video devices
    for dev in sorted(globmod.glob("/dev/video*")):
        if dev not in candidates:
            candidates.append(dev)

    if not candidates:
        log.warning("No /dev/video* devices found")
        return None

    for dev in candidates:
        log.info(f"Probing camera device: {dev}")
        # Quick probe: try v4l2-ctl --all to check if device is a capture device
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
            # v4l2-ctl not available, try a basic stat check
            pass

        # Fallback: just check the device exists and is readable
        if os.path.exists(dev):
            log.info(f"Using device (unverified): {dev}")
            _camera_device = dev
            return dev

    log.warning("No working camera device found")
    return None


def capture_frame_jpeg():
    """Capture a single JPEG frame from the camera.

    Tries methods in order of reliability:
      1. v4l2-ctl --stream-mmap (works with MJPEG and H264 cameras)
      2. ffmpeg single-frame capture
      3. dd from device (last resort, unreliable with H264)

    Returns JPEG bytes or None on failure.
    """
    dev = detect_camera_device()
    if not dev:
        return None

    tmpfile = "/tmp/pcc_frame.jpg"

    # ── Method 1: v4l2-ctl ──────────────────────────────────────────
    try:
        # First try to set MJPEG format, then capture
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
                log.debug(f"v4l2-ctl capture OK: {len(data)} bytes")
                return data
            # Maybe the file has embedded JPEG — search for markers
            start = data.find(b"\xff\xd8")
            end = data.find(b"\xff\xd9", max(start, 0))
            if start >= 0 and end > start:
                log.debug(f"v4l2-ctl capture OK (extracted): {end - start + 2} bytes")
                return data[start:end + 2]
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.debug(f"v4l2-ctl not available or timed out: {e}")

    # ── Method 2: ffmpeg ────────────────────────────────────────────
    try:
        # Remove stale file
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
                log.debug(f"ffmpeg capture OK: {len(data)} bytes")
                return data
        # Try with h264 input format
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
                log.debug(f"ffmpeg h264 capture OK: {len(data)} bytes")
                return data
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.debug(f"ffmpeg not available or timed out: {e}")

    # ── Method 3: dd from device (last resort) ─────────────────────
    try:
        r = subprocess.run(
            ["dd", f"if={dev}", "bs=512", "count=400"],
            capture_output=True, timeout=5,
        )
        data = r.stdout
        start = data.find(b"\xff\xd8")
        end = data.find(b"\xff\xd9", max(start, 0))
        if start >= 0 and end > start:
            frame = data[start:end + 2]
            log.debug(f"dd capture OK: {len(frame)} bytes")
            return frame
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.debug(f"dd capture failed: {e}")

    log.warning("All capture methods failed")
    return None


# ── Tool Execution (same as before, no Claude needed) ───────────────────

def execute_tool(name, args):
    """Execute a tool call against the OT-2 hardware. Returns result string."""
    try:
        if name == "ot2_health":
            s, r = ot2("GET", "/health")
            return json.dumps(r, indent=2)

        elif name == "ot2_pipettes":
            s, r = ot2("GET", "/pipettes")
            return json.dumps(r, indent=2)

        elif name == "ot2_modules":
            s, r = ot2("GET", "/modules")
            return json.dumps(r, indent=2)

        elif name == "ot2_deck_calibration":
            s, r = ot2("GET", "/calibration/status")
            return json.dumps(r, indent=2)

        elif name == "ot2_pipette_offset":
            s, r = ot2("GET", "/calibration/pipette_offset")
            return json.dumps(r, indent=2)

        elif name == "ot2_tip_length":
            s, r = ot2("GET", "/calibration/tip_length")
            return json.dumps(r, indent=2)

        elif name == "ot2_protocols_list":
            s, r = ot2("GET", "/protocols")
            return json.dumps(r, indent=2)

        elif name == "ot2_protocol_upload":
            filename = args.get("filename", "protocol.py")
            content = args["content"]
            tmppath = f"/tmp/{filename}"
            with open(tmppath, "w") as f:
                f.write(content)
            result = subprocess.run(
                ["curl", "-s", "-H", f"opentrons-version: {OT2_API_VERSION}",
                 "-F", f"files=@{tmppath}", f"{OT2_BASE}/protocols"],
                capture_output=True, text=True, timeout=30,
            )
            os.remove(tmppath)
            return result.stdout or result.stderr

        elif name == "ot2_runs_list":
            s, r = ot2("GET", "/runs")
            return json.dumps(r, indent=2)

        elif name == "ot2_run_create":
            s, r = ot2("POST", "/runs", {"data": {"protocolId": args["protocolId"]}})
            return json.dumps(r, indent=2)

        elif name == "ot2_run_action":
            run_id = args["runId"]
            action = args["action"]
            s, r = ot2("POST", f"/runs/{run_id}/actions", {"data": {"actionType": action}})
            return json.dumps(r, indent=2)

        elif name == "ot2_run_status":
            run_id = args["runId"]
            s, r = ot2("GET", f"/runs/{run_id}")
            return json.dumps(r, indent=2)

        elif name == "ot2_lights":
            s, r = ot2("POST", "/robot/lights", {"on": args.get("on", True)})
            return json.dumps(r, indent=2)

        elif name == "ot2_home":
            axes = args.get("axes", [])
            body = {"target": "robot"} if not axes else {"target": "robot", "axes": axes}
            s, r = ot2("POST", "/robot/home", body)
            return json.dumps(r, indent=2)

        elif name == "ot2_identify":
            secs = args.get("seconds", 5)
            s, r = ot2("POST", f"/identify?seconds={secs}")
            return json.dumps(r, indent=2)

        elif name == "ot2_shell":
            cmd = args["command"]
            timeout = args.get("timeout", 30)
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout,
            )
            return json.dumps({"exit_code": result.returncode, "output": (result.stdout + result.stderr)[:4000]})

        elif name == "ot2_camera_snapshot":
            frame = capture_frame_jpeg()
            if frame:
                frame_b64 = base64.b64encode(frame).decode("ascii")
                return json.dumps({
                    "snapshot": True,
                    "size": len(frame_b64),
                    "jpeg_bytes": len(frame),
                    "device": detect_camera_device(),
                    "format": "jpeg_base64",
                })
            return json.dumps({
                "snapshot": False,
                "error": "no frame captured",
                "device": detect_camera_device(),
            })

        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

    except Exception as e:
        return json.dumps({"error": str(e)})


# ── Camera Push ─────────────────────────────────────────────────────────

def push_camera_frame():
    """Capture and push a camera frame to PCC."""
    try:
        frame = capture_frame_jpeg()
        if frame is None:
            log.warning("Camera frame capture failed — no frame data")
            return

        frame_b64 = base64.b64encode(frame).decode("ascii")
        s, r = pcc("POST", "/api/ot2/camera/frame", {
            "kernelId": KERNEL_ID,
            "frame": frame_b64,
            "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        if s in (200, 201):
            log.info(f"Camera frame pushed ({len(frame)} bytes JPEG)")
        else:
            log.warning(f"Camera frame push failed: HTTP {s} — {r}")
    except Exception as e:
        log.warning(f"Camera push error: {e}")


# ── Main Loop ───────────────────────────────────────────────────────────

def poll_tool_calls():
    """Poll PCC for pending tool calls."""
    s, r = pcc("GET", f"/api/ot2/tool-call/pending?kernelId={KERNEL_ID}")
    if s != 200:
        return []
    calls = r.get("calls", r) if isinstance(r, dict) else r
    return calls if isinstance(calls, list) else []


def execute_and_report(call):
    """Execute a tool call and post the result back to PCC."""
    call_id = call.get("id", "unknown")
    tool_name = call.get("toolName", call.get("tool_name", ""))
    tool_args = call.get("toolArgs", call.get("args", call.get("tool_args", {})))

    log.info(f"Executing {tool_name}({json.dumps(tool_args)[:100]}) [call={call_id}]")

    result = execute_tool(tool_name, tool_args)
    log.info(f"Result: {result[:200]}")

    # Post result back to PCC
    s, r = pcc("POST", "/api/ot2/tool-result", {
        "callId": call_id,
        "result": result,
    })
    if s != 200:
        log.error(f"Failed to post result for {call_id}: {r}")


def poll_chat_messages():
    """Poll PCC for pending chat messages (direct questions that don't need Claude)."""
    s, r = pcc("GET", f"/api/ot2/chat/pending?kernelId={KERNEL_ID}")
    if s != 200:
        return []
    msgs = r.get("messages", r) if isinstance(r, dict) else r
    return msgs if isinstance(msgs, list) else []


def handle_simple_chat(msg):
    """Handle simple chat messages that don't need Claude — just report status."""
    msg_id = msg.get("id", "unknown")
    content = msg.get("content", "").lower()

    # Auto-respond to simple queries without Claude
    if any(w in content for w in ["health", "status", "alive", "ping"]):
        s, health = ot2("GET", "/health")
        s2, pips = ot2("GET", "/pipettes")
        response = f"Robot: {health.get('name', '?')} ({health.get('robot_model', '?')})\n"
        response += f"API: {health.get('api_version', '?')}, FW: {health.get('fw_version', '?')}\n"
        response += f"Pipettes: {json.dumps(pips, indent=2)[:500]}"
        pcc("POST", "/api/ot2/chat/respond", {"messageId": msg_id, "response": response})
    else:
        # For complex messages, mark as needs-brain (the Spark brain will handle it)
        pcc("POST", "/api/ot2/chat/respond", {
            "messageId": msg_id,
            "response": "[Relaying to brain for processing...]",
        })


def run():
    """Main executor loop."""
    # Verify OT-2
    s, health = ot2("GET", "/health")
    if s != 200:
        print(f"ERROR: Cannot reach OT-2 at {OT2_BASE}")
        sys.exit(1)

    log.info(f"Connected to OT-2 '{health.get('name')}' (API {health.get('api_version')})")
    log.info(f"Executor mode. Polling {PCC_BASE} every {POLL_INTERVAL}s for kernel {KERNEL_ID}")

    # Probe camera at startup
    cam = detect_camera_device()
    if cam:
        log.info(f"Camera device: {cam}")
        test_frame = capture_frame_jpeg()
        if test_frame:
            log.info(f"Camera probe OK: {len(test_frame)} byte JPEG")
        else:
            log.warning("Camera detected but frame capture failed — will retry in loop")
    else:
        log.warning("No camera device detected — camera frames will be skipped")

    # Register online
    pcc("POST", f"/api/kernels/{KERNEL_ID}/heartbeat", {"status": "online"})

    # Announce to DHT
    s2, pips = ot2("GET", "/pipettes")
    pipette_names = []
    if isinstance(pips, dict):
        for mount in ["left", "right"]:
            p = pips.get(mount, {})
            if p and p.get("name"):
                pipette_names.append(p["name"])
    log.info(f"Announcing to DHT: {KERNEL_ID} with pipettes {pipette_names}")
    pcc("POST", "/api/dht/announce", {
        "kernelId": KERNEL_ID,
        "kernelDid": f"did:pcc:{KERNEL_ID}",
        "capabilities": [
            {
                "type": "liquid-handler",
                "materials": ["aqueous", "biological", "organic"],
                "priceRange": {"min": 10, "max": 50, "currency": "USDC"},
                "queueDepth": 0,
            }
        ],
        "endpoints": [
            {"transport": "http-poll", "url": f"{PCC_BASE}/api/ot2/tool-call", "priority": 1},
        ],
        "ttlSeconds": 300,
    })

    camera_counter = 0
    CAMERA_EVERY = 10  # push camera every N cycles (~50s at 5s interval)

    while True:
        try:
            # 1. Poll for tool calls from the brain
            calls = poll_tool_calls()
            for call in calls:
                execute_and_report(call)

            # 2. Poll for simple chat messages
            msgs = poll_chat_messages()
            for msg in msgs:
                handle_simple_chat(msg)

            # 3. Push camera frame periodically
            camera_counter += 1
            if camera_counter >= CAMERA_EVERY:
                push_camera_frame()
                camera_counter = 0

        except KeyboardInterrupt:
            log.info("Shutting down...")
            pcc("POST", f"/api/kernels/{KERNEL_ID}/heartbeat", {"status": "offline"})
            break
        except Exception as e:
            log.error(f"Loop error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    if not PCC_API_KEY:
        print("ERROR: Set PCC_API_KEY")
        sys.exit(1)
    run()
