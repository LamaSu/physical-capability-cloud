/**
 * S03_Pipeline — "THE SIX ACTS"
 *
 * 510 frames (17 seconds). Protocol flow for infrastructure judges.
 * Target: Juan Benet, Brad Holden, E.G. Galano, David Casey.
 *
 * Frame 0:       Title "HOW IT WORKS" — Expressive thin, 48px, centered, fade in.
 * Frame 20-420:  6 phases revealed left-to-right. Each phase gets ~65 frames.
 *                Phase i appears at frame 20 + i*65.
 *                Node: scale 0.85→1 + opacity spring. Connector draws over 15 frames.
 * Frame 430:     Glow pulse ripples through all nodes (border brightens, 8-frame stagger by 5).
 * Frame 460:     Three key lines fade in, staggered 12 frames.
 * Frame 490:     Dim to black.
 *
 * Special: ESCROW (index 2) has discord border + brighter glow — the trust lock.
 *
 * Voices: Expressive thin (title), Monument (phase names), Swiss (desc + insights)
 */
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  AbsoluteFill,
  spring,
  interpolate,
  Easing,
} from "remotion";
import {
  COLORS,
  FONTS,
  SIX_PHASES,
  smoothSpring,
  slamSpring,
  whipUp,
  beatPulse,
  flashBurst,
} from "../lib";
import { PulseIndicator } from "../components";

// ─── Layout constants ─────────────────────────────────────────────────────────
const NODE_APPEAR_BASE = 20;
const NODE_STAGGER = 65;
const GLOW_PULSE_START = 430;
const INSIGHTS_START = 460;
const OUTRO_START = 490;

// ─── PhaseCard ────────────────────────────────────────────────────────────────
const PhaseCard: React.FC<{
  phase: (typeof SIX_PHASES)[number];
  index: number;
}> = ({ phase, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const nodeDelay = NODE_APPEAR_BASE + index * NODE_STAGGER;
  const progress = smoothSpring(frame, fps, nodeDelay);
  const enterScale = interpolate(progress, [0, 1], [0.85, 1]);
  const enterOpacity = interpolate(progress, [0, 0.4], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Glow pulse — ripples through at GLOW_PULSE_START + index*5 for 8 frames
  const glowPulseStart = GLOW_PULSE_START + index * 5;
  const glowPulse = flashBurst(frame, glowPulseStart, 8);

  // Idle breathe glow
  const idleGlow = 0.15 + 0.08 * Math.sin((frame - nodeDelay) * 0.04 + index * 1.1);
  const totalGlow = Math.max(idleGlow, glowPulse * 0.85);

  const isEscrow = index === 2;
  const borderColor = isEscrow ? COLORS.discord : phase.color;
  const glowHex = isEscrow ? "248,113,113" : hexToRgb(phase.color);
  const escrowExtraGlow = isEscrow ? totalGlow * 0.4 : 0;

  // Numbered circle background
  const circleOpacity = interpolate(progress, [0.3, 0.9], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        opacity: enterOpacity,
        transform: `scale(${enterScale})`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        flex: 1,
        maxWidth: 200,
        minWidth: 160,
      }}
    >
      {/* Card */}
      <div
        style={{
          width: "100%",
          padding: "16px 10px 14px",
          background: COLORS.bg.surface,
          border: `1px solid ${borderColor}`,
          borderRadius: 12,
          boxShadow: `
            0 0 ${8 + totalGlow * 32 + escrowExtraGlow * 20}px rgba(${glowHex},${0.12 + totalGlow * 0.65}),
            inset 0 1px 0 rgba(255,255,255,0.04)
          `,
          textAlign: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Radial inner glow */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse at center, rgba(${glowHex},${totalGlow * 0.18}) 0%, transparent 70%)`,
            pointerEvents: "none",
          }}
        />

        {/* Numbered circle */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 8,
            opacity: circleOpacity,
          }}
        >
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              backgroundColor: borderColor,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: `0 0 12px rgba(${glowHex},0.55)`,
            }}
          >
            <span
              style={{
                fontFamily: FONTS.brutalist,
                fontSize: 60,
                fontWeight: 700,
                color: COLORS.bg.deep,
                letterSpacing: "0.02em",
              }}
            >
              {String(index + 1).padStart(2, "0")}
            </span>
          </div>
        </div>

        {/* Phase name — Monument */}
        <div
          style={{
            fontFamily: FONTS.monument,
            fontSize: 66,
            fontWeight: 700,
            color: borderColor,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            lineHeight: 1.2,
            position: "relative",
          }}
        >
          {phase.name}
        </div>
      </div>

      {/* Description — Swiss */}
      <div
        style={{
          fontFamily: FONTS.swiss,
          fontSize: 34,
          color: COLORS.muted,
          textAlign: "center",
          lineHeight: 1.45,
          maxWidth: 190,
          opacity: interpolate(progress, [0.6, 1], [0, 0.9], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        {phase.desc}
      </div>
    </div>
  );
};

// ─── Connector ────────────────────────────────────────────────────────────────
const Connector: React.FC<{ fromIndex: number; color: string }> = ({
  fromIndex,
  color,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Draw 8 frames after the source node appears
  const connDelay = NODE_APPEAR_BASE + fromIndex * NODE_STAGGER + 8;
  const progress = smoothSpring(frame, fps, connDelay, 15);
  const lineLen = 44;
  const dashOffset = interpolate(progress, [0, 1], [lineLen, 0]);

  return (
    <div
      style={{
        flex: "0 0 44px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        paddingBottom: 52,
      }}
    >
      <svg width={44} height={10} overflow="visible">
        <line
          x1={0} y1={5} x2={44} y2={5}
          stroke={`${color}22`}
          strokeWidth={1.5}
        />
        <line
          x1={0} y1={5} x2={44} y2={5}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray={lineLen}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
        <polygon
          points="36,1.5 44,5 36,8.5"
          fill={color}
          opacity={progress}
        />
      </svg>
    </div>
  );
};

// ─── Key Insights ─────────────────────────────────────────────────────────────
const KeyInsights: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const lines = [
    "AI agents discover, negotiate, and orchestrate",
    "Milestone escrow locks funds before work starts",
    "Cryptographic evidence proves every step",
  ];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
      }}
    >
      {lines.map((text, i) => {
        const delay = INSIGHTS_START + i * 12;
        const { opacity, translateY } = whipUp(frame, fps, delay, 60);

        return (
          <div
            key={i}
            style={{
              opacity,
              transform: `translateY(${translateY}px)`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 20px",
              background: "rgba(255,255,255,0.025)",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 40,
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: COLORS.emerald,
                boxShadow: `0 0 7px rgba(52,211,153,0.7)`,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: FONTS.swiss,
                fontSize: 66,
                color: COLORS.fg,
                fontWeight: 400,
              }}
            >
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ─── Main scene ───────────────────────────────────────────────────────────────
export const S03_Pipeline: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleProgress = smoothSpring(frame, fps, 0, 20);
  const titleOpacity = interpolate(titleProgress, [0, 1], [0, 1]);
  const titleY = interpolate(titleProgress, [0, 1], [16, 0]);

  const beat = beatPulse(frame, fps, 170, 0.025);

  const endDim = interpolate(frame, [OUTRO_START, 508], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        padding: "44px 52px 36px",
        display: "flex",
        flexDirection: "column",
        gap: 24,
        opacity: endDim,
      }}
    >
      {/* Ambient glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 35%, rgba(148,184,255,${0.03 + beat}) 0%, transparent 55%)`,
          pointerEvents: "none",
        }}
      />

      {/* Title */}
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          fontFamily: FONTS.expressive,
          fontSize: 100,
          fontWeight: 100,
          color: COLORS.fg,
          textAlign: "center",
          letterSpacing: "0.02em",
          lineHeight: 1.1,
          zIndex: 1,
        }}
      >
        HOW IT WORKS
      </div>

      {/* Phase row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          zIndex: 1,
          gap: 0,
        }}
      >
        {SIX_PHASES.map((phase, i) => (
          <React.Fragment key={phase.name}>
            <PhaseCard phase={phase} index={i} />
            {i < SIX_PHASES.length - 1 && (
              <Connector fromIndex={i} color={phase.color} />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Key insights */}
      <div style={{ zIndex: 1 }}>
        <KeyInsights />
      </div>
    </AbsoluteFill>
  );
};

export default S03_Pipeline;

// ─── Utility ─────────────────────────────────────────────────────────────────
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}
