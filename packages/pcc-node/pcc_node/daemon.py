"""Main daemon loop -- executor + camera + heartbeat.

Combines all node subsystems into a single long-running process:
  - Polls PCC for pending jobs and executes them
  - Pushes camera frames periodically
  - Sends heartbeats to maintain "online" status
  - Handles graceful shutdown on SIGINT/SIGTERM
"""

import json
import logging
import os
import signal
import time

from .camera import push_camera_frame, detect_camera_device
from .config import NodeConfig
from .executor import create_adapter, poll_pending_jobs, execute_and_report
from .register import send_heartbeat

log = logging.getLogger("pcc-node.daemon")

# PID file for status checks
PID_FILE = os.path.expanduser("~/.pcc-node.pid")
STATE_FILE = os.path.expanduser("~/.pcc-node-state.json")


def _write_pid():
    """Write current PID to the PID file."""
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))


def _remove_pid():
    """Remove the PID file."""
    try:
        os.remove(PID_FILE)
    except OSError:
        pass


def _write_state(config, start_time, jobs_completed):
    """Write current state for the status command."""
    state = {
        "pid": os.getpid(),
        "kernel_id": config.kernel_id,
        "kernel_name": config.kernel_name,
        "pcc_base": config.pcc_base,
        "started_at": start_time,
        "jobs_completed": jobs_completed,
        "camera_device": config.camera_device,
        "last_update": time.time(),
    }
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except OSError:
        pass


def read_state():
    """Read the daemon state file. Returns dict or None."""
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def read_pid():
    """Read the PID from the PID file. Returns int or None."""
    try:
        with open(PID_FILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def is_running():
    """Check if a daemon is currently running.

    Returns (is_running: bool, pid: int | None).
    """
    pid = read_pid()
    if pid is None:
        return False, None

    # Check if process exists
    try:
        os.kill(pid, 0)  # signal 0 = existence check
        return True, pid
    except (OSError, ProcessLookupError):
        # Stale PID file
        _remove_pid()
        return False, None


def run_daemon(config):
    """Run the main daemon loop.

    Parameters
    ----------
    config : NodeConfig
        Fully populated node configuration (must have pcc_api_key set).
    """
    running = True

    def _shutdown(signum, frame):
        nonlocal running
        log.info(f"Received signal {signum}, shutting down...")
        running = False

    # Register signal handlers
    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    _write_pid()
    start_time = time.time()
    jobs_completed = 0

    # Build adapters from configured devices
    adapters = []
    for dev in config.devices:
        adapter = create_adapter(dev)
        if adapter:
            adapters.append(adapter)
            log.info(f"Adapter loaded: {adapter.device_type}")

    if not adapters:
        log.warning("No device adapters loaded -- will only poll and push camera")

    # Probe camera
    cam = detect_camera_device()
    if cam:
        log.info(f"Camera device: {cam}")
    elif config.camera_device:
        log.warning(f"Configured camera {config.camera_device} not detected")

    # Initial heartbeat
    send_heartbeat(config.pcc_base, config.pcc_api_key, config.kernel_id, "online")

    camera_counter = 0
    camera_cycles = max(1, config.camera_push_interval // max(1, config.poll_interval))
    heartbeat_counter = 0
    heartbeat_cycles = max(1, 60 // max(1, config.poll_interval))  # heartbeat every ~60s

    # Start UI server in background
    try:
        from .ui_server import start_ui_server
        start_ui_server(
            port=3200,
            background=True,
            pcc_base=config.pcc_base,
            pcc_api_key=config.pcc_api_key,
        )
        log.info("UI server: http://localhost:3200")
    except Exception as e:
        log.warning(f"UI server failed to start: {e}")

    log.info(
        f"Daemon running. Kernel={config.kernel_id}, "
        f"PCC={config.pcc_base}, poll={config.poll_interval}s"
    )

    while running:
        try:
            # 1. Poll for pending jobs
            calls = poll_pending_jobs(
                config.pcc_base, config.pcc_api_key, config.kernel_id
            )
            for call in calls:
                execute_and_report(
                    call, adapters, config.pcc_base, config.pcc_api_key
                )
                jobs_completed += 1

            # 2. Push camera frame periodically
            camera_counter += 1
            if camera_counter >= camera_cycles and cam:
                push_camera_frame(
                    config.pcc_base, config.pcc_api_key, config.kernel_id
                )
                camera_counter = 0

            # 3. Heartbeat periodically
            heartbeat_counter += 1
            if heartbeat_counter >= heartbeat_cycles:
                send_heartbeat(
                    config.pcc_base, config.pcc_api_key, config.kernel_id, "online"
                )
                heartbeat_counter = 0

            # Update state file
            _write_state(config, start_time, jobs_completed)

        except Exception as e:
            log.error(f"Loop error: {e}")

        # Sleep in short increments so we can respond to signals quickly
        sleep_end = time.time() + config.poll_interval
        while running and time.time() < sleep_end:
            time.sleep(0.5)

    # Clean shutdown
    log.info("Shutting down daemon...")
    send_heartbeat(config.pcc_base, config.pcc_api_key, config.kernel_id, "offline")
    _remove_pid()
    try:
        os.remove(STATE_FILE)
    except OSError:
        pass
    log.info(f"Daemon stopped. Jobs completed: {jobs_completed}")
