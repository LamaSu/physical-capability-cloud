"""Click CLI for pcc-node.

Commands:
  pcc-node start   -- Detect, configure, register, and run the daemon
  pcc-node detect  -- Just detect hardware
  pcc-node status  -- Check if the daemon is running
  pcc-node config  -- Interactive configuration
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
def start(config_file, pcc_base, api_key, kernel_id):
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

    # Detect hardware
    click.echo("Detecting hardware...")
    devices = detect_all()

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


if __name__ == "__main__":
    main()
