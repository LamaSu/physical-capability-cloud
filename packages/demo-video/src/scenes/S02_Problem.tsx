/**
 * S02_Impact — "The Title Slam"
 *
 * 390 frames (13 seconds). PCC arrives with FORCE.
 *
 * Frame 0:     Discord vertical line DRAWS first (8 frames).
 * Frame 4:     "PCC" SLAMS in — 3x scale → 1x in 10 frames. Neon glow explodes.
 * Frame 6:     2-frame discord flash (beat accent).
 * Frame 18:    Editorial subtitle rapid-types "Physical Capability Cloud".
 * Frame 40:    Swiss label — "AWS FOR THE PHYSICAL WORLD" (PHYSICAL in discord).
 * Frame 60:    Brutalist tagline types at 2 chars/frame.
 * Frame 120:   Capability ticker races at 4x speed.
 * Frame 360:   Everything dims except PCC glow. Preparing for cut.
 *
 * Axiom I: "PCC" at 200px is the ONLY thing that matters on entry.
 * Axiom II: Discord line appears BEFORE the text — the break proves the rest.
 * Axiom III: Slam → type → reveal → race. Each beat earns its frame.
 *
 * Voices: Monument (PCC), Editorial (subtitle), Swiss (label), Brutalist (tagline)
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
  slamSpring,
  slamScale,
  smoothSpring,
  fadeSlideUp,
  flashBurst,
  beatPulse,
  typewriterChars,
} from "../lib";
import { CapabilityTicker } from "../components/CapabilityTicker";

export const S02_Problem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Discord line — draws FIRST ──
  const lineHeight = interpolate(frame, [0, 8], [0, 420], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const lineOpacity = interpolate(frame, [0, 4], [0, 0.8], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── PCC SLAM — 3x→1x in 10 frames ──
  const pccProgress = slamSpring(frame, fps, 4);
  const pccScale = slamScale(frame, fps, 4, 3);
  const pccOpacity = Math.min(pccProgress * 6, 1); // near-instant appear

  // Noise drift after settle
  const driftX = pccProgress > 0.9 ? noise2D("pcc-x", 0, (frame / fps) * 0.3) * 4 : 0;
  const driftY = pccProgress > 0.9 ? noise2D("pcc-y", 1, (frame / fps) * 0.3) * 3 : 0;

  // ── Discord flash at frame 6 ──
  const discordFlash = flashBurst(frame, 6, 2);

  // ── Subtitle types fast ──
  const subtitleText = "Physical Capability Cloud";
  const subtitleChars = typewriterChars(frame, 18, 2.5, subtitleText.length);
  const subtitleDisplay = subtitleText.slice(0, subtitleChars);
  const subtitleComplete = subtitleChars >= subtitleText.length;
  const subtitleOpacity = interpolate(frame, [18, 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Swiss label ──
  const labelFade = fadeSlideUp(frame, fps, 40);

  // ── Brutalist tagline ──
  const tagline = "Every machine, lab, and factory on Earth just became a programmable endpoint.";
  const taglineChars = typewriterChars(frame, 60, 2, tagline.length);
  const taglineDisplay = tagline.slice(0, taglineChars);
  const taglineOpacity = interpolate(frame, [60, 64], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Capability ticker — gentle fade-in over 30 frames, then slow scroll ──
  // Fade-in: 0→0.7 over 30 frames starting at frame 120
  const tickerOpacity = interpolate(frame, [120, 150], [0, 0.7], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // ── End dim — everything fades at frame 360 ──
  const endDim = interpolate(frame, [360, 388], [1, 0.3], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Beat pulse for background ──
  const beat = beatPulse(frame, fps, 170, 0.03);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
      {/* Beat-synced background glow */}
      <div
        style={{
          position: "absolute",
          top: "42%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 1000,
          height: 700,
          background: `radial-gradient(ellipse, rgba(245,166,35,${0.04 + beat}) 0%, transparent 65%)`,
          pointerEvents: "none",
        }}
      />

      {/* DISCORD LINE — first thing visible */}
      <div
        style={{
          position: "absolute",
          left: 60,
          top: "50%",
          transform: "translateY(-50%)",
          width: 3,
          height: lineHeight,
          backgroundColor: COLORS.discord,
          opacity: lineOpacity * endDim,
          borderRadius: 2,
          boxShadow: `0 0 16px rgba(248,113,113,0.6), 0 0 32px rgba(248,113,113,0.2)`,
        }}
      />

      {/* Content stack */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          opacity: endDim,
        }}
      >
        {/* PCC — Monument voice, 200px, SLAM entrance */}
        <div
          style={{
            fontFamily: FONTS.monument,
            fontSize: 200,
            fontWeight: 700,
            letterSpacing: "-0.04em",
            lineHeight: 0.85,
            textTransform: "uppercase",
            color: COLORS.accent1,
            opacity: pccOpacity,
            transform: `scale(${pccScale}) translate(${driftX}px, ${driftY}px)`,
            textShadow: `
              0 0 80px rgba(245,166,35,0.7),
              0 0 160px rgba(245,166,35,0.3),
              0 0 240px rgba(245,166,35,0.1)
            `,
          }}
        >
          PCC
        </div>

        {/* Editorial subtitle — types fast */}
        <div
          style={{
            fontFamily: FONTS.editorial,
            fontSize: 42,
            fontWeight: 400,
            fontStyle: "italic",
            letterSpacing: "0.01em",
            color: COLORS.fg,
            opacity: subtitleOpacity,
          }}
        >
          {subtitleDisplay}
          {!subtitleComplete && (
            <span style={{ color: COLORS.accent2, opacity: 0.7 }}>|</span>
          )}
        </div>

        {/* Swiss label */}
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 22,
            fontWeight: 600,
            color: COLORS.muted,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            opacity: labelFade.opacity,
            transform: `translateY(${labelFade.translateY}px)`,
          }}
        >
          AWS FOR THE{" "}
          <span
            style={{
              color: COLORS.discord,
              textShadow: "0 0 14px rgba(248,113,113,0.6)",
            }}
          >
            PHYSICAL
          </span>{" "}
          WORLD
        </div>

        {/* Brutalist tagline — types at 2x speed */}
        <div
          style={{
            fontFamily: FONTS.brutalist,
            fontSize: 26,
            color: COLORS.text.primary,
            letterSpacing: "0.02em",
            lineHeight: 1.6,
            maxWidth: 960,
            textAlign: "center",
            opacity: taglineOpacity,
          }}
        >
          {taglineDisplay}
          {taglineChars < tagline.length && (
            <span
              style={{
                color: COLORS.discord,
                opacity: Math.sin(frame * 0.3) > 0 ? 1 : 0,
              }}
            >
              ▌
            </span>
          )}
        </div>
      </AbsoluteFill>

      {/* Capability ticker — gentle scroll, eased start */}
      <div style={{ opacity: tickerOpacity * endDim }}>
        <CapabilityTicker speed={3} fontSize={22} tickerStartFrame={120} />
      </div>

      {/* DISCORD FLASH */}
      {discordFlash > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(248,113,113,${discordFlash * 0.25})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S02_Problem;
