"""Module entry point — runs the stdio JSON-RPC server.

Invoked by the TypeScript adapter via
  ``python -m pcc_plr_sidecar``

stdio mapping:
  stdin  — newline-delimited JSON-RPC 2.0 requests + notifications
  stdout — newline-delimited JSON-RPC 2.0 responses + notifications
  stderr — free-form Python logs (captured + tee'd by the TS parent)
"""

from __future__ import annotations
import asyncio
import logging
import sys

from .server import Server


def cli() -> int:
    """CLI entrypoint (also exposed as ``pcc-plr-sidecar`` console script)."""
    # Route Python logs to stderr — the TS adapter parses these for low-
    # severity process_log_summary events while a recording is active.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )
    server = Server()
    try:
        asyncio.run(server.serve())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as e:  # noqa: BLE001
        logging.getLogger("pcc_plr_sidecar").exception("fatal: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(cli())
