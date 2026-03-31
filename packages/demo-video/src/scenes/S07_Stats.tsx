/**
 * S07_Stats — "Scale Proof"
 *
 * 360 frames (12s). 4 metrics, one at a time, 90 frames each.
 *
 * Metric 1 (0-90):   countTo(3300)+  "TESTS PASSING"
 *   Number starts C.discord, transitions to C.accent1 over 30 frames.
 *   Discord use #3 — discord-to-resolution arc.
 *
 * Metric 2 (90-180):  countTo(154)   "AGENT TOOLS"   C.accent2
 * Metric 3 (180-270): countTo(347)   "API ENDPOINTS" C.gold
 * Metric 4 (270-360): "APACHE 2.0"   "OPEN FOREVER"  C.accent1
 *
 * Previous metrics stack above at smaller size + reduced opacity.
 *
 * Design rules enforced:
 * - Min font 36px
 * - Max 5 elements on screen
 * - bg #050a0e
 * - Safe margins: 128px left/right, 96px top/bottom
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import { C, F, SIZE, smooth, fadeUp, countTo } from "../lib";

interface MetricConfig {
  type: "counter" | "text";
  value?: number;
  suffix?: string;
  text?: string;
  color: string;
  label: string;
}

const METRICS: MetricConfig[] = [
  {
    type: "counter",
    value: 3300,
    suffix: "+",
    color: C.accent1, // starts discord, animates to accent1
    label: "TESTS PASSING",
  },
  {
    type: "counter",
    value: 154,
    color: C.accent2,
    label: "AGENT TOOLS",
  },
  {
    type: "counter",
    value: 347,
    color: C.gold,
    label: "API ENDPOINTS",
  },
  {
    type: "text",
    text: "APACHE 2.0",
    color: C.accent1,
    label: "OPEN FOREVER",
  },
];

/** A single metric row — used for the "stack above" previous metrics */
const MetricRow: React.FC<{
  metric: MetricConfig;
  index: number;        // which metric (0-3)
  activeIndex: number;  // which metric is currently center-stage
  frame: number;
  fps: number;
}> = ({ metric, index, activeIndex, frame, fps }) => {
  const isActive = index === activeIndex;
  const isPast = index < activeIndex;

  if (index > activeIndex) return null;

  // Active metric: enter from below, centered, large
  // Past metrics: stack above at smaller size
  const metricStartFrame = index * 90;
  const p = smooth(frame, fps, metricStartFrame);
  const fu = fadeUp(frame, fps, metricStartFrame);

  // Past metric: shrink + move up + reduce opacity
  const distanceAbove = activeIndex - index; // 1, 2, 3...
  const pastScale = isActive ? 1 : Math.max(0.5, 1 - distanceAbove * 0.18);
  const pastOpacity = isActive ? 1 : Math.max(0.15, 0.6 - distanceAbove * 0.2);

  // Counter value
  let displayValue = "";
  if (metric.type === "counter" && metric.value !== undefined) {
    // Count over 60 frames starting at metricStartFrame
    const counted = countTo(frame, metric.value, 60, metricStartFrame);
    displayValue = counted.toString() + (metric.suffix ?? "");
  } else if (metric.type === "text" && metric.text) {
    displayValue = metric.text;
  }

  // Metric 1: color transitions from discord → accent1 over frames 0-30
  let numberColor = metric.color;
  if (index === 0) {
    numberColor = frame < 30
      ? C.discord
      : interpolate(frame, [0, 30], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        }) >= 1
        ? C.accent1
        : C.discord;
    // Smooth color transition via opacity layering is complex, use simple threshold
    if (frame >= 30) numberColor = C.accent1;
    else numberColor = C.discord;
  }

  // Layout: active is centered, past ones stack above
  const translateY = isActive
    ? fu.y
    : 0;
  const opacity = isActive
    ? p
    : isPast
    ? pastOpacity
    : 0;

  const numberSize = isActive ? SIZE.data + 40 : Math.round((SIZE.data + 40) * pastScale);
  const labelSize = isActive ? SIZE.label : Math.round(SIZE.label * pastScale);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: isActive ? 12 : 6,
        opacity,
        transform: `translateY(${translateY}px)`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontFamily: metric.type === "text" ? F.monument : F.brutalist,
          fontSize: numberSize,
          fontWeight: 700,
          color: numberColor,
          lineHeight: 1,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
          textTransform: metric.type === "text" ? "uppercase" as const : undefined,
        }}
      >
        {displayValue}
      </span>
      <span
        style={{
          fontFamily: F.swiss,
          fontSize: labelSize,
          fontWeight: 400,
          color: C.muted,
          letterSpacing: "0.12em",
          textTransform: "uppercase" as const,
        }}
      >
        {metric.label}
      </span>
    </div>
  );
};

export const S07_Stats: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Which metric is active (center stage)
  const activeIndex = Math.min(3, Math.floor(frame / 90));

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "96px 128px",
        gap: 28,
        boxSizing: "border-box" as const,
        overflow: "hidden",
      }}
    >
      {/* Render all metrics that have appeared so far, stacked */}
      {METRICS.map((metric, i) => (
        <MetricRow
          key={i}
          metric={metric}
          index={i}
          activeIndex={activeIndex}
          frame={frame}
          fps={fps}
        />
      ))}
    </AbsoluteFill>
  );
};

export default S07_Stats;
