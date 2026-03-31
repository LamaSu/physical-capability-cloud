/**
 * S02_Problem — "The Problem"
 *
 * 540 frames (18s). States what's broken, simply.
 *
 * Frame 0:   "Physical work is trapped behind" — EXPRESSIVE, fade in
 * Frame 60:  "brokers, procurement, and paperwork" — MONUMENT, accent1
 * Frame 150: Three lines stagger in:
 *            "Uber takes 40% from drivers"
 *            "Xometry takes 34.5% from manufacturers"
 *            "$9 billion in NIH grants → admin, not research"
 * Frame 380: "What if operators kept what they earned?" — EXPRESSIVE, accent1
 * Frame 480: Dim
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, Easing } from "remotion";
import { C, F, SIZE, smooth, fadeUp } from "../lib";

const PAIN_POINTS = [
  { text: "Uber takes 40% from drivers", source: "NELP, 2025" },
  { text: "Xometry takes 34.5% from manufacturers", source: "Q4 2024 earnings" },
  { text: "$9B in NIH grants goes to admin, not research", source: "NIH FY2023" },
];

export const S02_Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const line1 = fadeUp(frame, fps, 0);
  const line2 = fadeUp(frame, fps, 60);
  const question = fadeUp(frame, fps, 380);

  const endDim = interpolate(frame, [480, 540], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 48,
        opacity: endDim,
      }}
    >
      {/* Line 1 */}
      <div
        style={{
          fontFamily: F.express,
          fontSize: SIZE.subtitle,
          fontWeight: 300,
          color: C.fg,
          opacity: line1.opacity,
          transform: `translateY(${line1.y}px)`,
        }}
      >
        Physical work is trapped behind
      </div>

      {/* Line 2 — the punch */}
      <div
        style={{
          fontFamily: F.monument,
          fontSize: SIZE.title,
          fontWeight: 700,
          color: C.discord,
          textTransform: "uppercase" as const,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          opacity: line2.opacity,
          transform: `translateY(${line2.y}px)`,
        }}
      >
        BROKERS AND OVERHEAD
      </div>

      {/* Pain points */}
      <div style={{ display: "flex", flexDirection: "column", gap: 24, marginTop: 16 }}>
        {PAIN_POINTS.map((point, i) => {
          const fu = fadeUp(frame, fps, 150 + i * 50);
          return (
            <div
              key={i}
              style={{
                opacity: fu.opacity,
                transform: `translateY(${fu.y}px)`,
                display: "flex",
                alignItems: "baseline",
                gap: 16,
              }}
            >
              <span
                style={{
                  fontFamily: F.swiss,
                  fontSize: SIZE.body,
                  fontWeight: 400,
                  color: C.muted,
                }}
              >
                {point.text}
              </span>
            </div>
          );
        })}
      </div>

      {/* The question */}
      <div
        style={{
          fontFamily: F.express,
          fontSize: SIZE.body,
          fontWeight: 300,
          color: C.accent1,
          opacity: question.opacity,
          transform: `translateY(${question.y}px)`,
          marginTop: 32,
        }}
      >
        What if operators kept what they earned?
      </div>
    </AbsoluteFill>
  );
};

export default S02_Problem;
