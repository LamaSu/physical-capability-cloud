#!/usr/bin/env python3
"""
PCC OT-2 Agent — runs directly on the Opentrons OT-2.

Architecture:
  Claude API (cloud) ←→ this script (OT-2) ←→ localhost:31950 (robot)

The OT-2 becomes a self-driving robot on the PCC network.
It polls for jobs, executes them via Claude + the robot API,
and reports results back to capability.network.

Zero external dependencies — uses only Python 3.10 stdlib + aiohttp.
"""

import json
import time
import sys
import os
import ssl
import hashlib
import logging
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

# ── Config ──────────────────────────────────────────────────────────────

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_OAUTH_TOKEN = os.environ.get("ANTHROPIC_OAUTH_TOKEN", "")
PCC_API_KEY = os.environ.get("PCC_API_KEY", "")
PCC_BASE = os.environ.get("PCC_BASE", "https://capability.network")
OT2_BASE = os.environ.get("OT2_BASE", "http://localhost:31950")
OT2_API_VERSION = "2"
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-haiku-4-5-20251001")
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "10"))
KERNEL_ID = os.environ.get("KERNEL_ID", "kernel-nanoclaw")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ot2-agent")

# ── HTTP helpers (stdlib only) ──────────────────────────────────────────

# Skip SSL verification for self-signed certs on embedded devices
_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


def http(method, url, body=None, headers=None, timeout=30):
    """Make an HTTP request using stdlib. Returns (status, parsed_json | text)."""
    hdrs = headers or {}
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
    except URLError as e:
        return 0, {"error": str(e)}
    except Exception as e:
        return 0, {"error": str(e)}


def ot2(method, path, body=None):
    """Call the OT-2 robot API at localhost:31950."""
    url = f"{OT2_BASE}{path}"
    headers = {"opentrons-version": OT2_API_VERSION}
    return http(method, url, body, headers)


def pcc(method, path, body=None):
    """Call the PCC gateway at capability.network."""
    url = f"{PCC_BASE}{path}"
    headers = {"Authorization": f"Bearer {PCC_API_KEY}"}
    return http(method, url, body, headers)


def claude(messages, tools, system_prompt):
    """Call the Claude Messages API with tools. Supports API key or OAuth token."""
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    if ANTHROPIC_API_KEY:
        headers["x-api-key"] = ANTHROPIC_API_KEY
    elif ANTHROPIC_OAUTH_TOKEN:
        headers["Authorization"] = f"Bearer {ANTHROPIC_OAUTH_TOKEN}"
    body = {
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": messages,
        "tools": tools,
    }
    status, resp = http("POST", url, body, headers, timeout=120)
    if status != 200:
        log.error(f"Claude API error {status}: {resp}")
        return None
    return resp


# ── OT-2 Tool Definitions ──────────────────────────────────────────────

OT2_TOOLS = [
    {
        "name": "ot2_health",
        "description": "Get OT-2 health status, API version, firmware, serial number",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_pipettes",
        "description": "Get attached pipettes (left and right mounts) with model, name, tip length",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_modules",
        "description": "Get attached modules (temperature, magnetic, thermocycler, heater-shaker)",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_deck_calibration",
        "description": "Get deck calibration status and data",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_pipette_offset",
        "description": "Get pipette offset calibrations",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_tip_length",
        "description": "Get tip length calibrations",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_protocols_list",
        "description": "List all uploaded protocols on the robot",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_protocol_upload",
        "description": "Upload a Python protocol file to the robot. The protocol content should be valid Opentrons Protocol API v2 Python code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Protocol filename (e.g. my_protocol.py)"},
                "content": {"type": "string", "description": "Full Python protocol source code"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "ot2_runs_list",
        "description": "List all runs (protocol executions) on the robot",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "ot2_run_create",
        "description": "Create a new run from a protocol ID. Returns the run ID.",
        "input_schema": {
            "type": "object",
            "properties": {
                "protocolId": {"type": "string", "description": "Protocol ID to run"},
            },
            "required": ["protocolId"],
        },
    },
    {
        "name": "ot2_run_action",
        "description": "Control a run: play, pause, stop, or cancel",
        "input_schema": {
            "type": "object",
            "properties": {
                "runId": {"type": "string", "description": "Run ID"},
                "action": {
                    "type": "string",
                    "enum": ["play", "pause", "stop"],
                    "description": "Action to perform",
                },
            },
            "required": ["runId", "action"],
        },
    },
    {
        "name": "ot2_run_status",
        "description": "Get detailed status of a run including current command, progress, and errors",
        "input_schema": {
            "type": "object",
            "properties": {
                "runId": {"type": "string", "description": "Run ID"},
            },
            "required": ["runId"],
        },
    },
    {
        "name": "ot2_lights",
        "description": "Control the OT-2 deck lights",
        "input_schema": {
            "type": "object",
            "properties": {
                "on": {"type": "boolean", "description": "true to turn on, false to turn off"},
            },
            "required": ["on"],
        },
    },
    {
        "name": "ot2_home",
        "description": "Home all axes or specific axes of the robot",
        "input_schema": {
            "type": "object",
            "properties": {
                "axes": {
                    "type": "array",
                    "items": {"type": "string", "enum": ["x", "y", "z_l", "z_r", "z_g"]},
                    "description": "Specific axes to home. Empty = home all.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "ot2_identify",
        "description": "Blink the OT-2 lights for identification (useful for finding the robot)",
        "input_schema": {
            "type": "object",
            "properties": {
                "seconds": {"type": "integer", "description": "How long to blink (default 5)"},
            },
            "required": [],
        },
    },
    {
        "name": "pcc_report_status",
        "description": "Report job status back to PCC gateway",
        "input_schema": {
            "type": "object",
            "properties": {
                "jobId": {"type": "string", "description": "PCC job ID"},
                "status": {
                    "type": "string",
                    "enum": ["running", "completed", "failed"],
                    "description": "Job status",
                },
                "message": {"type": "string", "description": "Status message or error details"},
            },
            "required": ["jobId", "status"],
        },
    },
    {
        "name": "pcc_emit_telemetry",
        "description": "Emit telemetry data to PCC (temperature, progress, events)",
        "input_schema": {
            "type": "object",
            "properties": {
                "jobId": {"type": "string", "description": "PCC job ID"},
                "event": {"type": "string", "description": "Event type (progress, temperature, error, info)"},
                "data": {"type": "object", "description": "Event data payload"},
            },
            "required": ["jobId", "event", "data"],
        },
    },
]

# ── Tool Execution ──────────────────────────────────────────────────────


def execute_tool(name, args):
    """Execute a tool call and return the result as a string."""
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
            # Write protocol to temp file, then upload via multipart
            filename = args.get("filename", "protocol.py")
            content = args["content"]
            tmppath = f"/tmp/{filename}"
            with open(tmppath, "w") as f:
                f.write(content)
            # Use curl for multipart upload since urllib multipart is painful
            import subprocess
            result = subprocess.run(
                [
                    "curl", "-s",
                    "-H", f"opentrons-version: {OT2_API_VERSION}",
                    "-F", f"files=@{tmppath}",
                    f"{OT2_BASE}/protocols",
                ],
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

        elif name == "pcc_report_status":
            job_id = args["jobId"]
            s, r = pcc("PUT", f"/api/jobs/{job_id}/status", {
                "status": args["status"],
                "message": args.get("message", ""),
            })
            return json.dumps(r, indent=2)

        elif name == "pcc_emit_telemetry":
            s, r = pcc("POST", "/api/telemetry/emit", {
                "jobId": args["jobId"],
                "kernelId": KERNEL_ID,
                "event": args["event"],
                "data": args.get("data", {}),
            })
            return json.dumps(r, indent=2)

        else:
            return json.dumps({"error": f"Unknown tool: {name}"})

    except Exception as e:
        return json.dumps({"error": str(e)})


# ── System Prompt ───────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are the PCC OT-2 Agent running directly on an Opentrons OT-2 liquid handler robot.
Robot name: "falling-bush". Serial: falling-bush.
Pipettes: P20 Multi Gen2 (left), P1000 Single Gen2 (right).

You have direct control of this robot via tools that call localhost:31950 (the Opentrons HTTP API).
You are also connected to the Physical Capability Cloud (PCC) at capability.network.

## Your Role
- Execute liquid handling jobs submitted through PCC
- Report status and telemetry back to PCC
- Keep the robot safe (never run uncalibrated, check pipettes before use)
- Answer questions about the robot's state

## Protocol Writing Rules (Opentrons Protocol API v2)
When writing protocols:
- Always use `from opentrons import protocol_api`
- Metadata must include `apiLevel` (use "2.16" for OT-2)
- Load labware by API name (e.g. "opentrons_96_tiprack_20ul")
- Load pipettes by name (e.g. "p20_multi_gen2") on correct mount
- Always pick up tips before aspirate/dispense
- Always drop tips after use
- Use `protocol.home()` at the end

## Safety
- Never run a protocol without checking calibration first
- If deck calibration is missing, warn the operator
- If tip racks are not loaded, do not attempt to pick up tips
- Report ALL errors back to PCC immediately

## Job Execution Flow
1. Receive job details (protocol type, parameters)
2. Report status "running" to PCC
3. Check robot health and calibration
4. Upload/create the protocol
5. Create a run and start it
6. Monitor progress, emit telemetry
7. Report "completed" or "failed" to PCC
"""

# ── Agent Loop ──────────────────────────────────────────────────────────


def run_agent_turn(messages, tools=OT2_TOOLS):
    """Run one full agent turn — send to Claude, execute tools, repeat until done."""
    max_iterations = 20
    for i in range(max_iterations):
        log.info(f"  Turn {i+1}: sending {len(messages)} messages to Claude...")
        response = claude(messages, tools, SYSTEM_PROMPT)
        if response is None:
            log.error("  Claude API returned None, aborting turn")
            return messages

        # Extract text and tool_use blocks
        stop_reason = response.get("stop_reason", "end_turn")
        content = response.get("content", [])

        # Log any text output
        for block in content:
            if block.get("type") == "text":
                log.info(f"  Agent: {block['text'][:200]}")

        # Add assistant message
        messages.append({"role": "assistant", "content": content})

        # If no tool use, we're done
        if stop_reason != "tool_use":
            log.info(f"  Turn complete (stop_reason={stop_reason})")
            return messages

        # Execute tool calls
        tool_results = []
        for block in content:
            if block.get("type") == "tool_use":
                tool_name = block["name"]
                tool_input = block.get("input", {})
                tool_id = block["id"]
                log.info(f"  Executing tool: {tool_name}({json.dumps(tool_input)[:100]})")
                result = execute_tool(tool_name, tool_input)
                log.info(f"  Result: {result[:200]}")
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result,
                })

        messages.append({"role": "user", "content": tool_results})

    log.warning("  Max iterations reached")
    return messages


def poll_for_jobs():
    """Poll PCC for pending approved jobs."""
    s, r = pcc("GET", f"/api/operator/approvals?status=approved&kernelId={KERNEL_ID}")
    if s == 200 and isinstance(r, list) and len(r) > 0:
        return r
    return []


def handle_job(job):
    """Handle a single job from PCC."""
    job_id = job.get("id", "unknown")
    log.info(f"Processing job {job_id}: {json.dumps(job)[:200]}")

    # Build the user message from the job
    user_msg = f"""New job from PCC:
- Job ID: {job_id}
- Type: {job.get('capabilityType', 'liquid-handler')}
- Parameters: {json.dumps(job.get('parameters', {}), indent=2)}
- Agent: {job.get('agentId', 'unknown')}

Please execute this job. Start by checking robot health and calibration,
then create and run the appropriate protocol. Report status to PCC throughout."""

    messages = [{"role": "user", "content": user_msg}]
    run_agent_turn(messages)
    log.info(f"Job {job_id} processing complete")


def interactive_mode():
    """Interactive chat mode — talk to the agent directly."""
    log.info("Interactive mode. Type 'quit' to exit.")
    messages = []

    # Start with a health check
    messages.append({
        "role": "user",
        "content": "Hello! Check the robot's health and tell me what's connected.",
    })
    messages = run_agent_turn(messages)

    while True:
        try:
            user_input = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if user_input.lower() in ("quit", "exit", "q"):
            break
        if not user_input:
            continue

        messages.append({"role": "user", "content": user_input})
        messages = run_agent_turn(messages)


def daemon_mode():
    """Daemon mode — poll PCC for jobs and execute them."""
    log.info(f"Daemon mode. Polling {PCC_BASE} every {POLL_INTERVAL}s for kernel {KERNEL_ID}")

    # Register as online
    pcc("POST", f"/api/kernels/{KERNEL_ID}/heartbeat", {"status": "online"})

    while True:
        try:
            jobs = poll_for_jobs()
            if jobs:
                for job in jobs:
                    handle_job(job)
            else:
                log.debug("No pending jobs")
        except KeyboardInterrupt:
            log.info("Shutting down...")
            pcc("POST", f"/api/kernels/{KERNEL_ID}/heartbeat", {"status": "offline"})
            break
        except Exception as e:
            log.error(f"Error in poll loop: {e}")

        time.sleep(POLL_INTERVAL)


# ── Main ────────────────────────────────────────────────────────────────

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "interactive"

    # Only require auth for modes that use Claude
    if mode in ("interactive", "daemon") and not ANTHROPIC_API_KEY and not ANTHROPIC_OAUTH_TOKEN:
        print("ERROR: Set ANTHROPIC_API_KEY environment variable")
        print("  export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    # Verify OT-2 connection
    s, health = ot2("GET", "/health")
    if s != 200:
        print(f"ERROR: Cannot reach OT-2 at {OT2_BASE} (status={s})")
        sys.exit(1)

    robot_name = health.get("name", "unknown")
    api_ver = health.get("api_version", "unknown")
    log.info(f"Connected to OT-2 '{robot_name}' (API {api_ver})")

    if mode == "daemon":
        if not PCC_API_KEY:
            print("ERROR: Set PCC_API_KEY for daemon mode")
            sys.exit(1)
        daemon_mode()
    elif mode == "interactive":
        interactive_mode()
    elif mode == "health":
        print(json.dumps(health, indent=2))
    else:
        print(f"Usage: {sys.argv[0]} [interactive|daemon|health]")
        sys.exit(1)


if __name__ == "__main__":
    main()
