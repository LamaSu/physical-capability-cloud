#!/usr/bin/env python3
"""
Test script for OT-2 camera capture.

Run on the OT-2 to verify:
  1. Camera device detection
  2. Frame capture (v4l2-ctl / ffmpeg / dd)
  3. Optionally push a frame to PCC

Usage:
  python3 test-ot2-camera.py                    # detect + capture only
  python3 test-ot2-camera.py --push             # also push to PCC
  python3 test-ot2-camera.py --save frame.jpg   # save frame to file
  python3 test-ot2-camera.py --device /dev/video6  # force a specific device
"""

import os
import sys
import subprocess
import json
import ssl
import time
import base64
import glob as globmod
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

PCC_BASE = os.environ.get("PCC_BASE", "https://capability.network")
PCC_API_KEY = os.environ.get("PCC_API_KEY", "")
KERNEL_ID = os.environ.get("KERNEL_ID", "kernel-nanoclaw")


def banner(msg):
    print(f"\n{'=' * 60}")
    print(f"  {msg}")
    print(f"{'=' * 60}")


def step(msg):
    print(f"\n  >> {msg}")


# ── Step 1: Enumerate video devices ─────────────────────────────────

def enumerate_devices():
    banner("Step 1: Enumerating /dev/video* devices")
    devices = sorted(globmod.glob("/dev/video*"))
    if not devices:
        print("  NO video devices found!")
        return []
    for dev in devices:
        print(f"  Found: {dev}")
        try:
            r = subprocess.run(
                ["v4l2-ctl", "--device", dev, "--all"],
                capture_output=True, text=True, timeout=3,
            )
            if r.returncode == 0:
                # Extract key info
                for line in r.stdout.splitlines():
                    line = line.strip()
                    if any(k in line.lower() for k in ["driver", "card", "bus", "video capture", "format"]):
                        print(f"    {line}")
            else:
                print(f"    (v4l2-ctl returned {r.returncode})")
        except FileNotFoundError:
            print("    (v4l2-ctl not installed)")
        except subprocess.TimeoutExpired:
            print("    (v4l2-ctl timed out)")
    return devices


# ── Step 2: Detect best camera ──────────────────────────────────────

def detect_best_device(devices, forced=None):
    banner("Step 2: Detecting best capture device")
    if forced:
        print(f"  Forced device: {forced}")
        if os.path.exists(forced):
            return forced
        print(f"  ERROR: {forced} does not exist!")
        return None

    # Prefer /dev/video6
    preferred = ["/dev/video6", "/dev/video0"]
    for dev in preferred:
        if dev in devices:
            step(f"Trying preferred device: {dev}")
            try:
                r = subprocess.run(
                    ["v4l2-ctl", "--device", dev, "--all"],
                    capture_output=True, text=True, timeout=3,
                )
                if r.returncode == 0 and "Video Capture" in r.stdout:
                    print(f"  SELECTED: {dev} (confirmed capture device)")
                    return dev
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

    # Fallback: first available
    for dev in devices:
        step(f"Trying device: {dev}")
        if os.path.exists(dev):
            print(f"  SELECTED: {dev} (fallback, unverified)")
            return dev

    print("  NO suitable camera found!")
    return None


# ── Step 3: Capture frame ───────────────────────────────────────────

def try_capture(dev):
    banner("Step 3: Capturing frame")
    tmpfile = "/tmp/test_ot2_frame.jpg"
    methods_tried = []

    # Method 1: v4l2-ctl
    step("Method 1: v4l2-ctl --stream-mmap")
    methods_tried.append("v4l2-ctl")
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
                print(f"  SUCCESS: {len(data)} bytes, valid JPEG header")
                return data, "v4l2-ctl"
            start = data.find(b"\xff\xd8")
            end = data.find(b"\xff\xd9", max(start, 0))
            if start >= 0 and end > start:
                frame = data[start:end + 2]
                print(f"  SUCCESS (extracted): {len(frame)} bytes")
                return frame, "v4l2-ctl"
            print(f"  Got {len(data)} bytes but no JPEG markers found")
        else:
            stderr = r.stderr.decode("utf-8", errors="replace") if r.stderr else ""
            print(f"  FAILED: returncode={r.returncode}")
            if stderr:
                print(f"  stderr: {stderr[:200]}")
    except FileNotFoundError:
        print("  SKIPPED: v4l2-ctl not installed")
    except subprocess.TimeoutExpired:
        print("  FAILED: timed out")

    # Method 2: ffmpeg (MJPEG)
    step("Method 2: ffmpeg (mjpeg input)")
    methods_tried.append("ffmpeg-mjpeg")
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
                print(f"  SUCCESS: {len(data)} bytes")
                return data, "ffmpeg-mjpeg"
        else:
            print(f"  FAILED: returncode={r.returncode}")
    except FileNotFoundError:
        print("  SKIPPED: ffmpeg not installed")
    except subprocess.TimeoutExpired:
        print("  FAILED: timed out")

    # Method 2b: ffmpeg (H264 input)
    step("Method 2b: ffmpeg (h264 input)")
    methods_tried.append("ffmpeg-h264")
    try:
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
                print(f"  SUCCESS: {len(data)} bytes")
                return data, "ffmpeg-h264"
        else:
            print(f"  FAILED: returncode={r.returncode}")
    except FileNotFoundError:
        print("  SKIPPED: ffmpeg not installed")
    except subprocess.TimeoutExpired:
        print("  FAILED: timed out")

    # Method 3: dd (last resort)
    step("Method 3: dd from device")
    methods_tried.append("dd")
    try:
        r = subprocess.run(
            ["dd", f"if={dev}", "bs=512", "count=400"],
            capture_output=True, timeout=5,
        )
        data = r.stdout
        print(f"  Read {len(data)} raw bytes")
        start = data.find(b"\xff\xd8")
        end = data.find(b"\xff\xd9", max(start, 0))
        if start >= 0 and end > start:
            frame = data[start:end + 2]
            print(f"  SUCCESS (extracted JPEG): {len(frame)} bytes at offset {start}")
            return frame, "dd"
        else:
            print(f"  No JPEG markers (0xFFD8...0xFFD9) found in raw data")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        print(f"  FAILED: {e}")

    print(f"\n  ALL METHODS FAILED: tried {', '.join(methods_tried)}")
    return None, None


# ── Step 4: Push to PCC ─────────────────────────────────────────────

def push_to_pcc(frame):
    banner("Step 4: Pushing frame to PCC")
    if not PCC_API_KEY:
        print("  SKIPPED: PCC_API_KEY not set")
        return

    frame_b64 = base64.b64encode(frame).decode("ascii")
    body = json.dumps({
        "kernelId": KERNEL_ID,
        "frame": frame_b64,
        "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }).encode("utf-8")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    req = Request(
        f"{PCC_BASE}/api/ot2/camera/frame",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {PCC_API_KEY}",
            "User-Agent": "PCC-OT2-CameraTest/1.0 (falling-bush)",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=15, context=ctx) as resp:
            result = resp.read().decode("utf-8")
            print(f"  HTTP {resp.status}: {result}")
            if resp.status in (200, 201):
                print("  SUCCESS: Frame is now visible at PCC!")
                print(f"    View: {PCC_BASE}/api/ot2/camera/latest?kernelId={KERNEL_ID}")
            else:
                print("  WARNING: Unexpected status code")
    except HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"  HTTP ERROR {e.code}: {body}")
    except URLError as e:
        print(f"  URL ERROR: {e}")
    except Exception as e:
        print(f"  ERROR: {e}")


# ── Main ─────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Test OT-2 camera capture")
    parser.add_argument("--push", action="store_true", help="Push captured frame to PCC")
    parser.add_argument("--save", type=str, help="Save captured frame to file")
    parser.add_argument("--device", type=str, help="Force a specific /dev/video* device")
    args = parser.parse_args()

    print("OT-2 Camera Test")
    print(f"  PCC: {PCC_BASE}")
    print(f"  Kernel: {KERNEL_ID}")
    print(f"  API Key: {'set' if PCC_API_KEY else 'NOT SET'}")

    # Check available tools
    step("Checking available tools")
    for tool in ["v4l2-ctl", "ffmpeg", "dd"]:
        try:
            r = subprocess.run(["which", tool], capture_output=True, text=True, timeout=3)
            if r.returncode == 0:
                print(f"    {tool}: {r.stdout.strip()}")
            else:
                print(f"    {tool}: NOT FOUND")
        except Exception:
            print(f"    {tool}: check failed")

    devices = enumerate_devices()
    if not devices:
        print("\nFATAL: No video devices. Is the camera connected?")
        sys.exit(1)

    dev = detect_best_device(devices, forced=args.device)
    if not dev:
        print("\nFATAL: No suitable camera device found.")
        sys.exit(1)

    frame, method = try_capture(dev)
    if not frame:
        print("\nFATAL: Could not capture a frame with any method.")
        sys.exit(1)

    # Summary
    banner("Results")
    print(f"  Device:  {dev}")
    print(f"  Method:  {method}")
    print(f"  Size:    {len(frame)} bytes")
    print(f"  Header:  {frame[:4].hex()}")
    is_jpeg = frame[:2] == b"\xff\xd8" and frame[-2:] == b"\xff\xd9"
    print(f"  Valid JPEG: {'YES' if is_jpeg else 'NO (missing markers)'}")

    if args.save:
        with open(args.save, "wb") as f:
            f.write(frame)
        print(f"  Saved to: {args.save}")

    if args.push:
        push_to_pcc(frame)
    elif PCC_API_KEY:
        print("\n  Tip: Run with --push to send this frame to PCC")

    print()


if __name__ == "__main__":
    main()
