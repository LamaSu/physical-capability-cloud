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
import errno
import stat
import hashlib
import logging
import threading
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

# N4a guard. Without this module the agent cannot start (fail closed).
# UNSAFE_LOCAL_FLAG and local_base are re-exported for the guard tests.
from ot2_local_guard import (  # noqa: F401
    GUARD,
    UNSAFE_LOCAL_FLAG,
    allow_external,
    http as guarded_http,
    local_base,
    require_mode,
    require_robot,
    require_started,
    start_guard,
    start_interactive,
    upload_protocol,
)

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

# ── N4a start guard ─────────────────────────────────────────────────────
# This script runs whatever the PCC relay hands it, including a shell-command
# tool and arbitrary protocol uploads (an Opentrons protocol is Python code).
# The relay does not yet bind a call to an accepted, funded job with a committed
# protocol hash, so any holder of a PCC API key (self-service keys are free)
# could drive this robot. Until that is fixed (status board row N4b), every mode
# refuses to start unless it is run explicitly as an unsafe, local-only tool, and
# every request goes through the guard's one transport to the addresses it
# checked. The rules live in ot2_local_guard.py; see scripts/README-ot2-executor.md.


# ── HTTP helpers (stdlib only) ──────────────────────────────────────────

USER_AGENT = "PCC-OT2-Agent/1.0 (falling-bush)"
ANTHROPIC_API = "https://api.anthropic.com"


def http(method, url, body=None, headers=None, timeout=30):
    """Every request goes through the guard's one transport (ot2_local_guard.request):
    only after an accepted start, only to the bases it accepted (and, once main()
    allows it, the Anthropic API), no proxies, no redirects, verified TLS."""
    return guarded_http(method, url, body, headers, timeout, user_agent=USER_AGENT)


def ot2(method, path, body=None):
    """Call the OT-2 robot API (the local OT2_BASE the guard accepted)."""
    url = f"{require_robot('ot2()')}{path}"
    headers = {"opentrons-version": OT2_API_VERSION}
    return http(method, url, body, headers)


def pcc(method, path, body=None):
    """Call the PCC gateway (the local PCC_BASE start_guard() accepted)."""
    url = f"{require_started('pcc()')}{path}"
    headers = {"Authorization": f"Bearer {PCC_API_KEY}"}
    return http(method, url, body, headers)


def claude(messages, tools, system_prompt):
    """Call the Claude Messages API with tools. Supports API key or OAuth token."""
    url = f"{ANTHROPIC_API}/v1/messages"
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
        "name": "ot2_shell",
        "description": "Run a shell command on the OT-2. Use for checking hardware (cameras, USB devices), reading files, installing Python packages, or starting services. The OT-2 runs Linux (BusyBox) with Python 3.10.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run (e.g. 'ls /dev/video*', 'pip3 install mjpg-streamer', 'cat /etc/os-release')"},
                "timeout": {"type": "integer", "description": "Timeout in seconds (default 30)"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "ot2_self_update",
        "description": "Download and install the latest agent code from PCC. The agent restarts itself with the new code. Use when told to update or when a new version is available.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "URL to download the new agent from (default: PCC gateway)"},
            },
            "required": [],
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
    return _execute_tool(name, args)


def _execute_tool(name, args):
    """Execute a tool call and return the result as a string.

    N4a: the start guard is HERE, on the actual dispatcher, not only on the
    public execute_tool() wrapper. An imported caller that reaches this
    function directly (e.g. `_execute_tool("ot2_shell", ...)`) must still pass
    require_mode() first, so the shell tool below can never run on import alone
    or without an accepted --unsafe-local start.
    """
    require_mode("_execute_tool()")
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
            # Multipart upload through the guard's transport: no subprocess, no temp file.
            s, r = upload_protocol(
                OT2_API_VERSION, args.get("filename", "protocol.py"), args["content"], user_agent=USER_AGENT,
            )
            return json.dumps(r, indent=2)

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

        elif name == "ot2_self_update":
            # N4a: disabled. It downloaded code from any URL (following redirects)
            # and installed it over this agent. N4b-robot removes the tool.
            return json.dumps({
                "updated": False,
                "error": "ot2_self_update is disabled (N4a): it installed code fetched from any URL.",
            })

        elif name == "ot2_shell":
            import subprocess
            cmd = args["command"]
            timeout = args.get("timeout", 30)
            try:
                result = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=timeout,
                )
                output = result.stdout + result.stderr
                return json.dumps({"exit_code": result.returncode, "output": output[:4000]})
            except subprocess.TimeoutExpired:
                return json.dumps({"error": "Command timed out", "timeout": timeout})

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


# ── Each approval runs once ─────────────────────────────────────────────
# GET /api/operator/approvals?status=approved lists every approval whose status is
# "approved", and no gateway route moves one out of that status, so the daemon sees the
# same record on every poll. Unmarked, it would send the job to the agent again every
# POLL_INTERVAL seconds, and the robot could run the same protocol again and again.
#
# claim_job_once() is the mark: one file per approval, created atomically BEFORE the job
# is dispatched. That is at-most-once, not exactly-once. A crash or power cut after the
# mark loses that run instead of repeating it, and the operator re-approves. Whatever
# keeps the mark from being written fails closed: the job is not run.
# See "Each approval runs once" in scripts/README-ot2-executor.md.

STATE_DIR_DEFAULT = "~/.pcc/ot2-agent/handled"  # used when OT2_AGENT_STATE_DIR is unset
MARKER_TEXT_LIMIT = 512  # characters of an id kept inside a marker; its file name is a hash

_logged_once = set()
_logged_once_lock = threading.Lock()


def _first_time(token):
    """True the first time this process sees `token`: a message that would otherwise
    repeat on every poll is logged once."""
    with _logged_once_lock:
        if token in _logged_once:
            return False
        _logged_once.add(token)
        return True


def handled_dir():
    """The directory that holds one marker per handled approval: OT2_AGENT_STATE_DIR, else
    ~/.pcc/ot2-agent/handled. Raises OSError when it cannot be resolved (no home directory)."""
    raw = os.environ.get("OT2_AGENT_STATE_DIR", "").strip() or STATE_DIR_DEFAULT
    path = os.path.expanduser(raw)
    if path.startswith("~"):
        raise OSError(f"cannot resolve {raw!r} (no home directory); set OT2_AGENT_STATE_DIR to an absolute path")
    return os.path.abspath(path)


def _job_key(record):
    """The identity an approval runs once under: its `id`, else its `jobId`.

    None when there is no usable one: the record is not a dict, `id` and `jobId` are both
    missing or empty, or `id` is present but is not a string or an integer (it does not then
    fall back to `jobId`). Such a record is refused. It is never given a shared placeholder
    such as "unknown", under which unrelated records would collide."""
    if not isinstance(record, dict):
        return None
    for field in ("id", "jobId"):
        value = record.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            continue
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            return None
        return str(value)
    return None


def _recorded(value):
    """A job id as bounded text for a marker, or None when it is not a plain id."""
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    return str(value)[:MARKER_TEXT_LIMIT]


def _fsync_dir(directory):
    """Flush a directory's entries to stable storage, so that a file or directory just created
    in it survives a power cut. Raises OSError when that can't be done. (On Windows a directory
    can't be opened like this, so it always raises there.) The caller decides whether that is
    fatal: see claim_job_once's require_durable."""
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _makedirs_durable(path):
    """Create `path` and any missing ancestors (mode 0o700), then fsync each new directory's
    parent so the new entries survive a power cut.

    Every directory is created first, so `path` exists even when a sync then fails. A creation
    failure raises at once. A sync failure is raised after every sync was attempted, so the
    caller can still place (and keep) its mark while refusing to rely on it."""
    missing = []
    current = path
    while not os.path.isdir(current):
        missing.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    created = []
    for directory in reversed(missing):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            if not os.path.isdir(directory):
                raise
        created.append(directory)
    first_error = None
    for directory in created:
        try:
            _fsync_dir(os.path.dirname(directory) or os.curdir)
        except OSError as err:
            first_error = first_error or err
    if first_error is not None:
        raise first_error


def _sync_dir_chain(path):
    """fsync `path` and every directory above it, up to the filesystem root.

    fsyncing a directory persists the entries of its children, so this makes every component
    of `path` (and a mark inside it) reach stable storage, including directories an earlier,
    failed attempt created and never synced. Every directory is attempted; the first failure is
    raised at the end.

    It walks the path as written, so a symlink on it leaves the directories the link points into
    unsynced: this is the best-effort sync for consume "required". With OFF, claim_job_once walks
    the path with _open_dir_chain instead (#499 r3)."""
    current = os.path.abspath(path)
    first_error = None
    while True:
        try:
            _fsync_dir(current)
        except OSError as err:
            first_error = first_error or err
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    if first_error is not None:
        raise first_error


def _open_dir_chain(path):
    """Open every directory on the absolute path `path`, from the root down, creating any that is
    missing (mode 0o700). Returns their fds, root first; the caller closes them.

    Each directory is opened from the fd of the one above it, with O_NOFOLLOW, so the fds are
    exactly the directories that a file created from the last one lives in: nothing renamed or
    swapped while this runs can redirect the walk. A symlink anywhere on the path raises
    OSError(ELOOP); anything else that is not a directory raises too. Raises OSError, or
    NotImplementedError where a platform can't open relative to a directory fd."""
    nofollow = getattr(os, "O_NOFOLLOW", None)
    directory_only = getattr(os, "O_DIRECTORY", None)
    if nofollow is None or directory_only is None:
        raise OSError("this platform cannot walk a directory path without following symlinks")
    flags = os.O_RDONLY | directory_only | nofollow
    fds = [os.open(os.sep, os.O_RDONLY | directory_only)]

    def open_child(name, walked):
        try:
            return os.open(name, flags, dir_fd=fds[-1])
        except FileNotFoundError:
            raise
        except OSError as err:
            try:
                is_link = stat.S_ISLNK(os.stat(name, dir_fd=fds[-1], follow_symlinks=False).st_mode)
            except OSError:
                is_link = False
            if is_link:
                raise OSError(errno.ELOOP, "{} is a symlink".format(walked)) from err
            raise

    try:
        walked = os.sep
        for name in [part for part in path.split(os.sep) if part]:
            walked = os.path.join(walked, name)
            try:
                fds.append(open_child(name, walked))
                continue
            except FileNotFoundError:
                pass
            try:
                os.mkdir(name, 0o700, dir_fd=fds[-1])
            except FileExistsError:
                pass  # made by someone else since; open_child decides what it is
            fds.append(open_child(name, walked))
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise
    return fds


def _fsync_fds(fds):
    """fsync every directory fd, the deepest first. Every one is attempted; the first failure is
    raised at the end."""
    first_error = None
    for fd in reversed(fds):
        try:
            os.fsync(fd)
        except OSError as err:
            first_error = first_error or err
    if first_error is not None:
        raise first_error


def claim_job_once(record, require_durable=True):
    """Mark an approved job as handled and return True: it may go to the agent, this once.

    Returns False when it must not run: it is already marked (by this or an earlier process),
    it has no usable id (see _job_key), or the mark could not be written (fail closed).

    The mark is one file in handled_dir(), named by the SHA-256 hex of the key, so no id,
    however hostile, can name a path. O_CREAT | O_EXCL makes the claim atomic: of any number of
    threads or processes claiming one key, exactly one gets True. No fcntl or msvcrt.

    Durability. The mark only survives a power cut if its directory entry, and the entry of
    every directory on the state path, reach stable storage. So after the marker is written,
    every directory from the state directory up to the root is fsynced, on every claim. That
    includes directories an earlier, failed attempt created and never synced. When that can't
    be done, the mark is kept (it still blocks this machine while it exists). With
    require_durable (the default, and what OT2_AGENT_SERVER_CONSUME=off uses, where the mark
    is the ONLY record), the approval is refused: after a power cut the mark could be gone,
    and the approval run again. Without it (consume "required"), the gateway's consume is the
    durable record, since a consumed approval is never listed again, so a mark that may not be
    durable is logged and allowed.

    With require_durable the state path is walked one directory at a time without following
    symlinks (_open_dir_chain), the marker is created from the last directory's fd, and exactly
    those directories are synced: the ones the marker really lives in. A symlink on the path
    would put the marker in directories the path doesn't name, which a sync of the path would
    miss (#499 r3), so it is refused, and the error names the path to use instead."""
    key = _job_key(record)
    if key is None:
        log.error("Refusing an approval with no usable id or jobId; it cannot be marked handled, "
                  "so it is NOT run: %.200r", record)
        return False
    digest = hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest()
    payload = json.dumps({
        "key": key[:MARKER_TEXT_LIMIT],
        "jobId": _recorded(record.get("jobId")),
        "claimedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }).encode("ascii")  # json.dumps escapes everything outside ASCII

    durability_error = None
    try:
        directory = handled_dir()
    except OSError as err:
        log.error("Cannot use the handled-job directory (%s), so approval %.80r is NOT run. "
                  "Fix it (OT2_AGENT_STATE_DIR) and the approval is picked up again.", err, key)
        return False
    chain = []
    if require_durable:
        try:
            chain = _open_dir_chain(directory)
        except (OSError, NotImplementedError) as err:
            if getattr(err, "errno", None) == errno.ELOOP:
                log.error("The handled-job directory %s has a symlink on its path (%s), so approval %.80r "
                          "is NOT run: with OT2_AGENT_SERVER_CONSUME=off the mark is the only record, and a "
                          "mark behind a symlink can't be made durable. Set OT2_AGENT_STATE_DIR to a path "
                          "without symlinks (this one resolves to %s) and the approval is picked up again.",
                          directory, err.strerror, key, os.path.realpath(directory))
            else:
                log.error("Cannot use the handled-job directory (%s), so approval %.80r is NOT run. "
                          "Fix it (OT2_AGENT_STATE_DIR) and the approval is picked up again.", err, key)
            return False
    else:
        try:
            _makedirs_durable(directory)
        except OSError as err:
            if not os.path.isdir(directory):
                log.error("Cannot use the handled-job directory (%s), so approval %.80r is NOT run. "
                          "Fix it (OT2_AGENT_STATE_DIR) and the approval is picked up again.", err, key)
                return False
            durability_error = err  # the directory exists, but its entry may not survive a power cut
    marker = os.path.join(directory, digest)
    try:
        try:
            if chain:
                fd = os.open(digest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=chain[-1])
            else:
                fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if _first_time(("handled", digest)):
                log.info("Approval %.80r was already handled (marker %s); not running it again", key, marker)
            return False
        except OSError as err:
            log.error("Cannot mark approval %.80r handled in %s (%s), so it is NOT run. "
                      "Fix the directory and the approval is picked up again.", key, directory, err)
            return False

        # The marker now exists, so this approval never runs again, whatever fails from here on:
        # the cost is a lost run, never a repeated one.
        try:
            with os.fdopen(fd, "wb") as marker_file:
                marker_file.write(payload)
                marker_file.flush()
                os.fsync(marker_file.fileno())
        except OSError as err:
            log.error("Marked approval %.80r handled but could not finish writing %s (%s), so it is NOT "
                      "run, and it will not run again unless it is re-approved or the marker is deleted.",
                      key, marker, err)
            return False
        # The whole state path, every time: an earlier failed attempt may have created the chain
        # without syncing it, and a mark is only as durable as every entry above it (#499 r2).
        # With OFF, exactly the directories walked to create it (#499 r3).
        try:
            if chain:
                _fsync_fds(chain)
            else:
                _sync_dir_chain(directory)
        except OSError as err:
            durability_error = durability_error or err
    finally:
        for open_fd in chain:
            os.close(open_fd)
    if durability_error is not None:
        if require_durable:
            log.error("Marked approval %.80r handled but could not make the mark durable (%s), so it "
                      "is NOT run: after a power cut the mark could be gone and the approval run again. "
                      "The mark is kept; fix the state directory (OT2_AGENT_STATE_DIR) and approve the "
                      "job again.", key, durability_error)
            return False
        if _first_time(("not-durable", directory)):
            log.warning("Handled-job marks in %s cannot be made durable (%s). The gateway's consume is "
                        "the durable record in this mode, so jobs still run; with "
                        "OT2_AGENT_SERVER_CONSUME=off they would not.", directory, durability_error)
    return True


def release_job_claim(record):
    """Remove the mark claim_job_once(record) made, so a later poll may claim the approval again.

    Only for an approval the gateway did NOT consume (consume_on_gateway() said "retry"). From
    then on the gateway decides whether it may still run: its approved listing never shows a
    consumed approval again. If the mark cannot be removed, the approval stays blocked on this
    machine, which is the safe direction."""
    key = _job_key(record)
    if key is None:
        return
    digest = hashlib.sha256(key.encode("utf-8", "surrogatepass")).hexdigest()
    try:
        os.remove(os.path.join(handled_dir(), digest))
    except FileNotFoundError:
        pass
    except OSError as err:
        log.error("Could not release the mark for approval %.80r (%s); it is not tried again until "
                  "its marker is deleted.", key, err)


# ── The gateway consumes each approval once ─────────────────────────────
# The mark above stops THIS machine (this state directory) running an approval twice. It cannot
# stop another machine from running the same approval. The gateway's consume route,
# POST /api/operator/approvals/:id/consume (gateway WP-C, #445), is a compare-and-set on the
# approval itself, approved -> consumed: it answers 200 to exactly one caller and 409 to every
# other, and the approved listing never shows a consumed approval again. With the default
# OT2_AGENT_SERVER_CONSUME=required, a job reaches the agent only when this process holds the mark
# AND the gateway consumed the approval for it:
#   - 200 {"consumed": true}: it runs.
#   - any 409 (approval_not_consumable: another agent has it, or it is no longer approved;
#     kernel_emergency_stopped: nothing was consumed, and the approval does not start on its own
#     once the stop is cleared): it does not run, and the mark stays.
#   - anything else (401, 403, a 404 from a gateway without the route, 5xx, an answer without
#     "consumed": true, a transport error): it does not run. The gateway did not consume it for
#     anyone, or consumed it for this call whose answer was lost (then it is never listed again),
#     so the mark is released and a later poll asks again.
# OT2_AGENT_SERVER_CONSUME=off skips the gateway, for one that predates the route: the mark alone
# then protects, on this machine only, and the daemon warns at start. Any other value is logged
# and treated as "required".

SERVER_CONSUME_ENV = "OT2_AGENT_SERVER_CONSUME"


def server_consume_mode():
    """"required" (the default) or "off". Any other value is logged and treated as "required"."""
    raw = os.environ.get(SERVER_CONSUME_ENV, "")
    value = raw.strip().lower() or "required"
    if value in ("required", "off"):
        return value
    if _first_time(("consume-mode", raw)):
        log.error("%s=%r is neither 'required' nor 'off'; treating it as 'required'",
                  SERVER_CONSUME_ENV, raw)
    return "required"


def consume_on_gateway(record):
    """Ask the gateway to consume this approval. Returns "consumed", "refused" or "retry".

    "consumed" only for HTTP 200 with {"consumed": true}: the only answer that lets the job run.
    "refused" for any 409, and for a record without a usable approval `id` (it can never be
    consumed). "retry" for every other answer, a transport error included."""
    approval_id = record.get("id") if isinstance(record, dict) else None
    if isinstance(approval_id, bool) or not isinstance(approval_id, (str, int)) or not str(approval_id).strip():
        if _first_time(("consume-no-id", _job_key(record))):
            log.error("Approval %.200r has no approval id the gateway can consume, so it is NOT run",
                      record)
        return "refused"
    approval_id = str(approval_id)
    try:
        status, body = pcc("POST", f"/api/operator/approvals/{quote(approval_id, safe='')}/consume", {})
    except Exception as err:  # a transport failure: the gateway may or may not have seen it
        if _first_time(("consume-error", approval_id, type(err).__name__)):
            log.error("Could not ask the gateway to consume approval %.80r (%s); it is NOT run, and "
                      "a later poll asks again", approval_id, err)
        return "retry"
    error = body.get("error") if isinstance(body, dict) else None
    if status == 200 and isinstance(body, dict) and body.get("consumed") is True:
        return "consumed"
    if status == 409:
        if error == "kernel_emergency_stopped":
            log.warning("Approval %.80r is NOT run: the kernel's emergency stop is engaged. It does "
                        "not start on its own when the stop is cleared; approve it again to run it.",
                        approval_id)
        elif _first_time(("consume-409", approval_id)):
            log.info("The gateway did not consume approval %.80r for this agent (%s); not running it",
                     approval_id, error or "conflict")
        return "refused"
    if _first_time(("consume-status", approval_id, status)):
        log.error("The gateway did not consume approval %.80r (HTTP %s%s); it is NOT run, and a later "
                  "poll asks again. A gateway without POST /api/operator/approvals/:id/consume answers "
                  "404: deploy gateway WP-C (#445), or set %s=off knowingly.",
                  approval_id, status, f", {error}" if error else "", SERVER_CONSUME_ENV)
    return "retry"


def poll_for_jobs():
    """Poll PCC for pending approved jobs."""
    s, r = pcc("GET", f"/api/operator/approvals?status=approved&kernelId={KERNEL_ID}")
    if s != 200:
        return []
    # Gateway returns {"approvals": [...]} or a bare list
    jobs = r.get("approvals", r) if isinstance(r, dict) else r
    if isinstance(jobs, list) and len(jobs) > 0:
        return jobs
    return []


def handle_job(job):
    """Send a single approved job from PCC to the agent.

    Nothing here stops it running twice: the caller must have won claim_job_once(job)."""
    job_id = job.get("jobId", job.get("id", "unknown"))
    summary = job.get("jobSummary", {})
    params = summary.get("parameters", {}) if isinstance(summary, dict) else {}
    cap_type = summary.get("capabilityType", job.get("capabilityType", "liquid-handler"))
    agent = job.get("submittedBy", job.get("agentId", "unknown"))
    task = params.get("task", json.dumps(params))
    log.info(f"Processing job {job_id}: {task[:200]}")

    # Build the user message from the job
    user_msg = f"""New job from PCC:
- Job ID: {job_id}
- Type: {cap_type}
- Task: {task}
- Agent: {agent}

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


def poll_chat():
    """Poll PCC for pending chat messages."""
    s, r = pcc("GET", f"/api/ot2/chat/pending?kernelId={KERNEL_ID}")
    if s != 200:
        return []
    messages = r.get("messages", r) if isinstance(r, dict) else r
    return messages if isinstance(messages, list) else []


def handle_chat_message(msg):
    """Handle a chat message from a user via PCC."""
    msg_id = msg.get("id", "unknown")
    content = msg.get("content", "")
    log.info(f"Chat message {msg_id}: {content[:200]}")

    messages = [{"role": "user", "content": content}]
    messages = run_agent_turn(messages)

    # Extract the last assistant text response
    response_text = ""
    for m in reversed(messages):
        if m.get("role") == "assistant":
            for block in (m.get("content", []) if isinstance(m.get("content"), list) else []):
                if isinstance(block, dict) and block.get("type") == "text":
                    response_text = block["text"]
                    break
            if isinstance(m.get("content"), str):
                response_text = m["content"]
            if response_text:
                break

    # Post response back to PCC
    pcc("POST", "/api/ot2/chat/respond", {
        "messageId": msg_id,
        "response": response_text or "(no text response)",
    })
    log.info(f"Chat response sent for {msg_id}")


def push_camera_frame():
    """Capture a frame from the camera and push to PCC."""
    try:
        import subprocess
        r = subprocess.run(
            ["dd", "if=/dev/video0", "bs=512", "count=200"],
            capture_output=True, timeout=5,
        )
        data = r.stdout
        start = data.find(b"\xff\xd8")
        end = data.find(b"\xff\xd9", start)
        if start >= 0 and end >= 0:
            import base64
            frame_b64 = base64.b64encode(data[start:end + 2]).decode("ascii")
            pcc("POST", "/api/ot2/camera/frame", {
                "kernelId": KERNEL_ID,
                "frame": frame_b64,
            })
            log.debug("Camera frame pushed to PCC")
    except Exception as e:
        log.debug(f"Camera capture failed: {e}")


def poll_once():
    """One pass of the daemon loop: run newly approved jobs, then answer pending chat.

    Returns (jobs, chat_msgs) as polled. An approval is sent to the agent only after it is
    claimed on this machine (claim_job_once) and, unless OT2_AGENT_SERVER_CONSUME=off, consumed
    on the gateway (consume_on_gateway). A claim the gateway did not consume is released, so a
    later poll asks again; any 409 keeps it, and the approval does not run here."""
    jobs = poll_for_jobs()
    consume = server_consume_mode() == "required"
    for job in jobs:
        # With consume OFF the local mark is the only record, so it must be durable.
        if not claim_job_once(job, require_durable=not consume):
            continue
        if consume:
            outcome = consume_on_gateway(job)
            if outcome == "retry":
                release_job_claim(job)
            if outcome != "consumed":
                continue
        handle_job(job)

    chat_msgs = poll_chat()
    for msg in chat_msgs:
        handle_chat_message(msg)

    return jobs, chat_msgs


def daemon_mode():
    """Daemon mode: poll PCC for jobs and chat, push camera frames.

    Refuses (exit 2) unless start_guard() authorised this process.
    """
    pcc_base = require_started("daemon_mode()")
    require_robot("daemon_mode()")
    if server_consume_mode() == "off":
        log.warning("%s=off: each approval is marked handled on this machine only. Another machine "
                    "with the same key could run the same approval; cross-machine at-most-once is "
                    "NOT enforced.", SERVER_CONSUME_ENV)
    log.info(f"Daemon mode. Polling {pcc_base} every {POLL_INTERVAL}s for kernel {KERNEL_ID}")

    # Register as online
    pcc("POST", f"/api/kernels/{KERNEL_ID}/heartbeat", {"status": "online"})

    camera_counter = 0
    CAMERA_INTERVAL = 5  # push camera every N poll cycles

    while True:
        try:
            # Poll for approved jobs (each runs at most once) and chat messages
            jobs, chat_msgs = poll_once()

            # Push camera frame periodically
            camera_counter += 1
            if camera_counter >= CAMERA_INTERVAL:
                push_camera_frame()
                camera_counter = 0

            if not jobs and not chat_msgs:
                log.debug("No pending jobs or messages")
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
    if mode not in ("interactive", "daemon", "health"):
        print(f"Usage: {sys.argv[0]} [interactive|daemon|health] {UNSAFE_LOCAL_FLAG}")
        sys.exit(1)

    # N4a: every mode drives this robot, and interactive and daemon give an LLM a
    # shell on it, so every mode needs --unsafe-local and local addresses. Daemon
    # mode also polls PCC, so it needs a local PCC_BASE too.
    if mode == "daemon":
        refusal = start_guard(sys.argv[2:], PCC_BASE, "ot2-agent.py daemon", ot2_base=OT2_BASE)
    else:
        refusal = start_interactive(sys.argv[2:], OT2_BASE, f"ot2-agent.py {mode}")
    if refusal:
        print(refusal, file=sys.stderr)
        sys.exit(2)
    if mode in ("interactive", "daemon"):
        allow_external(ANTHROPIC_API)  # the Claude API, the one non-local destination
        log.warning(
            "UNSAFE LOCAL MODE: %s drives an LLM with a shell on this robot (status board row N4b).",
            f"jobs and chat relayed by {GUARD.pcc_base}" if mode == "daemon" else "the local terminal",
        )

    # Only require auth for modes that use Claude
    if mode in ("interactive", "daemon") and not ANTHROPIC_API_KEY and not ANTHROPIC_OAUTH_TOKEN:
        print("ERROR: Set ANTHROPIC_API_KEY environment variable")
        print("  export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    # Verify OT-2 connection
    s, health = ot2("GET", "/health")
    if s != 200:
        print(f"ERROR: Cannot reach OT-2 at {GUARD.ot2_base} (status={s})")
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


if __name__ == "__main__":
    main()
