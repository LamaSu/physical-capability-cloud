/**
 * RateSchedulePreviewChart — minimal placeholder.
 *
 * The full SVG line-chart implementation was scoped for impl-dashboard-publish-ui
 * but the agent rate-limited before it landed. This placeholder unblocks the
 * @pcc/dashboard build by satisfying the import in RateSchedulePublishPage.
 *
 * Resume target: render an SVG path of evaluateRateSchedule(schedule, ctx).bps
 * sampled at e.g. weekly intervals across a 24-month window, with one line per
 * segment kind for visual decomposition. See the agent prompt in
 * `C:\Users\globa\pcc-contributor-economics\ai\research\contributor-economics\99-resume-here.md`
 * (or this commit's parent context) for the full spec.
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

/**
 * PLACEHOLDER. Renders a textual summary of segment count + min/max bps so
 * the page is at least informative without the SVG chart.
 */
export function RateSchedulePreviewChart({
  segments,
  publishedAtSec,
  horizonSec = DEFAULT_HORIZON_SEC,
  sampleIntervalSec = DEFAULT_SAMPLE_INTERVAL_SEC,
}: RateSchedulePreviewChartProps): React.ReactElement {
  const totalSamples = Math.max(1, Math.floor(horizonSec / sampleIntervalSec));
  const stepSec = sampleIntervalSec;

  // Compute min/max bps across the window for a quick text summary.
  let minBps = Infinity;
  let maxBps = -Infinity;
  if (segments.length > 0) {
    const fakeSchedule = {
      version: 1,
      segments,
      publishedAt: new Date(publishedAtSec * 1000).toISOString(),
      scheduleHash:
        ("0x" + "0".repeat(64)) as `0x${string}`,
    };
    for (let i = 0; i <= totalSamples; i++) {
      const t = publishedAtSec + i * stepSec;
      try {
        const r = evaluateRateSchedule(fakeSchedule, {
          now: t,
          jobValueCents: 10_000, // $100 reference job
          jobsPerDay: 1,
        });
        if (r.bps < minBps) minBps = r.bps;
        if (r.bps > maxBps) maxBps = r.bps;
      } catch {
        // bad segments — skip in the placeholder
      }
    }
  }

  if (segments.length === 0) {
    return (
      <div className="rate-schedule-preview-placeholder text-sm opacity-70 italic">
        No segments yet — add at least one to preview the curve.
      </div>
    );
  }

  return (
    <div className="rate-schedule-preview-placeholder">
      <div className="text-sm">
        <strong>Preview (placeholder):</strong> {segments.length} segment
        {segments.length === 1 ? "" : "s"} over{" "}
        {Math.round(horizonSec / (30 * 86_400))} months. Bps range:{" "}
        {Number.isFinite(minBps) ? minBps : "?"} —{" "}
        {Number.isFinite(maxBps) ? maxBps : "?"}.
      </div>
      <div className="text-xs opacity-60 mt-1">
        SVG curve chart pending — see RateSchedulePreviewChart.tsx header for
        the resume spec.
      </div>
    </div>
  );
}
