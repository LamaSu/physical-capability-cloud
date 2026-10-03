"""Main daemon loop -- real end-to-end PCC protocol.

Combines all node subsystems into a single long-running process:
  1. Load or generate Ed25519 keys
  2. Run network discovery
  3. Register kernel with PCC gateway (HTTP POST)
  4. Announce capabilities (signed)
  5. Start HTTP polling loop:
     - Poll /api/operator/jobs every N seconds
     - Execute each job via JobExecutor
     - Push evidence bundle back to gateway
     - Re-announce capabilities every 60s (heartbeat)
  6. Handle graceful shutdown on SIGINT/SIGTERM
"""

import json
import logging
import os
import signal
import time

from .camera import push_camera_frame, detect_camera_device
from .config import NodeConfig
from .crypto import load_or_create_keys
from .discovery import discover_network, device_to_adapter_config
from .job_executor import JobExecutor
from .register import register_kernel, announce_capabilities
from .ws_client import PCCGatewayClient

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


def _build_capabilities_from_devices(devices):
    """Build capability announcement list from device dicts.

    Maps device types / protocols to PCC capability slugs.
    """
    cap_map = {
        "opentrons": [{"type": "liquid-handler"}, {"type": "pipette-transfer"}],
        "octoprint": [{"type": "3d-print"}, {"type": "fdm-fabrication"}],
        "printer": [{"type": "document-printing"}],
        "ipp": [{"type": "document-printing"}],
        "camera": [{"type": "visual-inspection"}, {"type": "photo-evidence"}],
        "serial": [{"type": "serial-instrument"}],
        "modbus": [{"type": "plc-control"}],
        "generic": [{"type": "generic-http"}],
        "http": [{"type": "generic-http"}],
        "mdns": [{"type": "network-instrument"}],
    }

    capabilities = []
    seen_types = set()

    for dev in devices:
        protocol = dev.get("protocol") or dev.get("type") or "generic"
        caps = cap_map.get(protocol, [{"type": f"{protocol}-device"}])
        for cap in caps:
            cap_type = cap["type"]
            if cap_type not in seen_types:
                seen_types.add(cap_type)
                capabilities.append({
                    **cap,
                    "deviceId": dev.get("id") or dev.get("host") or dev.get("ip", ""),
                    "protocol": protocol,
                })

    return capabilities


def run_daemon(config: NodeConfig):
    """Run the main daemon loop with the real PCC protocol.

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

    # ------------------------------------------------------------------
    # 1. Load or generate Ed25519 keys
    # ------------------------------------------------------------------
    try:
        public_key, secret_key = load_or_create_keys()
        if not config.public_key:
            config.public_key = public_key
        log.info(f"Node keys loaded: {public_key[:16]}...")
    except Exception as e:
        log.warning(f"Could not load keys: {e}")
        secret_key = ""

    # ------------------------------------------------------------------
    # 2. Optional: run network discovery to find new devices
    # ------------------------------------------------------------------
    discovered_devices = []
    if not config.devices:
        log.info("No devices configured, scanning network...")
        try:
            found = discover_network(timeout=0.5)
            for nd in found:
                cfg = device_to_adapter_config(nd)
                if cfg:
                    discovered_devices.append(cfg)
                    log.info(f"Discovered: {nd.device_type} at {nd.ip}")
        except Exception as e:
            log.warning(f"Network discovery failed: {e}")

    # Merge discovered devices with configured devices
    all_devices = list(config.devices) + discovered_devices

    if all_devices:
        log.info(f"Total devices: {len(all_devices)}")
    else:
        log.warning("No devices found -- running in relay-only mode")

    # ------------------------------------------------------------------
    # 3. Register kernel with gateway
    # ------------------------------------------------------------------
    try:
        register_kernel(config.pcc_base, config.pcc_api_key, config)
        log.info(f"Kernel {config.kernel_id} registered")
    except Exception as e:
        log.warning(f"Kernel registration failed: {e}")

    # ------------------------------------------------------------------
    # 4. Build capabilities + announce
    # ------------------------------------------------------------------
    capabilities = _build_capabilities_from_devices(all_devices)

    try:
        announce_capabilities(
            config.pcc_base,
            config.pcc_api_key,
            config.kernel_id,
            all_devices,
            secret_key=secret_key,
        )
    except Exception as e:
        log.warning(f"Capability announcement failed: {e}")

    # ------------------------------------------------------------------
    # 5. Create gateway client + job executor
    # ------------------------------------------------------------------
    gateway_client = PCCGatewayClient(
        gateway_url=config.pcc_base,
        api_key=config.pcc_api_key,
        kernel_id=config.kernel_id,
        poll_interval=config.poll_interval,
    )

    job_executor = JobExecutor(devices=all_devices, gateway_client=gateway_client)

    # ------------------------------------------------------------------
    # 6. Probe camera
    # ------------------------------------------------------------------
    cam = detect_camera_device()
    if cam:
        log.info(f"Camera device: {cam}")
    elif config.camera_device:
        log.warning(f"Configured camera {config.camera_device} not detected")

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

    # ------------------------------------------------------------------
    # 7. Auto-diagnostics setup (opt-in)
    # ------------------------------------------------------------------
    last_diag_upload = 0.0
    diag_interval = config.diagnostics_interval_hours * 3600
    consecutive_errors = 0
    ERROR_THRESHOLD = 5  # send diagnostics after this many consecutive errors

    if config.diagnostics_mode != "off":
        log.info(
            f"Auto-diagnostics: mode={config.diagnostics_mode}, "
            f"interval={config.diagnostics_interval_hours}h"
        )

    # ------------------------------------------------------------------
    # 8. Main polling loop
    # ------------------------------------------------------------------
    last_announce = time.time()
    announce_interval = 60  # re-announce capabilities every 60s
    camera_counter = 0
    camera_cycles = max(1, config.camera_push_interval // max(1, config.poll_interval))

    log.info(
        f"Daemon running. Kernel={config.kernel_id}, "
        f"PCC={config.pcc_base}, poll={config.poll_interval}s"
    )

    # Send initial heartbeat
    gateway_client.send_heartbeat("online")

    while running:
        try:
            # Poll for queued jobs
            jobs = gateway_client.poll_for_jobs()

            for job in jobs:
                job_id = job.get("id", "?")
                log.info(f"Received job {job_id}")

                # Mark seen before execution to prevent duplicate runs
                gateway_client.mark_job_seen(job_id)

                try:
                    job_executor.execute(job)
                    jobs_completed += 1
                except Exception as e:
                    log.error(f"Job {job_id} execution error: {e}")

            # Push camera frame periodically
            camera_counter += 1
            if camera_counter >= camera_cycles and cam:
                try:
                    push_camera_frame(
                        config.pcc_base, config.pcc_api_key, config.kernel_id
                    )
                except Exception as e:
                    log.warning(f"Camera push failed: {e}")
                camera_counter = 0

            # Re-announce capabilities every 60s (heartbeat)
            if time.time() - last_announce > announce_interval:
                try:
                    gateway_client.announce_capabilities(capabilities)
                except Exception as e:
                    log.warning(f"Heartbeat announce failed: {e}")
                last_announce = time.time()

            # Update state file
            _write_state(config, start_time, jobs_completed)

            # Reset error counter on successful loop iteration
            consecutive_errors = 0

        except Exception as e:
            log.error(f"Loop error: {e}")
            consecutive_errors += 1

        # Auto-diagnostics (opt-in only)
        if config.diagnostics_mode != "off":
            should_send = False
            reason = ""

            if config.diagnostics_mode == "periodic":
                if time.time() - last_diag_upload > diag_interval:
                    should_send = True
                    reason = "periodic"

            if config.diagnostics_mode in ("errors", "periodic"):
                if consecutive_errors >= ERROR_THRESHOLD:
                    should_send = True
                    reason = f"{consecutive_errors} consecutive errors"

            if should_send:
                try:
                    from .diagnostics import (
                        collect_diagnostic_bundle,
                        upload_diagnostic_bundle,
                    )
                    log.info(f"Auto-diagnostics: sending bundle (reason: {reason})")
                    bundle = collect_diagnostic_bundle(
                        pcc_base=config.pcc_base,
                        max_log_lines=200,
                        include_device_health=False,
                    )
                    bundle["auto_reason"] = reason
                    result = upload_diagnostic_bundle(
                        bundle=bundle,
                        pcc_base=config.pcc_base,
                        api_key=config.pcc_api_key,
                        kernel_id=config.kernel_id,
                    )
                    if "error" not in result:
                        log.info(
                            f"Auto-diagnostics: uploaded {result.get('upload_id')} "
                            f"(code: {result.get('retrieval_code')})"
                        )
                        # Auto-create support thread with logs attached
                        from .http_util import pcc_request as _pr
                        _pr(
                            "POST", "/api/operator/support",
                            body={
                                "kernelId": config.kernel_id,
                                "kernelName": config.kernel_name,
                                "message": f"[auto] Diagnostic report: {reason}",
                                "retrievalCode": result.get("retrieval_code", ""),
                                "systemInfo": {
                                    "platform": bundle.get("system", {}).get("platform", ""),
                                    "daemonRunning": True,
                                },
                            },
                            base_url=config.pcc_base,
                            api_key=config.pcc_api_key,
                        )
                    else:
                        log.warning(f"Auto-diagnostics: upload failed: {result['error']}")
                    last_diag_upload = time.time()
                    consecutive_errors = 0  # reset after sending
                except Exception as diag_err:
                    log.warning(f"Auto-diagnostics: collection failed: {diag_err}")

        # Interruptible sleep
        sleep_end = time.time() + config.poll_interval
        while running and time.time() < sleep_end:
            time.sleep(0.25)

    # ------------------------------------------------------------------
    # Clean shutdown
    # ------------------------------------------------------------------
    log.info("Shutting down daemon...")
    try:
        gateway_client.send_heartbeat("offline")
    except Exception:
        pass
    _remove_pid()
    try:
        os.remove(STATE_FILE)
    except OSError:
        pass
    log.info(f"Daemon stopped. Jobs completed: {jobs_completed}")
