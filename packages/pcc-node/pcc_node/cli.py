"""Click CLI for pcc-node.

Commands:
  pcc-node start   -- Detect, configure, register, and run the daemon
  pcc-node detect  -- Just detect hardware
  pcc-node status  -- Check if the daemon is running
  pcc-node config  -- Interactive configuration
  pcc-node ui      -- Dynamic UI server (serve, open, list, submissions)
"""

import json
import logging
import os
import sys
import time
from datetime import datetime

import click

from . import __version__
from .config import NodeConfig, generate_config, save_config, load_config
from .crypto import load_or_create_keys
from .daemon import run_daemon, is_running, read_state
from .detect import detect_all
from .discovery import (
    discover_network,
    device_to_adapter_config,
    format_discovery_report,
    DiscoveredDevice,
)
from .register import (
    provision_api_key,
    register_kernel,
    announce_capabilities,
    register_signing_key,
)
from .log_capture import LogSigningRefused


def _setup_logging(verbose):
    level = logging.DEBUG if verbose else logging.INFO
    fmt = "%(asctime)s [%(levelname)s] %(message)s"
    datefmt = "%H:%M:%S"

    # Always log to console
    logging.basicConfig(level=level, format=fmt, datefmt=datefmt)

    # Also log to file for diagnostic collection
    log_dir = os.path.expanduser("~/.pcc-node/logs")
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "pcc-node.log")
    try:
        from logging.handlers import RotatingFileHandler
        fh = RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=3)
        fh.setLevel(level)
        fh.setFormatter(logging.Formatter(fmt, datefmt=datefmt))
        logging.getLogger().addHandler(fh)
    except Exception:
        pass  # file logging is best-effort


DIAG_ACK_PATH = os.path.expanduser("~/.pcc-node/diagnostics-acknowledged")


def _maybe_prompt_diagnostics(config):
    """First-run banner: explain auto-diagnostics and let operator opt in/out.

    Shown once per machine (sentinel at ~/.pcc-node/diagnostics-acknowledged).
    Default is "errors" so the PCC team gets a crash report when things break;
    operators can say no here or run `pcc-node feedback off` later.
    """
    if os.path.exists(DIAG_ACK_PATH):
        return  # already acknowledged, don't nag

    click.echo("")
    click.echo("─" * 64)
    click.echo("  Auto-diagnostics (first-run setup)")
    click.echo("─" * 64)
    click.echo("")
    click.echo("  When your node hits 5+ errors in a row, pcc-node can")
    click.echo("  automatically send an encrypted diagnostic bundle to the PCC")
    click.echo("  team so we can investigate without bothering you.")
    click.echo("")
    click.echo("  What's in the bundle (encrypted, secrets redacted):")
    click.echo("    • OS, Python version, CPU, memory")
    click.echo("    • Node uptime, jobs completed, daemon status")
    click.echo("    • Config with API keys replaced by ***")
    click.echo("    • Last 200 log lines")
    click.echo("    • Gateway connectivity result")
    click.echo("")
    click.echo("  The bundle is encrypted client-side. The retrieval code is")
    click.echo("  attached to an auto-created support thread so our team can")
    click.echo("  decrypt and help.  Change any time with `pcc-node feedback off`.")
    click.echo("")

    choice = click.prompt(
        "  Enable auto-diagnostics?  [Y]es errors-only / [p]eriodic / [n]o",
        default="y",
        show_default=False,
    ).strip().lower()

    if choice in ("n", "no", "off"):
        config.diagnostics_mode = "off"
        click.echo("  → Disabled. Run `pcc-node feedback on` later to enable.")
    elif choice in ("p", "periodic"):
        config.diagnostics_mode = "periodic"
        click.echo(f"  → Periodic mode: every {config.diagnostics_interval_hours}h.")
    else:
        config.diagnostics_mode = "errors"
        click.echo("  → Errors-only mode: auto-send on 5+ consecutive errors.")

    click.echo("")

    try:
        os.makedirs(os.path.dirname(DIAG_ACK_PATH), exist_ok=True)
        with open(DIAG_ACK_PATH, "w") as f:
            f.write(f"mode={config.diagnostics_mode}\n")
    except OSError:
        pass


def _format_device(dev):
    """Format a device dict for display."""
    dtype = dev.get("type", "unknown")
    if dtype == "camera":
        name = dev.get("name", "Unknown Camera")
        fmts = ", ".join(dev.get("formats", [])) or "unknown format"
        path = dev.get("path", "")
        return f"Camera: {name} ({fmts}, {path})"
    elif dtype == "opentrons":
        name = dev.get("name", "OT-2")
        url = dev.get("url", "")
        api = dev.get("api_version", "")
        return f"Robot: Opentrons OT-2 \"{name}\" ({url}, API v{api})"
    elif dtype == "octoprint":
        server = dev.get("server", "")
        url = dev.get("url", "")
        return f"3D Printer: OctoPrint {server} ({url})"
    elif dtype == "serial":
        path = dev.get("path", "")
        return f"Serial: {path} (unknown device)"
    elif dtype == "mdns":
        name = dev.get("name", "")
        addrs = dev.get("addresses", [])
        port = dev.get("port", "")
        return f"Network: {name} ({', '.join(addrs)}:{port})"
    else:
        return f"{dtype}: {json.dumps(dev)}"


@click.group()
@click.version_option(version=__version__, prog_name="pcc-node")
@click.option("-v", "--verbose", is_flag=True, help="Enable debug logging")
@click.pass_context
def main(ctx, verbose):
    """Physical Capability Cloud node -- join the network with any equipment."""
    ctx.ensure_object(dict)
    ctx.obj["verbose"] = verbose
    _setup_logging(verbose)


@main.command()
@click.option(
    "--config-file", "-c",
    default="./pcc-node.json",
    help="Path to config file (default: ./pcc-node.json)",
)
@click.option(
    "--pcc-base",
    envvar="PCC_BASE",
    default="https://capability.network",
    help="PCC gateway URL",
)
@click.option(
    "--api-key",
    envvar="PCC_API_KEY",
    default="",
    help="PCC API key (or set PCC_API_KEY env var)",
)
@click.option(
    "--kernel-id",
    envvar="KERNEL_ID",
    default="",
    help="Override kernel ID",
)
@click.option(
    "--discover",
    is_flag=True,
    default=False,
    help="Scan the local network for devices before starting",
)
@click.option(
    "--subnet",
    default="",
    help="Subnet to scan with --discover (default: auto-detect)",
)
def start(config_file, pcc_base, api_key, kernel_id, discover, subnet):
    """Detect hardware, register on PCC, and start the node daemon."""
    log = logging.getLogger("pcc-node")

    # Check if already running
    running, pid = is_running()
    if running:
        click.echo(f"Node is already running (PID {pid}). Use 'pcc-node status'.")
        sys.exit(1)

    # Try loading existing config
    config = None
    if os.path.exists(os.path.abspath(config_file)):
        try:
            config = load_config(config_file)
            click.echo(f"Loaded config from {os.path.abspath(config_file)}")
        except Exception as e:
            log.warning(f"Failed to load config: {e}")

    # Network discovery (optional)
    network_devices = []
    if discover:
        click.echo("Scanning network for devices...")
        found = discover_network(subnet=subnet if subnet else None)
        for nd in found:
            cfg = device_to_adapter_config(nd)
            if cfg:
                hostname_str = f" ({nd.hostname})" if nd.hostname else ""
                click.echo(
                    f"  Network: {nd.device_type} at {nd.ip}{hostname_str} "
                    f"(confidence {nd.confidence * 100:.0f}%)"
                )
                network_devices.append(cfg)
        if not network_devices:
            click.echo("  No network devices found")

    # Detect hardware
    click.echo("Detecting hardware...")
    devices = detect_all()

    # Merge network-discovered devices (avoid duplicates by URL/host)
    existing_urls = {d.get("url", "") for d in devices}
    for nd in network_devices:
        nd_url = nd.get("url", f"http://{nd.get('host', '')}")
        if nd_url not in existing_urls:
            devices.append(nd)

    if devices:
        for dev in devices:
            click.echo(f"  Found: {_format_device(dev)}")
    else:
        click.echo("  No hardware detected (will run in relay-only mode)")

    # Generate or update config
    if config is None:
        click.echo("Generating kernel config...")
        config = generate_config(devices)
    else:
        # Merge newly detected devices into existing config
        config.devices = devices

    # Apply CLI overrides
    config.pcc_base = pcc_base
    if kernel_id:
        config.kernel_id = kernel_id
    if api_key:
        config.pcc_api_key = api_key

    # Load or create node keys
    click.echo("Loading node keys...")
    public_key, secret_key = load_or_create_keys()
    config.public_key = public_key

    click.echo(f"  Kernel ID: {config.kernel_id}")
    click.echo(f"  Public key: {public_key[:16]}...")

    # Provision API key if missing
    if not config.pcc_api_key:
        click.echo("Provisioning API key...")
        config.pcc_api_key = provision_api_key(config.pcc_base)
        if not config.pcc_api_key:
            click.echo(
                "Warning: Could not provision API key. "
                "Set PCC_API_KEY env var or use --api-key."
            )

    # Register kernel
    click.echo("Registering on PCC network...")
    register_kernel(config.pcc_base, config.pcc_api_key, config)

    # Prove possession of the node's Ed25519 machine-log signing key (#235).
    # Fail-soft: a genuine ed25519 node registers its signer so the oracle can
    # verify its machine logs; an HMAC dev-fallback node cannot prove one, so we
    # skip WITH a clear message rather than crash the daemon (its settlement /
    # signing path simply stays unavailable). No HMAC value is ever sent as ed25519.
    try:
        register_signing_key(
            config.pcc_base,
            config.pcc_api_key,
            config.kernel_id,
            public_key,
            secret_key,
        )
    except LogSigningRefused as exc:
        click.echo(f"  Skipping signing-key registration (dev key): {exc}")

    # Announce capabilities
    if devices:
        announce_capabilities(
            config.pcc_base,
            config.pcc_api_key,
            config.kernel_id,
            devices,
            secret_key=secret_key,
        )

    # First-run diagnostics banner (no-op if already acknowledged)
    _maybe_prompt_diagnostics(config)

    # Save config
    saved_path = save_config(config, config_file)
    click.echo(f"  Config saved to {saved_path}")

    # Start daemon
    click.echo("")
    click.echo("Node running. Accepting jobs.")
    click.echo(f"  Dashboard: {config.pcc_base}/operator")
    click.echo("  Press Ctrl+C to stop.")
    click.echo("")

    run_daemon(config)


@main.command("discover")
@click.option(
    "--subnet",
    default="",
    help="Subnet to scan, e.g. 192.168.1.0/24 (default: auto-detect)",
)
@click.option(
    "--register",
    is_flag=True,
    default=False,
    help="Auto-register all found PCC-compatible devices",
)
@click.option(
    "--pcc-base",
    envvar="PCC_BASE",
    default="https://capability.network",
    help="PCC gateway URL (used with --register)",
)
@click.option(
    "--api-key",
    envvar="PCC_API_KEY",
    default="",
    help="PCC API key (used with --register)",
)
def discover_cmd(subnet, register, pcc_base, api_key):
    """Scan the local network for PCC-compatible devices."""
    click.echo("Scanning network...")
    devices = discover_network(subnet=subnet if subnet else None)

    if not devices:
        click.echo("No devices found.")
        return

    click.echo(format_discovery_report(devices))

    if register:
        click.echo("Registering compatible devices with PCC...")
        registered = 0
        skipped = 0
        for nd in devices:
            cfg = device_to_adapter_config(nd)
            if cfg is None:
                skipped += 1
                continue

            hostname_str = f" ({nd.hostname})" if nd.hostname else ""
            click.echo(
                f"  Found: {nd.device_type} at {nd.ip}{hostname_str} "
                f"(confidence {nd.confidence * 100:.0f}%)"
            )
            # Register as a single-device kernel
            from .config import generate_config, save_config
            from .crypto import load_or_create_keys
            node_config = generate_config([cfg])
            node_config.pcc_base = pcc_base
            if api_key:
                node_config.pcc_api_key = api_key
            pub_key, _ = load_or_create_keys()
            node_config.public_key = pub_key
            register_kernel(pcc_base, api_key, node_config)
            registered += 1

        click.echo(
            f"\nDiscovered {len(devices)} device(s), "
            f"registered {registered} "
            f"({skipped} unknown/low-confidence skipped)"
        )


@main.command()
def detect():
    """Detect connected hardware without starting the node."""
    devices = detect_all()
    if not devices:
        click.echo("No devices detected.")
        return

    click.echo("Detected devices:")
    for dev in devices:
        click.echo(f"  {_format_device(dev)}")


@main.command()
def status():
    """Check if the node daemon is running."""
    running, pid = is_running()
    if not running:
        click.echo("Node: not running")
        return

    state = read_state()
    if state is None:
        click.echo(f"Node: running (PID {pid})")
        click.echo("  No state file found -- limited info")
        return

    # Calculate uptime
    started = state.get("started_at", 0)
    if started:
        elapsed = time.time() - started
        hours = int(elapsed // 3600)
        minutes = int((elapsed % 3600) // 60)
        uptime = f"{hours}h {minutes}m"
    else:
        uptime = "unknown"

    click.echo(f"Node: running (PID {pid})")
    click.echo(f"Kernel: {state.get('kernel_id', 'unknown')}")
    click.echo(f"Uptime: {uptime}")
    click.echo(f"Jobs completed: {state.get('jobs_completed', 0)}")
    click.echo(f"Camera: {state.get('camera_device', 'none')}")
    click.echo(f"PCC: connected ({state.get('pcc_base', 'unknown')})")


@main.command("config")
@click.option(
    "--output", "-o",
    default="./pcc-node.json",
    help="Output config file path",
)
def config_cmd(output):
    """Interactive configuration wizard."""
    click.echo("PCC Node Configuration")
    click.echo("=" * 40)

    equipment = click.prompt(
        "What kind of equipment?",
        type=click.Choice(
            ["3d-printer", "liquid-handler", "cnc", "laser", "camera", "other"],
            case_sensitive=False,
        ),
        default="other",
    )

    device_url = click.prompt(
        "Device IP or URL",
        default="localhost:31950" if equipment == "liquid-handler" else "",
    )

    approval = click.prompt(
        "Approval mode",
        type=click.Choice(["manual", "auto", "policy"], case_sensitive=False),
        default="manual",
    )

    base_rate = click.prompt("Pricing - base rate ($)", type=float, default=10.0)
    per_minute = click.prompt("Pricing - per minute ($)", type=float, default=0.15)

    pcc_base = click.prompt("PCC gateway URL", default="https://capability.network")

    # Build config
    device_type_map = {
        "3d-printer": "octoprint",
        "liquid-handler": "opentrons",
        "cnc": "serial",
        "laser": "serial",
        "camera": "camera",
        "other": "generic",
    }

    devices = []
    if device_url:
        devices.append({
            "type": device_type_map.get(equipment, "generic"),
            "url": device_url if "://" in device_url else f"http://{device_url}",
            "name": equipment,
        })

    config = generate_config(devices)
    config.pcc_base = pcc_base
    config.approval_mode = approval
    config.pricing = {"base": base_rate, "per_minute": per_minute}

    # Confirm and save
    click.echo("")
    click.echo(f"Kernel ID: {config.kernel_id}")
    click.echo(f"Kernel name: {config.kernel_name}")
    click.echo(f"Devices: {len(devices)}")
    click.echo(f"Approval: {approval}")
    click.echo(f"Pricing: ${base_rate} base + ${per_minute}/min")

    if click.confirm(f"\nSave config to {output}?", default=True):
        saved = save_config(config, output)
        click.echo(f"Config saved to {saved}")
        click.echo(f"\nRun 'pcc-node start -c {output}' to start the node.")
    else:
        click.echo("Config not saved.")


@main.command("import-job")
@click.argument("filepath")
@click.option("--kernel", default=None, help="Target kernel ID to validate against")
def import_job(filepath, kernel):
    """Import a job from a file (G-code, STL, protocol, CSV)."""
    from .importers import detect_and_import, list_supported

    if not os.path.exists(filepath):
        click.echo(f"Error: file not found: {filepath}")
        sys.exit(1)

    try:
        result = detect_and_import(filepath)
    except ValueError as exc:
        click.echo(f"Error: {exc}")
        click.echo(f"Supported formats: {', '.join(list_supported())}")
        sys.exit(1)

    click.echo(f"Imported: {result['capabilityType']}")
    # Print parameters (excluding bulky fields)
    display_params = {
        k: v
        for k, v in result.get("parameters", {}).items()
        if k != "protocolContent"
    }
    click.echo(json.dumps(display_params, indent=2, default=str))

    if result.get("needsSlicing"):
        click.echo("Note: this file needs slicing before it can be printed")

    if kernel:
        from .validator import validate_job

        # When no live kernel lookup, validate against declared type
        validation = validate_job(
            result, None, [{"type": result["capabilityType"]}]
        )
        if validation["valid"]:
            click.echo("Validation: PASS")
        else:
            click.echo("Validation: FAIL")
            for err in validation["errors"]:
                click.echo(f"  ERROR: {err}")
        for warn in validation["warnings"]:
            click.echo(f"  WARNING: {warn}")


@main.command()
def formats():
    """List supported import formats."""
    from .importers import list_supported

    supported = list_supported()
    if not supported:
        click.echo("No import formats registered.")
        return

    click.echo("Supported import formats:")
    for ext in supported:
        click.echo(f"  {ext}")


@main.group()
def ui():
    """Dynamic UI server -- generate and serve visual interfaces."""
    pass


@ui.command("serve")
@click.option("--port", default=3200, help="Server port (default: 3200)")
@click.option("--ui-dir", default=None, help="UI directory (default: ~/.pcc-node/ui/)")
@click.option(
    "--pcc-base",
    envvar="PCC_BASE",
    default="https://capability.network",
    help="PCC gateway URL for API proxy",
)
@click.option(
    "--api-key",
    envvar="PCC_API_KEY",
    default="",
    help="PCC API key for proxy auth",
)
def ui_serve(port, ui_dir, pcc_base, api_key):
    """Start the dynamic UI server."""
    from .ui_server import start_ui_server, _active_ui_dir

    click.echo(f"UI server: http://localhost:{port}")
    if ui_dir:
        click.echo(f"UI directory: {ui_dir}")
    else:
        from .ui_server import _DEFAULT_UI_DIR
        click.echo(f"UI directory: {_DEFAULT_UI_DIR}")
    click.echo("Press Ctrl+C to stop.")
    start_ui_server(
        port=port,
        ui_dir=ui_dir,
        background=False,
        pcc_base=pcc_base,
        pcc_api_key=api_key,
    )


@ui.command("open")
@click.argument("template")
@click.option("--port", default=3200, help="Server port (default: 3200)")
def ui_open(template, port):
    """Install and open a built-in template in the browser."""
    from .ui_gen import install_template, list_templates

    available = list_templates()
    if template not in available:
        click.echo(f"Unknown template: {template}")
        click.echo(f"Available: {', '.join(available)}")
        return

    try:
        filename = install_template(template)
        url = f"http://localhost:{port}/{filename}"
        click.echo(f"Installed: {filename}")
        click.echo(f"URL: {url}")
        import webbrowser
        webbrowser.open(url)
    except FileNotFoundError as e:
        click.echo(f"Error: {e}")


@ui.command("list")
def ui_list():
    """List available templates and active UIs."""
    from .ui_gen import list_templates, DEFAULT_UI_DIR

    click.echo("Built-in templates:")
    templates = list_templates()
    if templates:
        for t in templates:
            click.echo(f"  {t}")
    else:
        click.echo("  (none)")

    click.echo("")
    click.echo(f"Active UIs ({DEFAULT_UI_DIR}):")
    if DEFAULT_UI_DIR.exists():
        files = sorted(DEFAULT_UI_DIR.glob("*.html"))
        if files:
            for f in files:
                click.echo(f"  {f.name} ({f.stat().st_size} bytes)")
        else:
            click.echo("  (none)")
    else:
        click.echo("  (directory does not exist)")


@ui.command("submissions")
def ui_submissions():
    """Show pending form submissions from UIs."""
    from .ui_server import get_submissions

    subs = get_submissions()
    if not subs:
        click.echo("No pending submissions.")
        click.echo("(Submissions are only available while the UI server is running in this process.)")
        return

    for i, sub in enumerate(subs):
        click.echo(f"[{i}] source={sub.get('path', '?')} ts={sub.get('timestamp', '?')}")
        click.echo(f"    {json.dumps(sub.get('data', {}), indent=2)}")


@main.command("feedback")
@click.option(
    "--config-file", "-c",
    default="./pcc-node.json",
    help="Path to config file (default: ./pcc-node.json)",
)
@click.argument("mode", type=click.Choice(["on", "off", "errors", "periodic", "status"]))
@click.option(
    "--interval",
    default=24,
    help="Hours between periodic reports (default: 24)",
)
def feedback_cmd(config_file, mode, interval):
    """Opt in or out of automatic diagnostic feedback.

    Modes:

      on       — alias for 'errors' (send diagnostics when things break)
      off      — disable auto-diagnostics (default)
      errors   — send diagnostics after 5+ consecutive errors
      periodic — send diagnostics every N hours (default: 24)
      status   — show current feedback setting

    Data sent (all encrypted, secrets redacted):

      - System info (OS, Python version, CPU, memory)
      - Node state (uptime, jobs completed, daemon status)
      - Config (with API keys redacted)
      - Recent log lines (last 200)
      - Gateway connectivity test

    Nothing is readable without the retrieval code.

    Examples:

      pcc-node feedback on              # Enable (error-triggered)
      pcc-node feedback periodic --interval 12  # Every 12 hours
      pcc-node feedback off             # Disable
      pcc-node feedback status          # Check current setting
    """
    config_path = os.path.abspath(config_file)

    if mode == "status":
        try:
            cfg = load_config(config_path)
            click.echo(f"Diagnostic feedback: {cfg.diagnostics_mode}")
            if cfg.diagnostics_mode == "periodic":
                click.echo(f"  Interval: every {cfg.diagnostics_interval_hours} hours")
            elif cfg.diagnostics_mode == "errors":
                click.echo("  Trigger: after 5+ consecutive errors")
        except FileNotFoundError:
            click.echo("No config file found. Run 'pcc-node start' first.")
        return

    try:
        cfg = load_config(config_path)
    except FileNotFoundError:
        click.echo(f"Config not found: {config_path}")
        click.echo("Run 'pcc-node start' first to generate a config.")
        return

    if mode == "on":
        mode = "errors"

    cfg.diagnostics_mode = mode
    if mode == "periodic":
        cfg.diagnostics_interval_hours = interval

    from .config import save_config as _sc
    _sc(cfg, config_path)

    if mode == "off":
        click.echo("Diagnostic feedback: DISABLED")
        click.echo("No diagnostics will be sent automatically.")
    elif mode == "errors":
        click.echo("Diagnostic feedback: ENABLED (error-triggered)")
        click.echo("Diagnostics will be sent after 5+ consecutive errors.")
        click.echo("")
        click.echo("What is sent (encrypted, secrets redacted):")
        click.echo("  - OS, Python version, CPU count, memory")
        click.echo("  - Node uptime, jobs completed, daemon status")
        click.echo("  - Config (API keys replaced with ***)")
        click.echo("  - Last 200 log lines")
        click.echo("  - Gateway connectivity check")
    elif mode == "periodic":
        click.echo(f"Diagnostic feedback: ENABLED (every {interval} hours)")
        click.echo("")
        click.echo("What is sent (encrypted, secrets redacted):")
        click.echo("  - OS, Python version, CPU count, memory")
        click.echo("  - Node uptime, jobs completed, daemon status")
        click.echo("  - Config (API keys replaced with ***)")
        click.echo("  - Last 200 log lines")
        click.echo("  - Gateway connectivity check")

    click.echo("")
    click.echo("Restart pcc-node for changes to take effect.")


@main.command("logs")
@click.option(
    "--config-file", "-c",
    default="./pcc-node.json",
    help="Path to config file (default: ./pcc-node.json)",
)
@click.option(
    "--pcc-base",
    envvar="PCC_BASE",
    default="https://capability.network",
    help="PCC gateway URL",
)
@click.option(
    "--api-key",
    envvar="PCC_API_KEY",
    default="",
    help="PCC API key",
)
@click.option(
    "--max-lines", "-n",
    default=500,
    help="Max log lines to include (default: 500)",
)
@click.option(
    "--no-device-health",
    is_flag=True,
    default=False,
    help="Skip device health probing (faster)",
)
@click.option(
    "--local-only",
    is_flag=True,
    default=False,
    help="Save diagnostic bundle locally instead of uploading",
)
@click.option(
    "--send",
    is_flag=True,
    default=False,
    help="Upload logs AND open a support thread automatically",
)
@click.option(
    "--message", "-m",
    default="",
    help="Description of the issue (used with --send)",
)
@click.option(
    "--output", "-o",
    default=None,
    help="Output file path for --local-only (default: pcc-diagnostics-<timestamp>.json)",
)
@click.pass_context
def logs_cmd(ctx, config_file, pcc_base, api_key, max_lines, no_device_health, local_only, send, message, output):
    """Collect and securely send diagnostic logs for troubleshooting.

    Gathers system info, node state, recent logs, device health, and
    network diagnostics. Encrypts everything and uploads to the PCC
    gateway. You receive a short retrieval code to share with support.

    Use --send to automatically open a support thread with your logs
    attached — no need to copy the retrieval code anywhere.

    Examples:

      pcc-node logs                              # Collect, encrypt, upload
      pcc-node logs --send                       # Upload + open support thread
      pcc-node logs --send -m "printer offline"  # With description
      pcc-node logs --local-only                 # Save locally (no upload)
      pcc-node logs -n 1000                      # Include more log lines
    """
    from .diagnostics import collect_diagnostic_bundle, upload_diagnostic_bundle

    click.echo("Collecting diagnostic information...")
    click.echo("")

    # Collect
    with click.progressbar(length=4, label="  Gathering data") as bar:
        bundle = {}

        # System info
        bar.update(1)
        bundle_data = collect_diagnostic_bundle(
            config_path=os.path.abspath(config_file),
            pcc_base=pcc_base,
            max_log_lines=max_lines,
            include_device_health=not no_device_health,
        )
        bar.update(3)

    click.echo("")
    click.echo(f"  System: {bundle_data.get('system', {}).get('platform', '?')}")
    click.echo(f"  Log lines: {len(bundle_data.get('logs', []))}")
    click.echo(f"  Devices: {len(bundle_data.get('devices', []))}")

    node_state = bundle_data.get("node_state", {})
    if node_state.get("daemon_running"):
        click.echo(f"  Daemon: running (PID {node_state.get('daemon_pid')})")
    else:
        click.echo("  Daemon: not running")

    net = bundle_data.get("network", {})
    if net.get("gateway_reachable"):
        click.echo(f"  Gateway: reachable ({net.get('gateway_latency_ms')}ms)")
    else:
        click.echo(f"  Gateway: unreachable ({net.get('gateway_error', '?')})")

    click.echo("")

    if local_only:
        # Save locally
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = output or f"pcc-diagnostics-{ts}.json"
        with open(out_path, "w") as f:
            json.dump(bundle_data, f, indent=2, default=str)
        click.echo(f"Diagnostics saved to: {os.path.abspath(out_path)}")
        click.echo("Share this file with your support contact.")
        return

    # Upload
    click.echo("Encrypting and uploading...")

    # Try to get kernel_id and api_key from config if not provided
    if not api_key:
        try:
            from .config import load_config as _lc
            cfg = _lc(os.path.abspath(config_file))
            api_key = cfg.pcc_api_key or ""
        except Exception:
            pass

    kernel_id = bundle_data.get("config", {}).get("kernel_id", "")

    result = upload_diagnostic_bundle(
        bundle=bundle_data,
        pcc_base=pcc_base,
        api_key=api_key,
        kernel_id=kernel_id,
    )

    if "error" in result:
        click.echo("")
        click.echo(f"Upload failed: {result['error']}")
        if result.get("details"):
            click.echo(f"  Details: {json.dumps(result['details'])}")
        click.echo("")
        click.echo("Falling back to local save...")
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = output or f"pcc-diagnostics-{ts}.json"
        with open(out_path, "w") as f:
            json.dump(bundle_data, f, indent=2, default=str)
        click.echo(f"Diagnostics saved to: {os.path.abspath(out_path)}")
        click.echo("Share this file with your support contact.")
        return

    click.echo("")
    click.echo("=" * 50)
    click.echo("  DIAGNOSTIC LOGS UPLOADED SUCCESSFULLY")
    click.echo("=" * 50)
    click.echo("")
    click.echo(f"  Retrieval code:  {result['retrieval_code']}")
    click.echo(f"  Upload ID:       {result['upload_id']}")
    click.echo(f"  Bundle size:     {result['bundle_size']:,} bytes")
    click.echo(f"  Expires:         {result['expires_at']}")
    if send:
        # Auto-create a support thread with the retrieval code attached
        from .http_util import pcc_request as _pr

        desc = message or "Diagnostic logs submitted (auto-send)"
        payload = {
            "kernelId": kernel_id or "unknown",
            "kernelName": bundle_data.get("config", {}).get("kernel_name", ""),
            "message": desc,
            "retrievalCode": result["retrieval_code"],
            "systemInfo": {
                "platform": bundle_data.get("system", {}).get("platform", ""),
                "nodeVersion": "0.1.0",
                "daemonRunning": bundle_data.get("node_state", {}).get("daemon_running", False),
                "gatewayReachable": bundle_data.get("network", {}).get("gateway_reachable", False),
            },
        }
        s_status, s_body = _pr(
            "POST", "/api/operator/support",
            body=payload, base_url=pcc_base, api_key=api_key,
        )
        if s_status in (200, 201):
            click.echo(f"  Support thread opened: {s_body.get('threadId', '?')}")
            click.echo("  Logs are attached — support can see them immediately.")
            click.echo("")
            click.echo("  Check for replies: pcc-node support --check")
        else:
            click.echo("  (Could not auto-create support thread, share the code manually)")
    else:
        click.echo("")
        click.echo("  Share the RETRIEVAL CODE with your support contact.")
        click.echo("  They will use it to decrypt and view your logs.")
        click.echo("  The code is the ONLY way to read the logs.")
    click.echo("")


@main.command("support")
@click.argument("message", required=False)
@click.option(
    "--config-file", "-c",
    default="./pcc-node.json",
    help="Path to config file (default: ./pcc-node.json)",
)
@click.option(
    "--pcc-base",
    envvar="PCC_BASE",
    default="https://capability.network",
    help="PCC gateway URL",
)
@click.option(
    "--api-key",
    envvar="PCC_API_KEY",
    default="",
    help="PCC API key",
)
@click.option(
    "--attach-logs",
    is_flag=True,
    default=False,
    help="Automatically collect and attach diagnostic logs",
)
@click.option(
    "--check",
    is_flag=True,
    default=False,
    help="Check for replies to your support messages",
)
def support_cmd(message, config_file, pcc_base, api_key, attach_logs, check):
    """Send a support message or check for replies.

    Messages go directly to the PCC support team through the gateway.
    You can optionally attach diagnostic logs (encrypted) in one step.

    Examples:

      pcc-node support "my printer won't connect"
      pcc-node support "jobs keep failing" --attach-logs
      pcc-node support --check
    """
    from .http_util import pcc_request

    config_path = os.path.abspath(config_file)
    kernel_id = ""
    kernel_name = ""

    # Load config for kernel info and API key
    try:
        cfg = load_config(config_path)
        kernel_id = cfg.kernel_id
        kernel_name = cfg.kernel_name
        if not api_key:
            api_key = cfg.pcc_api_key or ""
        if not pcc_base or pcc_base == "https://capability.network":
            pcc_base = cfg.pcc_base or pcc_base
    except Exception:
        pass

    if check:
        if not kernel_id:
            click.echo("No config found. Run 'pcc-node start' first.")
            return

        click.echo("Checking for replies...")
        status, body = pcc_request(
            "GET",
            f"/api/operator/support/mine?kernelId={kernel_id}",
            base_url=pcc_base,
            api_key=api_key,
        )

        if status != 200:
            click.echo(f"Error: {body}")
            return

        threads_list = body.get("threads", [])
        if not threads_list:
            click.echo("No support threads found.")
            return

        for t in threads_list:
            status_icon = {
                "open": "[OPEN]",
                "in-progress": "[IN PROGRESS]",
                "resolved": "[RESOLVED]",
                "closed": "[CLOSED]",
            }.get(t.get("status", ""), "[?]")

            click.echo(f"\n{status_icon} {t.get('subject', '?')}")
            click.echo(f"  Thread: {t.get('id')}  Created: {t.get('createdAt', '?')[:10]}")

            for msg in t.get("messages", []):
                sender = "YOU" if msg.get("from") == "operator" else "SUPPORT"
                ts = msg.get("timestamp", "")[:16].replace("T", " ")
                click.echo(f"  [{ts}] {sender}: {msg.get('text', '')}")
                if msg.get("retrievalCode"):
                    click.echo(f"           (logs attached: {msg['retrievalCode']})")

        has_unread = body.get("hasUnreadReplies", False)
        if has_unread:
            click.echo("\n  ** You have unread replies from support **")
        return

    # Sending a message
    if not message:
        click.echo("Usage: pcc-node support \"your message here\"")
        click.echo("       pcc-node support --check")
        return

    retrieval_code = None

    # Auto-attach logs if requested
    if attach_logs:
        from .diagnostics import collect_diagnostic_bundle, upload_diagnostic_bundle

        click.echo("Collecting diagnostic logs...")
        bundle_data = collect_diagnostic_bundle(
            config_path=config_path,
            pcc_base=pcc_base,
            max_log_lines=300,
            include_device_health=True,
        )
        click.echo("Encrypting and uploading logs...")
        result = upload_diagnostic_bundle(
            bundle=bundle_data,
            pcc_base=pcc_base,
            api_key=api_key,
            kernel_id=kernel_id,
        )
        if "error" not in result:
            retrieval_code = result.get("retrieval_code")
            click.echo(f"  Logs uploaded (code: {retrieval_code})")
        else:
            click.echo(f"  Log upload failed: {result['error']} (sending message without logs)")

    # Collect basic system info for the thread
    import platform as plat
    from .daemon import is_running as _is_running

    running, _ = _is_running()
    sys_info = {
        "platform": plat.platform(),
        "nodeVersion": "0.1.0",
        "daemonRunning": running,
    }

    # Send support message
    payload = {
        "kernelId": kernel_id or "unknown",
        "kernelName": kernel_name or "unknown",
        "message": message,
        "systemInfo": sys_info,
    }
    if retrieval_code:
        payload["retrievalCode"] = retrieval_code

    click.echo("Sending message...")
    status, body = pcc_request(
        "POST",
        "/api/operator/support",
        body=payload,
        base_url=pcc_base,
        api_key=api_key,
    )

    if status in (200, 201):
        click.echo("")
        click.echo("Message sent!")
        click.echo(f"  Thread: {body.get('threadId', '?')}")
        if body.get("isNewThread"):
            click.echo("  (New support thread created)")
        if retrieval_code:
            click.echo(f"  Logs attached: {retrieval_code}")
        click.echo("")
        click.echo("Check for replies with: pcc-node support --check")
    else:
        click.echo(f"Failed to send message (HTTP {status})")
        if isinstance(body, dict):
            click.echo(f"  {body.get('error', body)}")


if __name__ == "__main__":
    main()
