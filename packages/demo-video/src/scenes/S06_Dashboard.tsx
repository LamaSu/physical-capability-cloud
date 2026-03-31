/**
 * S06_Dashboard — "Global Access"
 *
 * 450 frames (15s). Clean, simple, well-spaced.
 * 5 text elements total. Max 5 on screen.
 *
 * Frame 0:   "OPEN ACCESS" SLAM — MONUMENT, 96px, C.fg
 * Frame 40:  "pip install pcc-node" — BRUTALIST, 64px, C.accent2
 * Frame 100: "Hardware auto-detect. Keys generated." — SWISS, 44px, C.muted
 * Frame 160: "Operator live in 30 minutes." — SWISS, 44px, C.muted
 * Frame 220: "34 countries. Fiat ramps. No gatekeepers." — EXPRESSIVE, 44px, C.fg
 * Frame 350: Dim over 100 frames
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
} from "remotion";
import { C, F, SIZE, smooth, slamScale, fadeUp } from "../lib";

export const S06_Dashboard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title SLAM at frame 0
  const titleP = smooth(frame, fps, 0);
  const titleScale = slamScale(frame, fps, 0, 2.5);

  // pip install at frame 40
  const pipFu = fadeUp(frame, fps, 40);

  // Line 1 at frame 100
  const line1Fu = fadeUp(frame, fps, 100);

  // Line 2 at frame 160
  const line2Fu = fadeUp(frame, fps, 160);

  // Line 3 at frame 220
  const line3Fu = fadeUp(frame, fps, 220);

  // End dim: frame 350 → 450
  const endDim =
    frame >= 350
      ? Math.max(0, 1 - (frame - 350) / 100)
      : 1;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 40,
        padding: "96px 128px",
        opacity: endDim,
        boxSizing: "border-box" as const,
        overflow: "hidden",
      }}
    >
      {/* OPEN ACCESS */}
      <div
        style={{
          opacity: Math.min(titleP * 5, 1),
          transform: `scale(${titleScale})`,
          transformOrigin: "left center",
        }}
      >
        <span
          style={{
            fontFamily: F.monument,
            fontSize: SIZE.title,
            fontWeight: 700,
            color: C.fg,
            textTransform: "uppercase" as const,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          OPEN ACCESS
        </span>
      </div>

      {/* pip install pcc-node */}
      <div
        style={{
          opacity: pipFu.opacity,
          transform: `translateY(${pipFu.y}px)`,
        }}
      >
        <span
          style={{
            fontFamily: F.brutalist,
            fontSize: SIZE.subtitle,
            fontWeight: 700,
            color: C.accent2,
            letterSpacing: "0.02em",
          }}
        >
          pip install pcc-node
        </span>
      </div>

      {/* Hardware auto-detect */}
      <div
        style={{
          opacity: line1Fu.opacity,
          transform: `translateY(${line1Fu.y}px)`,
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
          Hardware auto-detect. Keys generated.
        </span>
      </div>

      {/* Operator live in 30 minutes */}
      <div
        style={{
          opacity: line2Fu.opacity,
          transform: `translateY(${line2Fu.y}px)`,
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
          Operator live in 30 minutes.
        </span>
      </div>

      {/* 34 countries */}
      <div
        style={{
          opacity: line3Fu.opacity,
          transform: `translateY(${line3Fu.y}px)`,
        }}
      >
        <span
          style={{
            fontFamily: F.express,
            fontSize: SIZE.body,
            fontWeight: 300,
            color: C.fg,
          }}
        >
          34 countries. Fiat ramps. No gatekeepers.
        </span>
      </div>
    </AbsoluteFill>
  );
};

export default S06_Dashboard;
