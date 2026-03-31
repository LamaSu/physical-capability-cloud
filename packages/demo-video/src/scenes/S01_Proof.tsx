/**
 * S01_Proof — "The Cold Open"
 *
 * 600 frames (20 seconds). Opens on proof, not on a problem.
 *
 * Frame 0-30:   Pure black. Silence.
 * Frame 30:     Evidence anchor command types in — BRUTALIST, 48px, accent1.
 *               Cursor blinks in discord. 1.5 chars/frame.
 * Frame 90:     Line complete. Hold 1 second.
 * Frame 120:    3-frame white flash.
 * Frame 123:    "PCC" SLAMS in — SIZE.hero, MONUMENT, accent1, slamScale 2.5x.
 *               Neon glow shadow. Breathing after settle.
 * Frame 180:    "Physical Capability Cloud" — EXPRESSIVE, SIZE.body, fg.
 * Frame 240:    "CAPABILITY NETWORK" — SWISS, SIZE.label, muted.
 * Frame 500:    Begin dim to 0 over 100 frames.
 *
 * Background: radial glow behind PCC (accent1 at 0.06 opacity).
 *
 * DESIGN RULES:
 * - Min font: 36px (SIZE.label)
 * - Max 5 elements on screen at any time
 * - bg: #050a0e (never pure black except frame 0-30 intentional pause)
 * - Discord (#ff0066) used ONCE total in scenes 1-4 (cursor only)
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill, interpolate, Easing } from "remotion";
import { C, F, SIZE, smooth, slamScale, flash, breathe } from "../lib";

const CMD = '> evidence.anchor("bafy...xq7r")';

export const S01_Proof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Pure black opening ───────────────────────────────────────────────────
  if (frame < 30) {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  // ── Typewriter ───────────────────────────────────────────────────────────
  const charsTyped = Math.min(
    Math.floor((frame - 30) * 1.5),
    CMD.length
  );
  const displayCmd = CMD.slice(0, charsTyped);
  const cmdComplete = charsTyped >= CMD.length;
  const cursorVisible = Math.sin((frame - 30) * 0.4) > 0;

  // ── Flash at frame 120 ───────────────────────────────────────────────────
  const flashOpacity = flash(frame, 120, 3);

  // ── PCC slam (starts frame 123) ──────────────────────────────────────────
  const pccScale = slamScale(frame, fps, 123, 2.5);
  const pccProgress = smooth(frame, fps, 123);
  const pccOpacity = Math.min(pccProgress * 8, 1);
  const pccBreathe = breathe(frame, fps, 0.97, 1.03);

  // ── Subtitle fade in (frame 180) ─────────────────────────────────────────
  const subtitleProgress = smooth(frame, fps, 180);
  const subtitleOpacity = interpolate(subtitleProgress, [0, 1], [0, 1]);
  const subtitleY = interpolate(subtitleProgress, [0, 1], [20, 0]);

  // ── Label fade in (frame 240) ────────────────────────────────────────────
  const labelProgress = smooth(frame, fps, 240);
  const labelOpacity = interpolate(labelProgress, [0, 1], [0, 1]);
  const labelY = interpolate(labelProgress, [0, 1], [16, 0]);

  // ── End dim (frame 500-600) ──────────────────────────────────────────────
  const endDim = interpolate(frame, [500, 600], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ backgroundColor: C.bg }}>

      {/* Radial glow behind PCC */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse 800px 600px at 50% 45%, rgba(0,255,136,0.06) 0%, transparent 65%)`,
          pointerEvents: "none",
        }}
      />

      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "flex-start",
          padding: "96px 128px",
          opacity: endDim,
        }}
      >
        {/* Terminal command line */}
        <div
          style={{
            fontFamily: F.brutalist,
            fontSize: 48,
            fontWeight: 400,
            color: C.accent1,
            letterSpacing: "0.02em",
            lineHeight: 1.4,
            marginBottom: 0,
          }}
        >
          {displayCmd}
          {!cmdComplete && cursorVisible && (
            <span style={{ color: C.discord }}>▌</span>
          )}
          {cmdComplete && (
            <span style={{ color: C.discord, opacity: cursorVisible ? 1 : 0 }}>▌</span>
          )}
        </div>

        {/* PCC hero — centered in remaining space */}
        <div
          style={{
            flex: 1,
            width: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 24,
          }}
        >
          {/* PCC */}
          <div
            style={{
              fontFamily: F.monument,
              fontSize: SIZE.hero,
              fontWeight: 700,
              color: C.accent1,
              textTransform: "uppercase" as const,
              letterSpacing: "-0.02em",
              lineHeight: 1.0,
              opacity: pccOpacity,
              transform: `scale(${pccScale * pccBreathe})`,
              textShadow: `
                0 0 60px rgba(0,255,136,0.8),
                0 0 120px rgba(0,255,136,0.4),
                0 0 200px rgba(0,255,136,0.15)
              `,
            }}
          >
            PCC
          </div>

          {/* Physical Capability Cloud */}
          <div
            style={{
              fontFamily: F.express,
              fontSize: SIZE.body,
              fontWeight: 300,
              color: C.fg,
              letterSpacing: "0.01em",
              opacity: subtitleOpacity,
              transform: `translateY(${subtitleY}px)`,
            }}
          >
            Physical Capability Cloud
          </div>

          {/* CAPABILITY NETWORK label */}
          <div
            style={{
              fontFamily: F.swiss,
              fontSize: SIZE.label,
              fontWeight: 400,
              color: C.muted,
              letterSpacing: "0.22em",
              textTransform: "uppercase" as const,
              opacity: labelOpacity,
              transform: `translateY(${labelY}px)`,
            }}
          >
            CAPABILITY NETWORK
          </div>
        </div>
      </AbsoluteFill>

      {/* White flash overlay */}
      {flashOpacity > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(255,255,255,${flashOpacity * 0.9})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S01_Proof;
