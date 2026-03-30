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
from .register import provision_api_key, register_kernel, announce_capabilities


def _setup_logging(verbose):
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )


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

    # Announce capabilities
    if devices:
        announce_capabilities(
            config.pcc_base,
            config.pcc_api_key,
            config.kernel_id,
            devices,
            secret_key=secret_key,
        )

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


if __name__ == "__main__":
    main()
