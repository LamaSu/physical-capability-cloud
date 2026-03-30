/**
 * S08_Eternal — "The Last Frame"
 *
 * 490 frames (16 seconds). Pure dominance. Near-empty whitespace.
 *
 * After the Ancient scene's reverence, energy returns — but controlled.
 * Not DnB fury. Architectural confidence.
 *
 * Frame 0-15:   Pure black. The final pause.
 * Frame 15:     "PCC" at 200px SLAMS in. Breathing glow. Noise drift.
 * Frame 30:     Editorial subtitle — holographic gradient, types.
 * Frame 60:     Discord → accent1 gradient line draws horizontally.
 * Frame 90:     URL "capability.network" — Swiss voice, 36px, bright white.
 * Frame 130:    "Built with" label.
 * Frame 140:    Sponsor pills — FAST stagger (5 frames per pill). Glass.
 * Frame 280:    "PL Genesis Hackathon 2026" — Brutalist, tiny, tracked.
 * Frame 400:    Final dim — everything fades except "PCC" glow.
 *               PCC continues breathing on black. Eternal.
 * Frame 475:    Pure black.
 *
 * Axiom I: "PCC" is the ONLY thing that matters. 200px. Everything else subordinate.
 * Axiom II: Discord → accent1 gradient line is the final tension. The discord element.
 * Axiom III: Slam → reveal → breathe → dim → black. The narrative closes.
 *
 * Voices: Monument (PCC), Editorial (subtitle), Swiss (URL), Brutalist (sponsors, hackathon)
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
  SPONSORS,
  slamSpring,
  slamScale,
  smoothSpring,
  fadeSlideUp,
  breathe,
} from "../lib";
import { ParticleField } from "../components/ParticleField";

export const S08_CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // PCC SLAM — 200px, from 2.5x — no dead-time opening, use transition instead
  const pccProgress = slamSpring(frame, fps, 4);
  const pccScale = slamScale(frame, fps, 4, 2.5);
  const pccOpacity = Math.min(pccProgress * 5, 1);

  // Breathing after settle
  const pccBreathe = pccProgress > 0.95
    ? breathe(frame, fps, 0.82, 1, 3)
    : pccProgress;

  // Noise drift
  const driftX = noise2D("pcc-final-x", 0, (frame / fps) * 0.25) * 4;
  const driftY = noise2D("pcc-final-y", 1, (frame / fps) * 0.25) * 3;

  // Subtitle types
  const subtitleFade = fadeSlideUp(frame, fps, 30);

  // Gradient line draws
  const lineWidth = interpolate(frame, [60, 95], [0, 500], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // URL
  const urlFade = fadeSlideUp(frame, fps, 90);

  // Built with label
  const builtWithFade = fadeSlideUp(frame, fps, 130);

  // Hackathon label
  const hackathonFade = fadeSlideUp(frame, fps, 280);

  // Final dim — everything fades except PCC glow
  const contentDim = interpolate(frame, [400, 440], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // PCC glow persists longer, then dims
  const pccFinalDim = interpolate(frame, [440, 475], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
      {/* Very subtle particles */}
      <ParticleField opacity={0.1 * contentDim} />

      {/* Amber/gold radial glow — primary accent */}
      <div
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 700,
          height: 500,
          background: "radial-gradient(ellipse, rgba(245,166,35,0.06) 0%, transparent 65%)",
          opacity: pccFinalDim,
          pointerEvents: "none",
        }}
      />

      {/* Blue-white glow — off-center, secondary accent */}
      <div
        style={{
          position: "absolute",
          top: "58%",
          left: "68%",
          transform: "translate(-50%, -50%)",
          width: 350,
          height: 350,
          background: "radial-gradient(circle, rgba(148,184,255,0.04) 0%, transparent 70%)",
          opacity: contentDim,
          pointerEvents: "none",
        }}
      />

      {/* Main content */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          paddingBottom: 80,
        }}
      >
        {/* PCC — 200px, SLAM, breathing */}
        <div
          style={{
            fontFamily: FONTS.monument,
            fontSize: 200,
            fontWeight: 700,
            letterSpacing: "-0.04em",
            lineHeight: 0.85,
            textTransform: "uppercase",
            color: COLORS.accent1,
            opacity: pccOpacity * pccBreathe * pccFinalDim,
            transform: `scale(${pccScale}) translate(${driftX}px, ${driftY}px)`,
            textShadow: `
              0 0 80px rgba(245,166,35,0.7),
              0 0 160px rgba(245,166,35,0.3),
              0 0 240px rgba(245,166,35,0.1)
            `,
            marginBottom: 20,
          }}
        >
          PCC
        </div>

        {/* Editorial subtitle — holographic */}
        <div
          style={{
            fontFamily: FONTS.editorial,
            fontSize: 36,
            fontWeight: 400,
            fontStyle: "italic",
            letterSpacing: "0.01em",
            lineHeight: 1.2,
            background: GRADIENTS.holographic,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            opacity: subtitleFade.opacity * contentDim,
            transform: `translateY(${subtitleFade.translateY}px)`,
            marginBottom: 28,
            textAlign: "center",
          }}
        >
          Physical Capability Cloud
        </div>

        {/* Gradient line — discord → accent1 */}
        <div
          style={{
            width: lineWidth,
            height: 2,
            background: `linear-gradient(90deg, transparent 0%, ${COLORS.accent2} 25%, ${COLORS.accent1} 75%, transparent 100%)`,
            marginBottom: 28,
            opacity: 0.8 * contentDim,
          }}
        />

        {/* URL — Swiss, bright */}
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 36,
            fontWeight: 600,
            color: COLORS.text.bright,
            opacity: urlFade.opacity * contentDim,
            transform: `translateY(${urlFade.translateY}px)`,
            marginBottom: 52,
            letterSpacing: "-0.01em",
          }}
        >
          capability.network
        </div>

        {/* Sponsor section */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            opacity: contentDim,
          }}
        >
          {/* "Built with" */}
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 18,
              fontWeight: 600,
              color: COLORS.muted,
              textTransform: "uppercase",
              letterSpacing: "0.22em",
              opacity: builtWithFade.opacity,
              transform: `translateY(${builtWithFade.translateY}px)`,
            }}
          >
            Built with
          </div>

          {/* Sponsor pills — FAST stagger (5 frames) */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: 10,
              maxWidth: 900,
            }}
          >
            {SPONSORS.map((sponsor, i) => {
              const pillDelay = 140 + i * 5; // 5-frame stagger (was 8)
              const pillProgress = smoothSpring(frame, fps, pillDelay);
              const pillScale = interpolate(pillProgress, [0, 1], [0.8, 1]);

              return (
                <div
                  key={sponsor.name}
                  style={{
                    padding: "7px 16px",
                    background: GRADIENTS.glass,
                    border: `1px solid ${GRADIENTS.glassBorder}`,
                    borderRadius: 6,
                    opacity: pillProgress,
                    transform: `scale(${pillScale})`,
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONTS.brutalist,
                      fontSize: 18,
                      fontWeight: 400,
                      color: COLORS.fg,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {sponsor.name}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>

      {/* Hackathon label — bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 28,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: hackathonFade.opacity * contentDim,
          transform: `translateY(${hackathonFade.translateY}px)`,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.brutalist,
            fontSize: 18,
            fontWeight: 400,
            color: COLORS.muted,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
          }}
        >
          PL Genesis 2026 — Existing Code Track — AI & Robotics
        </span>
      </div>
    </AbsoluteFill>
  );
};

export default S08_CTA;
