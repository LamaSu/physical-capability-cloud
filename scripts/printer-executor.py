#!/usr/bin/env python3
"""
HP Printer Executor -- runs on DGX Spark, drives the HP Color LaserJet Pro MFP 3301.

No LLM. No decision-making. Just executes tool calls relayed through PCC
and returns results. Same architecture as ot2-executor.py.

Architecture:
  Brain (Claude on Spark) -> PCC (relay) <- this script (executor) <- CUPS/lp

Env vars:
  PCC_API_KEY    -- Bearer token for PCC gateway
  PCC_BASE       -- Gateway URL (default https://capability.network)
  KERNEL_ID      -- Kernel identifier (default kernel-hp-printer)
  PRINTER_NAME   -- CUPS printer name (default HP_Color_LaserJet_Pro_MFP_3301_0D253A@HP48EA620D253A.local)
  POLL_INTERVAL  -- Poll interval in seconds (default 5)
"""

import json
import time
import sys
import os
import ssl
import subprocess
import logging
import base64
import tempfile
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# -- Config -------------------------------------------------------------------

PCC_API_KEY = os.environ.get("PCC_API_KEY", "")
PCC_BASE = os.environ.get("PCC_BASE", "https://capability.network")
KERNEL_ID = os.environ.get("KERNEL_ID", "kernel-hp-printer")
PRINTER_NAME = os.environ.get(
    "PRINTER_NAME",
    "HP_Color_LaserJet_Pro_MFP_3301_0D253A@HP48EA620D253A.local",
)
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "5"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("printer-exec")

# -- HTTP helpers -------------------------------------------------------------

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def http(method, url, body=None, headers=None, timeout=30):
    hdrs = headers or {}
    hdrs.setdefault("User-Agent", "PCC-Printer-Executor/1.0 (hp-laserjet-3301)")
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


def pcc(method, path, body=None):
    url = f"{PCC_BASE}{path}"
    headers = {"Authorization": f"Bearer {PCC_API_KEY}"}
    return http(method, url, body, headers)


# -- Tool dispatch ------------------------------------------------------------

def run_cmd(args, timeout=30):
    """Run a subprocess and return (returncode, stdout, stderr)."""
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except FileNotFoundError:
        return -1, "", f"Command not found: {args[0]}"
    except subprocess.TimeoutExpired:
        return -1, "", f"Command timed out after {timeout}s"


def execute_tool(name, args):
    """Execute a printer tool call. Returns result string.

    Accepts both qualified names (printer_print_text) and short names (print).
    The generic 'print' tool auto-routes based on which args are present.
    """
    try:
        # Route the generic "print" tool to the appropriate specific tool
        if name == "print":
            if args.get("url"):
                name = "printer_print_url"
            elif args.get("content") or args.get("data"):
                name = "printer_print_file"
            elif args.get("text"):
                name = "printer_print_text"
            else:
                return json.dumps({
                    "error": "No printable content: provide 'text', 'url', or 'content' (base64)",
                    "received_args": list(args.keys()),
                })

        if name == "printer_status":
            rc, out, err = run_cmd(["lpstat", "-p", PRINTER_NAME])
            return json.dumps({
                "printer": PRINTER_NAME,
                "status": out.strip() or err.strip(),
                "exit_code": rc,
            })

        elif name == "printer_queue":
            rc, out, err = run_cmd(["lpq", "-P", PRINTER_NAME])
            return json.dumps({
                "printer": PRINTER_NAME,
                "queue": out.strip() or err.strip(),
                "exit_code": rc,
            })

        elif name == "printer_print_text":
            text = args.get("text", args.get("content", ""))
            if not text:
                return json.dumps({"error": "No text provided"})
            copies = args.get("copies", 1)
            options = args.get("options", "")

            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False, prefix="pcc_print_"
            ) as f:
                f.write(text)
                tmppath = f.name

            try:
                cmd = ["lp", "-d", PRINTER_NAME, "-n", str(copies)]
                if options:
                    for opt in options.split():
                        cmd.extend(["-o", opt])
                cmd.append(tmppath)
                rc, out, err = run_cmd(cmd)
                # lp outputs something like "request id is HP_printer-123 (1 file(s))"
                job_info = out.strip() or err.strip()
                return json.dumps({
                    "printed": rc == 0,
                    "job_info": job_info,
                    "exit_code": rc,
                    "copies": copies,
                })
            finally:
                os.unlink(tmppath)

        elif name == "printer_print_url":
            url = args.get("url", "")
            if not url:
                return json.dumps({"error": "No URL provided"})
            copies = args.get("copies", 1)
            options = args.get("options", "")

            # Determine file extension from URL
            ext = ".pdf"
            lower_url = url.lower()
            for e in [".pdf", ".ps", ".png", ".jpg", ".jpeg", ".txt", ".html"]:
                if e in lower_url:
                    ext = e
                    break

            with tempfile.NamedTemporaryFile(
                suffix=ext, delete=False, prefix="pcc_url_"
            ) as f:
                tmppath = f.name

            try:
                # Download file
                rc, out, err = run_cmd(
                    ["curl", "-sL", "-o", tmppath, "--max-time", "60", url],
                    timeout=65,
                )
                if rc != 0:
                    return json.dumps({
                        "error": f"Download failed: {err.strip()}",
                        "exit_code": rc,
                    })

                # Verify file is not empty
                if os.path.getsize(tmppath) == 0:
                    return json.dumps({"error": "Downloaded file is empty"})

                # Print
                cmd = ["lp", "-d", PRINTER_NAME, "-n", str(copies)]
                if options:
                    for opt in options.split():
                        cmd.extend(["-o", opt])
                cmd.append(tmppath)
                rc, out, err = run_cmd(cmd)
                job_info = out.strip() or err.strip()
                return json.dumps({
                    "printed": rc == 0,
                    "job_info": job_info,
                    "exit_code": rc,
                    "url": url,
                    "copies": copies,
                })
            finally:
                os.unlink(tmppath)

        elif name == "printer_print_file":
            content_b64 = args.get("content", args.get("data", ""))
            filename = args.get("filename", "document.pdf")
            copies = args.get("copies", 1)
            options = args.get("options", "")

            if not content_b64:
                return json.dumps({"error": "No base64 content provided"})

            # Determine suffix from filename
            _, ext = os.path.splitext(filename)
            if not ext:
                ext = ".pdf"

            with tempfile.NamedTemporaryFile(
                suffix=ext, delete=False, prefix="pcc_file_"
            ) as f:
                try:
                    f.write(base64.b64decode(content_b64))
                except Exception as e:
                    os.unlink(f.name)
                    return json.dumps({"error": f"Base64 decode failed: {e}"})
                tmppath = f.name

            try:
                cmd = ["lp", "-d", PRINTER_NAME, "-n", str(copies)]
                if options:
                    for opt in options.split():
                        cmd.extend(["-o", opt])
                cmd.append(tmppath)
                rc, out, err = run_cmd(cmd)
                job_info = out.strip() or err.strip()
                return json.dumps({
                    "printed": rc == 0,
                    "job_info": job_info,
                    "exit_code": rc,
                    "filename": filename,
                    "copies": copies,
                })
            finally:
                os.unlink(tmppath)

        elif name == "printer_cancel":
            job_id = args.get("jobId", args.get("job_id", ""))
            if not job_id:
                return json.dumps({"error": "No jobId provided"})
            rc, out, err = run_cmd(["cancel", str(job_id)])
            return json.dumps({
                "cancelled": rc == 0,
                "job_id": job_id,
                "output": (out.strip() or err.strip()),
                "exit_code": rc,
            })

        elif name == "printer_options":
            rc, out, err = run_cmd(["lpoptions", "-d", PRINTER_NAME, "-l"])
            return json.dumps({
                "printer": PRINTER_NAME,
                "options": out.strip() or err.strip(),
                "exit_code": rc,
            })

        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

    except Exception as e:
        return json.dumps({"error": str(e)})


# -- Relay polling (dual endpoint) -------------------------------------------

# Track which endpoint works so we do not retry 404s every cycle
_use_relay = True  # True = generic relay, False = ot2 relay


def poll_tool_calls():
    """Poll PCC for pending tool calls. Tries generic relay first, falls back to ot2."""
    global _use_relay

    if _use_relay:
        s, r = pcc("GET", f"/api/relay/{KERNEL_ID}/tool-call/pending")
        if s == 200:
            calls = r.get("calls", r) if isinstance(r, dict) else r
            return calls if isinstance(calls, list) else []
        if s == 404:
            log.info("Generic relay returned 404, switching to ot2 relay")
            _use_relay = False

    # Fallback: ot2 relay
    s, r = pcc("GET", f"/api/ot2/tool-call/pending?kernelId={KERNEL_ID}")
    if s == 200:
        calls = r.get("calls", r) if isinstance(r, dict) else r
        return calls if isinstance(calls, list) else []

    return []


def post_result(call_id, result, error=None):
    """Post tool result back to PCC. Tries generic relay first, falls back to ot2."""
    body = {"callId": call_id, "result": result}
    if error:
        body["error"] = error

    if _use_relay:
        s, r = pcc("POST", f"/api/relay/{KERNEL_ID}/tool-result", body)
        if s in (200, 201):
            return s, r

    # Fallback
    s, r = pcc("POST", "/api/ot2/tool-result", body)
    return s, r


def send_heartbeat(status="online"):
    """Send heartbeat to PCC."""
    pcc("POST", f"/api/kernels/{KERNEL_ID}/heartbeat", {"status": status})


# -- Execute and report ------------------------------------------------------

def execute_and_report(call):
    """Execute a tool call and post the result back to PCC."""
    call_id = call.get("id", "unknown")
    tool_name = call.get("toolName", call.get("tool_name", ""))
    tool_args = call.get("toolArgs", call.get("args", call.get("tool_args", {})))

    if isinstance(tool_args, str):
        try:
            tool_args = json.loads(tool_args)
        except json.JSONDecodeError:
            tool_args = {}

    log.info(f"Executing {tool_name}({json.dumps(tool_args)[:120]}) [call={call_id}]")

    result = execute_tool(tool_name, tool_args)
    log.info(f"Result: {result[:200]}")

    s, r = post_result(call_id, result)
    if s not in (200, 201):
        log.error(f"Failed to post result for {call_id}: HTTP {s} {r}")


# -- Main loop ---------------------------------------------------------------

def run():
    """Main executor loop."""
    # Verify printer is reachable via CUPS
    rc, out, err = run_cmd(["lpstat", "-p", PRINTER_NAME])
    if rc != 0:
        log.warning(f"Printer not found in CUPS: {err.strip()}")
        log.warning("Will continue anyway -- printer may come online later")
    else:
        log.info(f"Printer: {out.strip()}")

    log.info(f"Kernel: {KERNEL_ID}")
    log.info(f"Printer: {PRINTER_NAME}")
    log.info(f"Gateway: {PCC_BASE}")
    log.info(f"Poll interval: {POLL_INTERVAL}s")

    # Register online
    send_heartbeat("online")

    # Announce to DHT
    pcc("POST", "/api/dht/announce", {
        "kernelId": KERNEL_ID,
        "kernelDid": f"did:pcc:{KERNEL_ID}",
        "capabilities": [
            {
                "type": "printer",
                "subtype": "color-laser",
                "model": "HP Color LaserJet Pro MFP 3301",
                "formats": ["pdf", "ps", "txt", "png", "jpg"],
                "color": True,
                "duplex": True,
                "priceRange": {"min": 0.05, "max": 1.00, "currency": "USDC"},
                "queueDepth": 0,
            }
        ],
        "endpoints": [
            {
                "transport": "http-poll",
                "url": f"{PCC_BASE}/api/relay/{KERNEL_ID}/tool-call",
                "priority": 1,
            },
        ],
        "ttlSeconds": 300,
    })

    heartbeat_counter = 0
    HEARTBEAT_EVERY = 12  # every ~60s at 5s interval

    while True:
        try:
            # Poll for tool calls
            calls = poll_tool_calls()
            for call in calls:
                execute_and_report(call)

            # Periodic heartbeat
            heartbeat_counter += 1
            if heartbeat_counter >= HEARTBEAT_EVERY:
                send_heartbeat("online")
                heartbeat_counter = 0

        except KeyboardInterrupt:
            log.info("Shutting down...")
            send_heartbeat("offline")
            break
        except Exception as e:
            log.error(f"Loop error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    if not PCC_API_KEY:
        print("ERROR: Set PCC_API_KEY environment variable")
        sys.exit(1)
    run()
