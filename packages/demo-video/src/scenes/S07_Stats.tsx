/**
 * S07_Ancient — "The Revelation"
 *
 * 750 frames (25 seconds). The tempo SHIFTS. Everything slows.
 *
 * This is the "respect the ages, look forward knowing you are ancient" moment.
 * After the DnB fury of the first 6 scenes, we breathe. Giant type.
 * Code whispers in the background. Stats emerge like constellations.
 *
 * Frame 0-45:   Pure black. Breathing. The audience rests.
 * Frame 45:     "Every machine." — Editorial voice, 64px, fades in SLOWLY (40 frames).
 * Frame 105:    "Every lab." — same cadence.
 * Frame 165:    "Every factory on Earth." — bigger (72px), brighter.
 * Frame 250:    Pause. Then: "Just became" — Expressive thin, smaller.
 * Frame 320:    "a programmable endpoint." — Monument voice, 88px, accent1 glow.
 *               This is the climax. Hold it.
 * Frame 420:    Code fragments emerge from black — very low opacity (0.06).
 *               The actual TypeScript of PCC, floating.
 * Frame 480:    Stats emerge one by one — 40-frame stagger. Slow. Reverent.
 *               Each stat: big number (Monument) + tiny label (Swiss).
 * Frame 650:    "$3.5T" — gold, massive (120px), breathing glow. Holds.
 * Frame 720:    Everything dims except the glow. Preparing for Eternal.
 *
 * Axiom I: Text IS the design. No chrome, no panels. Just words on black.
 * Axiom II: No discord here. This is the moment of pure intent. Discord returns in S08.
 * Axiom III: SLOWNESS is the design decision. After DnB fury, stillness is dramatic.
 *
 * Voices: Editorial (revelation lines), Monument (climax + stats), Swiss (labels),
 *         Expressive ("just became"), Brutalist (code texture)
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
  GRADIENTS,
  CODE_FRAGMENTS,
  SLAM_STATS,
  ANCIENT_LINES,
  smoothSpring,
  breathe,
} from "../lib";

/** Single revelation line — fades in SLOWLY */
const RevelationLine: React.FC<{
  text: string;
  delay: number;
  fontSize?: number;
  isClimax?: boolean;
  voice?: string;
}> = ({ text, delay, fontSize = 64, isClimax = false, voice }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // SLOW fade — 40 frames to appear (NOT slam)
  const opacity = interpolate(frame, [delay, delay + 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Gentle rise — 20px over 40 frames
  const translateY = interpolate(frame, [delay, delay + 40], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Breathing glow for climax
  const glowIntensity = isClimax && frame > delay + 40
    ? breathe(frame, fps, 0.4, 0.7, 3)
    : 0;

  const fontFamily = voice === "expressive"
    ? FONTS.expressive
    : voice === "monument"
    ? FONTS.monument
    : FONTS.editorial;

  const fontWeight = voice === "monument" ? 700 : voice === "expressive" ? 300 : 400;
  const fontStyle = voice === "editorial" || voice === "expressive" ? "italic" as const : "normal" as const;

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        fontFamily,
        fontSize,
        fontWeight,
        fontStyle,
        color: isClimax ? COLORS.accent1 : COLORS.fg,
        textAlign: "center",
        lineHeight: 1.15,
        letterSpacing: isClimax ? "-0.02em" : "0.01em",
        textShadow: isClimax
          ? `0 0 ${40 + glowIntensity * 60}px rgba(245,166,35,${glowIntensity}), 0 0 ${80 + glowIntensity * 100}px rgba(245,166,35,${glowIntensity * 0.4})`
          : undefined,
      }}
    >
      {text}
    </div>
  );
};

/** Floating code fragments — very subtle background texture */
const CodeWhisper: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame, [420, 460], [0, 0.06], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (opacity <= 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        opacity,
        pointerEvents: "none",
      }}
    >
      {CODE_FRAGMENTS.map((line, i) => {
        // Very slow scroll
        const y = ((i * 72 - (frame * 0.15)) % 1300) + 50;
        const x = 60 + (i % 4) * 480;
        const lineOpacity = 0.3 + noise2D(`whisper-${i}`, 0, (frame / fps) * 0.08) * 0.4;

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top: y,
              left: x,
              fontFamily: FONTS.brutalist,
              fontSize: 16,
              color: COLORS.accent2,
              whiteSpace: "nowrap",
              opacity: lineOpacity,
            }}
          >
            {line}
          </div>
        );
      })}
    </div>
  );
};

/** Single stat — emerges slowly */
const StatItem: React.FC<{
  value: string;
  label: string;
  color: string;
  delay: number;
}> = ({ value, label, color, delay }) => {
  const frame = useCurrentFrame();

  // Slow emergence — 30 frames
  const opacity = interpolate(frame, [delay, delay + 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        opacity,
        textAlign: "center",
        minWidth: 120,
      }}
    >
      <div
        style={{
          fontFamily: FONTS.monument,
          fontSize: 44,
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
          fontSize: 16,
          fontWeight: 600,
          color: COLORS.muted,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          marginTop: 6,
        }}
      >
        {label}
      </div>
    </div>
  );
};

export const S07_Stats: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Market size — frame 650
  const marketOpacity = interpolate(frame, [650, 690], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const marketBreathe = frame > 690
    ? breathe(frame, fps, 0.85, 1, 4)
    : 1;

  // End dim
  const endDim = interpolate(frame, [720, 748], [1, 0.15], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
      {/* Code whisper texture */}
      <CodeWhisper />

      {/* Gentle ambient glow */}
      <div
        style={{
          position: "absolute",
          top: "45%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 800,
          height: 600,
          background: "radial-gradient(ellipse, rgba(245,166,35,0.02) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          opacity: endDim,
        }}
      >
        {/* Revelation lines — slow, reverent */}
        <RevelationLine text="Every machine." delay={45} fontSize={64} voice="editorial" />
        <RevelationLine text="Every lab." delay={105} fontSize={64} voice="editorial" />
        <RevelationLine text="Every factory on Earth." delay={165} fontSize={72} voice="editorial" />

        <div style={{ height: 32 }} />

        <RevelationLine text="Just became" delay={250} fontSize={42} voice="expressive" />
        <RevelationLine
          text="a programmable endpoint."
          delay={320}
          fontSize={88}
          voice="monument"
          isClimax
        />

        <div style={{ height: 48 }} />

        {/* Stats emerge — slow stagger (40 frames apart) */}
        <div
          style={{
            display: "flex",
            gap: 40,
            justifyContent: "center",
            flexWrap: "wrap",
          }}
        >
          {SLAM_STATS.slice(0, 5).map((stat, i) => (
            <StatItem
              key={stat.label}
              value={stat.value}
              label={stat.label}
              color={stat.color}
              delay={480 + i * 30}
            />
          ))}
        </div>

        <div style={{ height: 32 }} />

        {/* "$3.5T" — massive, gold, breathing */}
        <div
          style={{
            opacity: marketOpacity,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: FONTS.monument,
              fontSize: 120,
              fontWeight: 700,
              color: COLORS.accent1,
              lineHeight: 1,
              letterSpacing: "-0.04em",
              opacity: marketBreathe,
              textShadow: `0 0 60px rgba(245,166,35,0.6), 0 0 120px rgba(245,166,35,0.25)`,
            }}
          >
            $3.5T
          </div>
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 20,
              fontWeight: 700,
              color: COLORS.muted,
              textTransform: "uppercase",
              letterSpacing: "0.3em",
              marginTop: 8,
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
