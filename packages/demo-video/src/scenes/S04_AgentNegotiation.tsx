/**
 * S04_AgentNegotiation — "THE MARKET"
 *
 * 870 frames (29 seconds). The longest scene. A2A protocol in action.
 * Target: David Sneider, Elliot Braem, Eshan Chordia (AI agent judges).
 *
 * Frame 0-15:    "COMPETITIVE BIDDING" SLAMS in — Monument, 56px, accent2.
 *                "34 typed A2A intents" label below, Swiss muted.
 * Frame 25-60:   3 operator cards stagger in (12-frame apart).
 *                Surface panels: name (Swiss semibold 16px), capability (Brutalist 12px).
 *                PulseIndicators: green, blue, discord.
 * Frame 70-700:  TerminalLog — NEGOTIATION_LOG, framesPerEntry: 55 (slow, deliberate).
 * Frame 720+:    Status bar — Brutalist, small. 3 PulseIndicator dots.
 * Frame 750:     "Zero middlemen. Pure market-driven pricing." — Editorial italic,
 *                accent1, 24px. The Brad Holden line.
 * Frame 830:     Dim to black over 40 frames.
 *
 * Voices: Monument (title), Swiss (operator names, label), Brutalist (capabilities, status),
 *         Editorial (closing line)
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
  NEGOTIATION_LOG,
  slamScale,
  slamSpring,
  smoothSpring,
  flashBurst,
  beatPulse,
  whipUp,
} from "../lib";
import { TerminalLog, PulseIndicator } from "../components";

// ─── Operator data ────────────────────────────────────────────────────────────
const OPERATORS = [
  {
    name: "BioLab Alpha",
    capability: "HPLC · 99.2% PURITY",
    dotColor: COLORS.emerald,
  },
  {
    name: "MachineShop Beta",
    capability: "CNC · ±0.01MM",
    dotColor: COLORS.accent2,
  },
  {
    name: "CourierNet Gamma",
    capability: "SAME-DAY DELIVERY",
    dotColor: COLORS.discord,
  },
] as const;

// ─── OperatorCard ─────────────────────────────────────────────────────────────
const OperatorCard: React.FC<{
  name: string;
  capability: string;
  dotColor: string;
  delay: number;
}> = ({ name, capability, dotColor, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = smoothSpring(frame, fps, delay);
  const opacity = interpolate(progress, [0, 1], [0, 1]);
  const y = interpolate(progress, [0, 1], [20, 0]);

  const isDiscord = dotColor === COLORS.discord;

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${y}px)`,
        padding: "14px 18px",
        background: COLORS.bg.surface,
        border: `1px solid ${isDiscord ? COLORS.discord + "55" : COLORS.bg.border}`,
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 12,
        minWidth: 240,
        boxShadow: isDiscord
          ? `0 0 16px rgba(248,113,113,0.12)`
          : `0 0 12px rgba(148,184,255,0.06)`,
      }}
    >
      <PulseIndicator color={dotColor} size={9} delay={delay + 4} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 60,
            fontWeight: 600,
            color: COLORS.fg,
            letterSpacing: "0.01em",
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontFamily: FONTS.brutalist,
            fontSize: 60,
            fontWeight: 400,
            color: isDiscord ? COLORS.discord : COLORS.muted,
            letterSpacing: "0.14em",
            textTransform: "uppercase" as const,
          }}
        >
          {capability}
        </span>
      </div>
    </div>
  );
};

// ─── Main scene ───────────────────────────────────────────────────────────────
export const S04_AgentNegotiation: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Title SLAM
  const titleProgress = slamSpring(frame, fps, 0);
  const titleScale = slamScale(frame, fps, 0, 2.5);
  const titleOpacity = Math.min(titleProgress * 5, 1);

  const labelProgress = smoothSpring(frame, fps, 12);
  const labelOpacity = interpolate(labelProgress, [0, 1], [0, 0.7]);
  const labelY = interpolate(labelProgress, [0, 1], [10, 0]);

  const slamFlash = flashBurst(frame, 0, 2);
  const beat = beatPulse(frame, fps, 170, 0.03);

  // Terminal log — appears at frame 70
  const terminalProgress = smoothSpring(frame, fps, 70);
  const terminalOpacity = interpolate(terminalProgress, [0, 1], [0, 1]);
  const terminalY = interpolate(terminalProgress, [0, 1], [24, 0]);

  // Status bar — frame 720
  const statusProgress = smoothSpring(frame, fps, 720);
  const statusOpacity = interpolate(statusProgress, [0, 1], [0, 1]);

  // Closing editorial line — frame 750
  const closingProgress = smoothSpring(frame, fps, 750);
  const closingOpacity = interpolate(closingProgress, [0, 1], [0, 1]);
  const closingY = interpolate(closingProgress, [0, 1], [16, 0]);

  // End dim — frame 830 over 40 frames
  const endDim = interpolate(frame, [830, 870], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLORS.bg.deep,
        padding: "36px 60px 32px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
        opacity: endDim,
      }}
    >
      {/* Ambient glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 30%, rgba(148,184,255,${0.04 + beat}) 0%, transparent 52%)`,
          pointerEvents: "none",
        }}
      />

      {/* ── Title row ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          zIndex: 1,
        }}
      >
        {/* COMPETITIVE BIDDING */}
        <div
          style={{
            fontFamily: FONTS.monument,
            fontSize: 94,
            fontWeight: 700,
            color: COLORS.accent2,
            textTransform: "uppercase",
            letterSpacing: "-0.02em",
            lineHeight: 1.0,
            textAlign: "center",
            opacity: titleOpacity,
            transform: `scale(${titleScale})`,
            textShadow: `0 0 50px rgba(148,184,255,0.5), 0 0 100px rgba(148,184,255,0.2)`,
          }}
        >
          COMPETITIVE BIDDING
        </div>

        {/* A2A label */}
        <div
          style={{
            fontFamily: FONTS.swiss,
            fontSize: 66,
            fontWeight: 400,
            color: COLORS.muted,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            opacity: labelOpacity,
            transform: `translateY(${labelY}px)`,
          }}
        >
          34 typed A2A intents
        </div>
      </div>

      {/* ── Operator cards ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 16,
          flexWrap: "wrap",
          zIndex: 1,
        }}
      >
        {OPERATORS.map((op, i) => (
          <OperatorCard
            key={op.name}
            name={op.name}
            capability={op.capability}
            dotColor={op.dotColor}
            delay={25 + i * 12}
          />
        ))}
      </div>

      {/* ── Terminal log ── */}
      <div
        style={{
          opacity: terminalOpacity,
          transform: `translateY(${terminalY}px)`,
          flex: 1,
          zIndex: 1,
          minHeight: 0,
        }}
      >
        <TerminalLog
          entries={NEGOTIATION_LOG}
          delay={70}
          framesPerEntry={55}
          fontSize={32}
        />
      </div>

      {/* ── Status bar ── */}
      {frame >= 720 && (
        <div
          style={{
            opacity: statusOpacity,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            zIndex: 1,
          }}
        >
          <PulseIndicator color={COLORS.emerald} size={8} delay={720} />
          <PulseIndicator color={COLORS.accent2} size={8} delay={724} />
          <PulseIndicator color={COLORS.discord} size={8} delay={728} />
          <span
            style={{
              fontFamily: FONTS.brutalist,
              fontSize: 34,
              color: COLORS.muted,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            3 operators&nbsp;&nbsp;|&nbsp;&nbsp;15 bids&nbsp;&nbsp;|&nbsp;&nbsp;$3,932 locked on Base Sepolia
          </span>
        </div>
      )}

      {/* ── Closing editorial line — Brad Holden ── */}
      {frame >= 750 && (
        <div
          style={{
            opacity: closingOpacity,
            transform: `translateY(${closingY}px)`,
            textAlign: "center",
            zIndex: 1,
          }}
        >
          <span
            style={{
              fontFamily: FONTS.editorial,
              fontSize: 60,
              fontWeight: 400,
              fontStyle: "italic",
              color: COLORS.accent1,
              letterSpacing: "0.01em",
              textShadow: `0 0 28px rgba(245,166,35,0.35)`,
            }}
          >
            Zero middlemen. Pure market-driven pricing.
          </span>
        </div>
      )}

      {/* Slam flash */}
      {slamFlash > 0 && (
        <AbsoluteFill
          style={{
            backgroundColor: `rgba(148,184,255,${slamFlash * 0.15})`,
            pointerEvents: "none",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export default S04_AgentNegotiation;
