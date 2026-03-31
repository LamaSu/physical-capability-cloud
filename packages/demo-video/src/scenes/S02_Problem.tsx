/**
 * S02_Problem — "The $40,000 HPLC Run"
 *
 * 540 frames (18 seconds). Two-panel contrast. Left = broken world. Right = PCC.
 *
 * Frame 0:      Title "The $40,000 HPLC Run" — EXPRESSIVE, SIZE.subtitle (64px),
 *               C.fg, centered. Fade in over 30 frames.
 * Frame 60:     LEFT PANEL — BRUTALIST header, C.discord. ← DISCORD USE #1 for scenes 1-4.
 *               3 bullets stagger in (30 frames apart).
 * Frame 180:    RIGHT PANEL — MONUMENT header, C.accent1.
 *               3 bullets stagger in.
 * Frame 420:    Both panels visible. Hold. Let judges READ.
 * Frame 480:    Dim over 60 frames.
 *
 * DESIGN RULES:
 * - Min font: SIZE.label = 36px
 * - Max 5 elements visible at once (stagger enforces this)
 * - Discord used exactly ONCE: left panel header border + text
 * - bg: #050a0e throughout
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, Easing } from "remotion";
import { C, F, SIZE, smooth } from "../lib";

const LEFT_BULLETS = [
  "3 months of procurement",
  "3 NDAs, 2 site visits",
  "No composable proof",
];

const RIGHT_BULLETS = [
  "47 seconds to match",
  "Cryptographic evidence",
  "1.5% protocol fee",
];

function fadeInAt(frame: number, fps: number, delay: number) {
  const p = smooth(frame, fps, delay);
  return {
    opacity: p,
    transform: `translateY(${interpolate(p, [0, 1], [20, 0])}px)`,
  };
}

export const S02_Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Title fade in ────────────────────────────────────────────────────────
  const titleStyle = fadeInAt(frame, fps, 0);

  // ── Left panel appears at frame 60 ──────────────────────────────────────
  const leftHeaderStyle = fadeInAt(frame, fps, 60);

  // Left bullets stagger: 90, 120, 150
  const leftBullet1 = fadeInAt(frame, fps, 90);
  const leftBullet2 = fadeInAt(frame, fps, 120);
  const leftBullet3 = fadeInAt(frame, fps, 150);

  // ── Right panel appears at frame 180 ────────────────────────────────────
  const rightHeaderStyle = fadeInAt(frame, fps, 180);

  // Right bullets stagger: 210, 240, 270
  const rightBullet1 = fadeInAt(frame, fps, 210);
  const rightBullet2 = fadeInAt(frame, fps, 240);
  const rightBullet3 = fadeInAt(frame, fps, 270);

  // ── End dim ──────────────────────────────────────────────────────────────
  const endDim = interpolate(frame, [480, 540], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  const leftBulletStyles = [leftBullet1, leftBullet2, leftBullet3];
  const rightBulletStyles = [rightBullet1, rightBullet2, rightBullet3];

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        padding: "96px 128px",
        display: "flex",
        flexDirection: "column",
        opacity: endDim,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontFamily: F.express,
          fontSize: SIZE.subtitle,
          fontWeight: 300,
          color: C.fg,
          textAlign: "center",
          letterSpacing: "0.01em",
          marginBottom: 64,
          ...titleStyle,
        }}
      >
        The $40,000 HPLC Run
      </div>

      {/* Two-panel layout */}
      <div
        style={{
          flex: 1,
          display: "flex",
          gap: 0,
          alignItems: "flex-start",
        }}
      >
        {/* LEFT PANEL — 45% width */}
        <div
          style={{
            width: "45%",
            paddingRight: 48,
            borderLeft: `3px solid ${C.discord}`,
            paddingLeft: 32,
          }}
        >
          {/* Left header — DISCORD USE #1 */}
          <div
            style={{
              fontFamily: F.brutalist,
              fontSize: SIZE.label,
              fontWeight: 700,
              color: C.discord,
              letterSpacing: "0.12em",
              textTransform: "uppercase" as const,
              marginBottom: 32,
              ...leftHeaderStyle,
            }}
          >
            THE OLD WAY
          </div>

          {/* Left bullets */}
          {LEFT_BULLETS.map((bullet, i) => (
            <div
              key={i}
              style={{
                fontFamily: F.swiss,
                fontSize: SIZE.label,
                fontWeight: 400,
                color: C.muted,
                lineHeight: 1.5,
                marginBottom: 20,
                ...leftBulletStyles[i],
              }}
            >
              — {bullet}
            </div>
          ))}
        </div>

        {/* Divider */}
        <div
          style={{
            width: 1,
            alignSelf: "stretch",
            background: C.border,
            flexShrink: 0,
          }}
        />

        {/* RIGHT PANEL — 55% width */}
        <div
          style={{
            width: "55%",
            paddingLeft: 48,
            borderLeft: `3px solid ${C.accent1}`,
          }}
        >
          {/* Right header */}
          <div
            style={{
              fontFamily: F.monument,
              fontSize: SIZE.label,
              fontWeight: 700,
              color: C.accent1,
              letterSpacing: "0.12em",
              textTransform: "uppercase" as const,
              marginBottom: 32,
              ...rightHeaderStyle,
            }}
          >
            PCC
          </div>

          {/* Right bullets */}
          {RIGHT_BULLETS.map((bullet, i) => (
            <div
              key={i}
              style={{
                fontFamily: F.swiss,
                fontSize: SIZE.label,
                fontWeight: 400,
                color: C.fg,
                lineHeight: 1.5,
                marginBottom: 20,
                ...rightBulletStyles[i],
              }}
            >
              — {bullet}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default S02_Problem;
