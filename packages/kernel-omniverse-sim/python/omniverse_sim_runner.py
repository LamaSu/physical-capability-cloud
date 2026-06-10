#!/usr/bin/env python3
"""
Omniverse Kit sim runner — shells out from @pcc/kernel-omniverse-sim.

Operates in two modes:

  --detect : print a JSON SimRunnerCapabilities to stdout and exit.
  --run    : read a MADSci workflow JSON from stdin, simulate it, print
             a JSON SimRunResult to stdout.

Real-mode (env OMNIVERSE_AVAILABLE=1) shells into NVIDIA Omniverse Kit
headless — replaces the stub with PRISM's Stage-2 sim core. Until that
ships, the stub returns deterministic verdict=pass with a synthetic
trace so the end-to-end PCC pipeline can be wired and tested.

Env contract:
  OMNIVERSE_AVAILABLE  : "1" enables real-mode; anything else is stub
  OMNIVERSE_KIT_PATH   : (real-mode) path to omni.kit_app binary or .py
  OMNIVERSE_USD_SCENE  : (real-mode) USD lab-scene file to load
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
from typing import Any


def capabilities() -> dict[str, Any]:
    real_mode = os.environ.get("OMNIVERSE_AVAILABLE") == "1"
    if not real_mode:
        return {
            "available": True,
            "gpuRtx": False,
            "pythonPath": sys.executable,
            "unavailableReason": "stub mode (OMNIVERSE_AVAILABLE!=1)",
        }
    # Real-mode probe — try to import omni.kit_app to confirm install.
    try:
        from omni.kit_app import KitApp  # noqa: F401
        kit_version = os.environ.get("OMNIVERSE_KIT_VERSION", "unknown")
        return {
            "available": True,
            "gpuRtx": True,
            "kitVersion": kit_version,
            "pythonPath": sys.executable,
        }
    except Exception as e:
        return {
            "available": False,
            "gpuRtx": False,
            "pythonPath": sys.executable,
            "unavailableReason": f"omni.kit_app import failed: {e}",
        }


def _stub_simulate(workflow: dict[str, Any]) -> dict[str, Any]:
    """Deterministic synthetic verdict — every step "passes" at 100ms."""
    steps = workflow.get("steps", [])
    t = 0
    trace = []
    for step in steps:
        trace.append(
            {
                "stepName": step.get("name", "<unnamed>"),
                "startMs": t,
                "endMs": t + 100,
                "status": "ok",
                "detail": "stub-mode",
            }
        )
        t += 100
    return {
        "verdict": "pass",
        "durationMs": t,
        "errors": [],
        "trace": trace,
        "metrics": {"stepsSimulated": len(steps)},
    }


def _real_simulate(workflow: dict[str, Any]) -> dict[str, Any]:
    """Real-mode entry point — Stage-2 sim core goes here.

    When PRISM's Stage-2 (ProtocolGenerator/Code) is wired up, this
    function loads OMNIVERSE_USD_SCENE, instantiates robots per
    workflow.metadata.lab_config, replays each step, and emits a
    SimRunResult. Until then, callers receive a clear NotImplementedError.
    """
    raise NotImplementedError(
        "real-mode sim not yet wired — wire ProtocolGenerator/Code from "
        "github.com/ramanathanlab/PRISM into this function"
    )


def run() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--detect", action="store_true")
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()

    if args.detect:
        print(json.dumps(capabilities()))
        return 0

    if args.run:
        try:
            workflow = json.loads(sys.stdin.read())
        except json.JSONDecodeError as e:
            sys.stderr.write(f"invalid workflow JSON: {e}\n")
            return 2

        real_mode = os.environ.get("OMNIVERSE_AVAILABLE") == "1"
        try:
            result = (
                _real_simulate(workflow) if real_mode else _stub_simulate(workflow)
            )
        except Exception as e:
            sys.stderr.write(f"sim failed: {e}\n")
            return 3

        print(json.dumps(result))
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(run())
