/**
 * S07_Stats — "THE PROOF"
 *
 * 750 frames (25 seconds). Judge target: Molly Mackinlay (engineering rigor),
 * Brad Holden (traction), Benjamin Lavergne (infrastructure).
 *
 * This scene proves PCC is REAL. Slow, reverent. Text IS the design.
 *
 * Frame 0-60:   Pure black, then ANCIENT_LINES revealed slowly.
 *   Line 0 "Every machine."      — Expressive thin, 56px, accent1. Fade frame 0.
 *   Line 1 "Every lab."          — Same style, frame 60.
 *   Line 2 "Every factory on Earth." — Same, 60px, frame 120.
 *   Line 3 "Just became"         — Editorial italic, 48px, accent2, frame 210.
 *   Line 4 "a programmable endpoint." — Monument bold, 52px, emerald, frame 280.
 *
 * Frame 350-620: 6 stats slam in vertically — 45 frames apart.
 *   Each: Brutalist value (64px, stat color) + Swiss label (14px tracked uppercase muted).
 *
 * Frame 670:   "$3.5T" extra-large emphasised version (96px, gold, breathing glow).
 *
 * Frame 720:   Dim over 30 frames.
 *
 * Background: CODE_FRAGMENTS floating, drifting with noise2D.
 *
 * Voices: Expressive (first 3 lines), Editorial ("Just became"),
 *         Monument (climax + $3.5T), Brutalist (stat values + code),
 *         Swiss (stat labels)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import { noise2D } from "@remotion/noise";
import {
  COLORS,
  FONTS,
  CODE_FRAGMENTS,
  SLAM_STATS,
  ANCIENT_LINES,
  breathe,
  slamSpring,
} from "../lib";

/** Slowly-revealed revelation line */
const RevelationLine: React.FC<{
  text: string;
  startFrame: number;
  fontSize?: number;
  fontFamily: string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  color: string;
  isClimax?: boolean;
}> = ({
  text,
  startFrame,
  fontSize = 94,
  fontFamily,
  fontWeight = 400,
  fontStyle = "normal",
  color,
  isClimax = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [startFrame, startFrame + 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const translateY = interpolate(
    frame,
    [startFrame, startFrame + 30],
    [20, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    },
  );

  const glowIntensity =
    isClimax && frame > startFrame + 30
      ? breathe(frame, fps, 0.4, 0.7, 3)
      : 0;

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        fontFamily,
        fontSize,
        fontWeight,
        fontStyle,
        color,
        textAlign: "center",
        lineHeight: 1.2,
        letterSpacing: isClimax ? "-0.01em" : "0.01em",
        textShadow:
          isClimax && glowIntensity > 0
            ? `0 0 ${40 + glowIntensity * 60}px rgba(52,211,153,${glowIntensity * 0.7}), 0 0 80px rgba(52,211,153,${glowIntensity * 0.3})`
            : undefined,
      }}
    >
      {text}
    </div>
  );
};

/** Single stat — slams in then holds */
const SlamStat: React.FC<{
  value: string;
  label: string;
  color: string;
  delay: number;
  valueSize?: number;
}> = ({ value, label, color, delay, valueSize = 88 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = slamSpring(frame, fps, delay);
  const translateY = interpolate(progress, [0, 1], [30, 0]);
  const opacity = Math.min(progress * 4, 1);

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: FONTS.brutalist,
          fontSize: valueSize,
          fontWeight: 700,
          color,
          lineHeight: 1,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: FONTS.swiss,
          fontSize: 66,
          fontWeight: 600,
          color: COLORS.muted,
          textTransform: "uppercase" as const,
          letterSpacing: "0.18em",
          marginTop: 8,
        }}
      >
        {label}
      </div>
    </div>
  );
};

/** Code fragments floating as background texture */
const CodeWhisper: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Fade in early and stay subtle
  const opacity = interpolate(frame, [0, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0.01) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {CODE_FRAGMENTS.map((line, i) => {
        // Noise-based drift
        const driftX =
          noise2D(`cw-x-${i}`, 0, (frame / fps) * 0.06) * 18;
        const driftY =
          noise2D(`cw-y-${i}`, 1, (frame / fps) * 0.05) * 12;

        // Distribute across screen
        const baseX = 40 + (i % 4) * 450;
        const baseY = 30 + Math.floor(i / 4) * 130 + (i % 3) * 42;

        const fragmentOpacity =
          (0.06 + noise2D(`cw-o-${i}`, 2, (frame / fps) * 0.04) * 0.06) *
          opacity;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: baseX + driftX,
              top: baseY + driftY,
              fontFamily: FONTS.brutalist,
              fontSize: 66,
              fontWeight: 400,
              color: COLORS.accent2,
              opacity: fragmentOpacity,
              whiteSpace: "nowrap" as const,
              userSelect: "none" as const,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

export const S07_Stats: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // The last SLAM_STATS entry is $3.5T — give it extra treatment at frame 670
  // But we also include it in the vertical slam list (all 6 at 45-frame stagger from 350)
  const STAT_STAGGER = 45;

  // Market size breathing glow at frame 670
  const marketOpacity = interpolate(frame, [660, 695], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const marketBreathe =
    frame > 695 ? breathe(frame, fps, 0.82, 1, 4) : 0.82;

  // End dim
  const endDim = interpolate(frame, [720, 750], [1, 0.15], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Map ANCIENT_LINES to specific voices
  const lineConfigs = [
    {
      fontFamily: FONTS.expressive,
      fontWeight: 100,
      fontStyle: "normal" as const,
      fontSize: 94,
      color: COLORS.accent1,
    },
    {
      fontFamily: FONTS.expressive,
      fontWeight: 100,
      fontStyle: "normal" as const,
      fontSize: 94,
      color: COLORS.accent1,
    },
    {
      fontFamily: FONTS.expressive,
      fontWeight: 100,
      fontStyle: "normal" as const,
      fontSize: 100,
      color: COLORS.fg,
    },
    {
      fontFamily: FONTS.editorial,
      fontWeight: 400,
      fontStyle: "italic" as const,
      fontSize: 100,
      color: COLORS.accent2,
    },
    {
      fontFamily: FONTS.monument,
      fontWeight: 700,
      fontStyle: "normal" as const,
      fontSize: 106,
      color: COLORS.emerald,
      isClimax: true,
    },
  ];

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
      {/* Code whisper texture */}
      <CodeWhisper />

      {/* Gentle gold ambient */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 900,
          height: 700,
          background:
            "radial-gradient(ellipse, rgba(245,166,35,0.02) 0%, transparent 65%)",
          pointerEvents: "none",
        }}
      />

      {/* All content */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          paddingLeft: 80,
          paddingRight: 80,
          opacity: endDim,
        }}
      >
        {/* Ancient lines — revealed slowly */}
        {ANCIENT_LINES.map((line, i) => {
          const cfg = lineConfigs[i];
          return (
            <RevelationLine
              key={i}
              text={line.text}
              startFrame={line.delay}
              fontSize={cfg.fontSize}
              fontFamily={cfg.fontFamily}
              fontWeight={cfg.fontWeight}
              fontStyle={cfg.fontStyle}
              color={cfg.color}
              isClimax={(cfg as { isClimax?: boolean }).isClimax ?? false}
            />
          );
        })}

        <div style={{ height: 36 }} />

        {/* Stats — vertical list, slam in one by one */}
        {SLAM_STATS.slice(0, 5).map((stat, i) => (
          <SlamStat
            key={stat.label}
            value={stat.value}
            label={stat.label}
            color={stat.color}
            delay={350 + i * STAT_STAGGER}
          />
        ))}

        <div style={{ height: 24 }} />

        {/* $3.5T — extra emphasis, larger slam */}
        <div
          style={{
            opacity: marketOpacity,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONTS.monument,
              fontSize: 140,
              fontWeight: 700,
              color: COLORS.gold,
              lineHeight: 1,
              letterSpacing: "-0.04em",
              opacity: marketBreathe,
              textShadow: `
                0 0 60px rgba(245,166,35,${0.5 + marketBreathe * 0.2}),
                0 0 120px rgba(245,166,35,${0.2 + marketBreathe * 0.1})
              `,
            }}
          >
            $3.5T
          </div>
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 66,
              fontWeight: 700,
              color: COLORS.muted,
              textTransform: "uppercase" as const,
              letterSpacing: "0.3em",
              marginTop: 10,
            }}
          >
            Addressable Market
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export default S07_Stats;
