#!/usr/bin/env python3
"""PCC streaming-3D runner — headless wrapper around vendor/lingbot-map.

Usage:
    PYTHONPATH=vendor/lingbot-map python scripts/pcc_lingbot_runner.py \
        --video-path /tmp/upload.mp4 \
        --out /tmp/trace.json \
        --mode streaming \
        --fps 10 \
        --max-frames 32 \
        --downsample-points 256 \
        --model-path /opt/checkpoints/lingbot-map-stage1.pt

Stub mode (no GPU / no checkpoint — for CI and aarch64 dev boxes):
    PCC_LINGBOT_STUB=1 python scripts/pcc_lingbot_runner.py \
        --video-path any.mp4 --out /tmp/trace.json

In stub mode the wrapper does NOT load PyTorch or LingBot. It emits a
deterministic synthetic trace (identity-pose-with-drift, random-but-seeded
sparse points, ``stubbed: true`` flag) so the rest of the pipeline can be
exercised end-to-end without downloading the 4.6 GB long checkpoint or
compiling FlashInfer.

Output schema matches `PointMap3DTrace` from
``packages/spec/src/types/capture.ts``.

Author: pcc-lingbot adapter
License: Apache-2.0 (matches LingBot-Map upstream)
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
from typing import Any, Dict, List

ADAPTER_VERSION = "0.1.0"


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    if not path.exists():
        # Stub mode may run with a non-existent video — hash a deterministic
        # placeholder so the JSON is still parseable downstream.
        h.update(b"pcc-stub-video")
    else:
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def _stub_trace(
    video_hash: str,
    video_path: str,
    fps: int,
    max_frames: int,
    mode: str,
    downsample_points: int,
    started_at: str,
    ended_at: str,
) -> Dict[str, Any]:
    """Synthesize a deterministic PointMap3DTrace without loading any models."""
    rng = random.Random(0xC0FFEE)
    frames: List[Dict[str, Any]] = []
    for i in range(max_frames):
        # Identity rotation, translate forward by 1cm per frame — gives the
        # adapter a non-trivial pose stream to assert on.
        matrix = [
            1.0, 0.0, 0.0, 0.01 * i,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
        ]
        points = [
            {
                "x": rng.uniform(-1.0, 1.0),
                "y": rng.uniform(-1.0, 1.0),
                "z": rng.uniform(0.5, 5.0),
                "conf": rng.uniform(0.7, 1.0),
            }
            for _ in range(downsample_points)
        ]
        frames.append({
            "frameIndex": i,
            "timestampSec": round(i / max(fps, 1), 4),
            "pose": {"matrix": matrix, "intrinsic": [500, 0, 256, 0, 500, 256, 0, 0, 1]},
            "points": points,
            "meanConfidence": 0.85,
        })

    return {
        "deviceId": os.environ.get("PCC_DEVICE_ID", "pcc-stub-device"),
        "startedAt": started_at,
        "endedAt": ended_at,
        "videoHash": video_hash,
        "mode": mode,
        "fps": fps,
        "frameCount": len(frames),
        "frames": frames,
        "model": "lingbot-map-stub",
        "adapterVersion": ADAPTER_VERSION,
        "stubbed": True,
    }


def _real_trace(
    args: argparse.Namespace,
    video_hash: str,
    started_at: str,
) -> Dict[str, Any]:
    """Run actual LingBot streaming inference. Imports happen lazily so the
    stub path never pays the torch / lingbot_map import cost.
    """
    # Lazy imports — torch / lingbot are NOT importable on aarch64 dev boxes
    # without CUDA + FlashInfer JIT.
    try:
        import torch  # type: ignore
        from lingbot_map.models.gct_stream import GCTStream  # type: ignore
        from lingbot_map.utils.pose_enc import pose_encoding_to_extri_intri  # type: ignore
        from lingbot_map.utils.geometry import closed_form_inverse_se3_general  # type: ignore
        # demo.py owns the video → tensor pipeline; reuse its loader.
        sys.path.insert(0, str(Path(args.lingbot_root) / "."))
        from demo import load_images, postprocess  # type: ignore  # noqa: E402
    except ImportError as e:
        raise RuntimeError(
            f"LingBot real-mode requires torch + lingbot_map + a demo.py on PYTHONPATH; "
            f"got: {e}. Set PCC_LINGBOT_STUB=1 for stub mode."
        ) from e

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    images, _paths, _resolved = load_images(
        video_path=args.video_path,
        fps=args.fps,
        first_k=args.max_frames,
        image_size=518,
        patch_size=14,
    )
    images = images.to(device)

    if not args.model_path:
        # Random-weights fallback (mirrors gct_profile.py): useful when the
        # user has the deps but no checkpoint. NOT recommended for prod —
        # produces geometrically invalid output. We still mark stubbed=false
        # because the inference path is real; the report explains the caveat.
        model = GCTStream(
            img_size=518,
            patch_size=14,
            enable_3d_rope=True,
            max_frame_num=max(args.max_frames + 10, 1024),
            kv_cache_sliding_window=64,
            kv_cache_scale_frames=8,
            use_sdpa=True,
            camera_num_iterations=1,
        ).to(device).eval()
    else:
        ckpt = torch.load(args.model_path, map_location=device, weights_only=False)
        state = ckpt.get("model", ckpt)
        model = GCTStream(
            img_size=518,
            patch_size=14,
            enable_3d_rope=True,
            max_frame_num=max(args.max_frames + 10, 1024),
            kv_cache_sliding_window=64,
            kv_cache_scale_frames=8,
            use_sdpa=True,
            camera_num_iterations=4,
        )
        model.load_state_dict(state, strict=False)
        model = model.to(device).eval()

    with torch.no_grad():
        preds = model.inference_streaming(
            images,
            num_scale_frames=min(8, images.shape[0]),
            keyframe_interval=1,
            output_device=torch.device("cpu"),
        )
    preds, _ = postprocess(preds, images)

    extrinsic = preds["extrinsic"]      # [F, 3, 4] (c2w)
    intrinsic = preds["intrinsic"]      # [F, 3, 3]
    world_points = preds["world_points"]            # [F, H, W, 3]
    world_points_conf = preds["world_points_conf"]  # [F, H, W]

    F = int(extrinsic.shape[0])
    H, W = int(world_points.shape[1]), int(world_points.shape[2])
    n_pts = H * W
    stride = max(1, n_pts // max(args.downsample_points, 1))

    frames_out: List[Dict[str, Any]] = []
    for i in range(F):
        ext = extrinsic[i].reshape(-1).tolist()
        intr = intrinsic[i].reshape(-1).tolist()
        wp = world_points[i].reshape(-1, 3)
        wc = world_points_conf[i].reshape(-1)

        sel = list(range(0, n_pts, stride))[: args.downsample_points]
        pts = [
            {
                "x": float(wp[j, 0]),
                "y": float(wp[j, 1]),
                "z": float(wp[j, 2]),
                "conf": float(max(0.0, min(1.0, wc[j]))),
            }
            for j in sel
        ]
        frames_out.append({
            "frameIndex": i,
            "timestampSec": round(i / max(args.fps, 1), 4),
            "pose": {"matrix": ext, "intrinsic": intr},
            "points": pts,
            "meanConfidence": float(max(0.0, min(1.0, wc.mean().item()))),
        })

    return {
        "deviceId": os.environ.get("PCC_DEVICE_ID", "pcc-device"),
        "startedAt": started_at,
        "endedAt": _iso_now(),
        "videoHash": video_hash,
        "mode": args.mode,
        "fps": args.fps,
        "frameCount": len(frames_out),
        "frames": frames_out,
        "model": Path(args.model_path).stem if args.model_path else "lingbot-map-random-init",
        "adapterVersion": ADAPTER_VERSION,
        "stubbed": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="PCC streaming-3D runner")
    parser.add_argument("--video-path", required=True, help="Source phone video")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--mode", choices=["streaming", "windowed"], default="streaming")
    parser.add_argument("--fps", type=int, default=10)
    parser.add_argument("--max-frames", type=int, default=32,
                        help="Hard cap on frames processed (keeps adapter latency bounded)")
    parser.add_argument("--downsample-points", type=int, default=256,
                        help="Sparse points per frame in the trace JSON (full cloud stays off-chain)")
    parser.add_argument("--model-path", default=None,
                        help="LingBot checkpoint. Omit for random-weights smoke run.")
    parser.add_argument("--lingbot-root", default="vendor/lingbot-map",
                        help="Root of vendored lingbot-map repo (for demo.py imports)")
    args = parser.parse_args()

    started_at = _iso_now()
    video_path = Path(args.video_path)
    video_hash = _sha256_file(video_path)

    stub_env = os.environ.get("PCC_LINGBOT_STUB", "").strip().lower()
    use_stub = stub_env in ("1", "true", "yes")

    if use_stub:
        trace = _stub_trace(
            video_hash=video_hash,
            video_path=args.video_path,
            fps=args.fps,
            max_frames=args.max_frames,
            mode=args.mode,
            downsample_points=args.downsample_points,
            started_at=started_at,
            ended_at=_iso_now(),
        )
    else:
        trace = _real_trace(args, video_hash=video_hash, started_at=started_at)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(trace, separators=(",", ":")))
    print(f"wrote {args.out} ({trace['frameCount']} frames, stubbed={trace.get('stubbed', False)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
