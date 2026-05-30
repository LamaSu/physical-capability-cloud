# Landscape: 3D Point-Map + Camera-Pose Streaming (operator capture evidence)

## Wheel-scout note (abbreviated)

The user pre-selected the target (`Robbyant/lingbot-map`, Apache-2.0) and
constrained the integration shape (vendor clone, demo.py --mode streaming,
do NOT download long checkpoint). This bypasses the usual ≥3-candidate
landscape because the comparative decision is already made.

For audit completeness, the candidate space was:

| # | Solution | Notes | Verdict |
|---|----------|-------|---------|
| 1 | **LingBot-Map (Robbyant/lingbot-map)** | Apache-2.0, demo.py exposes `--mode streaming`, per-frame point maps + poses. Has stage1 checkpoint that fits without the 4.6 GB long-context file. | **ADOPT (vendored, no fork)** |
| 2 | VGGT / DUSt3R / MASt3R (academic) | Pretrained 3D reconstruction transformers; heavier deps, no first-class streaming CLI, license varies | Skip — heavier integration burden, no streaming wrapper |
| 3 | COLMAP / OpenMVG | Classical SfM, BSD/MPL, very mature | Skip — not real-time / streaming-friendly, not learned point-map output |

LingBot wins on (a) Apache-2.0 (commercial OK), (b) streaming CLI already
present, (c) stage1 checkpoint is small enough to keep CI viable.

## Path

- **ADOPT — vendored, no fork.** Shallow-clone to `vendor/lingbot-map` so we
  pin a working tree without taking it into the monorepo's git history.
- Talk to it via subprocess (`spawn(python, ["demo.py", "--mode", "streaming", ...])`) —
  the inference loop is Python with native PyTorch + (optionally) FlashInfer
  JIT; calling it from a Node/TS server is the safe boundary.
- Stub the inference path (`PCC_LINGBOT_STUB=1`) for tests and aarch64 dev
  boxes that can't compile FlashInfer.

## Constitutional fit

No `constitution.md` present in this repo. License (Apache-2.0) is
commercially compatible. No GPL pull-through risk.
