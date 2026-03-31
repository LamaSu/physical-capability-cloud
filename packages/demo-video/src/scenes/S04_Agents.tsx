/**
 * S04_Agents — "The Agents"
 *
 * 540 frames (18 seconds). A2A intent flow as terminal stream.
 *
 * Frame 0:      Title "AGENT PROTOCOL" — MONUMENT, SIZE.title (96px), C.accent2. Slam entrance.
 * Frame 30:     Label "34 typed A2A intents" — SWISS, SIZE.label (36px), C.muted.
 * Frame 70-440: Terminal panel. A2A_FLOW entries appear one by one in BRUTALIST, SIZE.label.
 *               Format: [FROM] → [TO]: INTENT_NAME
 *               FROM/TO in entry's color. Intent in C.fg.
 *               Stagger: 50 frames per entry. Entries accumulate.
 * Frame 460:    "No middleware. No chat. Typed contracts." — EXPRESSIVE, SIZE.body, C.fg.
 * Frame 490:    Dim over 50 frames.
 *
 * DESIGN RULES:
 * - Min font: SIZE.label = 36px
 * - Max 5 elements on screen (title + label + terminal panel + bottom text = 4 max)
 * - bg: #050a0e
 * - No discord use in this scene
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, Easing } from "remotion";
import { C, F, SIZE, slam, slamScale, smooth } from "../lib";
import { A2A_FLOW } from "../lib";

export const S04_Agents: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Title slam (frame 0) ─────────────────────────────────────────────────
  const titleScale = slamScale(frame, fps, 0, 2.5);
  const titleProgress = slam(frame, fps, 0);
  const titleOpacity = Math.min(titleProgress * 6, 1);

  // ── Subtitle label (frame 30) ────────────────────────────────────────────
  const labelP = smooth(frame, fps, 30);
  const labelOpacity = labelP;
  const labelY = interpolate(labelP, [0, 1], [16, 0]);

  // ── Terminal entries (frame 70, stagger 50) ──────────────────────────────
  // Entry i visible at frame 70 + i * 50
  const visibleEntries = A2A_FLOW.filter(
    (_, i) => frame >= 70 + i * 50
  );

  // Per-entry fade opacity for the latest entry
  const entryOpacities = A2A_FLOW.map((_, i) => {
    const entryStart = 70 + i * 50;
    const p = smooth(frame, fps, entryStart);
    return p;
  });

  // ── Bottom callout (frame 460) ───────────────────────────────────────────
  const calloutP = smooth(frame, fps, 460);
  const calloutOpacity = calloutP;
  const calloutY = interpolate(calloutP, [0, 1], [20, 0]);

  // ── End dim (frame 490-540) ──────────────────────────────────────────────
  const endDim = interpolate(frame, [490, 540], [1, 0], {
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
        gap: 24,
        opacity: endDim,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontFamily: F.monument,
          fontSize: SIZE.title,
          fontWeight: 700,
          color: C.accent2,
          textTransform: "uppercase" as const,
          letterSpacing: "-0.02em",
          lineHeight: 1.0,
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          transformOrigin: "left center",
          textShadow: `0 0 40px rgba(0,212,255,0.5), 0 0 80px rgba(0,212,255,0.2)`,
        }}
      >
        AGENT PROTOCOL
      </div>

      {/* Subtitle label */}
      <div
        style={{
          fontFamily: F.swiss,
          fontSize: SIZE.label,
          fontWeight: 400,
          color: C.muted,
          letterSpacing: "0.08em",
          opacity: labelOpacity,
          transform: `translateY(${labelY}px)`,
        }}
      >
        34 typed A2A intents
      </div>

      {/* Terminal panel */}
      <div
        style={{
          flex: 1,
          backgroundColor: C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 12,
          padding: "28px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          overflow: "hidden",
        }}
      >
        {A2A_FLOW.map((entry, i) => {
          const isVisible = frame >= 70 + i * 50;
          if (!isVisible) return null;

          const entryOpacity = entryOpacities[i];

          return (
            <div
              key={i}
              style={{
                fontFamily: F.brutalist,
                fontSize: SIZE.label,
                fontWeight: 400,
                lineHeight: 1.4,
                display: "flex",
                alignItems: "center",
                gap: 0,
                opacity: entryOpacity,
              }}
            >
              {/* FROM */}
              <span style={{ color: entry.color, fontWeight: 700 }}>
                {entry.from}
              </span>

              {/* Arrow */}
              <span style={{ color: C.muted, margin: "0 12px" }}>→</span>

              {/* TO */}
              <span style={{ color: entry.color, fontWeight: 700 }}>
                {entry.to}
              </span>

              {/* Separator */}
              <span style={{ color: C.border, margin: "0 12px" }}>:</span>

              {/* Intent */}
              <span style={{ color: C.fg }}>
                {entry.intent}
              </span>
            </div>
          );
        })}
      </div>

      {/* Bottom callout */}
      <div
        style={{
          fontFamily: F.express,
          fontSize: SIZE.body,
          fontWeight: 300,
          color: C.fg,
          letterSpacing: "0.01em",
          opacity: calloutOpacity,
          transform: `translateY(${calloutY}px)`,
        }}
      >
        No middleware. No chat. Typed contracts.
      </div>
    </AbsoluteFill>
  );
};

export default S04_Agents;
