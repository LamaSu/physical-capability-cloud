/**
 * S05_Evidence — "SOVEREIGN STACK"
 *
 * 570 frames (19 seconds). Judge target: David Sneider (Lit), Omar Espejel (Starknet),
 * Dhruv Varshney (Storacha), Molly Mackinlay (IPFS).
 *
 * The SPONSOR scene. Each integration named and badged.
 *
 * Frame 0:     Title "SOVEREIGN INFRASTRUCTURE" — Editorial italic, holographic, fade in.
 * Frame 20:    Subtitle — Swiss, muted, small.
 * Frame 40-440: 9-step evidence cascade from EVIDENCE_PIPELINE.
 *               Sponsor badges on steps 3-6 (Lit, Storacha, Bittensor, Starknet).
 * Frame 460:   Glow sweep through all steps.
 * Frame 480:   "Zero trust required." — Expressive italic, accent2.
 * Frame 540:   Dim to 0.2.
 *
 * Voices: Editorial (title), Swiss (subtitle + step detail), Monument (numbers),
 *         Brutalist (sponsor badges), Expressive (closer)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  interpolate,
  Easing,
} from "remotion";
import {
  COLORS,
  FONTS,
  GRADIENTS,
  EVIDENCE_PIPELINE,
  slamSpring,
  smoothSpring,
  fadeSlideUp,
  beatPulse,
  flashBurst,
} from "../lib";
import { PulseIndicator } from "../components/PulseIndicator";

const STEP_STAGGER = 40;
const STEP_HEIGHT = 48;

/** Sponsor badge data — indexed by EVIDENCE_PIPELINE position */
const SPONSOR_BADGES: Record<number, { name: string; borderColor: string }> = {
  3: { name: "LIT PROTOCOL", borderColor: COLORS.emerald },
  4: { name: "STORACHA", borderColor: COLORS.accent2 },
  5: { name: "BITTENSOR", borderColor: COLORS.accent2 },
  6: { name: "STARKNET", borderColor: COLORS.emerald },
};

const SponsorBadge: React.FC<{
  name: string;
  borderColor: string;
  stepColor: string;
}> = ({ name, borderColor }) => (
  <div
    style={{
      padding: "3px 8px",
      border: `1px solid ${borderColor}`,
      borderRadius: 4,
      background: `${borderColor}10`,
      flexShrink: 0,
      marginLeft: 8,
    }}
  >
    <span
      style={{
        fontFamily: FONTS.brutalist,
        fontSize: 60,
        fontWeight: 700,
        color: borderColor,
        letterSpacing: "0.12em",
        textTransform: "uppercase" as const,
        whiteSpace: "nowrap" as const,
      }}
    >
      {name}
    </span>
  </div>
);

const EvidenceStep: React.FC<{
  index: number;
  step: string;
  detail: string;
  color: string;
  appearFrame: number;
  glowSweepFrame: number;
}> = ({ index, step, detail, color, appearFrame, glowSweepFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Slide in from left
  const progress = smoothSpring(frame, fps, appearFrame);
  const slideX = interpolate(progress, [0, 1], [-30, 0]);
  const enterOpacity = progress;

  // Glow sweep at frame 460 + index*6
  const glowFlash = flashBurst(frame, glowSweepFrame, 6);
  const borderGlow = 0.06 + glowFlash * 0.5;

  const badge = SPONSOR_BADGES[index];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        height: STEP_HEIGHT,
        padding: "0 16px 0 14px",
        background: COLORS.bg.surface,
        border: `1px solid rgba(${hexToRgb(color)},${borderGlow})`,
        borderRadius: 10,
        opacity: enterOpacity,
        transform: `translateX(${slideX}px)`,
        boxShadow:
          glowFlash > 0.02
            ? `0 0 20px rgba(${hexToRgb(color)},${glowFlash * 0.35})`
            : undefined,
        flexShrink: 0,
      }}
    >
      {/* Number circle */}
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          backgroundColor: color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.monument,
            fontSize: 34,
            fontWeight: 700,
            color: COLORS.bg.deep,
            lineHeight: 1,
          }}
        >
          {index + 1}
        </span>
      </div>

      {/* Step name + detail */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 66,
            fontWeight: 600,
            color: COLORS.fg,
            lineHeight: 1.2,
            whiteSpace: "nowrap" as const,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {step}
        </div>
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 34,
            fontWeight: 400,
            color: COLORS.muted,
            lineHeight: 1.2,
            marginTop: 1,
          }}
        >
          {detail}
        </div>
      </div>

      {/* Sponsor badge — only on sponsor steps */}
      {badge && (
        <SponsorBadge
          name={badge.name}
          borderColor={badge.borderColor}
          stepColor={color}
        />
      )}

      <PulseIndicator color={color} size={7} delay={appearFrame} />
    </div>
  );
};

/** Tiny helper: convert hex to "r,g,b" string */
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r},${g},${b}`;
}

export const S05_Evidence: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title fade in
  const titleOpacity = interpolate(frame, [0, 25], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Subtitle fade
  const subtitleOpacity = interpolate(frame, [20, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // Closer text
  const closerFade = fadeSlideUp(frame, fps, 480);

  // End dim
  const endDim = interpolate(frame, [540, 570], [1, 0.2], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const beat = beatPulse(frame, fps, 170, 0.03);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        paddingTop: 36,
        paddingBottom: 28,
        paddingLeft: 72,
        paddingRight: 72,
        overflow: "hidden",
      }}
    >
      {/* Ambient glow */}
      <div
        style={{
          position: "absolute",
          top: "30%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 700,
          height: 500,
          background: `radial-gradient(ellipse, rgba(148,184,255,${0.04 + beat}) 0%, transparent 60%)`,
          pointerEvents: "none",
        }}
      />

      {/* Title — Editorial italic, holographic gradient */}
      <div
        style={{
          opacity: titleOpacity * endDim,
          marginBottom: 6,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.editorial,
            fontSize: 94,
            fontWeight: 400,
            fontStyle: "italic",
            lineHeight: 1.1,
            background: GRADIENTS.holographic,
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          Sovereign Infrastructure
        </span>
      </div>

      {/* Subtitle */}
      <div
        style={{
          opacity: subtitleOpacity * endDim,
          marginBottom: 20,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 34,
            fontWeight: 400,
            color: COLORS.muted,
            letterSpacing: "0.02em",
          }}
        >
          Every piece of evidence, verified without trusting our servers
        </span>
      </div>

      {/* Evidence steps cascade */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          maxWidth: 820,
          gap: 8,
          flex: 1,
          opacity: endDim,
        }}
      >
        {EVIDENCE_PIPELINE.map((item, i) => {
          const appearFrame = 40 + i * STEP_STAGGER;
          const glowSweepFrame = 460 + i * 6;

          return (
            <EvidenceStep
              key={i}
              index={i}
              step={item.step}
              detail={item.detail}
              color={item.color}
              appearFrame={appearFrame}
              glowSweepFrame={glowSweepFrame}
            />
          );
        })}
      </div>

      {/* Closer — Expressive italic, accent2 */}
      <div
        style={{
          marginTop: 16,
          opacity: closerFade.opacity * endDim,
          transform: `translateY(${closerFade.translateY}px)`,
          textAlign: "center",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: FONTS.expressive,
            fontSize: 66,
            fontWeight: 400,
            fontStyle: "italic",
            color: COLORS.accent2,
            letterSpacing: "0.01em",
          }}
        >
          Zero trust required.
        </span>
      </div>
    </AbsoluteFill>
  );
};

export default S05_Evidence;
