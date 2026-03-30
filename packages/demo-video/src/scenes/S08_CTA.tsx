/**
 * S08_CTA — "ETERNAL"
 *
 * 490 frames (~16s). Judge target: ALL judges. The final impression.
 *
 * Frame 0-15:   Pure black. The final pause.
 * Frame 15:     "PCC" SLAMS in at 200px. Monument, accent1 gold. Breathing glow. Noise drift.
 * Frame 35:     Editorial italic: "Physical Capability Cloud" — holographic gradient, 36px. Fade.
 * Frame 60:     Gradient line draws: discord → accent1. Width 0→500px. Height 2px.
 * Frame 85:     "capability.network" — Swiss, 36px, white. Spring entrance.
 * Frame 115:    "BUILT WITH" label — Swiss, 11px, tracked, muted.
 * Frame 125-175: Sponsor pills stagger in, 8 frames apart. SPONSORS data.
 * Frame 200:    "Open Source · Apache 2.0 · Public Goods Infrastructure" — Swiss, accent2.
 * Frame 260:    "PL Genesis Hackathon 2026" — Brutalist, muted, bottom.
 * Frame 390-430: Content dims to 0. PCC glow persists.
 * Frame 430-460: PCC glow dims to 0.
 * Frame 475:    Pure black.
 *
 * Voices: Monument (PCC), Editorial (subtitle), Swiss (URL, built-with, open-source),
 *         Brutalist (sponsor pills, hackathon)
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

  // Pure black for first 15 frames
  if (frame < 14) {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  // PCC SLAM — from 2.5x at frame 15
  const pccProgress = slamSpring(frame, fps, 15);
  const pccScale = slamScale(frame, fps, 15, 2.5);
  const pccOpacity = Math.min(pccProgress * 5, 1);

  // Breathing after settle
  const pccBreathe =
    pccProgress > 0.95 ? breathe(frame, fps, 0.82, 1, 3) : pccProgress;

  // Noise drift for organic feel
  const driftX =
    noise2D("pcc-final-x", 0, (frame / fps) * 0.25) * 4;
  const driftY =
    noise2D("pcc-final-y", 1, (frame / fps) * 0.25) * 3;

  // Subtitle fade at frame 35
  const subtitleFade = fadeSlideUp(frame, fps, 35);

  // Gradient line draws frame 60→95
  const lineWidth = interpolate(frame, [60, 95], [0, 500], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // URL entrance at frame 85
  const urlFade = fadeSlideUp(frame, fps, 85);

  // "Built with" label at frame 115
  const builtWithFade = fadeSlideUp(frame, fps, 115);

  // Open source line at frame 200
  const openSourceOpacity = interpolate(frame, [200, 220], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Hackathon label at frame 260
  const hackathonFade = fadeSlideUp(frame, fps, 260);

  // Content dims frame 390→430
  const contentDim = interpolate(frame, [390, 430], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // PCC glow persists until 430, then dims to 460
  const pccFinalDim = interpolate(frame, [430, 460], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Pure black after 475
  const sceneOpacity =
    frame >= 475
      ? 0
      : frame >= 460
      ? interpolate(frame, [460, 475], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  return (
    <AbsoluteFill
      style={{ backgroundColor: "#000000", opacity: sceneOpacity }}
    >
      {/* Background particles — very subtle */}
      <ParticleField opacity={0.1 * contentDim} />

      {/* Amber/gold radial glow — centered */}
      <div
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 700,
          height: 500,
          background:
            "radial-gradient(ellipse, rgba(245,166,35,0.06) 0%, transparent 65%)",
          opacity: pccFinalDim,
          pointerEvents: "none",
        }}
      />

      {/* Discord off-center-right glow */}
      <div
        style={{
          position: "absolute",
          top: "55%",
          left: "70%",
          transform: "translate(-50%, -50%)",
          width: 400,
          height: 400,
          background:
            "radial-gradient(circle, rgba(248,113,113,0.03) 0%, transparent 70%)",
          opacity: contentDim,
          pointerEvents: "none",
        }}
      />

      {/* Main content — vertically centered */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          paddingBottom: 72,
        }}
      >
        {/* PCC — 200px, gold, SLAM */}
        <div
          style={{
            fontFamily: FONTS.monument,
            fontSize: 280,
            fontWeight: 700,
            letterSpacing: "-0.04em",
            lineHeight: 0.85,
            textTransform: "uppercase" as const,
            color: COLORS.accent1,
            opacity: pccOpacity * pccBreathe * pccFinalDim,
            transform: `scale(${pccScale}) translate(${driftX}px, ${driftY}px)`,
            textShadow: `
              0 0 80px rgba(245,166,35,0.7),
              0 0 160px rgba(245,166,35,0.3),
              0 0 240px rgba(245,166,35,0.1)
            `,
            marginBottom: 16,
          }}
        >
          PCC
        </div>

        {/* Editorial subtitle — holographic */}
        <div
          style={{
            fontFamily: FONTS.editorial,
            fontSize: 66,
            fontWeight: 400,
            fontStyle: "italic",
            letterSpacing: "0.01em",
            lineHeight: 1.2,
            background: GRADIENTS.holographic,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            opacity: subtitleFade.opacity * contentDim,
            transform: `translateY(${subtitleFade.translateY}px)`,
            marginBottom: 24,
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
            background: `linear-gradient(90deg, ${COLORS.discord} 0%, ${COLORS.accent1} 100%)`,
            marginBottom: 24,
            opacity: 0.85 * contentDim,
            borderRadius: 1,
          }}
        />

        {/* URL */}
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 66,
            fontWeight: 600,
            color: COLORS.text.bright,
            opacity: urlFade.opacity * contentDim,
            transform: `translateY(${urlFade.translateY}px)`,
            marginBottom: 44,
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
            gap: 12,
            opacity: contentDim,
          }}
        >
          {/* "BUILT WITH" */}
          <div
            style={{
              fontFamily: FONTS.swiss,
              fontSize: 60,
              fontWeight: 600,
              color: COLORS.muted,
              textTransform: "uppercase" as const,
              letterSpacing: "0.3em",
              opacity: builtWithFade.opacity,
              transform: `translateY(${builtWithFade.translateY}px)`,
            }}
          >
            Built With
          </div>

          {/* Sponsor pills — 8-frame stagger */}
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
              const pillDelay = 125 + i * 8;
              const pillProgress = smoothSpring(frame, fps, pillDelay);
              const pillScale = interpolate(pillProgress, [0, 1], [0.85, 1]);

              return (
                <div
                  key={sponsor.name}
                  style={{
                    padding: "5px 12px",
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
                      fontSize: 34,
                      fontWeight: 400,
                      color: COLORS.fg,
                      letterSpacing: "0.1em",
                      textTransform: "uppercase" as const,
                      whiteSpace: "nowrap" as const,
                    }}
                  >
                    {sponsor.name}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Open source line */}
          <div
            style={{
              opacity: openSourceOpacity,
              textAlign: "center",
              marginTop: 4,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 34,
                fontWeight: 400,
                color: COLORS.accent2,
                letterSpacing: "0.1em",
                textTransform: "uppercase" as const,
              }}
            >
              Open Source · Apache 2.0 · Public Goods Infrastructure
            </span>
          </div>
        </div>
      </AbsoluteFill>

      {/* Hackathon label — pinned to bottom */}
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
            fontSize: 60,
            fontWeight: 400,
            color: COLORS.muted,
            letterSpacing: "0.18em",
            textTransform: "uppercase" as const,
          }}
        >
          PL Genesis Hackathon 2026
        </span>
      </div>
    </AbsoluteFill>
  );
};

export default S08_CTA;
