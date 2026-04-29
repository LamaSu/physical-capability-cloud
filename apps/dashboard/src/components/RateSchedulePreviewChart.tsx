/**
 * RateSchedulePreviewChart — pure-SVG line chart of evaluateRateSchedule output.
 *
 * Renders a deterministic bps-over-time curve for a sealed RateSchedule. We
 * sample weekly (104 samples / 24 months by default) and compute bps via
 * `evaluateRateSchedule` from @pcc/spec — the SAME function the on-chain
 * settlement path uses, so the preview reflects the live curve byte-for-byte.
 *
 * Design choices:
 * - **Pure SVG, no chart library.** The dashboard bundle is already heavy
 *   from recharts + framer-motion; one curve doesn't justify a recharts
 *   instance. Hand-rolled SVG with mounting via React keeps it ~80 LOC.
 * - **Theme**: emerald accents (matches Solarpunk Ground Control), white/X
 *   gridlines, slate axis labels.
 * - **Synthetic context** for adoption-indexed/piecewise-value/capture-class-
 *   indexed segments: jobsPerDay=100, jobValueCents=10000 ($100), captureClass
 *   omitted (those segments fall back to `default`). Documented in the page.
 * - **Tooltip**: skipped in MVP (TODO comment below). Cursor-on-curve
 *   tooltips would need invisible <rect> overlays + onMouseMove + a state
 *   ref; the curve's enough information to validate a schedule visually.
 *
 * Input contract is identical to the placeholder.
 */
import React from "react";
import { evaluateRateSchedule, type RateSegment } from "@pcc/spec";

export interface RateSchedulePreviewChartProps {
  segments: RateSegment[];
  publishedAtSec: number;
  /** Window length in seconds. Defaults to ~24 months from publishedAtSec. */
  horizonSec?: number;
  /** Defaults to weekly samples (604_800 seconds). */
  sampleIntervalSec?: number;
}

const DEFAULT_HORIZON_SEC = 24 * 30 * 86_400; // ~24 months
const DEFAULT_SAMPLE_INTERVAL_SEC = 7 * 86_400; // weekly
const ONE_MONTH_SEC = 30 * 86_400;

// SVG viewBox dimensions. We render in a fixed coordinate space and let CSS
// scale the SVG to the container width (preserveAspectRatio="none").
const VB_W = 600;
const VB_H = 220;
const PAD_L = 38; // left axis label gutter
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24; // bottom axis label gutter
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;

/** Compute (timeSec, bps) sample pairs for the schedule across the horizon. */
function sampleCurve(
  segments: RateSegment[],
  publishedAtSec: number,
  horizonSec: number,
  sampleIntervalSec: number,
): { t: number; bps: number }[] {
  // Empty / invalid → no points.
  if (segments.length === 0) return [];

  // We construct a synthetic RateSchedule because evaluateRateSchedule wants
  // the wrapping shape (we don't actually need a real hash for evaluation —
  // the function only reads schedule.segments).
  const fakeSchedule = {
    version: 1,
    segments,
    publishedAt: new Date(publishedAtSec * 1000).toISOString(),
    scheduleHash: ("0x" + "0".repeat(64)) as `0x${string}`,
  };

  const samples: { t: number; bps: number }[] = [];
  const totalSamples = Math.max(1, Math.floor(horizonSec / sampleIntervalSec));
  for (let i = 0; i <= totalSamples; i++) {
    const t = publishedAtSec + i * sampleIntervalSec;
    try {
      const r = evaluateRateSchedule(fakeSchedule, {
        now: t,
        jobValueCents: 10_000, // $100 reference job
        jobsPerDay: 100, // moderate adoption assumption
      });
      samples.push({ t, bps: r.bps });
    } catch {
      // Bad segments → 0 bps point so the line doesn't disappear silently.
      samples.push({ t, bps: 0 });
    }
  }
  return samples;
}

/**
 * Build the SVG <path> "d" attribute from samples. Linear segments between
 * adjacent points (no smoothing — bps is piecewise so straight lines are
 * the *honest* representation, especially at segment-boundary cliffs).
 */
function buildPathD(
  samples: { t: number; bps: number }[],
  publishedAtSec: number,
  horizonSec: number,
  yMax: number,
): string {
  if (samples.length === 0) return "";
  const xOf = (t: number) =>
    PAD_L + ((t - publishedAtSec) / horizonSec) * PLOT_W;
  // Y is inverted: 0 bps at PAD_T+PLOT_H, yMax at PAD_T.
  const yOf = (bps: number) =>
    PAD_T + PLOT_H - (yMax > 0 ? (bps / yMax) * PLOT_H : 0);

  const cmds: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const { t, bps } = samples[i];
    cmds.push(`${i === 0 ? "M" : "L"}${xOf(t).toFixed(1)},${yOf(bps).toFixed(1)}`);
  }
  return cmds.join(" ");
}

/**
 * X-axis label tick positions (months). For a 24-month horizon: 0, 6, 12, 18, 24.
 * For shorter/longer windows we adapt to roughly 4-6 ticks.
 */
function xAxisTicks(horizonSec: number): { sec: number; label: string }[] {
  const months = horizonSec / ONE_MONTH_SEC;
  // Aim for ~5 ticks. Use months as the unit when months >= 1; otherwise weeks.
  if (months >= 4) {
    const stepMonths = Math.max(1, Math.round(months / 5));
    const ticks: { sec: number; label: string }[] = [];
    for (let m = 0; m <= months; m += stepMonths) {
      ticks.push({ sec: m * ONE_MONTH_SEC, label: m === 0 ? "0" : `${m}mo` });
    }
    return ticks;
  }
  // Fallback for tiny horizons — sub-month, label in days.
  const days = horizonSec / 86_400;
  const stepDays = Math.max(1, Math.round(days / 5));
  const ticks: { sec: number; label: string }[] = [];
  for (let d = 0; d <= days; d += stepDays) {
    ticks.push({ sec: d * 86_400, label: d === 0 ? "0" : `${d}d` });
  }
  return ticks;
}

export function RateSchedulePreviewChart({
  segments,
  publishedAtSec,
  horizonSec = DEFAULT_HORIZON_SEC,
  sampleIntervalSec = DEFAULT_SAMPLE_INTERVAL_SEC,
}: RateSchedulePreviewChartProps): React.ReactElement {
  // Empty state — no segments yet.
  if (segments.length === 0) {
    return (
      <div className="rate-schedule-preview-empty text-xs text-white/40 italic py-8 text-center">
        No segments yet — add at least one to preview the curve.
      </div>
    );
  }

  // Sample the curve (memoized so we don't re-sample on every render).
  const samples = React.useMemo(
    () => sampleCurve(segments, publishedAtSec, horizonSec, sampleIntervalSec),
    [segments, publishedAtSec, horizonSec, sampleIntervalSec],
  );

  // Compute Y-axis max with a small headroom so the curve doesn't kiss the
  // top edge. Round up to a clean number (50, 100, 250, 500, 1000, 2500,
  // 5000, 10000) for nicer gridline labels.
  const observedMax = samples.reduce((m, s) => (s.bps > m ? s.bps : m), 0);
  const niceSteps = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
  const yMax =
    observedMax === 0
      ? 100
      : niceSteps.find((step) => step >= observedMax * 1.1) ?? 10_000;

  const pathD = buildPathD(samples, publishedAtSec, horizonSec, yMax);

  // Gridline values: 25%, 50%, 75%, 100% of yMax.
  const gridlines = [0.25, 0.5, 0.75, 1.0].map((frac) => ({
    bps: yMax * frac,
    y: PAD_T + PLOT_H - frac * PLOT_H,
  }));

  const xTicks = xAxisTicks(horizonSec);

  // Bps range for the title tag.
  const bpsRange =
    samples.length > 0
      ? {
          min: Math.min(...samples.map((s) => s.bps)),
          max: Math.max(...samples.map((s) => s.bps)),
        }
      : { min: 0, max: 0 };

  return (
    <div className="rate-schedule-preview">
      <div className="text-[10px] text-white/30 mb-1 flex items-center justify-between">
        <span>{samples.length} samples · weekly</span>
        <span className="font-mono">
          {bpsRange.min} – {bpsRange.max} bps
        </span>
      </div>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="w-full h-48 block"
        role="img"
        aria-label={`Rate schedule preview: ${segments.length} segment${segments.length === 1 ? "" : "s"}, ${bpsRange.min}-${bpsRange.max} bps`}
      >
        {/* Gridlines (4 horizontal) */}
        {gridlines.map((g, i) => (
          <line
            key={`grid-${i}`}
            x1={PAD_L}
            x2={PAD_L + PLOT_W}
            y1={g.y}
            y2={g.y}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
            strokeDasharray="2,3"
          />
        ))}

        {/* Y-axis labels (right of gridlines) */}
        {gridlines.map((g, i) => (
          <text
            key={`ylabel-${i}`}
            x={PAD_L - 4}
            y={g.y + 3}
            textAnchor="end"
            fontSize={9}
            fill="rgba(255,255,255,0.35)"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
          >
            {Math.round(g.bps)}
          </text>
        ))}

        {/* Y=0 baseline (slightly stronger) */}
        <line
          x1={PAD_L}
          x2={PAD_L + PLOT_W}
          y1={PAD_T + PLOT_H}
          y2={PAD_T + PLOT_H}
          stroke="rgba(255,255,255,0.18)"
          strokeWidth={1}
        />

        {/* X-axis labels */}
        {xTicks.map((tick, i) => {
          const x = PAD_L + (tick.sec / horizonSec) * PLOT_W;
          return (
            <g key={`xtick-${i}`}>
              <line
                x1={x}
                x2={x}
                y1={PAD_T + PLOT_H}
                y2={PAD_T + PLOT_H + 3}
                stroke="rgba(255,255,255,0.18)"
                strokeWidth={1}
              />
              <text
                x={x}
                y={PAD_T + PLOT_H + 14}
                textAnchor="middle"
                fontSize={9}
                fill="rgba(255,255,255,0.35)"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
              >
                {tick.label}
              </text>
            </g>
          );
        })}

        {/* Curve fill (subtle area under the line) */}
        {pathD && samples.length > 1 && (
          <path
            d={
              pathD +
              ` L${(PAD_L + PLOT_W).toFixed(1)},${(PAD_T + PLOT_H).toFixed(1)}` +
              ` L${PAD_L.toFixed(1)},${(PAD_T + PLOT_H).toFixed(1)} Z`
            }
            fill="rgba(16, 185, 129, 0.08)"
            stroke="none"
          />
        )}

        {/* Curve stroke */}
        <path
          d={pathD}
          fill="none"
          stroke="#10b981"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {/* TODO: hover tooltip with (month, bps) for the closest sample. Skipped
          for MVP — mouse-tracking + invisible-rect overlay can come in a
          follow-up if reviewers want it. */}
    </div>
  );
}
