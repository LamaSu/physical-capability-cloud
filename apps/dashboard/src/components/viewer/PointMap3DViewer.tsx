/**
 * PointMap3DViewer — operator-evidence 3D playback surface.
 *
 * Renders a `PointMap3DTrace` (per-frame sparse point clouds + 6-DoF camera
 * poses produced by the LingBot adapter) inside the dashboard's evidence
 * detail. Three concerns:
 *
 *   1. <Canvas> with a R3F scene that shows the current frame's points and
 *      the full camera trajectory (see PointMap3DScene).
 *   2. Transport controls — play / pause, step ±1, reset, rate selector,
 *      and a frame seek slider.
 *   3. Metadata strip — current/total frames, current time, fps, model id,
 *      stubbed flag.
 *
 * Pure presentational component. The parent (EvidenceExplorerPage,
 * JobDetailPage, etc.) is responsible for loading the trace JSON.
 *
 * Visual style follows the solarpunk dashboard system (GlassPanel, dark
 * background, emerald/teal accents). No new design tokens introduced.
 */

import React, { useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import type { PointMap3DTrace } from "@pcc/spec";
import { PointMap3DScene } from "./PointMap3DScene.js";
import { usePointMap3DPlayback } from "./usePointMap3DPlayback.js";

export interface PointMap3DViewerProps {
  /** The trace to render. Null shows the empty state. */
  trace: PointMap3DTrace | null;
  /** Optional title for the panel header. */
  title?: string;
  /** Optional starting frame. Default 0. */
  initialFrame?: number;
  /** Autoplay on mount. Default false. */
  autoplay?: boolean;
  /** Loop when reaching the end. Default true. */
  loop?: boolean;
  /** Canvas height in px. Default 360. */
  height?: number;
  /** Show camera-path polyline. Default true. */
  showCameraPath?: boolean;
  /** Show 3-axis + ground grid helpers. Default true. */
  showHelpers?: boolean;
  /** Optional className for the outer wrapper. */
  className?: string;
}

const RATE_OPTIONS = [0.25, 0.5, 1, 2, 4];

function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const s = Math.max(0, sec);
  const minutes = Math.floor(s / 60);
  const seconds = (s % 60).toFixed(2);
  return `${minutes}:${seconds.padStart(5, "0")}`;
}

export function PointMap3DViewer(props: PointMap3DViewerProps): React.ReactElement {
  const {
    trace,
    title = "3D Trace",
    autoplay = false,
    loop = true,
    height = 360,
    showCameraPath = true,
    showHelpers = true,
    className,
  } = props;

  const playback = usePointMap3DPlayback(trace, { autoplay, loop });
  const currentFrameMeta = trace?.frames?.[playback.currentFrame];

  const onSeekChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      playback.seekFrame(Number(e.target.value));
    },
    [playback],
  );

  const onRateChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      playback.setRate(Number(e.target.value));
    },
    [playback],
  );

  // Empty state — keep the panel even with no trace so the layout doesn't
  // collapse when the operator hasn't run streaming-3D capture yet.
  if (!trace) {
    return (
      <div
        data-testid="pointmap3d-viewer-empty"
        className={`rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 text-center text-xs text-white/30 ${className ?? ""}`}
      >
        <div className="mb-1 font-medium text-white/50">{title}</div>
        No streaming-3D trace available for this capture.
      </div>
    );
  }

  const hasFrames = playback.frameCount > 0;
  const lastFrame = Math.max(0, playback.frameCount - 1);
  const tNow = currentFrameMeta?.timestampSec ?? 0;
  const tEnd = playback.durationSec;

  return (
    <div
      data-testid="pointmap3d-viewer"
      className={`rounded-xl border border-white/[0.06] bg-black/40 overflow-hidden ${className ?? ""}`}
    >
      {/* Header strip ---------------------------------------------------- */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06] bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs uppercase tracking-wider text-white/60">{title}</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-white/30 font-mono">
          <span>{trace.model}</span>
          <span>·</span>
          <span>{trace.fps} fps</span>
          <span>·</span>
          <span>{playback.frameCount} frames</span>
          {trace.stubbed && (
            <>
              <span>·</span>
              <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                stub
              </span>
            </>
          )}
        </div>
      </div>

      {/* Canvas --------------------------------------------------------- */}
      <div style={{ height }} className="w-full bg-gradient-to-b from-[#020618] to-[#021416]">
        {hasFrames ? (
          <Canvas
            camera={{ position: [3, 2, 3], fov: 50, near: 0.01, far: 1000 }}
            dpr={[1, 2]}
            data-testid="pointmap3d-canvas"
          >
            <PointMap3DScene
              trace={trace}
              currentFrame={playback.currentFrame}
              showCameraPath={showCameraPath}
              showHelpers={showHelpers}
            />
          </Canvas>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-white/30">
            Trace has 0 frames.
          </div>
        )}
      </div>

      {/* Controls ------------------------------------------------------- */}
      <div className="px-4 py-3 space-y-2 border-t border-white/[0.06] bg-white/[0.02]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Reset to first frame"
            onClick={playback.reset}
            disabled={!hasFrames}
            className="w-7 h-7 rounded-md bg-white/[0.04] border border-white/[0.06] text-white/70 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <span aria-hidden className="text-[10px]">⏮</span>
          </button>
          <button
            type="button"
            aria-label="Step back one frame"
            onClick={() => playback.step(-1)}
            disabled={!hasFrames || playback.currentFrame === 0}
            className="w-7 h-7 rounded-md bg-white/[0.04] border border-white/[0.06] text-white/70 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <span aria-hidden className="text-[10px]">◀</span>
          </button>
          <button
            type="button"
            aria-label={playback.playing ? "Pause" : "Play"}
            onClick={playback.toggle}
            disabled={!hasFrames || playback.frameCount < 2}
            className="w-9 h-7 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <span aria-hidden className="text-[11px]">{playback.playing ? "❚❚" : "▶"}</span>
          </button>
          <button
            type="button"
            aria-label="Step forward one frame"
            onClick={() => playback.step(1)}
            disabled={!hasFrames || playback.currentFrame >= lastFrame}
            className="w-7 h-7 rounded-md bg-white/[0.04] border border-white/[0.06] text-white/70 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
          >
            <span aria-hidden className="text-[10px]">▶</span>
          </button>

          <span className="ml-2 text-[10px] font-mono text-white/40 min-w-[110px]">
            {formatTime(tNow)} / {formatTime(tEnd)}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-wider text-white/30" htmlFor="pm3d-rate">
              rate
            </label>
            <select
              id="pm3d-rate"
              value={playback.rate}
              onChange={onRateChange}
              className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-[11px] text-white/70 focus:outline-none focus:border-emerald-400/40"
            >
              {RATE_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}x</option>
              ))}
            </select>
          </div>
        </div>

        {/* Seek slider — single hi-res input across the full frame range. */}
        <div className="flex items-center gap-3">
          <input
            type="range"
            aria-label="Seek to frame"
            min={0}
            max={lastFrame}
            step={1}
            value={playback.currentFrame}
            onChange={onSeekChange}
            disabled={!hasFrames || playback.frameCount < 2}
            className="flex-1 accent-emerald-400 disabled:opacity-40"
          />
          <span className="text-[10px] font-mono text-white/50 min-w-[80px] text-right">
            frame {playback.currentFrame} / {lastFrame}
          </span>
        </div>

        {currentFrameMeta && (
          <div className="text-[10px] text-white/30 font-mono">
            {currentFrameMeta.points.length} points
            {typeof currentFrameMeta.meanConfidence === "number" && (
              <> · conf {currentFrameMeta.meanConfidence.toFixed(2)}</>
            )}
            {currentFrameMeta.cid && (
              <> · cid <span className="text-white/40">{currentFrameMeta.cid.slice(0, 24)}…</span></>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
