#!/usr/bin/env python3
"""PCC Genesis-sim runner — headless wrapper for sim-rollout normalization.

Mirror of ``scripts/pcc_lingbot_runner.py``. Where the LingBot runner takes a
phone-video clip and produces a ``PointMap3DTrace``, this runner takes a
Genesis-sim rollout artefact (jsonl/npz/h5 bytes the operator's sim runner
produced) and produces a ``SimulationTrace``.

Usage:
    PYTHONPATH=vendor/genesis python scripts/pcc_genesis_runner.py \
        --rollout-path /tmp/rollout.jsonl \
        --out /tmp/trace.json \
        --fps 30 \
        --max-frames 256 \
        --downsample-points 256 \
        --model-path /opt/checkpoints/policy-ppo-v3.pt \
        --task-id cube-stack \
        --simulator genesis

Stub mode (no Genesis / no checkpoint — for CI and aarch64 dev boxes):
    PCC_GENESIS_STUB=1 python scripts/pcc_genesis_runner.py \
        --rollout-path any.jsonl --out /tmp/trace.json

In stub mode the wrapper does NOT load Genesis, PyTorch, or any policy model.
It emits a deterministic synthetic rollout (identity dynamics + sparse-reward
success-at-last-tick, seeded random observation/action vectors,
``stubbed: true``) so the rest of the pipeline can be exercised end-to-end
without a CUDA-capable host.

Output schema matches ``SimulationTrace`` from
``packages/spec/src/types/simulation.ts``.

Bounded clamps (defense in depth — gateway also clamps via Zod):
    --fps                 ∈ [1, 240]    (default 30)
    --max-frames          ∈ [1, 4096]   (default 256)
    --downsample-points   ∈ [16, 16384] (default 256, the flat-vector width)

Author: pcc-genesis adapter
License: Apache-2.0 (matches Genesis upstream)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

ADAPTER_VERSION = "0.1.0"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    if not path.exists():
        # Stub mode may run with a non-existent rollout artefact — hash a
        # deterministic placeholder so the JSON is still parseable downstream.
        h.update(b"pcc-stub-rollout")
    else:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def _clamp(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(value)))


def _scene_hash_for(simulator: str, embodiment: str, task_id: str, seed: int) -> str:
    """Stable sha256 over the canonical scene tuple (used in stub mode)."""
    h = hashlib.sha256()
    h.update(simulator.encode("utf-8"))
    h.update(b"\x00")
    h.update(embodiment.encode("utf-8"))
    h.update(b"\x00")
    h.update(task_id.encode("utf-8"))
    h.update(b"\x00")
    h.update(str(seed).encode("utf-8"))
    return f"sha256:{h.hexdigest()}"


# ---------------------------------------------------------------------------
# Stub-mode synthesis
# ---------------------------------------------------------------------------


def _stub_trace(
    rollout_hash: str,
    fps: int,
    max_frames: int,
    downsample_points: int,
    started_at: str,
    ended_at: str,
    task_id: str,
    simulator: str,
    model_path: Optional[str],
) -> Dict[str, Any]:
    """Synthesize a deterministic SimulationTrace without loading any models."""
    fps = _clamp(fps, 1, 240)
    max_frames = _clamp(max_frames, 1, 4096)
    downsample_points = _clamp(downsample_points, 16, 16384)

    rng = random.Random(0xC0FFEE)
    embodiment = "franka-panda"
    seed = 42
    scene_hash = _scene_hash_for(simulator, embodiment, task_id, seed)

    # Sparse-reward trajectory: reward 0 until the very last tick, where the
    # robot "succeeds" and gets +1. Reproducible across stub runs.
    action_dim = 7
    obs_dim = max(7, min(downsample_points, 31))
    frames: List[Dict[str, Any]] = []
    total_return = 0.0
    for i in range(max_frames):
        is_last = (i == max_frames - 1)
        action = [rng.uniform(-0.1, 0.1) for _ in range(action_dim)]
        observation = [rng.uniform(-1.0, 1.0) for _ in range(obs_dim)]
        reward = 1.0 if is_last else 0.0
        total_return += reward
        frame: Dict[str, Any] = {
            "frameIndex": i,
            "timestampSec": round(i / max(fps, 1), 4),
            "action": action,
            "observation": observation,
            "reward": reward,
            "done": is_last,
        }
        if is_last:
            frame["info"] = {"success": True, "collision": False, "timeout": False}
        frames.append(frame)

    return {
        "deviceId": os.environ.get("PCC_DEVICE_ID", "pcc-stub-device"),
        "startedAt": started_at,
        "endedAt": ended_at,
        "rolloutHash": rollout_hash,
        "scene": {
            "simulator": simulator,
            "simulatorVersion": "0.0.0-stub",
            "embodiment": embodiment,
            "taskId": task_id,
            "sceneHash": scene_hash,
            "physicsParams": {
                "gravity": [0.0, 0.0, -9.81],
                "timestepSec": 1.0 / 240.0,
                "solver": "stub",
                "substeps": 1,
            },
            "randomSeed": seed,
            "observationKeys": ["qpos", "qvel", "ee_pose"],
            "actionDim": action_dim,
            "observationDim": obs_dim,
        },
        "fps": fps,
        "frameCount": len(frames),
        "frames": frames,
        "summary": {
            "totalReturn": total_return,
            "episodeLength": len(frames),
            "success": True,
            "terminatedReason": "success",
            "meanReward": total_return / max(len(frames), 1),
            "domainRandomizationHash": scene_hash,
        },
        "model": Path(model_path).stem if model_path else "genesis-stub-policy",
        "adapterVersion": ADAPTER_VERSION,
        "stubbed": True,
    }


# ---------------------------------------------------------------------------
# Real-mode rollout normalization
# ---------------------------------------------------------------------------


def _real_trace(
    args: argparse.Namespace,
    rollout_hash: str,
    started_at: str,
) -> Dict[str, Any]:
    """Normalize a real Genesis-sim rollout artefact into SimulationTrace.

    Imports happen lazily so the stub path never pays the torch / genesis
    import cost. The runner supports two artefact formats:

      1. JSONL  — one dict per step with keys {action, observation, reward,
         done, info}. The runner just streams through this.
      2. NPZ    — a numpy-saved archive with arrays {actions, observations,
         rewards, dones}. Requires numpy at runtime.

    Either format must carry a sibling ``scene.json`` describing the scene
    context (simulator, embodiment, task, seed, ...). If the operator only
    has one of the two halves, --task-id / --simulator overrides are used to
    fill in the gaps.
    """
    # Lazy imports — numpy is the only hard runtime dep for real mode, and
    # only when --rollout-path ends in .npz / .npy / .h5.
    rollout_path = Path(args.rollout_path)
    sidecar = rollout_path.with_suffix(".scene.json")

    scene: Dict[str, Any]
    if sidecar.exists():
        scene = json.loads(sidecar.read_text())
    else:
        # Fall back to CLI-provided overrides.
        scene = {
            "simulator": args.simulator,
            "simulatorVersion": os.environ.get("PCC_GENESIS_VERSION", "unknown"),
            "embodiment": os.environ.get("PCC_EMBODIMENT", "franka-panda"),
            "taskId": args.task_id,
            "sceneHash": _scene_hash_for(
                args.simulator, "franka-panda", args.task_id, 0,
            ),
        }

    fps = _clamp(args.fps, 1, 240)
    max_frames = _clamp(args.max_frames, 1, 4096)
    downsample_points = _clamp(args.downsample_points, 16, 16384)

    frames: List[Dict[str, Any]] = []
    total_return = 0.0
    last_info: Dict[str, Any] = {}

    if rollout_path.suffix.lower() == ".jsonl":
        # Stream through the JSONL one step at a time. Strict cap on max_frames.
        with rollout_path.open("r") as fh:
            for i, line in enumerate(fh):
                if i >= max_frames:
                    break
                step = json.loads(line)
                action = step.get("action") or []
                observation = step.get("observation") or []
                reward = float(step.get("reward", 0.0))
                done = bool(step.get("done", False))
                info = step.get("info") or {}
                total_return += reward
                # Defensive truncation in case the operator dumps a 50k-dim
                # observation — the manifest can't carry that and the schema
                # has no array-length cap (the cap is here).
                if isinstance(action, list) and len(action) > downsample_points:
                    action = action[:downsample_points]
                if isinstance(observation, list) and len(observation) > downsample_points:
                    observation = observation[:downsample_points]
                frame: Dict[str, Any] = {
                    "frameIndex": i,
                    "timestampSec": round(i / max(fps, 1), 4),
                    "action": [float(x) for x in action],
                    "observation": [float(x) for x in observation],
                    "reward": reward,
                    "done": done,
                }
                if isinstance(info, dict) and info:
                    frame["info"] = {
                        k: bool(v) for k, v in info.items()
                        if k in ("success", "collision", "timeout")
                    }
                    last_info = info
                frames.append(frame)
    elif rollout_path.suffix.lower() in (".npz", ".npy"):
        try:
            import numpy as np  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Real-mode .npz rollouts require numpy at runtime; got: {e}. "
                "Set PCC_GENESIS_STUB=1 for stub mode."
            ) from e
        data = np.load(str(rollout_path), allow_pickle=False)
        actions = data["actions"]
        observations = data["observations"]
        rewards = data["rewards"] if "rewards" in data else None
        dones = data["dones"] if "dones" in data else None
        n = min(int(actions.shape[0]), max_frames)
        for i in range(n):
            action = actions[i].reshape(-1).tolist()
            observation = observations[i].reshape(-1).tolist()
            reward = float(rewards[i]) if rewards is not None else 0.0
            done = bool(dones[i]) if dones is not None else (i == n - 1)
            total_return += reward
            if len(action) > downsample_points:
                action = action[:downsample_points]
            if len(observation) > downsample_points:
                observation = observation[:downsample_points]
            frames.append({
                "frameIndex": i,
                "timestampSec": round(i / max(fps, 1), 4),
                "action": [float(x) for x in action],
                "observation": [float(x) for x in observation],
                "reward": reward,
                "done": done,
            })
    else:
        raise RuntimeError(
            f"Unsupported rollout artefact extension: {rollout_path.suffix}. "
            "Use .jsonl or .npz, or set PCC_GENESIS_STUB=1 for stub mode."
        )

    if not frames:
        raise RuntimeError(f"Empty rollout: no frames recovered from {rollout_path}")

    # Last frame is authoritative for success — info dict if the operator set
    # one, otherwise reward>0 fallback.
    last_frame = frames[-1]
    success = bool(last_info.get("success", float(last_frame.get("reward", 0.0)) > 0.0))
    terminated_reason = "success" if success else (
        "timeout" if last_info.get("timeout") else
        ("collision" if last_info.get("collision") else "failure")
    )

    return {
        "deviceId": os.environ.get("PCC_DEVICE_ID", "pcc-device"),
        "startedAt": started_at,
        "endedAt": _iso_now(),
        "rolloutHash": rollout_hash,
        "scene": scene,
        "fps": fps,
        "frameCount": len(frames),
        "frames": frames,
        "summary": {
            "totalReturn": total_return,
            "episodeLength": len(frames),
            "success": success,
            "terminatedReason": terminated_reason,
            "meanReward": total_return / max(len(frames), 1),
        },
        "model": Path(args.model_path).stem if args.model_path else "genesis-rollout",
        "adapterVersion": ADAPTER_VERSION,
        "stubbed": False,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="PCC Genesis-sim rollout runner")
    parser.add_argument("--rollout-path", required=True,
                        help="Source rollout artefact (.jsonl or .npz)")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--fps", type=int, default=30,
                        help="Steps-per-second the simulator was driven at")
    parser.add_argument("--max-frames", type=int, default=256,
                        help="Hard cap on frames recorded in the trace (keeps manifest size bounded)")
    parser.add_argument("--downsample-points", type=int, default=256,
                        help="Flat-vector width cap for observation/action arrays (full state stays off-chain)")
    parser.add_argument("--model-path", default=None,
                        help="Policy / checkpoint identifier. Records into trace.model.")
    parser.add_argument("--task-id", default="generic-task",
                        help="Logical task identifier (used when no scene sidecar is present)")
    parser.add_argument("--simulator", default="genesis",
                        help="Simulator identifier (used when no scene sidecar is present)")
    parser.add_argument("--genesis-root", default="vendor/genesis",
                        help="Root of vendored Genesis tree (advisory; runner does not import it)")
    args = parser.parse_args()

    started_at = _iso_now()
    rollout_path = Path(args.rollout_path)
    rollout_hash = _sha256_file(rollout_path)

    stub_env = os.environ.get("PCC_GENESIS_STUB", "").strip().lower()
    use_stub = stub_env in ("1", "true", "yes")

    if use_stub:
        trace = _stub_trace(
            rollout_hash=rollout_hash,
            fps=args.fps,
            max_frames=args.max_frames,
            downsample_points=args.downsample_points,
            started_at=started_at,
            ended_at=_iso_now(),
            task_id=args.task_id,
            simulator=args.simulator,
            model_path=args.model_path,
        )
    else:
        trace = _real_trace(args, rollout_hash=rollout_hash, started_at=started_at)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(trace, separators=(",", ":")))
    print(
        f"wrote {args.out} ({trace['frameCount']} frames, "
        f"stubbed={trace.get('stubbed', False)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
